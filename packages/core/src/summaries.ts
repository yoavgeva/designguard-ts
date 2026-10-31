import ts from "typescript";
import { type FunctionLike, type Resolution, resolveCall } from "./resolve.js";

/**
 * A loop a call runs once per item of: a `for`, `for…of` or `for…in` loop, or the callback of an array method such as
 * `map()`. A `while` loop polls or retries rather than walking items, so it isn't one.
 */
export interface Loop {
  readonly node: ts.Node;
  /** How a message names it: `the for…of loop`, `map()`. */
  readonly label: string;
}

export interface CallSite {
  /** The call, or the argument that passes a function by name. */
  readonly node: ts.CallLikeExpression | ts.Expression;
  /** The expression a message names it by: the callee, or the function passed. */
  readonly named: ts.Expression;
  readonly resolution: Resolution;
  /** The innermost loop the call runs once per item of, if any. */
  readonly loop: Loop | undefined;
}

/** A function's own calls, those of the callbacks written inline in its calls included. */
export interface FunctionSummary {
  readonly node: FunctionLike | ts.SourceFile;
  readonly calls: readonly CallSite[];
}

/** The array, map and set methods that call their callback once per item. */
const LOOPING = /^(?:Readonly)?(?:Array|Map|Set)\.(?:forEach|map|flatMap|filter|reduce|reduceRight|some|every|find|findIndex|findLast|findLastIndex)$/;

const STATEMENT_LOOPS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.ForStatement]: "the for loop",
  [ts.SyntaxKind.ForOfStatement]: "the for…of loop",
  [ts.SyntaxKind.ForInStatement]: "the for…in loop",
};

type Owner = FunctionLike | ts.SourceFile;
type Claims = (fileName: string) => string | undefined;

/** The names of the array, map and set methods that call their callback once per item. */
const LOOPING_NAMES = new Set(["forEach", "map", "flatMap", "filter", "reduce", "reduceRight", "some", "every", "find", "findIndex", "findLast", "findLastIndex"]);

/** A function's own calls, every one resolved: what the engine follows when a call reaches the function. */
export function summarizeFunction(program: ts.Program, checker: ts.TypeChecker, owner: Owner, claims: Claims): FunctionSummary {
  return { node: owner, calls: walk(program, checker, owner, claims, { nested: "skip", resolveAll: true }) };
}

/**
 * The calls in a file, in any of its functions, that run once per item of a loop. Only those, and the array-method
 * calls that might start a loop, are resolved, so linting a file doesn't type-check the code around it.
 */
export function loopCalls(program: ts.Program, checker: ts.TypeChecker, file: ts.SourceFile, claims: Claims): CallSite[] {
  return walk(program, checker, file, claims, { nested: "descend", resolveAll: false }).filter((site) => site.loop !== undefined);
}

/** Every function in a file with code of its own, the file's top-level code first. */
export function ownersOf(file: ts.SourceFile): Owner[] {
  const owners: Owner[] = [file];
  const visit = (node: ts.Node): void => {
    if (isFunctionWithBody(node) && !isInlineCallback(node)) owners.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return owners;
}

/**
 * Walks a function's code, the callbacks written inline in its calls included, recording each call with the loop it
 * runs in. Other functions inside it are skipped, or, with `nested: "descend"`, walked as code outside any loop.
 */
function walk(
  program: ts.Program,
  checker: ts.TypeChecker,
  owner: Owner,
  claims: Claims,
  options: { nested: "skip" | "descend"; resolveAll: boolean },
): CallSite[] {
  const calls: CallSite[] = [];
  const visit = (node: ts.Node, loop: Loop | undefined): void => {
    if (node !== owner && isFunctionWithBody(node) && !isInlineCallback(node)) {
      if (options.nested === "descend") visit(node.body, undefined);
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const candidate = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LOOPING_NAMES.has(node.expression.name.text);
      const resolution = options.resolveAll || loop !== undefined || candidate ? resolveCall(program, checker, node, claims) : undefined;
      if (resolution !== undefined) calls.push({ node, named: node.expression, resolution, loop });
      visit(node.expression, loop);
      const perItem = resolution === undefined ? undefined : loopingMethod(node, resolution);
      for (const argument of node.arguments ?? []) {
        const inLoop = perItem ?? loop;
        const passed = options.resolveAll || inLoop !== undefined ? passedFunction(program, checker, argument, claims) : undefined;
        if (passed !== undefined) calls.push({ node: argument, named: argument, resolution: passed, loop: inLoop });
        visit(argument, inLoop);
      }
      return;
    }
    const label = STATEMENT_LOOPS[node.kind];
    if (label !== undefined && isIterationStatement(node)) {
      ts.forEachChild(node, (child) => {
        visit(child, child === node.statement ? { node, label } : loop);
      });
      return;
    }
    ts.forEachChild(node, (child) => {
      visit(child, loop);
    });
  };
  if (ts.isSourceFile(owner)) {
    ts.forEachChild(owner, (child) => {
      visit(child, undefined);
    });
  } else visit(owner.body, undefined);
  return calls;
}

function isIterationStatement(node: ts.Node): node is ts.IterationStatement {
  return STATEMENT_LOOPS[node.kind] !== undefined;
}

function isFunctionWithBody(node: ts.Node): node is FunctionLike {
  return ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined;
}

/** A function written as an argument of a call: it runs as part of the call, so its calls count as the caller's. */
function isInlineCallback(node: FunctionLike): boolean {
  const parent = node.parent;
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    (parent.arguments ?? []).some((argument) => argument === node)
  );
}

/** The loop of a call to an array method that calls its callback once per item, such as `ids.map(...)`. */
function loopingMethod(call: ts.CallLikeExpression, resolution: Resolution): Loop | undefined {
  if (resolution.kind !== "lib" || !LOOPING.test(resolution.name) || !ts.isCallExpression(call)) return undefined;
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : resolution.name;
  return { node: call, label: `${name}()` };
}

/** A project function passed by name as an argument, as `ids.map(loadUser)` passes `loadUser`. */
function passedFunction(
  program: ts.Program,
  checker: ts.TypeChecker,
  argument: ts.Expression,
  claims: (fileName: string) => string | undefined,
): Resolution | undefined {
  if (!ts.isIdentifier(argument) && !ts.isPropertyAccessExpression(argument)) return undefined;
  let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(argument) ? argument.name : argument);
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (declaration === undefined) return undefined;
  const target = isFunctionWithBody(declaration)
    ? declaration
    : ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && isFunctionWithBody(declaration.initializer)
      ? declaration.initializer
      : undefined;
  if (target === undefined) return undefined;
  const file = target.getSourceFile();
  if (file.isDeclarationFile || program.isSourceFileFromExternalLibrary(file) || claims(file.fileName) !== undefined) return undefined;
  return { kind: "project", targets: [target] };
}
