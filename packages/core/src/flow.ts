import ts from "typescript";
import type { ParameterSpec } from "./adapter.js";
import { glob } from "./patterns.js";
import type { FunctionLike } from "./resolve.js";
import { isUserName } from "./words.js";

/** What a value in a function holds, as its parameters' specs tell. */
export type Holding = "input" | "context" | "user";

/**
 * What a function's values hold: the request's input, a context the user asking can be read from, or the user asking,
 * by where they come from in its parameters, followed through properties, destructuring and the variables that keep
 * them. Values made from input, as `Number(req.params.id)` is, are input too.
 */
export interface Flow {
  /** Whether the function reads the user asking: takes them, or reads them from a context. */
  readonly readsUser: boolean;
  /** Whether a call gives the user asking, or a context holding them, to the code it calls. */
  carriesUser(call: ts.CallLikeExpression): boolean;
  /** Whether an expression holds what the request sent, or a value made from it. */
  fromInput(node: ts.Node): boolean;
  /** Whether an expression is a whole object the request sent, as `input` and `{ ...input }` are, not `input.id`. */
  wholeInput(node: ts.Expression): boolean;
  /** The positions of a call's arguments that hold what the request sent. */
  inputArguments(call: ts.CallLikeExpression): number[];
}

/** Where a value comes from: a parameter, and the way into it, as `["params", "id"]` for `req.params.id`. */
interface Origin {
  readonly parameter: number;
  readonly path: readonly string[];
}

type Value = Origin | { readonly derived: "input" };

