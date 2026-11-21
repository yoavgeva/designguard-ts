import ts from "typescript";
import { callee } from "./names.js";
import { wordsOf } from "./words.js";
import { type FunctionLike, isProjectSource, type Resolution, resolveCall } from "./resolve.js";

/**
 * Code a call runs in: a loop, which runs it once per item, or a transaction. A loop is a `for`, `for…of` or `for…in`
 * loop, or the callback of an array method such as `map()`; a `while` loop polls or retries rather than walking
 * items, so it isn't one, and neither is a `for` loop with no condition, or one counting to a number the code gives
 * or to a limit of attempts or passes, nor a loop over a list written in the code, which run as often whatever the
 * data, nor one over the data a chunk at a time. A transaction is the function an adapter's transaction call runs.
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
  /**
   * Whether the call runs only when a cache misses or goes stale, so not each time the code around it runs: in a
   * function named for a cache, as `getCachedKey()` and `refreshIfStale()` are; in a function given to a cache, as
   * `memoize(key, load)` and `cache.wrap(key, load)` are; past a return of what a cache holds, as
   * `if (cached) return cached;` is; as the fallback of a cache, as in `cache.get(key) ?? load(key)`; when a cache is
   * stale, as under `if (this.isStale())`; or kept in a field it's made for, as `this.key ??= loadKey()` is. A
   * function that takes arguments is cached by them, as React's `cache((id) => ...)` is, so calls with each item's own
   * still miss: only one that takes none counts.
   */
  readonly cached: boolean;
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
  const visit = (node: ts.Node, loop: Scope | undefined, transaction: Scope | undefined, cached: boolean): void => {
    if (node !== owner && isFunctionWithBody(node) && !isInlineCallback(node)) {
      if (options.nested === "descend") {
        const outer = current;
        current = node;
        visit(node.body, undefined, undefined, startsCached(node));
        current = outer;
      }
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = lastName(node.expression);
      const candidate = name !== undefined && (LOOPING_NAMES.has(name) || transactions.mightBe(name));
      const scoped = loop !== undefined || transaction !== undefined;
      const resolution = options.resolveAll || scoped || candidate ? resolveCall(program, checker, node, claims) : undefined;
      if (resolution !== undefined) calls.push({ owner: current, node, named: node.expression, resolution, loop, transaction, cached });
      visit(node.expression, loop, transaction, cached);
      const perItem = resolution === undefined ? undefined : loopingMethod(checker, node, resolution);
      const spec = resolution === undefined ? undefined : transactions.bodyOf(resolution);
      const body = spec === "last" ? (node.arguments ?? []).length - 1 : spec;
      const opened = body === undefined ? undefined : { node, label: `${callee(node.expression)}()` };
      // A function given to a cache runs only when the cache misses.
      const caching = chainNames(node.expression).some(isCacheName);
      (node.arguments ?? []).forEach((argument, index) => {
        const inLoop = perItem ?? loop;
        const inTransaction = index === body ? opened : transaction;
        const passed =
          options.resolveAll || inLoop !== undefined || inTransaction !== undefined
            ? passedFunction(program, checker, argument, claims)
            : undefined;
        const loader = passed?.kind === "project" ? passed.targets[0] : ts.isArrowFunction(argument) || ts.isFunctionExpression(argument) ? argument : undefined;
        const inCache = cached || (caching && loader?.parameters.length === 0);
        if (passed !== undefined) {
          calls.push({ owner: current, node: argument, named: argument, resolution: passed, loop: inLoop, transaction: inTransaction, cached: inCache });
        }
        visit(argument, inLoop, inTransaction, inCache);
      });
      return;
    }
    // What `if (this.isStale())` runs, it runs only when a cache has gone stale.
    if (ts.isIfStatement(node)) {
      visit(node.expression, loop, transaction, cached);
      visit(node.thenStatement, loop, transaction, cached || mentions(node.expression, isStaleName));
      if (node.elseStatement !== undefined) visit(node.elseStatement, loop, transaction, cached);
      return;
    }
    // Past `if (cached) return cached;`, the code runs only when the cache misses.
    if (ts.isBlock(node)) {
      let missed = cached;
      for (const statement of node.statements) {
        visit(statement, loop, transaction, missed);
        if (ts.isIfStatement(statement) && statement.elseStatement === undefined && returnsCached(statement.thenStatement)) missed = true;
      }
      return;
    }
    if (ts.isBinaryExpression(node) && (fallsBackFromCache(node) || memoizes(node, owner))) {
      visit(node.left, loop, transaction, cached);
      visit(node.right, loop, transaction, true);
      return;
    }
    const label = STATEMENT_LOOPS[node.kind];
    if (label !== undefined && isIterationStatement(node) && walksItems(checker, node)) {
      ts.forEachChild(node, (child) => {
        visit(child, child === node.statement ? { node, label } : loop, transaction, cached);
      });
      return;
    }
    ts.forEachChild(node, (child) => {
      visit(child, loop, transaction, cached);
    });
  };
  if (ts.isSourceFile(owner)) {
    ts.forEachChild(owner, (child) => {
      visit(child, undefined, undefined, false);
    });
  } else visit(owner.body, undefined, undefined, startsCached(owner));
  return calls;
}

