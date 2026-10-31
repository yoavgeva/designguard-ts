import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import semver from "semver";
import ts from "typescript";
import type { Adapter, EffectKind, EntryPointSpec, ListSpec, WriteSpec } from "./adapter.js";
import { glob } from "./patterns.js";
import { type FunctionLike, isProjectSource, resolveCall } from "./resolve.js";
import { callee, oneLine } from "./names.js";
import { type EntryPoint, entriesOf, type EntrySpecs } from "./entries.js";
import { flowOf } from "./flow.js";
import { standards } from "./standards.js";
import { type CallSite, type FunctionSummary, nameOf, ownersOf, scopedCalls, summarizeFunction, type Transactions } from "./summaries.js";
import { isCheckName, isRequirementName, isUserCall } from "./words.js";

/** A function in the project, by its file's absolute path and its name, as `nameOf` gives it. */
export interface Place {
  readonly file: string;
  readonly symbol: string;
}

/** A step on a finding's way: a project function, or, last, a package's declaration by its qualified name. */
export type Reached = Place | { readonly package: string; readonly symbol: string };

/** A finding, at the node the rule reports, with the function it's in and the steps it leads through. */
export interface Finding {
  readonly node: ts.Node;
  readonly message: string;
  readonly at: Place;
  readonly reaching: readonly Reached[];
}

/** What the adapters make of a call into a package: its effect, the argument it runs in a transaction, or nothing. */
export interface Role {
  readonly node: ts.Node;
  /** The call as messages name it: `prisma.user.findMany`. */
  readonly callee: string;
  readonly package: string;
  /** The qualified name of the declaration it resolves to, which adapter patterns match. */
  readonly name: string;
  readonly effect?: EffectKind;
  /** The argument, counting from 1, that runs inside the transaction the call opens. */
  readonly transaction?: number;
  /** Why no adapter applies: the adapter for the package is off for the installed version. */
  readonly off?: string;
}

/** A request handler the adapters find: where it is, how messages name it, and what runs before it. */
export interface EntryPointRole {
  readonly node: ts.Node;
  readonly label: string;
  readonly reads: boolean;
  /** The names of the middleware that runs before it, "" for one written inline. */
  readonly middleware: readonly string[];
}

export interface Explanation {
  readonly at: string;
  readonly label: string;
  readonly reads: boolean;
  readonly writes: string | undefined;
  readonly looksUp: string | undefined;
  readonly passes: string | undefined;
}

export interface AnalysisOptions {
  readonly adapters: readonly Adapter[];
  /** The directory message paths are relative to: the tsconfig's, unless given. */
  readonly root?: string;
  /** Whether the platform's own effects (`fetch`, Node's modules) count. They do unless this is `false`. */
  readonly standards?: boolean;
}

/** How a function reaches an effect: the call in it that leads there, and the rest of the way from that call. */
interface Trace {
  readonly site: CallSite;
  readonly next: Trace | undefined;
}

/** How many of the project's calls resolve, and to what. */
export interface ResolutionStats {
  files: number;
  functions: number;
  calls: number;
  project: number;
  dependency: number;
  lib: number;
  unresolvedAny: number;
  unresolvedAbstract: number;
  /** Calls that open a transaction, as the adapters describe them. */
  transactions: number;
}

export interface Analysis {
  queriesInLoops(file: ts.SourceFile): Finding[];
  ioInTransactions(file: ts.SourceFile): Finding[];
  /** Request handlers that write with nothing reading the user asking or checking what they may do. */
  unauthorizedWrites(file: ts.SourceFile): Finding[];
  /** Request handlers that read a record by a key the request sends, with nothing reading the user asking. */
  unauthorizedReads(file: ts.SourceFile): Finding[];
  /** Request handlers that load every row of a table. */
  unboundedQueries(file: ts.SourceFile): Finding[];
  /** Request handlers that save what the request sends as it is, when it has a property the request shouldn't set. */
  massAssignments(file: ts.SourceFile): Finding[];
  unknownIo(file: ts.SourceFile): Finding[];
  /** What the adapters make of each call a file makes into a package, in the order the calls start. */
  roles(file: ts.SourceFile): Role[];
  /** The request handlers a file registers or declares, as the adapters find them. */
  entryPoints(file: ts.SourceFile): EntryPointRole[];
  /** For audits: each handler in a file, what it writes or looks up, and why the authorization rules pass it. */
  explain(file: ts.SourceFile): Explanation[];
  stats(): ResolutionStats;
}

const cache = new WeakMap<ts.Program, Map<string, Analysis>>();

/**
 * Summaries and loop calls, by the node they were made for and the adapters they were made with. typescript-eslint's
 * project service builds new programs as it opens files, and they share the source files that didn't change, so
 * each is read once.
 */
