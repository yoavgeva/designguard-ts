import ts from "typescript";
import type { Adapter, LifecycleSpec, ResourceSpec } from "./adapter.js";
import { callee } from "./names.js";
import { glob } from "./patterns.js";
import { type FunctionLike, packageOf, qualifiedName, type Resolution, resolveCall } from "./resolve.js";

/**
 * Something a part of the page starts while it's on the page that the methods running when it leaves never stop: at
 * the call in the part's method that starts it, directly or through the project functions in `through`.
 */
export interface Leak {
  readonly node: ts.Node;
  /** The part's method it's in, or nothing for a class field's initializer. */
  readonly method: FunctionLike | undefined;
  readonly through: readonly Step[];
  readonly started: ts.Node;
  readonly label: string;
  readonly stops: readonly string[];
  readonly part: string;
}

/** A call into a project function on the way to a start. */
export interface Step {
  readonly call: ts.CallExpression | ts.NewExpression;
  readonly target: FunctionLike;
}

interface Matcher {
  readonly packages: readonly string[];
  readonly pattern: RegExp;
}

interface Resource {
  readonly spec: ResourceSpec;
  readonly starts: Matcher;
  readonly stops: Matcher;
}

interface Lifecycle {
  readonly spec: LifecycleSpec;
  readonly type: Matcher;
  readonly stops: RegExp;
}

interface Context {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly claims: (fileName: string) => string | undefined;
  readonly resources: readonly Resource[];
  readonly lifecycles: readonly Lifecycle[];
}

/** A part found in a file: its lifecycle, its methods by name, and a class's field initializers, which run when it's made. */
interface Part {
  readonly lifecycle: Lifecycle;
  readonly methods: ReadonlyMap<string, FunctionLike>;
  readonly fields: readonly ts.Expression[];
}

/**
 * Where code runs, for telling what a name holds: the part, and the arguments the call into a project function passed
 * its parameters, back to the part's method.
 */
interface Frame {
  readonly part: Part;
  readonly arguments: ReadonlyMap<ts.ParameterDeclaration, ts.Expression>;
  readonly caller: Frame | undefined;
}

// How far a start or a stop is followed through the project's functions, and how far a name back to what it holds.
const DEPTH = 4;
// What gives an element inside another: what's inside an element goes with it.
const INSIDE = new Set(["querySelector", "querySelectorAll", "getElementsByClassName", "getElementsByTagName", "item"]);
const CHILDREN = new Set(["children", "firstElementChild", "lastElementChild", "firstChild", "lastChild", "shadowRoot", "content"]);
// What makes an element no one else holds yet.
const CREATED = /^(?:Document\.createElement(?:NS)?|Image|Audio|Option)$/;
const ABORT = /^AbortController\.abort$/;

/** The leaks in a file, by the resources and lifecycles of the adapters that are on. */
export function lifecycleLeaks(
  program: ts.Program,
  adapters: readonly Adapter[],
  claims: (fileName: string) => string | undefined,
): (file: ts.SourceFile) => Leak[] {
  const matcher = (adapter: Adapter, on: string): Matcher => ({ packages: adapter.packages, pattern: glob(on) });
  const context: Context = {
    program,
    checker: program.getTypeChecker(),
    claims,
    resources: adapters.flatMap((adapter) =>
      (adapter.resources ?? []).map((spec) => ({ spec, starts: matcher(adapter, spec.starts), stops: matcher(adapter, spec.stops) })),
    ),
    lifecycles: adapters.flatMap((adapter) =>
      (adapter.lifecycles ?? []).map((spec) => ({ spec, type: matcher(adapter, spec.type), stops: glob(spec.stops) })),
    ),
  };
  if (context.resources.length === 0 || context.lifecycles.length === 0) return () => [];
  return (file) => partsOf(context, file).flatMap((part) => leaksOf(context, part));
}