/** The words a cache goes by, as `cachedUser` and `memoize()` do. */
const CACHE_WORDS = new Set(["cache", "cached", "caches", "caching", "memo", "memoize", "memoized", "memoizer", "memoise", "memoised"]);

/** Whether a name is a cache's, or asks whether one is stale, as `cachedUser`, `memoize` and `refreshIfStale` are. */
function isCacheName(name: string): boolean {
  return wordsOf(name).some((word) => CACHE_WORDS.has(word)) || isStaleName(name);
}

/**
 * Whether a name asks whether a cache is stale, as `isStale()`, `refreshIfStale()` and `isLocalCacheExpired` do:
 * stale data, as `staleFiles` names, is no cache, and a check that a cache holds a value runs what follows on a hit.
 */
function isStaleName(name: string): boolean {
  const words = wordsOf(name);
  const stale = words.indexOf("stale");
  if (stale >= 0 && (words[0] === "is" || words[stale - 1] === "if")) return true;
  return words.some((word) => CACHE_WORDS.has(word)) && words.some((word) => word === "expired" || word === "stale");
}

/** The words a part of a list goes by, as `chunk(ids, 100)`, `batch` and `BATCH_SIZE` do. */
const CHUNK_WORDS = new Set(["chunk", "chunks", "chunked", "batch", "batches", "batched"]);

/** The words a list of parts goes by, as `batches` does: `batch` is one part, whose items a loop goes over one by one. */
const CHUNKS_WORDS = new Set(["chunks", "chunked", "batches", "batched"]);

function isChunkName(name: string): boolean {
  return wordsOf(name).some((word) => CHUNK_WORDS.has(word));
}

/**
 * Whether a function runs only when a cache misses, taking no arguments to be cached by: its own name says it reads a
 * cache or refreshes one, as `getCachedKey()` and `refreshIfStale()` do, or it's written as what a cache loads, as
 * `cache(async () => ...)` writes it.
 */
function startsCached(function_: FunctionLike): boolean {
  if (function_.parameters.length > 0) return false;
  const name = nameOf(function_);
  if (isCacheName(name.slice(name.lastIndexOf(".") + 1))) return true;
  const parent = function_.parent;
  return isInlineCallback(function_) && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && chainNames(parent.expression).some(isCacheName);
}

/** Whether code names something a way it tells: a variable, a property or a method it calls. */
function mentions(expression: ts.Node, named: (name: string) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && named(node.text)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

/** The names along a callee, without its calls' arguments: `wrap`, `cacheManager` for `this.cacheManager.wrap`. */
function chainNames(expression: ts.Expression): string[] {
  const names: string[] = [];
  let current = expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      names.push(current.name.text);
      current = current.expression;
    } else if (ts.isCallExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else {
      if (ts.isIdentifier(current)) names.push(current.text);
      return names;
    }
  }
}

/** A value that falls back on loading when a cache has none, as `cache.get(key) ?? load(key)` does. */
function fallsBackFromCache(node: ts.BinaryExpression): boolean {
  const operator = node.operatorToken.kind;
  const fallback = operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
  return fallback && mentions(node.left, isCacheName);
}

/** Whether a statement returns what a cache holds, as `return cached;` and `{ return cachedApp.id; }` do. */
function returnsCached(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) return statement.expression !== undefined && mentions(statement.expression, isCacheName);
  const last = ts.isBlock(statement) ? statement.statements[statement.statements.length - 1] : undefined;
  return last !== undefined && returnsCached(last);
}

/**
 * A value kept in the place a check looks in first, made only when that place is empty, as `this.key ??= loadKey()`
 * and `if (this.key === undefined) this.key = loadKey();` make it.
 */
function memoizes(node: ts.BinaryExpression, owner: Owner): boolean {
  const operator = node.operatorToken.kind;
  if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken || operator === ts.SyntaxKind.BarBarEqualsToken) return true;
  const target = node.left;
  if (operator !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(target) || target.expression.kind !== ts.SyntaxKind.ThisKeyword) {
    return false;
  }
  for (let inner: ts.Node = node; inner !== owner && !ts.isSourceFile(inner); inner = inner.parent) {
    const parent = inner.parent;
    if (ts.isIfStatement(parent) && parent.thenStatement === inner && readsField(parent.expression, target.name.text)) return true;
  }
  return false;
}

/** Whether an expression reads `this.<name>`. */
function readsField(expression: ts.Expression, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === name) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

/** Whether a statement always leaves the code around it: a `return`, a `throw`, or a block that ends in one. */
export function exits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (!ts.isBlock(statement)) return false;
  const last = statement.statements[statement.statements.length - 1];
  return last !== undefined && exits(last);
}