const summaryCache = new WeakMap<ts.Node, Map<string, FunctionSummary>>();
const scopedCache = new WeakMap<ts.SourceFile, Map<string, CallSite[]>>();
const entryCache = new WeakMap<ts.SourceFile, Map<string, EntryPoint[]>>();

function cached<K extends object, V>(store: WeakMap<K, Map<string, V>>, node: K, key: string, make: () => V): V {
  let byKey = store.get(node);
  if (byKey === undefined) {
    byKey = new Map();
    store.set(node, byKey);
  }
  let value = byKey.get(key);
  if (value === undefined) {
    value = make();
    byKey.set(key, value);
  }
  return value;
}

/** The analysis of a program with these options, built once and shared by every rule and file. */
export function analyze(program: ts.Program, options: AnalysisOptions): Analysis {
  const adapters = options.standards === false ? options.adapters : [standards, ...options.adapters];
  const root = options.root;
  const key = JSON.stringify(adapters);
  return cached(cache, program, `${key}\0${root ?? ""}`, () => build(program, adapters, key, root ?? projectRoot(program)));
}

type Owner = FunctionLike | ts.SourceFile;

/**
 * What a call does that rules ask about: its effects, giving the user asking, checking what they may do, or loading
 * every row of a table.
 */
type Kind = EffectKind | "user" | "check" | "all";

/**
 * The analysis reads code only as a question needs it: the loop calls of the file asked about, and the functions
 * those calls reach.
 */