function partsOf(context: Context, file: ts.SourceFile): Part[] {
  const parts: Part[] = [];
  const visit = (node: ts.Node): void => {
    const lifecycle = ts.isObjectLiteralExpression(node)
      ? objectLifecycle(context, node)
      : ts.isClassLike(node)
        ? classLifecycle(context, node)
        : undefined;
    if (lifecycle !== undefined) {
      const holder = node as ts.ObjectLiteralExpression | ts.ClassLikeDeclaration;
      parts.push({ lifecycle, methods: methodsOf(holder), fields: fieldsOf(holder) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return parts;
}

/** The lifecycle of an object literal given a part's type, as `const hook: Hook = {...}` or a `hooks` option's value. */
function objectLifecycle(context: Context, node: ts.ObjectLiteralExpression): Lifecycle | undefined {
  const type = context.checker.getContextualType(node);
  return type === undefined ? undefined : context.lifecycles.find((lifecycle) => typeIs(context, type, lifecycle.type, new Set()));
}

/** The lifecycle of a class that extends or implements a part's type. */
function classLifecycle(context: Context, node: ts.ClassLikeDeclaration): Lifecycle | undefined {
  const heritage = (node.heritageClauses ?? []).flatMap((clause) => clause.types);
  return context.lifecycles.find((lifecycle) =>
    heritage.some((type) => typeIs(context, context.checker.getTypeAtLocation(type), lifecycle.type, new Set())),
  );
}

/** Whether a type is the one `matcher` names, or extends it: through unions, intersections and base types. */
function typeIs(context: Context, type: ts.Type, matcher: Matcher, seen: Set<ts.Type>): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) return type.types.some((member) => typeIs(context, member, matcher, seen));
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol !== undefined && symbolIs(context, symbol, matcher)) return true;
  // A generic class or interface, as ViewHook<E>, is a reference to its declared type.
  const target = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? (type as ts.TypeReference).target : type;
  if (!target.isClassOrInterface()) return false;
  return context.checker.getBaseTypes(target).some((base) => typeIs(context, base, matcher, seen));
}

function symbolIs(context: Context, symbol: ts.Symbol, matcher: Matcher): boolean {
  const declaration = symbol.declarations?.[0];
  if (declaration === undefined) return false;
  const file = declaration.getSourceFile();
  const package_ = context.program.isSourceFileDefaultLibrary(file)
    ? "typescript"
    : (context.claims(file.fileName) ?? packageOf(file.fileName));
  return matcher.packages.includes(package_) && matcher.pattern.test(qualifiedName(context.checker, declaration));
}

function methodsOf(node: ts.ObjectLiteralExpression | ts.ClassLikeDeclaration): Map<string, FunctionLike> {
  const methods = new Map<string, FunctionLike>();
  const members: readonly (ts.ObjectLiteralElementLike | ts.ClassElement)[] = ts.isObjectLiteralExpression(node) ? node.properties : node.members;
  for (const member of members) {
    const name = member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : undefined;
    const function_ = functionOf(member);
    if (name !== undefined && function_ !== undefined) methods.set(name, function_);
  }
  return methods;
}

/** A class's field initializers that aren't functions, and its constructor's body: code that runs when it's made. */
function fieldsOf(node: ts.ObjectLiteralExpression | ts.ClassLikeDeclaration): ts.Expression[] {
  if (ts.isObjectLiteralExpression(node)) return [];
  return node.members.flatMap((member) => {
    if (ts.isConstructorDeclaration(member) && member.body !== undefined) return member.body.statements.flatMap(expressionsOf);
    if (!ts.isPropertyDeclaration(member) || member.initializer === undefined) return [];
    const value = member.initializer;
    return ts.isFunctionExpression(value) || ts.isArrowFunction(value) ? [] : [value];
  });
}

function expressionsOf(statement: ts.Statement): ts.Expression[] {
  return ts.isExpressionStatement(statement) ? [statement.expression] : [];
}

function functionOf(member: ts.ObjectLiteralElementLike | ts.ClassElement): FunctionLike | undefined {
  if (ts.isMethodDeclaration(member)) return member.body === undefined ? undefined : (member as FunctionLike);
  const value = ts.isPropertyAssignment(member) || ts.isPropertyDeclaration(member) ? member.initializer : undefined;
  return value !== undefined && (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) ? value : undefined;
}

/** The methods that run when the part leaves, and the part's methods they call through `this`. */
function stopMethods(part: Part): Set<string> {
  const found = new Set<string>();
  const queue = [...part.methods.keys()].filter((name) => part.lifecycle.stops.test(name));
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const method = part.methods.get(name);
    if (found.has(name) || method === undefined) continue;
    found.add(name);
    forEachCall(method.body, (call) => {
      const called = thisCall(call);
      if (called !== undefined && part.methods.has(called)) queue.push(called);
    });
  }
  return found;
}

