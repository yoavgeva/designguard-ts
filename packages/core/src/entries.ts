import ts from "typescript";
import type { EntryPointSpec, ParameterSpec } from "./adapter.js";
import { glob } from "./patterns.js";
import { type FunctionLike, isProjectSource, type Resolution, resolveCall } from "./resolve.js";
import { nameOf } from "./summaries.js";

/** A function that handles requests, found where an adapter's entry point registers or marks it. */
export interface EntryPoint {
  readonly handler: FunctionLike;
  /**
   * Where findings about it are reported when the handler is written elsewhere: the argument that names it, as
   * `remove` in `app.delete("/orders/:id", remove)`.
   */
  readonly at: ts.Node | undefined;
  /** How messages name it: `the POST /orders handler`, `the remove mutation`, `OrdersController.cancel()`. */
  readonly label: string;
  readonly reads: boolean;
  /** What its parameters hold, with the decorators of each, by position, to match the specs' `decorator`. */
  readonly parameters: readonly ParameterSpec[];
  readonly decoratorsOf: (parameter: number) => readonly string[];
  /**
   * What runs before it, as middleware does: by the name it's given, as `isAdmin` in `use(isAdmin)`, and its function
   * when the project writes one, inline, by name, or wrapped, as `t.middleware(fn)` wraps one.
   */
  readonly middleware: readonly Middleware[];
  /** The decorator calls on it and on its class, which may check permissions. */
  readonly decorators: readonly ts.CallExpression[];
  /**
   * The variables its registration's chain goes through, as `publicProcedure` and `adminProcedure`, whose names can
   * say who may call it.
   */
  readonly builders: readonly string[];
}

export interface Middleware {
  readonly name: string;
  readonly function: FunctionLike | undefined;
}

/** What finding entry points needs of the adapters. */
export interface EntrySpecs {
  readonly specs: readonly EntryPointSpec[];
  /** Whether a resolved call matches a pattern of the adapter a spec comes from. */
  matches(spec: EntryPointSpec, pattern: string, resolution: Resolution): boolean;
}

type Claims = (fileName: string) => string | undefined;