function build(program: ts.Program, configured: readonly Adapter[], key: string, root: string): Analysis {
  const checker = program.getTypeChecker();
  const versionOf = installedVersions(program);
  const inactive = new Map<string, { adapter: Adapter; range: string }>();
  const adapters = configured.filter((adapter) => {
    if (adapter.versions === undefined) return true;
    const installed = adapter.packages.map((name) => versionOf(name)).find((version) => version !== undefined);
    // A package typed by @types has its types' version, whose major and minor follow the package's.
    const version = installed?.replace(/ \(types\)$/, "");
    if (version === undefined || semver.satisfies(version, adapter.versions, { includePrerelease: true })) return true;
    for (const name of adapter.packages) inactive.set(name, { adapter, range: adapter.versions });
    return false;
  });
  const covered = new Set(adapters.flatMap((adapter) => adapter.packages));
  const claims = claimsOf(adapters);
  const matchers = adapters.flatMap((adapter) =>
    (adapter.effects ?? []).map((effect) => ({ packages: adapter.packages, pattern: glob(effect.on), kind: effect.kind })),
  );
  const direct = (site: CallSite): EffectKind | undefined => {
    const target = packaged(site.resolution);
    return target === undefined ? undefined : matchers.find((matcher) => matcher.packages.includes(target.package) && matcher.pattern.test(target.name))?.kind;
  };
  const patternsOf = (field: "users" | "checks" | "lookups") =>
    adapters.flatMap((adapter) => (adapter[field] ?? []).map((on) => ({ packages: adapter.packages, pattern: glob(on) })));
  const userMatchers = patternsOf("users");
  const checkMatchers = patternsOf("checks");
  const lookupMatchers = patternsOf("lookups");
  const listMatchers = adapters.flatMap((adapter) =>
    (adapter.lists ?? []).map((spec) => ({ packages: adapter.packages, pattern: glob(spec.on), spec })),
  );
  const matching = (site: CallSite, list: readonly { packages: readonly string[]; pattern: RegExp }[]): boolean => {
    const target = packaged(site.resolution);
    return target !== undefined && list.some((matcher) => matcher.packages.includes(target.package) && matcher.pattern.test(target.name));
  };
  /** A call's own kinds: its effect, and whether it gives the user asking or checks permissions, by adapters or names. */
  const kindsOf = (site: CallSite): Kind[] => {
    const kinds: Kind[] = [];
    const effect = direct(site);
    if (effect !== undefined) kinds.push(effect);
    const name = site.node === site.named ? undefined : lastName(site.named);
    const count = ts.isCallExpression(site.node) || ts.isNewExpression(site.node) ? (site.node.arguments ?? []).length : 0;
    if (matching(site, userMatchers) || (name !== undefined && isUserCall(name, count))) kinds.push("user");
    if (matching(site, checkMatchers) || (name !== undefined && isCheckName(name))) kinds.push("check");
    const target = packaged(site.resolution);
    const list = target === undefined ? undefined : listMatchers.find((matcher) => matcher.packages.includes(target.package) && matcher.pattern.test(target.name));
    if (list !== undefined && ts.isCallExpression(site.node) && loadsEveryRow(site.node, list.spec)) kinds.push("all");
    return kinds;
  };
  const owners = new Map<EntryPointSpec, Adapter>();
  for (const adapter of adapters) for (const spec of adapter.entryPoints ?? []) owners.set(spec, adapter);
  const entrySpecs: EntrySpecs = {
    specs: [...owners.keys()],
    matches(spec, pattern, resolution) {
      const target = packaged(resolution);
      const adapter = owners.get(spec);
      return target !== undefined && adapter !== undefined && adapter.packages.includes(target.package) && glob(pattern).test(target.name);
    },
  };
  const transactionMatchers = adapters.flatMap((adapter) =>
    (adapter.transactions ?? []).map((spec) => ({ packages: adapter.packages, pattern: glob(spec.on), body: spec.body, on: spec.on })),
  );
  const transactionNames = transactionMatchers.map((matcher) => lastNamePattern(matcher.on));
  const transactions: Transactions = {
    bodyOf(resolution) {
      const target = packaged(resolution);
      if (target === undefined) return undefined;
      return transactionMatchers.find((matcher) => matcher.packages.includes(target.package) && matcher.pattern.test(target.name))?.body;
    },
    mightBe: (name) => transactionNames.some((pattern) => pattern.test(name)),
  };
  const summaryOf = (owner: Owner): FunctionSummary =>
    cached(summaryCache, owner, key, () => summarizeFunction(program, checker, owner, claims, transactions));
  const scoped = (file: ts.SourceFile): CallSite[] => cached(scopedCache, file, key, () => scopedCalls(program, checker, file, claims, transactions));
  const isProject = (file: ts.SourceFile): boolean =>
    isProjectSource(file) && claims(file.fileName) === undefined;

  /** Effects found for every function a finished question reached: complete, since that set holds all they call. */
  const final = new Map<Owner, Map<Kind, Trace>>();

  const effectsOf = (owner: Owner): Map<Kind, Trace> => {
    const known = final.get(owner);
    if (known !== undefined) return known;
    // The functions it reaches that no earlier question did, then their effects to a fixpoint over just those.
    const reached: Owner[] = [];
    const seen = new Set<Owner>();
    const pending: Owner[] = [owner];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (seen.has(next) || final.has(next)) continue;
      seen.add(next);
      reached.push(next);
      for (const site of summaryOf(next).calls) {
        if (site.resolution.kind !== "project") continue;
        for (const target of site.resolution.targets) {
          if (!seen.has(target) && !final.has(target) && isProject(target.getSourceFile())) pending.push(target);
        }
      }
    }
    const working = new Map<Owner, Map<Kind, Trace>>();
    for (const function_ of reached) {
      const own = new Map<Kind, Trace>();
      for (const site of summaryOf(function_).calls) {
        for (const kind of kindsOf(site)) if (!own.has(kind)) own.set(kind, { site, next: undefined });
      }
      working.set(function_, own);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const function_ of reached) {
        const own = working.get(function_);
        if (own === undefined) continue;
        for (const site of summaryOf(function_).calls) {
          if (site.resolution.kind !== "project") continue;
          for (const target of site.resolution.targets) {
            for (const [kind, trace] of working.get(target) ?? final.get(target) ?? []) {
              if (!own.has(kind)) {
                own.set(kind, { site, next: trace });
                changed = true;
              }
            }
          }
        }
      }
    }
    for (const [function_, effects] of working) final.set(function_, effects);
    return final.get(owner) ?? new Map<Kind, Trace>();
  };

  /** The effects a call has: its own, or those of the project functions it reaches, with the way there. */
  const effectsOfCall = (site: CallSite): Map<Kind, Trace> => {
    const found = new Map<Kind, Trace>();
    for (const kind of kindsOf(site)) found.set(kind, { site, next: undefined });
    if (site.resolution.kind === "project") {
      for (const target of site.resolution.targets) {
        if (!isProject(target.getSourceFile())) continue;
        for (const [kind, trace] of effectsOf(target)) {
          if (!found.has(kind)) found.set(kind, { site, next: trace });
        }
      }
    }
    return found;
  };

  const describe = (trace: Trace): string => {
    const first = `${callee(trace.site.named)}()`;
    let last = trace;
    while (last.next !== undefined) last = last.next;
    if (last === trace) return first;
    const file = last.site.node.getSourceFile();
    const line = file.getLineAndCharacterOfPosition(last.site.node.getStart()).line + 1;
    return `${first}, which reaches ${callee(last.site.named)}() (${relative(root, file.fileName)}:${String(line)})`;
  };

  const entries = (file: ts.SourceFile): EntryPoint[] =>
    cached(entryCache, file, key, () => entriesOf(program, checker, file, entrySpecs, claims));

  /**
   * Whether a handler acts for the user asking: it reads them, gives them or its context to what it calls, reaches
   * code that gets them or checks what they may do, or runs after middleware or under a decorator that checks.
   */
  const actsForUser = (entry: EntryPoint): boolean => whyActsForUser(entry) !== undefined;
  const whyActsForUser = (entry: EntryPoint): string | undefined => {
    const where = (node: ts.Node): string => {
      const file = node.getSourceFile();
      return `${relative(root, file.fileName)}:${String(file.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`;
    };
    const flow = flowOf(checker, entry.handler, entry.parameters, entry.decoratorsOf);
    if (flow.readsUser !== undefined) return `reads the user asking: ${oneLine(flow.readsUser.getText())} (${where(flow.readsUser)})`;
    if (flow.readsSecret !== undefined) return `checks a secret the request sends: ${oneLine(flow.readsSecret.getText())} (${where(flow.readsSecret)})`;
    for (const site of summaryOf(entry.handler).calls) {
      if ((ts.isCallExpression(site.node) || ts.isNewExpression(site.node)) && flow.carriesUser(site.node)) {
        return `gives the user asking or its context to ${callee(site.named)}() (${where(site.node)})`;
      }
      const user = effectsOfCall(site).get("user");
      if (user !== undefined) return `gets the user asking through ${describe(user)}`;
    }
    return whyChecked(entry);
  };

  /** Why a handler counts as checking permissions: what it reaches, its middleware or its decorators do. */
  const whyChecked = (entry: EntryPoint): string | undefined => {
    for (const site of summaryOf(entry.handler).calls) {
      const check = effectsOfCall(site).get("check");
      if (check !== undefined) return `checks permissions through ${describe(check)}`;
    }
    for (const middleware of entry.middleware) {
      if (isCheckName(middleware.name)) return `runs after ${middleware.name}`;
      const function_ = middleware.function;
      if (function_ === undefined) continue;
      if (isCheckName(nameOf(function_))) return `runs after ${nameOf(function_)}`;
      const check = effectsOf(function_).get("check");
      if (check !== undefined) return `runs after middleware that checks permissions through ${describe(check)}`;
    }
    for (const call of entry.decorators) {
      const name = lastName(call.expression);
      if (name !== undefined && isRequirementName(name)) return `has @${name}()`;
      const site: CallSite = { owner: entry.handler, node: call, named: call.expression, resolution: resolveCall(program, checker, call, claims), loop: undefined, transaction: undefined };
      const check = effectsOfCall(site).get("check");
      if (check !== undefined) return `has @${callee(call.expression)}(), which checks permissions through ${describe(check)}`;
    }
    return undefined;
  };

  /**
   * The way from a handler to what it does: from the call in it that leads there, or, for a handler written elsewhere,
   * from the argument that names it where it's registered.
   */
  const fromEntry = (entry: EntryPoint, trace: Trace): Trace =>
    entry.at === undefined ? trace : { site: { ...trace.site, node: entry.at as ts.Expression, named: entry.at as ts.Expression }, next: trace };

  /** A finding about a handler, reported where its way starts. */
  const findingFor = (entry: EntryPoint, trace: Trace, message: string): Finding => ({
    node: trace.site.node,
    message,
    at: placeOf(entry.handler),
    reaching: reachingOf(trace),
  });

  const ids = new Map<FunctionLike, number>();
  const idOf = (function_: FunctionLike): number => {
    let id = ids.get(function_);
    if (id === undefined) {
      id = ids.size;
      ids.set(function_, id);
    }
    return id;
  };

  /**
   * The first lookup a function makes by a key from the input `flow` tells of, itself or through the project functions
   * it gives that input to. `key` names the function and its input, for the cache.
   */
  const lookups = new Map<string, Trace | null>();
  const lookupBy = (function_: FunctionLike, flow: ReturnType<typeof flowOf>, key: string): Trace | undefined => {
    const known = lookups.get(key);
    if (known !== undefined) return known ?? undefined;
    lookups.set(key, null);
    let found: Trace | undefined;
    for (const site of summaryOf(function_).calls) {
      if (!(ts.isCallExpression(site.node) || ts.isNewExpression(site.node))) continue;
      if (matching(site, lookupMatchers) && flow.fromInput(site.node)) found = { site, next: undefined };
      else if (site.resolution.kind === "project") {
        const inputs = flow.inputArguments(site.node);
        if (inputs.length === 0) continue;
        for (const target of site.resolution.targets) {
          if (!isProject(target.getSourceFile())) continue;
          const inner = flowOf(checker, target, inputs.map((at) => ({ at, holds: "input" as const })));
          const next = lookupBy(target, inner, `${String(idOf(target))}:${inputs.join(",")}`);
          if (next !== undefined) {
            found = { site, next };
            break;
          }
        }
      }
      if (found !== undefined) break;
    }
    lookups.set(key, found ?? null);
    return found;
  };
  const writeMatchers = adapters.flatMap((adapter) =>
    (adapter.writes ?? []).map((spec) => ({ packages: adapter.packages, pattern: glob(spec.on), spec })),
  );

  /** The properties of what a write saves that the request sends and shouldn't set, as `role`. */
  const settable = (data: ts.Expression, flow: ReturnType<typeof flowOf>): string[] => {
    const expression = unwrapped(data);
    const from = new Map<string, "input" | "code">();
    const propertiesOf = (node: ts.Expression): string[] => {
      const parent = node.parent;
      const symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === node ? checker.getShorthandAssignmentValueSymbol(parent) : undefined;
      const type = symbol === undefined ? checker.getTypeAtLocation(node) : checker.getTypeOfSymbolAtLocation(symbol, node);
      return type.getApparentProperties().map((property) => property.getName());
    };
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          if (flow.wholeInput(property.expression)) for (const name of propertiesOf(property.expression)) from.set(name, "input");
        } else if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
          from.set(property.name.text, "code");
        }
      }
    } else if (flow.wholeInput(expression)) for (const name of propertiesOf(data)) from.set(name, "input");
    return [...from].filter(([name, source]) => source === "input" && PRIVILEGED.has(name)).map(([name]) => name);
  };

  /**
   * The first write a function makes of what the request sends as it is, itself or through the project functions it
   * gives it to, with the properties the request can set that way. `key` names the function and its input.
   */
  const assignments = new Map<string, { trace: Trace; fields: string[] } | null>();
  const assignmentBy = (function_: FunctionLike, flow: ReturnType<typeof flowOf>, key: string): { trace: Trace; fields: string[] } | undefined => {
    const known = assignments.get(key);
    if (known !== undefined) return known ?? undefined;
    assignments.set(key, null);
    let found: { trace: Trace; fields: string[] } | undefined;
    for (const site of summaryOf(function_).calls) {
      if (!ts.isCallExpression(site.node)) continue;
      const target = packaged(site.resolution);
      const spec = target === undefined ? undefined : writeMatchers.find((matcher) => matcher.packages.includes(target.package) && matcher.pattern.test(target.name))?.spec;
      if (spec !== undefined) {
        const fields = dataOf(site.node, spec).flatMap((data) => settable(data, flow));
        if (fields.length > 0) found = { trace: { site, next: undefined }, fields: [...new Set(fields)] };
      } else if (site.resolution.kind === "project") {
        const call = site.node;
        const whole = call.arguments.flatMap((argument, index) => (flow.wholeInput(argument) ? [index] : []));
        if (whole.length === 0) continue;
        for (const target of site.resolution.targets) {
          if (!isProject(target.getSourceFile())) continue;
          const inner = flowOf(checker, target, whole.map((at) => ({ at, holds: "input" as const })));
          const next = assignmentBy(target, inner, `${String(idOf(target))}:${whole.join(",")}`);
          if (next !== undefined) {
            found = { trace: { site, next: next.trace }, fields: next.fields };
            break;
          }
        }
      }
      if (found !== undefined) break;
    }
    assignments.set(key, found ?? null);
    return found;
  };

  return {
    unauthorizedWrites(file) {
      const findings: Finding[] = [];
      for (const entry of entries(file)) {
        if (entry.reads) continue;
        const trace = summaryOf(entry.handler)
          .calls.map((site) => effectsOfCall(site).get("db.write"))
          .find((found) => found !== undefined);
        if (trace === undefined || actsForUser(entry)) continue;
        const way = fromEntry(entry, trace);
        findings.push(findingFor(entry, way, `${entry.label} writes to the database through ${describe(way)} with nothing checking that the user asking may`));
      }
      return findings;
    },
    unboundedQueries(file) {
      const findings: Finding[] = [];
      for (const entry of entries(file)) {
        const trace = summaryOf(entry.handler)
          .calls.map((site) => effectsOfCall(site).get("all"))
          .find((found) => found !== undefined);
        if (trace === undefined) continue;
        const way = fromEntry(entry, trace);
        findings.push(findingFor(entry, way, `${entry.label} loads every row through ${describe(way)}, so each request loads more as the table grows`));
      }
      return findings;
    },
    massAssignments(file) {
      const findings: Finding[] = [];
      for (const entry of entries(file)) {
        const flow = flowOf(checker, entry.handler, entry.parameters, entry.decoratorsOf);
        const found = assignmentBy(entry.handler, flow, `${String(idOf(entry.handler))}:entry:${entry.label}`);
        if (found === undefined || whyChecked(entry) !== undefined) continue;
        const way = fromEntry(entry, found.trace);
        findings.push(
          findingFor(entry, way, `${entry.label} saves what the request sends as it is through ${describe(way)}, so the request can set ${listed(found.fields)}`),
        );
      }
      return findings;
    },
    unauthorizedReads(file) {
      const findings: Finding[] = [];
      for (const entry of entries(file)) {
        const flow = flowOf(checker, entry.handler, entry.parameters, entry.decoratorsOf);
        const trace = lookupBy(entry.handler, flow, `${String(idOf(entry.handler))}:entry:${entry.label}`);
        if (trace === undefined || actsForUser(entry)) continue;
        const way = fromEntry(entry, trace);
        findings.push(
          findingFor(entry, way, `${entry.label} reads a record by a key the request sends through ${describe(way)}: nothing checks that the user asking may see it`),
        );
      }
      return findings;
    },
    queriesInLoops(file) {
      const findings: Finding[] = [];
      for (const site of scoped(file)) {
        if (site.loop === undefined) continue;
        const found = effectsOfCall(site);
        const trace = found.get("db.read") ?? found.get("db.write");
        if (trace !== undefined) {
          findings.push({
            node: site.node,
            message: `queries the database once per item: ${site.loop.label} calls ${describe(trace)}`,
            at: placeOf(site.owner),
            reaching: reachingOf(trace),
          });
        }
      }
      return findings;
    },
    ioInTransactions(file) {
      const findings: Finding[] = [];
      for (const site of scoped(file)) {
        if (site.transaction === undefined) continue;
        const found = effectsOfCall(site);
        const io = OUTSIDE.find((kind) => found.has(kind.kind));
        const trace = io === undefined ? undefined : found.get(io.kind);
        if (io !== undefined && trace !== undefined) {
          findings.push({
            node: site.node,
            message:
              `${io.verb} inside ${site.transaction.label} through ${describe(trace)}: the transaction holds its database ` +
              `connection while it waits, and a rollback can't undo ${io.undone}`,
            at: placeOf(site.owner),
            reaching: reachingOf(trace),
          });
        }
      }
      return findings;
    },
    unknownIo(file) {
      const findings: Finding[] = [];
      const seen = new Set<string>();
      const sites = ownersOf(file)
        .flatMap((owner) => summaryOf(owner).calls)
        .sort((first, second) => first.node.getStart() - second.node.getStart());
      for (const site of sites) {
        const resolution = site.resolution;
        if (site.node === site.named || resolution.kind !== "dependency") continue;
        const name = resolution.package;
        if (name === "" || covered.has(name) || seen.has(name)) continue;
        if (checker.getTypeAtLocation(site.node).getProperty("then") === undefined) continue;
        seen.add(name);
        const version = versionOf(name);
        const from = version === undefined ? name : `${name} ${version}`;
        const off = inactive.get(name);
        findings.push({
          node: site.node,
          message:
            off === undefined
              ? `calls ${callee(site.named)}(), from ${from}, which no adapter describes, so designguard can't tell what it does`
              : `calls ${callee(site.named)}(), from ${from}, which the ${off.adapter.name} adapter doesn't describe: it describes ${off.range}`,
          at: placeOf(site.owner),
          reaching: [{ package: name, symbol: resolution.name }],
        });
      }
      return findings;
    },
    explain(file) {
      return entries(file).map((entry) => {
        const write = summaryOf(entry.handler)
          .calls.map((site) => effectsOfCall(site).get("db.write"))
          .find((found) => found !== undefined);
        const flow = flowOf(checker, entry.handler, entry.parameters, entry.decoratorsOf);
        const lookup = lookupBy(entry.handler, flow, `${String(idOf(entry.handler))}:entry:${entry.label}`);
        const node = entry.at ?? entry.handler;
        const line = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
        return {
          at: `${relative(root, node.getSourceFile().fileName)}:${String(line)}`,
          label: entry.label,
          reads: entry.reads,
          writes: write === undefined ? undefined : describe(fromEntry(entry, write)),
          looksUp: lookup === undefined ? undefined : describe(fromEntry(entry, lookup)),
          passes: whyActsForUser(entry),
        };
      });
    },
    entryPoints(file) {
      return entries(file).map((entry) => ({
        node: entry.at ?? entry.handler,
        label: entry.label,
        reads: entry.reads,
        middleware: entry.middleware.map((middleware) => middleware.name),
      }));
    },
    roles(file) {
      const roles: Role[] = [];
      const sites = ownersOf(file)
        .flatMap((owner) => summaryOf(owner).calls)
        .filter((site) => site.node !== site.named)
        .sort((first, second) => first.node.getStart() - second.node.getStart());
      for (const site of sites) {
        const resolution = site.resolution;
        if (resolution.kind !== "dependency") continue;
        const off = inactive.get(resolution.package);
        const effect = direct(site);
        const body = transactions.bodyOf(resolution);
        const argumentCount = ts.isCallExpression(site.node) || ts.isNewExpression(site.node) ? (site.node.arguments ?? []).length : 0;
        const version = versionOf(resolution.package) ?? "";
        roles.push({
          node: site.node,
          callee: callee(site.named),
          package: resolution.package,
          name: resolution.name,
          ...(effect === undefined ? {} : { effect }),
          ...(body === undefined ? {} : { transaction: body === "last" ? argumentCount : body + 1 }),
          ...(off === undefined ? {} : { off: `${resolution.package} ${version} is outside ${off.range}` }),
        });
      }
      return roles;
    },
    stats() {
      const files = program.getSourceFiles().filter(isProject);
      const stats: ResolutionStats = {
        files: files.length,
        functions: 0,
        calls: 0,
        project: 0,
        dependency: 0,
        lib: 0,
        unresolvedAny: 0,
        unresolvedAbstract: 0,
        transactions: 0,
      };
      for (const file of files) {
        for (const owner of ownersOf(file)) {
          stats.functions++;
          for (const site of summaryOf(owner).calls) {
            if (site.node === site.named) continue; // a function passed by name, not a call
            stats.calls++;
            const resolution = site.resolution;
            if (transactions.bodyOf(resolution) !== undefined) stats.transactions++;
            if (resolution.kind === "unresolved") {
              if (resolution.reason === "any") stats.unresolvedAny++;
              else stats.unresolvedAbstract++;
            } else stats[resolution.kind]++;
          }
        }
      }
      return stats;
    },
  };
}