function leaksOf(context: Context, part: Part): Leak[] {
  const stopping = stopMethods(part);
  const stops = [...stopping].flatMap((name) => stopCalls(context, part.methods.get(name)));
  const leaks: Leak[] = [];
  const sources: [FunctionLike | undefined, ts.Node][] = [
    ...[...part.methods].filter(([name]) => !stopping.has(name)).map(([, method]): [FunctionLike, ts.Node] => [method, method.body]),
    ...part.fields.map((field): [undefined, ts.Node] => [undefined, field]),
  ];
  for (const [method, code] of sources) {
    const frame: Frame = { part, arguments: new Map(), caller: undefined };
    for (const found of startsIn(context, code, frame, [])) {
      if (stopped(context, found.resource, found.call, stops)) continue;
      leaks.push({
        node: found.through[0]?.call ?? found.call,
        method,
        through: found.through,
        started: found.call,
        label: labelOf(found.resource.spec, found.call),
        stops: stopNames(part),
        part: part.lifecycle.spec.part,
      });
    }
  }
  return leaks;
}

interface Start {
  readonly call: ts.CallExpression | ts.NewExpression;
  readonly resource: Resource;
  readonly through: readonly Step[];
}

/** The part's methods that run when it leaves, or, when it has none, the pattern that names them. */
function stopNames(part: Part): string[] {
  const names = [...part.methods.keys()].filter((name) => part.lifecycle.stops.test(name));
  return names.length > 0 ? names : [part.lifecycle.spec.stops];
}

/** What a function starts, directly or through the project functions it calls, other than the part's own methods. */
function startsIn(context: Context, code: ts.Node, frame: Frame, through: readonly Step[]): Start[] {
  const starts: Start[] = [];
  forEachCall(code, (call) => {
    if (thisCall(call) !== undefined && frame.caller === undefined) return;
    const resolution = resolveCall(context.program, context.checker, call, context.claims);
    const resource = matching(context, resolution, (candidate) => candidate.starts);
    if (resource !== undefined) {
      if (!(resource.spec.onTarget === true && onOwnElement(context, call, frame))) starts.push({ call, resource, through });
      return;
    }
    if (resolution.kind !== "project" || through.length >= DEPTH) return;
    for (const target of resolution.targets) {
      starts.push(...startsIn(context, target.body, { part: frame.part, arguments: bound(target, call), caller: frame }, [...through, { call, target }]));
    }
  });
  return starts;
}

/** The calls that stop things, in a stop method and the project functions it calls. */
function stopCalls(context: Context, function_: FunctionLike | undefined, depth = 0): ts.CallExpression[] {
  if (function_ === undefined || depth > DEPTH) return [];
  const calls: ts.CallExpression[] = [];
  forEachCall(function_.body, (call) => {
    if (!ts.isCallExpression(call)) return;
    const resolution = resolveCall(context.program, context.checker, call, context.claims);
    if (resolution.kind === "project") for (const target of resolution.targets) calls.push(...stopCalls(context, target, depth + 1));
    else calls.push(call);
  });
  return calls;
}