/** The entry points a file registers or declares, in the order they appear. */
export function entriesOf(program: ts.Program, checker: ts.TypeChecker, file: ts.SourceFile, specs: EntrySpecs, claims: Claims): EntryPoint[] {
  const found: EntryPoint[] = [];
  const callSpecs = specs.specs.filter((spec) => spec.call !== undefined);
  const callNames = callSpecs.map((spec) => lastSegment(spec.call ?? ""));
  const decoratorSpecs = specs.specs.filter((spec) => spec.decorator !== undefined);
  const resolve = (call: ts.CallExpression): Resolution => resolveCall(program, checker, call, claims);
  const directives = specs.specs.filter((spec) => spec.directive !== undefined);
  const fileDirective = directives.find((spec) => hasDirective(file.statements, spec.directive ?? ""));

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callSpecs.length > 0) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      if (name !== undefined && callNames.some((pattern) => pattern.test(name))) {
        const resolution = resolve(node);
        const spec = callSpecs.find((candidate) => specs.matches(candidate, candidate.call ?? "", resolution));
        const entry = spec === undefined ? undefined : registered(program, checker, node, spec, specs, resolve, claims);
        if (entry !== undefined) found.push(entry);
      }
    }
    if (ts.isMethodDeclaration(node) && node.body !== undefined && decoratorSpecs.length > 0) {
      const own = decoratorCalls(node);
      for (const call of own) {
        const resolution = resolve(call);
        const spec = decoratorSpecs.find((candidate) => specs.matches(candidate, candidate.decorator ?? "", resolution));
        if (spec !== undefined) {
          const holder = ts.isClassLike(node.parent) ? decoratorCalls(node.parent) : [];
          found.push(declared(node as FunctionLike, `${nameOf(node as FunctionLike)}()`, spec, [...own, ...holder]));
          break;
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const entry = wrappedExport(program, checker, node, specs.specs, claims);
      if (entry !== undefined) found.push(entry);
    }
    if (isFunctionWithBody(node)) {
      const spec =
        (fileDirective !== undefined && isExported(node) ? fileDirective : undefined) ??
        directives.find((candidate) => ts.isBlock(node.body) && hasDirective(node.body.statements, candidate.directive ?? ""));
      if (spec !== undefined) found.push(declared(node, `${nameOf(node)}()`, spec, []));
      else {
        const exported = exportsSpec(checker, node, specs.specs);
        if (exported !== undefined) found.push(declared(node, `${nameOf(node)}()`, exported, []));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

function declared(handler: FunctionLike, label: string, spec: EntryPointSpec, decorators: readonly ts.CallExpression[]): EntryPoint {
  return {
    handler,
    at: undefined,
    label,
    reads: spec.reads === true,
    parameters: spec.parameters ?? [],
    decoratorsOf: (index) => {
      const parameter = handler.parameters[index];
      return parameter === undefined ? [] : decoratorCalls(parameter).map((call) => calleeText(call.expression));
    },
    middleware: [],
    decorators,
    builders: [],
  };
}

/** An entry point a call registers: its handler argument, the middleware before it, and a label from its route. */
function registered(
  program: ts.Program,
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  spec: EntryPointSpec,
  specs: EntrySpecs,
  resolve: (call: ts.CallExpression) => Resolution,
  claims: Claims,
): EntryPoint | undefined {
  const index = spec.handler === undefined || spec.handler === "last" ? call.arguments.length - 1 : spec.handler;
  const argument = call.arguments[index];
  const handler = argument === undefined ? undefined : functionOf(program, checker, argument, claims);
  if (argument === undefined || handler === undefined) return undefined;
  const middleware = call.arguments.slice(0, index).flatMap((before) => middlewareOf(program, checker, before, claims));
  const chain = spec.middleware === undefined ? { middleware: [], builders: [] } : chainMiddleware(program, checker, call, spec, specs, resolve, claims);
  middleware.unshift(...chain.middleware);
  return {
    handler,
    at: handler === argument ? undefined : argument,
    label: labelOf(call, resolve(call)),
    reads: spec.reads === true,
    parameters: spec.parameters ?? [],
    decoratorsOf: () => [],
    middleware,
    decorators: [],
    builders: chain.builders,
  };
}

/**
 * The functions the calls before a registration in its chain give as middleware, following a builder kept in a
 * variable to the chain it was made with, as `authed` in `const authed = t.procedure.use(isAuthed)`.
 */
function chainMiddleware(
  program: ts.Program,
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  spec: EntryPointSpec,
  specs: EntrySpecs,
  resolve: (call: ts.CallExpression) => Resolution,
  claims: Claims,
): { middleware: Middleware[]; builders: string[] } {
  const found: Middleware[] = [];
  const builders: string[] = [];
  const seen = new Set<ts.Node>();
  let node: ts.Expression | undefined = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined;
  // Builders are the variables of the receiver's type, as `authedProcedure` is a ProcedureBuilder, not the objects
  // that make them, as `t` and `initTRPC` do.
  const builderType = node === undefined ? undefined : checker.getTypeAtLocation(node).getSymbol();
  while (node !== undefined && !seen.has(node)) {
    seen.add(node);
    if (ts.isCallExpression(node)) {
      if (specs.matches(spec, spec.middleware ?? "", resolve(node))) {
        for (const argument of node.arguments) found.push(...middlewareOf(program, checker, argument, claims));
      }
      node = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : undefined;
    } else if (ts.isPropertyAccessExpression(node)) node = node.expression;
    else if (ts.isIdentifier(node)) {
      if (builderType !== undefined && checker.getTypeAtLocation(node).getSymbol() === builderType) builders.push(node.text);
      const symbol = aliased(checker, checker.getSymbolAtLocation(node));
      const declaration = symbol?.valueDeclaration;
      node = declaration !== undefined && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    } else node = undefined;
  }
  // Found from the registration outwards; they run from the start of the chain.
  return { middleware: found.reverse(), builders };
}

/**
 * How a message names a registered handler: by its method and route, `the POST /orders handler`; by the key it's
 * registered under, `the remove mutation`; or by the call, `the mutation() handler`.
 */
function labelOf(call: ts.CallExpression, resolution: Resolution): string {
  const name = resolution.kind === "dependency" || resolution.kind === "lib" ? resolution.name : "";
  const method = name.slice(name.lastIndexOf(".") + 1);
  const route = call.arguments[0];
  if (route !== undefined && ts.isStringLiteralLike(route)) return `the ${method.toUpperCase()} ${route.text} handler`;
  const property = call.parent;
  if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
    return `the ${property.name.text} ${method}`;
  }
  return `the ${method}() handler`;
}

/** The middleware an argument gives: a function, or a name for one. */
function middlewareOf(program: ts.Program, checker: ts.TypeChecker, argument: ts.Expression, claims: Claims): Middleware[] {
  const function_ = functionOf(program, checker, argument, claims);
  const name = ts.isIdentifier(argument) ? argument.text : ts.isPropertyAccessExpression(argument) ? argument.name.text : "";
  return function_ === undefined && name === "" ? [] : [{ name, function: function_ }];
}

/**
 * The project function an argument is or names: written inline, a function or method it refers to, or the function
 * a variable it refers to wraps, as `const isAdmin = t.middleware(async (opts) => ...)` does.
 */
function functionOf(program: ts.Program, checker: ts.TypeChecker, argument: ts.Expression, claims: Claims): FunctionLike | undefined {
  if (isFunctionWithBody(argument)) return argument;
  if (!ts.isIdentifier(argument) && !ts.isPropertyAccessExpression(argument)) return undefined;
  const symbol = aliased(checker, checker.getSymbolAtLocation(ts.isPropertyAccessExpression(argument) ? argument.name : argument));
  const declaration = symbol?.valueDeclaration;
  if (declaration === undefined) return undefined;
  const initializer =
    ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration) ? declaration.initializer : undefined;
  const wrapped = initializer !== undefined && ts.isCallExpression(initializer) ? lastFunction(initializer.arguments) : undefined;
  const target = isFunctionWithBody(declaration)
    ? declaration
    : initializer !== undefined && isFunctionWithBody(initializer)
      ? initializer
      : wrapped;
  if (target === undefined) return undefined;
  const file = target.getSourceFile();
  return !isProjectSource(file) || claims(file.fileName) !== undefined ? undefined : target;
}

/**
 * A route handler exported as what a call makes of a function, as `export const POST = respond(handler)` exports: the
 * function is the handler, and the call runs before it, as middleware does.
 */
function wrappedExport(
  program: ts.Program,
  checker: ts.TypeChecker,
  node: ts.VariableDeclaration,
  specs: readonly EntryPointSpec[],
  claims: Claims,
): EntryPoint | undefined {
  const statement = node.parent.parent;
  const call = node.initializer;
  if (!ts.isIdentifier(node.name) || !ts.isVariableStatement(statement) || !hasExport(statement) || call === undefined || !ts.isCallExpression(call)) {
    return undefined;
  }
  const name = node.name.text;
  for (let index = call.arguments.length - 1; index >= 0; index--) {
    const argument = call.arguments[index];
    const handler = argument === undefined ? undefined : functionOf(program, checker, argument, claims);
    if (argument === undefined || handler === undefined) continue;
    const spec = specs.find((candidate) => candidate.exports !== undefined && glob(candidate.exports).test(name) && takes(checker, handler, candidate));
    if (spec === undefined) return undefined;
    return {
      ...declared(handler, `${name}()`, spec, []),
      at: handler === argument ? undefined : argument,
      middleware: middlewareOf(program, checker, call.expression, claims),
    };
  }
  return undefined;
}

/** Whether a handler's first parameter's type, or a type it extends, matches a spec's `takes`. */
function takes(checker: ts.TypeChecker, handler: FunctionLike, spec: EntryPointSpec): boolean {
  if (spec.takes === undefined) return true;
  const first = handler.parameters[0];
  return first !== undefined && typeNames(checker, checker.getTypeAtLocation(first)).some((type) => glob(spec.takes ?? "").test(type));
}

/** The spec whose `exports` names an exported function and whose `takes` its first parameter's type matches. */
function exportsSpec(checker: ts.TypeChecker, node: FunctionLike, specs: readonly EntryPointSpec[]): EntryPointSpec | undefined {
  const name = exportedName(node);
  if (name === undefined) return undefined;
  return specs.find((spec) => spec.exports !== undefined && glob(spec.exports).test(name) && takes(checker, node, spec));
}

/** The names of a type, the types it's a union of, and the types it extends. */
function typeNames(checker: ts.TypeChecker, type: ts.Type): string[] {
  const names: string[] = [];
  const pending = [type];
  const seen = new Set<ts.Type>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (next.isUnion()) pending.push(...next.types);
    const symbol = next.getSymbol() ?? next.aliasSymbol;
    if (symbol !== undefined) names.push(symbol.getName());
    if (next.isClassOrInterface()) pending.push(...(checker.getBaseTypes(next) as ts.Type[]));
  }
  return names;
}

/** The name an exported function goes by: its own, or the exported variable's that holds it. */
function exportedName(node: FunctionLike): string | undefined {
  if (ts.isFunctionDeclaration(node)) return isExported(node) && node.name !== undefined ? node.name.text : undefined;
  const holder = node.parent;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
    return isExported(node) ? holder.name.text : undefined;
  }
  return undefined;
}