/**
 * The installed version of a package the program uses: from the `package.json` of the folder its declarations come
 * from, under `node_modules`, or, for a package typed by `@types`, its types' version, marked `(types)`.
 */
function installedVersions(program: ts.Program): (name: string) => string | undefined {
  const versions = new Map<string, string | undefined>();
  const read = (marker: string): string | undefined => {
    const file = program.getSourceFiles().find((source) => source.fileName.includes(marker));
    if (file === undefined) return undefined;
    const folder = file.fileName.slice(0, file.fileName.lastIndexOf(marker) + marker.length);
    try {
      const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { version?: unknown };
      return typeof manifest.version === "string" ? manifest.version : undefined;
    } catch {
      return undefined;
    }
  };
  return (name) => {
    if (versions.has(name)) return versions.get(name);
    const typed = read(`/node_modules/@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}/`);
    const version = read(`/node_modules/${name}/`) ?? (typed === undefined ? undefined : `${typed} (types)`);
    versions.set(name, version);
    return version;
  };
}

/** What a transaction shouldn't wait on, in the order a message names them: work outside the database. */
const OUTSIDE: readonly { kind: EffectKind; verb: string; undone: string }[] = [
  { kind: "network", verb: "makes an HTTP request", undone: "the request" },
  { kind: "mail", verb: "sends mail", undone: "the mail" },
  { kind: "publish", verb: "publishes a message", undone: "the message" },
];