function stopped(context: Context, resource: Resource, start: ts.CallExpression | ts.NewExpression, stops: readonly ts.CallExpression[]): boolean {
  const signal = resource.spec.signal === undefined ? undefined : start.arguments?.[resource.spec.signal];
  if (signal !== undefined && hasSignal(signal)) {
    return stops.some((stop) => ABORT.test(nameOf(resolveCall(context.program, context.checker, stop, context.claims)) ?? ""));
  }
  const key = keyOf(resource.spec, start);
  return stops.some((stop) => {
    const resolution = resolveCall(context.program, context.checker, stop, context.claims);
    if (matching(context, resolution, (candidate) => candidate.stops) !== resource) return false;
    const stopKey = keyOf(resource.spec, stop);
    return key === undefined || stopKey === undefined || key === stopKey;
  });
}

function hasSignal(options: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(options) && options.properties.some((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === "signal");
}

function keyOf(spec: ResourceSpec, call: ts.CallExpression | ts.NewExpression): string | undefined {
  const argument = spec.key === undefined ? undefined : call.arguments?.[spec.key];
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function matching(context: Context, resolution: Resolution, side: (resource: Resource) => Matcher): Resource | undefined {
  const target = packaged(resolution);
  if (target === undefined) return undefined;
  return context.resources.find((resource) => {
    const matcher = side(resource);
    return matcher.packages.includes(target.package) && matcher.pattern.test(target.name);
  });
}

function packaged(resolution: Resolution): { package: string; name: string } | undefined {
  if (resolution.kind === "lib") return { package: "typescript", name: resolution.name };
  if (resolution.kind === "dependency") return { package: resolution.package, name: resolution.name };
  return undefined;
}

function nameOf(resolution: Resolution): string | undefined {
  return packaged(resolution)?.name;
}

/** Whether a listener is started on the part's own element or an element inside it, which goes with the part. */
function onOwnElement(context: Context, call: ts.CallExpression | ts.NewExpression, frame: Frame): boolean {
  const target = ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined;
  return target !== undefined && owned(context, target, frame, 0);
}

/** Whether an expression is the part's element, an element inside it, or an element the code just made. */
function owned(context: Context, node: ts.Expression, frame: Frame, depth: number): boolean {
  if (depth > DEPTH) return false;
  const inner = skipOuter(node);
  if (isElementOf(inner, frame.part.lifecycle.spec.element ?? [])) return true;
  if (ts.isPropertyAccessExpression(inner)) return CHILDREN.has(inner.name.text) && owned(context, inner.expression, frame, depth);
  if (ts.isElementAccessExpression(inner)) return owned(context, inner.expression, frame, depth);
  if (ts.isCallExpression(inner) || ts.isNewExpression(inner)) return ownedCall(context, inner, frame, depth);
  return ts.isIdentifier(inner) && ownedName(context, inner, frame, depth);
}

function skipOuter(node: ts.Expression): ts.Expression {
  let inner = node;
  while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner) || ts.isAsExpression(inner)) inner = inner.expression;
  return inner;
}

/** `this` followed by the element's path, as `this.el`. */
function isElementOf(node: ts.Expression, path: readonly string[]): boolean {
  let current = node;
  for (const name of [...path].reverse()) {
    if (!ts.isPropertyAccessExpression(current) || current.name.text !== name) return false;
    current = skipOuter(current.expression);
  }
  return current.kind === ts.SyntaxKind.ThisKeyword;
}

function ownedCall(context: Context, call: ts.CallExpression | ts.NewExpression, frame: Frame, depth: number): boolean {
  const name = nameOf(resolveCall(context.program, context.checker, call, context.claims));
  if (name !== undefined && CREATED.test(name)) return true;
  const method = ts.isPropertyAccessExpression(call.expression) ? call.expression : undefined;
  return method !== undefined && INSIDE.has(method.name.text) && owned(context, method.expression, frame, depth);
}

