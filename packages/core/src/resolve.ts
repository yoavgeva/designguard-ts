import ts from "typescript";

/** A function-like declaration with a body: code the engine can read. */
export type FunctionLike = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

/**
 * What a call reaches:
 *
 * - `project`: the project's own functions, more than one when the call is through an interface or abstract method
 *   that several classes implement;
 * - `dependency`: a declaration in a package, named by the package and its qualified name, as
 *   `Prisma.UserDelegate.findMany` in `@prisma/client`;
 * - `lib`: TypeScript's own library, such as `Array.map`;
 * - `unresolved`: a call through `any`, or to a declaration with no code to read.
 */
export type Resolution =
  | { kind: "project"; targets: FunctionLike[] }
  | { kind: "dependency"; package: string; name: string; declaration: ts.Declaration }
  | { kind: "lib"; name: string; declaration: ts.Declaration }
  | { kind: "unresolved"; reason: "any" | "abstract" };

const implementers = new WeakMap<ts.Program, Map<ts.Symbol, ts.ClassLikeDeclaration[]>>();

/**
 * What a call reaches. `claims` names the package a project file belongs to when a library generated it there, so
 * its declarations count as the package's.
 */
export function resolveCall(
  program: ts.Program,
  checker: ts.TypeChecker,
  call: ts.CallLikeExpression,
  claims: (fileName: string) => string | undefined = () => undefined,
): Resolution {
  const declaration = declarationOf(checker, call);
  if (declaration === undefined) return { kind: "unresolved", reason: "any" };
  const file = declaration.getSourceFile();
  // A signature with no name of its own, as a property of a function type has, goes by the property's.
  const name = (): string => qualifiedName(checker, declaration) || calleeName(checker, call);
  if (program.isSourceFileDefaultLibrary(file)) return { kind: "lib", name: name(), declaration };
  const claimed = claims(file.fileName);
  if (claimed !== undefined) return { kind: "dependency", package: claimed, name: name(), declaration };
  if (file.isDeclarationFile || program.isSourceFileFromExternalLibrary(file)) {
    return { kind: "dependency", package: packageOf(file.fileName), name: name(), declaration };
  }
  const targets = implementations(program, checker, declaration);
  return targets.length > 0 ? { kind: "project", targets } : { kind: "unresolved", reason: "abstract" };
}

/** The declaration a call's signature comes from, or the function a variable or property holding it was given. */
function declarationOf(checker: ts.TypeChecker, call: ts.CallLikeExpression): ts.Declaration | undefined {
  const fromSignature = checker.getResolvedSignature(call)?.getDeclaration();
  if (fromSignature !== undefined && hasBody(fromSignature)) return fromSignature;
  const callee = ts.isCallExpression(call) || ts.isNewExpression(call) ? call.expression : undefined;
  const symbol = callee === undefined ? undefined : symbolOf(checker, callee);
  const held = symbol === undefined ? undefined : heldFunction(symbol);
  return held ?? fromSignature;
}

/** The qualified name of the property or variable a call's callee reads, as `Router.post` for `app.post(...)`. */
function calleeName(checker: ts.TypeChecker, call: ts.CallLikeExpression): string {
  const callee = ts.isCallExpression(call) || ts.isNewExpression(call) ? call.expression : undefined;
  const symbol = callee === undefined ? undefined : symbolOf(checker, callee);
  return symbol === undefined ? "" : nameOfSymbol(checker, symbol);
}

function symbolOf(checker: ts.TypeChecker, callee: ts.Expression): ts.Symbol | undefined {
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  const symbol = checker.getSymbolAtLocation(name);
  return symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** The function a variable or property was initialized with, as `const load = async () => ...` holds one. */
function heldFunction(symbol: ts.Symbol): FunctionLike | undefined {
  const declaration = symbol.valueDeclaration;
  if (declaration === undefined) return undefined;
  const initializer =
    ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)
      ? declaration.initializer
      : undefined;
  return initializer !== undefined && hasBody(initializer) ? initializer : undefined;
}