/**
 * A resolved call as a package and qualified name, for adapter patterns: a dependency's, or TypeScript's own library
 * as the `typescript` package.
 */
function packaged(resolution: CallSite["resolution"]): { package: string; name: string } | undefined {
  if (resolution.kind === "dependency") return resolution;
  if (resolution.kind === "lib") return { package: "typescript", name: resolution.name };
  return undefined;
}

/**
 * Whether a read loads every row: given no options that bound it, or, for a chain, run with no call that does. Options
 * or a chain that come from elsewhere may bound it, so they don't count.
 */
function loadsEveryRow(call: ts.CallExpression, spec: ListSpec): boolean {
  const bounds = glob(spec.bounds);
  if (spec.aggregates !== undefined && aggregates(call, glob(spec.aggregates))) return false;
  if (spec.argument !== undefined) {
    const argument = call.arguments[spec.argument];
    if (argument === undefined) return true;
    let options: ts.Expression = argument;
    while (ts.isParenthesizedExpression(options) || ts.isAsExpression(options) || ts.isSatisfiesExpression(options)) options = options.expression;
    if (!ts.isObjectLiteralExpression(options)) return false;
    return options.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) return false;
      const name = property.name;
      return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && !bounds.test(name.text);
    });
  }
  const names: string[] = [];
  let node: ts.Expression = call;
  for (;;) {
    const access = node.parent;
    const next = access.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== node || !ts.isCallExpression(next) || next.expression !== access) break;
    names.push(access.name.text);
    node = next;
  }
  if (names.some((name) => bounds.test(name))) return false;
  if (spec.runs !== undefined) return names.length > 0 && glob(spec.runs).test(names[names.length - 1] ?? "");
  return runsHere(node);
}