/** What a name holds: a variable's value, the element a loop over owned elements gives, or what a parameter was passed. */
function ownedName(context: Context, name: ts.Identifier, frame: Frame, depth: number): boolean {
  const declaration = context.checker.getSymbolAtLocation(name)?.valueDeclaration;
  if (declaration === undefined) return false;
  if (ts.isVariableDeclaration(declaration)) return ownedVariable(context, declaration, frame, depth);
  if (ts.isParameter(declaration)) return ownedParameter(context, declaration, frame, depth);
  return false;
}

function ownedVariable(context: Context, declaration: ts.VariableDeclaration, frame: Frame, depth: number): boolean {
  if (declaration.initializer !== undefined) return owned(context, declaration.initializer, frame, depth + 1);
  const loop = declaration.parent.parent;
  return ts.isForOfStatement(loop) && owned(context, loop.expression, frame, depth + 1);
}

function ownedParameter(context: Context, parameter: ts.ParameterDeclaration, frame: Frame, depth: number): boolean {
  for (let current: Frame | undefined = frame; current !== undefined; current = current.caller) {
    const argument = current.arguments.get(parameter);
    if (argument !== undefined) return owned(context, argument, current.caller ?? current, depth + 1);
  }
  const function_ = parameter.parent;
  // The element a callback over owned elements is given, as `this.el.querySelectorAll("a").forEach((a) => ...)`.
  const call = function_.parent;
  if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "forEach" && call.arguments[0] === function_) {
    return function_.parameters[0] === parameter && owned(context, call.expression.expression, frame, depth + 1);
  }
  return ownedThroughThisCalls(context, parameter, frame, depth);
}

/** A parameter of the part's method that every `this.method(...)` call in the part passes an owned element. */
function ownedThroughThisCalls(context: Context, parameter: ts.ParameterDeclaration, frame: Frame, depth: number): boolean {
  const method = [...frame.part.methods].find(([, function_]) => function_ === parameter.parent)?.[0];
  const index = parameter.parent.parameters.indexOf(parameter);
  if (method === undefined) return false;
  const passed: ts.Expression[] = [];
  for (const function_ of frame.part.methods.values()) {
    forEachCall(function_.body, (call) => {
      const argument = thisCall(call) === method ? call.arguments?.[index] : undefined;
      if (argument !== undefined) passed.push(argument);
    });
  }
  return passed.length > 0 && passed.every((argument) => owned(context, argument, frame, depth + 1));
}

function bound(target: FunctionLike, call: ts.CallExpression | ts.NewExpression): Map<ts.ParameterDeclaration, ts.Expression> {
  const bindings = new Map<ts.ParameterDeclaration, ts.Expression>();
  target.parameters.forEach((parameter, index) => {
    const argument = call.arguments?.[index];
    if (argument !== undefined) bindings.set(parameter, argument);
  });
  return bindings;
}

/** The name of the part's method a call makes through `this`, as `this.setup()`. */
function thisCall(call: ts.CallExpression | ts.NewExpression): string | undefined {
  const expression = call.expression;
  return ts.isCallExpression(call) && ts.isPropertyAccessExpression(expression) && expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ? expression.name.text
    : undefined;
}

function forEachCall(code: ts.Node, visit: (call: ts.CallExpression | ts.NewExpression) => void): void {
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) visit(node);
    ts.forEachChild(node, walk);
  };
  walk(code);
}

/** What a start makes, for messages: `a "resize" listener`, `an observer`. */
function labelOf(spec: ResourceSpec, call: ts.CallExpression | ts.NewExpression): string {
  const key = keyOf(spec, call);
  const what = key === undefined ? spec.what : `"${key}" ${spec.what}`;
  const started = ts.isNewExpression(call) ? `new ${call.expression.getText()}()` : `${callee(call.expression)}()`;
  return `${/^[aeiou]/i.test(what) ? "an" : "a"} ${what} with ${started}`;
}