export function flowOf(
  checker: ts.TypeChecker,
  function_: FunctionLike,
  specs: readonly ParameterSpec[],
  decoratorsOf: (parameter: number) => readonly string[] = () => [],
): Flow {
  const values = new Map<ts.Symbol, Value>();
  const seedsOf = (parameter: number): ParameterSpec[] =>
    specs.filter((spec) =>
      spec.decorator !== undefined
        ? decoratorsOf(parameter).some((name) => glob(spec.decorator ?? "").test(name))
        : spec.at === undefined || spec.at === parameter,
    );

  /** What a way into a parameter holds, by the longest spec path it starts with, or "wrapper" while it may lead to one. */
  const classify = (origin: Origin): Holding | "beneath" | "wrapper" | undefined => {
    let best: { spec: ParameterSpec; length: number } | undefined;
    let leads = false;
    for (const spec of seedsOf(origin.parameter)) {
      const path = spec.path ?? [];
      const shared = Math.min(path.length, origin.path.length);
      let matched = true;
      for (let i = 0; i < shared; i++) if (!glob(path[i] ?? "").test(origin.path[i] ?? "")) matched = false;
      if (!matched) continue;
      if (path.length > origin.path.length) leads = true;
      else if (best === undefined || path.length > best.length) best = { spec, length: path.length };
    }
    if (best === undefined) return leads ? "wrapper" : undefined;
    if (best.spec.holds !== "context") return best.spec.holds;
    const rest = origin.path.slice(best.length);
    if (rest.length === 0) return "context";
    return rest.some((segment) => isUserName(segment.replace(/\(\)$/, ""))) ? "user" : "beneath";
  };

  const holdingOf = (value: Value | undefined): Holding | "beneath" | "wrapper" | undefined =>
    value === undefined ? undefined : "derived" in value ? value.derived : classify(value);

  /** The value an expression is, when it's a parameter, a variable holding one, or a way into either. */
  const valueOf = (node: ts.Expression): Value | undefined => {
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) {
      const parent = expression.parent;
      const symbol =
        ts.isShorthandPropertyAssignment(parent) && parent.name === expression
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(expression);
      return symbol === undefined ? undefined : values.get(symbol);
    }
    const step = stepOf(expression);
    if (step !== undefined) {
      const base = valueOf(step.base);
      if (base === undefined || "derived" in base) return base;
      return { parameter: base.parameter, path: [...base.path, step.name] };
    }
    return undefined;
  };

  const seen = { user: false };
  const note = (value: Value | undefined): void => {
    if (holdingOf(value) === "user") seen.user = true;
  };

  const fromInput = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) return;
      if (ts.isExpression(child) && holdingOf(valueOf(child)) === "input") {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };

  const bind = (name: ts.BindingName, value: Value | undefined, initializer: ts.Expression | undefined): void => {
    if (ts.isIdentifier(name)) {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol === undefined) return;
      const kept = value ?? (initializer !== undefined && fromInput(initializer) ? { derived: "input" as const } : undefined);
      if (kept !== undefined) {
        values.set(symbol, kept);
        note(kept);
      }
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (element.dotDotDotToken !== undefined) {
          bind(element.name, value, undefined);
          continue;
        }
        const property = element.propertyName ?? element.name;
        const key = ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined;
        if (key === undefined || value === undefined) continue;
        bind(element.name, "derived" in value ? value : { parameter: value.parameter, path: [...value.path, key] }, undefined);
      }
    }
  };

  function_.parameters.forEach((parameter, index) => {
    const origin = { parameter: index, path: [] };
    if (classify(origin) !== undefined) bind(parameter.name, origin, undefined);
  });

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer !== undefined) visit(node.initializer);
      bind(node.name, node.initializer === undefined ? undefined : valueOf(node.initializer), node.initializer);
      return;
    }
    if (ts.isExpression(node) && stepOf(node) !== undefined) note(valueOf(node));
    ts.forEachChild(node, visit);
  };
  visit(function_.body);

  /** Whether a way into a parameter leads to a context or the user asking, as tRPC's `opts` leads to `opts.ctx`. */
  const leadsToUser = (origin: Origin): boolean =>
    seedsOf(origin.parameter).some(
      (spec) =>
        spec.holds !== "input" &&
        (spec.path ?? []).length > origin.path.length &&
        origin.path.every((segment, i) => glob(spec.path?.[i] ?? "").test(segment)),
    );

  const carries = (argument: ts.Expression): boolean => {
    const value = valueOf(argument);
    const holding = holdingOf(value);
    if (holding === "context" || holding === "user") return true;
    if (holding === "wrapper" && value !== undefined && !("derived" in value) && leadsToUser(value)) return true;
    const literal = unwrap(argument);
    return (
      ts.isObjectLiteralExpression(literal) &&
      literal.properties.some((property) =>
        ts.isShorthandPropertyAssignment(property)
          ? carries(property.name)
          : ts.isPropertyAssignment(property)
            ? carries(property.initializer)
            : ts.isSpreadAssignment(property) && carries(property.expression),
      )
    );
  };

  const wholeInput = (node: ts.Expression): boolean => {
    const expression = unwrap(node);
    const value = valueOf(expression);
    if (value !== undefined && !("derived" in value) && classify(value) === "input") return true;
    return ts.isObjectLiteralExpression(expression) && expression.properties.some((property) => ts.isSpreadAssignment(property) && wholeInput(property.expression));
  };

  return {
    readsUser: seen.user,
    carriesUser: (call) => argumentsOf(call).some(carries),
    fromInput,
    wholeInput,
    inputArguments: (call) => argumentsOf(call).flatMap((argument, index) => (fromInput(argument) ? [index] : [])),
  };
}

/** A step into a value: a property, `x["name"]`, a method's result, `x.json()`, or a context's `get("user")`. */
function stepOf(node: ts.Expression): { base: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { base: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return { base: node.expression, name: node.argumentExpression.text };
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const key = node.arguments[0];
    if (node.expression.name.text === "get" && node.arguments.length === 1 && key !== undefined && ts.isStringLiteralLike(key)) {
      return { base: node.expression.expression, name: key.text };
    }
    return { base: node.expression.expression, name: `${node.expression.name.text}()` };
  }
  return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  let expression = node;
  for (;;) {
    if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) expression = expression.expression;
    else if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
    else return expression;
  }
}

function argumentsOf(call: ts.CallLikeExpression): readonly ts.Expression[] {
  return ts.isCallExpression(call) || ts.isNewExpression(call) ? (call.arguments ?? []) : [];
}