/**
 * Whether a thenable query runs where it is: awaited, or returned from an async function, which awaits what it
 * returns. Kept or returned elsewhere, its caller may add to it first.
 */
function runsHere(node: ts.Expression): boolean {
  let outer: ts.Node = node.parent;
  let inner: ts.Node = node;
  while (ts.isParenthesizedExpression(outer)) {
    inner = outer;
    outer = outer.parent;
  }
  if (ts.isAwaitExpression(outer)) return true;
  const function_ = ts.isReturnStatement(outer)
    ? ts.findAncestor(outer, ts.isFunctionLike)
    : ts.isArrowFunction(outer) && outer.body === inner
      ? outer
      : undefined;
  return function_ !== undefined && (ts.getCombinedModifierFlags(function_) & ts.ModifierFlags.Async) !== 0;
}

/**
 * Properties a request shouldn't set: ones that grant access, name an owner, or record a check the server makes.
 */
const PRIVILEGED = new Set([
  "role",
  "roles",
  "admin",
  "isAdmin",
  "superuser",
  "isSuperuser",
  "staff",
  "isStaff",
  "permissions",
  "authorities",
  "userId",
  "ownerId",
  "accountId",
  "organizationId",
  "orgId",
  "teamId",
  "tenantId",
  "workspaceId",
  "user",
  "owner",
  "tenant",
  "verified",
  "isVerified",
  "emailVerified",
  "emailVerifiedAt",
  "confirmedAt",
  "approved",
  "isApproved",
  "approvedAt",
  "passwordHash",
]);