/** Whether a function is exported: declared with `export`, or held by an exported variable. */
function isExported(node: FunctionLike): boolean {
  if (ts.isFunctionDeclaration(node)) return hasExport(node);
  const holder = node.parent;
  if (!((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(holder))) return false;
  const statement = holder.parent.parent;
  return ts.isVariableStatement(statement) && hasExport(statement);
}

function hasExport(node: ts.HasModifiers): boolean {
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDirective(statements: ts.NodeArray<ts.Statement>, directive: string): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === directive) return true;
  }
  return false;
}

/** The decorators of a node that are calls, as `@Post(":id")`. */
function decoratorCalls(node: ts.Node): ts.CallExpression[] {
  if (!ts.canHaveDecorators(node)) return [];
  return (ts.getDecorators(node) ?? []).flatMap((decorator) => (ts.isCallExpression(decorator.expression) ? [decorator.expression] : []));
}

function calleeText(expression: ts.Expression): string {
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.getText();
}

function lastSegment(pattern: string): RegExp {
  const dot = pattern.lastIndexOf(".");
  return glob(dot < 0 ? pattern : pattern.slice(dot + 1));
}

function aliased(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  return symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function lastFunction(nodes: readonly ts.Node[]): FunctionLike | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node !== undefined && isFunctionWithBody(node)) return node;
  }
  return undefined;
}

function isFunctionWithBody(node: ts.Node): node is FunctionLike {
  return ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined;
}