/** The last name of a callee: `map` for `ids.map`, `load` for `load`. */
function lastName(callee: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

function isIterationStatement(node: ts.Node): node is ts.IterationStatement {
  return STATEMENT_LOOPS[node.kind] !== undefined;
}

export function isFunctionWithBody(node: ts.Node): node is FunctionLike {
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
function loopingMethod(checker: ts.TypeChecker, call: ts.CallLikeExpression, resolution: Resolution): Scope | undefined {
  if (resolution.kind !== "lib" || !LOOPING.test(resolution.name) || !ts.isCallExpression(call)) return undefined;
  if (ts.isPropertyAccessExpression(call.expression)) {
    const list = call.expression.expression;
    if (isWrittenList(checker, list) || isChunkList(list)) return undefined;
  }
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : resolution.name;
  return { node: call, label: `${name}()` };
}

/**
 * Whether a loop statement walks items of the data, rather than retrying, going over what the code writes, or going
 * over the data a chunk at a time, as `for (const batch of chunk(ids, 100))` and `i += BATCH_SIZE` do.
 */
function walksItems(checker: ts.TypeChecker, loop: ts.IterationStatement): boolean {
  if (ts.isForOfStatement(loop)) {
    const chunks = isChunkList(loop.expression) || mentions(loop.initializer, isChunkName);
    return !isWrittenList(checker, loop.expression) && !chunks;
  }
  if (!ts.isForStatement(loop)) return true;
  const condition = loop.condition;
  if (condition === undefined) return false;
  const step = loop.incrementor;
  const byChunk =
    (loop.initializer !== undefined && mentions(loop.initializer, isChunkName)) ||
    (step !== undefined && ts.isBinaryExpression(step) && step.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && mentions(step.right, isChunkName));
  const limited = conjuncts(condition).some(
    (part) =>
      ts.isBinaryExpression(part) &&
      COMPARISONS.has(part.operatorToken.kind) &&
      [part.left, part.right].some((side) => isWrittenNumber(checker, side) || isRetryLimit(side)),
  );
  return !byChunk && !limited;
}

/** The parts a condition needs all of: `a`, `b` and `c` for `a && (b && c)`. */
function conjuncts(condition: ts.Expression): ts.Expression[] {
  const inner = withoutWrappers(condition);
  return ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ? [...conjuncts(inner.left), ...conjuncts(inner.right)]
    : [inner];
}

/**
 * Whether a list holds parts of the data rather than its items: one named for them, as `batches` is, or made by a
 * function named for chunking, as `chunk(ids, 100)` is, and its `entries()`.
 */
function isChunkList(expression: ts.Expression): boolean {
  const list = withoutWrappers(expression);
  if (ts.isCallExpression(list)) {
    const callee = list.expression;
    if (ts.isPropertyAccessExpression(callee) && ["entries", "values", "keys"].includes(callee.name.text)) return isChunkList(callee.expression);
    return isChunkName(lastName(callee) ?? "");
  }
  const name = ts.isIdentifier(list) ? list.text : ts.isPropertyAccessExpression(list) ? list.name.text : "";
  return wordsOf(name).some((word) => CHUNKS_WORDS.has(word));
}

/** The words a limit of attempts or passes goes by, as `maxAttempts`, `MAX_RETRIES` and `MAX_ROUNDS` do. */
const RETRY_WORDS = new Set(["attempt", "attempts", "retry", "retries", "tries", "pass", "passes", "round", "rounds"]);

function isRetryLimit(expression: ts.Expression): boolean {
  const limit = withoutWrappers(expression);
  const name = ts.isIdentifier(limit) ? limit.text : ts.isPropertyAccessExpression(limit) ? limit.name.text : "";
  return wordsOf(name).some((word) => RETRY_WORDS.has(word));
}

const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** A number written in the code, directly or in a `const`, as `5` and `MAX_ATTEMPTS = 5` are. */
function isWrittenNumber(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const value = withoutWrappers(expression);
  return ts.isNumericLiteral(value) || (ts.isIdentifier(value) && ts.isNumericLiteral(constantOf(checker, value) ?? value));
}

/**
 * A list whose items are all written in the code, as `[owner, admin]` is, directly or in a `const`: a loop over it
 * runs as many times whatever the data. A spread, as `[owner, ...ids]` has, adds items from the data.
 */
function isWrittenList(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const outer = withoutWrappers(expression);
  const list = ts.isIdentifier(outer) ? constantOf(checker, outer) : outer;
  return list !== undefined && ts.isArrayLiteralExpression(list) && !list.elements.some(ts.isSpreadElement);
}

/** The value a `const` is declared with, here or in the module it's imported from, without parentheses or type assertions. */
function constantOf(checker: ts.TypeChecker, name: ts.Identifier): ts.Expression | undefined {
  let symbol = checker.getSymbolAtLocation(name);
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined;
  const constant = ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  return constant ? withoutWrappers(declaration.initializer) : undefined;
}

/** An expression without the parentheses and type assertions around it: `[a, b]` for `([a, b] as const)`. */
function withoutWrappers(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
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