/** Names as a message lists them: `role`, `role and isAdmin`, `role, isAdmin and ownerId`. */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/** What a write saves: the argument its spec names, or the properties of it, as Prisma's `data`. */
function dataOf(call: ts.CallExpression, spec: WriteSpec): ts.Expression[] {
  const argument = call.arguments[spec.argument];
  if (argument === undefined) return [];
  if (spec.property === undefined) return [argument];
  const options = unwrapped(argument);
  if (!ts.isObjectLiteralExpression(options)) return [];
  const pattern = glob(spec.property);
  return options.properties.flatMap((property) => {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && pattern.test(property.name.text)) {
      return [property.initializer];
    }
    return ts.isShorthandPropertyAssignment(property) && pattern.test(property.name.text) ? [property.name] : [];
  });
}

function unwrapped(node: ts.Expression): ts.Expression {
  let expression = node;
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isAwaitExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

/** Whether the arguments of a read, or of the calls in its chain after it, call or tag an aggregate. */
function aggregates(call: ts.CallExpression, names: RegExp): boolean {
  const calls: ts.CallExpression[] = [call];
  for (let node: ts.Node = call; ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent); node = node.parent.parent) {
    calls.push(node.parent.parent);
  }
  const visit = (node: ts.Node): boolean => {
    const named = ts.isCallExpression(node) ? node.expression : ts.isTaggedTemplateExpression(node) ? node.tag : undefined;
    const name = named === undefined ? undefined : lastName(named);
    return (name !== undefined && names.test(name)) || (ts.forEachChild(node, visit) ?? false);
  };
  return calls.some((each) => each.arguments.some(visit));
}

