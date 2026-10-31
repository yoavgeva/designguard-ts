import ts from "typescript";
import { type FunctionLike, type Resolution, resolveCall } from "./resolve.js";

/** A loop a call runs in: a loop statement, or the callback of an array method such as `map()`. */
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
  [ts.SyntaxKind.WhileStatement]: "the while loop",
  [ts.SyntaxKind.DoStatement]: "the do…while loop",
};

/** The summaries of every function in one of the project's files, the file's top-level code as one more. */
export function summarize(program: ts.Program, checker: ts.TypeChecker, file: ts.SourceFile): FunctionSummary[] {
  const summaries: FunctionSummary[] = [];

  const walk = (owner: FunctionLike | ts.SourceFile): void => {
    const calls: CallSite[] = [];
    summaries.push({ node: owner, calls });
    const visit = (node: ts.Node, loop: Loop | undefined): void => {
      if (node !== owner && isFunctionWithBody(node) && !isInlineCallback(node)) {
        walk(node);
        return;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const resolution = resolveCall(program, checker, node);
        calls.push({ node, named: node.expression, resolution, loop });
        visit(node.expression, loop);
        const perItem = loopingMethod(node, resolution);
        for (const argument of node.arguments ?? []) {
          const passed = passedFunction(program, checker, argument);
          if (passed !== undefined) calls.push({ node: argument, named: argument, resolution: passed, loop: perItem ?? loop });
          visit(argument, perItem ?? loop);
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
    if (ts.isSourceFile(owner)) ts.forEachChild(owner, (child) => {
      visit(child, undefined);
    });
    else visit(owner.body, undefined);
  };

  walk(file);
  return summaries;
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
function passedFunction(program: ts.Program, checker: ts.TypeChecker, argument: ts.Expression): Resolution | undefined {
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
  if (file.isDeclarationFile || program.isSourceFileFromExternalLibrary(file)) return undefined;
  return { kind: "project", targets: [target] };
}
