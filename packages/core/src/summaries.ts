import ts from "typescript";
import { callee } from "./names.js";
import { type FunctionLike, isProjectSource, type Resolution, resolveCall } from "./resolve.js";

/**
 * Code a call runs in: a loop, which runs it once per item, or a transaction. A loop is a `for`, `for…of` or `for…in`
 * loop, or the callback of an array method such as `map()`; a `while` loop polls or retries rather than walking
 * items, so it isn't one. A transaction is the function an adapter's transaction call runs.
 */
export interface Scope {
  readonly node: ts.Node;
  /** How a message names it: `the for…of loop`, `map()`, `prisma.$transaction()`. */
  readonly label: string;
}



export interface CallSite {
  /** The function the call is in, or the file for top-level code. */
  readonly owner: FunctionLike | ts.SourceFile;
  /** The call, or the argument that passes a function by name. */
  readonly node: ts.CallLikeExpression | ts.Expression;
  /** The expression a message names it by: the callee, or the function passed. */
  readonly named: ts.Expression;
  readonly resolution: Resolution;
  /** The innermost loop the call runs once per item of, if any. */
  readonly loop: Scope | undefined;
  /** The innermost transaction the call runs in, if any. */
  readonly transaction: Scope | undefined;
}

/** What the walker needs to know of the adapters: which calls run a transaction, and the names those calls have. */
export interface Transactions {
  /** The argument of a call that runs inside the transaction it opens, if it opens one. */
  bodyOf(resolution: Resolution): number | "last" | undefined;
  /** Whether a callee's last name could be a transaction call, so a file's walk resolves it. */
  mightBe(name: string): boolean;
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
export function summarizeFunction(
  program: ts.Program,
  checker: ts.TypeChecker,
  owner: Owner,
  claims: Claims,
  transactions: Transactions,
): FunctionSummary {
  return { node: owner, calls: walk(program, checker, owner, claims, transactions, { nested: "skip", resolveAll: true }) };
}

/**
 * The calls in a file, in any of its functions, that run in a loop or a transaction. Only those, and the calls that
 * might start one, are resolved, so linting a file doesn't type-check the code around it.
 */
export function scopedCalls(
  program: ts.Program,
  checker: ts.TypeChecker,
  file: ts.SourceFile,
  claims: Claims,
  transactions: Transactions,
): CallSite[] {
  return walk(program, checker, file, claims, transactions, { nested: "descend", resolveAll: false }).filter(
    (site) => site.loop !== undefined || site.transaction !== undefined,
  );
}

/**
 * The name a function goes by in options and messages: `loadUser`, `UserService.load`, `users.find`, or "" for a
 * file's top-level code.
 */
export function nameOf(owner: Owner): string {
  if (ts.isSourceFile(owner)) return "";
  const own = owner.name !== undefined && (ts.isIdentifier(owner.name) || ts.isPrivateIdentifier(owner.name)) ? owner.name.text : undefined;
  const parent = owner.parent;
  if (ts.isConstructorDeclaration(owner)) return `${className(parent)}.constructor`;
  if (own !== undefined && ts.isClassLike(parent)) return `${className(parent)}.${own}`;
  if (own !== undefined && ts.isObjectLiteralExpression(parent)) {
    const holder = parent.parent;
    return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? `${holder.name.text}.${own}` : own;
  }
  if (own !== undefined) return own;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    const property = ts.isIdentifier(parent.name) ? parent.name.text : "<anonymous>";
    return ts.isPropertyDeclaration(parent) ? `${className(parent.parent)}.${property}` : property;
  }
  return "<anonymous>";
}

function className(node: ts.Node): string {
  return ts.isClassLike(node) && node.name !== undefined ? node.name.text : "<anonymous>";
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
  transactions: Transactions,
  options: { nested: "skip" | "descend"; resolveAll: boolean },
): CallSite[] {
  const calls: CallSite[] = [];
  let current: Owner = owner;
  const visit = (node: ts.Node, loop: Scope | undefined, transaction: Scope | undefined): void => {
    if (node !== owner && isFunctionWithBody(node) && !isInlineCallback(node)) {
      if (options.nested === "descend") {
        const outer = current;
        current = node;
        visit(node.body, undefined, undefined);
        current = outer;
      }
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = lastName(node.expression);
      const candidate = name !== undefined && (LOOPING_NAMES.has(name) || transactions.mightBe(name));
      const scoped = loop !== undefined || transaction !== undefined;
      const resolution = options.resolveAll || scoped || candidate ? resolveCall(program, checker, node, claims) : undefined;
      if (resolution !== undefined) calls.push({ owner: current, node, named: node.expression, resolution, loop, transaction });
      visit(node.expression, loop, transaction);
      const perItem = resolution === undefined ? undefined : loopingMethod(node, resolution);
      const spec = resolution === undefined ? undefined : transactions.bodyOf(resolution);
      const body = spec === "last" ? (node.arguments ?? []).length - 1 : spec;
      const opened = body === undefined ? undefined : { node, label: `${callee(node.expression)}()` };
      (node.arguments ?? []).forEach((argument, index) => {
        const inLoop = perItem ?? loop;
        const inTransaction = index === body ? opened : transaction;
        const passed =
          options.resolveAll || inLoop !== undefined || inTransaction !== undefined
            ? passedFunction(program, checker, argument, claims)
            : undefined;
        if (passed !== undefined) {
          calls.push({ owner: current, node: argument, named: argument, resolution: passed, loop: inLoop, transaction: inTransaction });
        }
        visit(argument, inLoop, inTransaction);
      });
      return;
    }
    const label = STATEMENT_LOOPS[node.kind];
    if (label !== undefined && isIterationStatement(node)) {
      ts.forEachChild(node, (child) => {
        visit(child, child === node.statement ? { node, label } : loop, transaction);
      });
      return;
    }
    ts.forEachChild(node, (child) => {
      visit(child, loop, transaction);
    });
  };
  if (ts.isSourceFile(owner)) {
    ts.forEachChild(owner, (child) => {
      visit(child, undefined, undefined);
    });
  } else visit(owner.body, undefined, undefined);
  return calls;
}

/** The last name of a callee: `map` for `ids.map`, `load` for `load`. */
function lastName(callee: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

function isIterationStatement(node: ts.Node): node is ts.IterationStatement {
  return STATEMENT_LOOPS[node.kind] !== undefined;
}

function isFunctionWithBody(node: ts.Node): node is FunctionLike {
  return ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined;
}

/** A function written as an argument of a call: it runs as part of the call, so its calls count as the caller's. */
export function isInlineCallback(node: FunctionLike): boolean {
  const parent = node.parent;
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    (parent.arguments ?? []).some((argument) => argument === node)
  );
}

/** The loop of a call to an array method that calls its callback once per item, such as `ids.map(...)`. */
function loopingMethod(call: ts.CallLikeExpression, resolution: Resolution): Scope | undefined {
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
  if (!isProjectSource(file) || claims(file.fileName) !== undefined) return undefined;
  return { kind: "project", targets: [target] };
}