/** The last name of a callee: `update` for `prisma.user.update`, `load` for `load`. */
function lastName(named: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(named)) return named.name.text;
  return ts.isIdentifier(named) ? named.text : undefined;
}

/** The names a pattern's last segment matches, as `$transaction` for `PrismaClient.$transaction`. */
function lastNamePattern(on: string): RegExp {
  const dot = on.lastIndexOf(".");
  return glob(dot < 0 ? on : on.slice(dot + 1));
}

function placeOf(owner: Owner): Place {
  return { file: owner.getSourceFile().fileName, symbol: nameOf(owner) };
}

/** The functions a trace goes through after its first call, then the package declaration it ends at, if any. */
function reachingOf(trace: Trace): Reached[] {
  const steps: Reached[] = [];
  for (let step: Trace | undefined = trace; step !== undefined; step = step.next) {
    if (step.next !== undefined) steps.push(placeOf(step.next.site.owner));
    else if (step.site.resolution.kind === "dependency") steps.push({ package: step.site.resolution.package, symbol: step.site.resolution.name });
  }
  return steps;
}

/**
 * Which adapter's package a project file belongs to, for code a library generates into the project, as Prisma's
 * `prisma-client` generator writes the client to `generated/prisma`: the adapter claims it with `files`.
 */
function claimsOf(adapters: readonly Adapter[]): (fileName: string) => string | undefined {
  const claimed = adapters.flatMap((adapter) =>
    (adapter.files ?? []).map((pattern) => ({ pattern: glob(pattern), package: adapter.packages[0] ?? adapter.name })),
  );
  return (fileName) => claimed.find((claim) => claim.pattern.test(fileName))?.package;
}

/** The directory of the program's tsconfig, which message paths are relative to. */
function projectRoot(program: ts.Program): string {
  const config = program.getCompilerOptions().configFilePath;
  return typeof config === "string" ? dirname(config) : program.getCurrentDirectory();
}