function hasBody(node: ts.Node): node is FunctionLike {
  return ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined;
}

/**
 * The project functions a declaration stands for: itself when it has a body, the implementation of an overload, or,
 * for an interface or abstract method, the methods of every project class that implements or extends its owner.
 */
function implementations(program: ts.Program, checker: ts.TypeChecker, declaration: ts.Declaration): FunctionLike[] {
  if (hasBody(declaration)) return [declaration];
  const name = ts.getNameOfDeclaration(declaration);
  const symbol = name === undefined ? undefined : checker.getSymbolAtLocation(name);
  const overloads = (symbol?.declarations ?? []).filter(hasBody);
  if (overloads.length > 0) return overloads;
  const owner = declaration.parent;
  if (symbol === undefined || !(ts.isInterfaceDeclaration(owner) || ts.isClassLike(owner))) return [];
  const ownerSymbol = owner.name === undefined ? undefined : checker.getSymbolAtLocation(owner.name);
  if (ownerSymbol === undefined) return [];
  const found: FunctionLike[] = [];
  for (const type of implementersOf(program, checker, ownerSymbol)) {
    const member = checker.getPropertyOfType(checker.getTypeAtLocation(type), symbol.name);
    for (const candidate of member?.declarations ?? []) {
      if (hasBody(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** The project's classes that implement or extend `owner`, directly or through others, in declaration order. */
function implementersOf(program: ts.Program, checker: ts.TypeChecker, owner: ts.Symbol): ts.ClassLikeDeclaration[] {
  let index = implementers.get(program);
  if (index === undefined) {
    index = heritageIndex(program, checker);
    implementers.set(program, index);
  }
  const found: ts.ClassLikeDeclaration[] = [];
  const pending = [owner];
  const seen = new Set<ts.Symbol>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    for (const type of index.get(next) ?? []) {
      if (!found.includes(type)) found.push(type);
      const symbol = type.name === undefined ? undefined : checker.getSymbolAtLocation(type.name);
      if (symbol !== undefined) pending.push(symbol);
    }
  }
  return found;
}

function heritageIndex(program: ts.Program, checker: ts.TypeChecker): Map<ts.Symbol, ts.ClassLikeDeclaration[]> {
  const index = new Map<ts.Symbol, ts.ClassLikeDeclaration[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node)) {
      for (const clause of node.heritageClauses ?? []) {
        for (const type of clause.types) {
          let symbol = checker.getSymbolAtLocation(type.expression);
          if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          if (symbol !== undefined) index.set(symbol, [...(index.get(symbol) ?? []), node]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of program.getSourceFiles()) {
    if (!file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file)) visit(file);
  }
  return index;
}

/**
 * A declaration's qualified name without the path of the file that declares it: `Prisma.UserDelegate.findMany`, or
 * `fs.readFile` for a declaration in `declare module "fs"`.
 */
export function qualifiedName(checker: ts.TypeChecker, declaration: ts.Declaration): string {
  const name = ts.getNameOfDeclaration(declaration);
  const symbol = name === undefined ? undefined : checker.getSymbolAtLocation(name);
  return symbol === undefined ? "" : nameOfSymbol(checker, symbol);
}

function nameOfSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): string {
  return checker
    .getFullyQualifiedName(symbol)
    .replace(/^"[^"]*\/[^"]*"\./, "")
    .replace(/^"([^"]+)"\./, "$1.");
}

/** The package a file under `node_modules` belongs to, with `@types/scope__name` read as `@scope/name`. */
export function packageOf(fileName: string): string {
  const at = fileName.lastIndexOf("/node_modules/");
  if (at < 0) return "";
  const parts = fileName.slice(at + "/node_modules/".length).split("/");
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : (parts[0] ?? "");
  if (name.startsWith("@types/")) {
    const typed = name.slice("@types/".length);
    return typed.includes("__") ? `@${typed.replace("__", "/")}` : typed;
  }
  return name;
}
