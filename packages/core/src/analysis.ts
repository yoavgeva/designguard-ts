import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import semver from "semver";
import ts from "typescript";
import type { Adapter, EffectKind } from "./adapter.js";
import { glob } from "./patterns.js";
import type { FunctionLike } from "./resolve.js";
import { callee } from "./names.js";
import { standards } from "./standards.js";
import { type CallSite, type FunctionSummary, nameOf, ownersOf, scopedCalls, summarizeFunction, type Transactions } from "./summaries.js";

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
}

export interface Analysis {
  queriesInLoops(file: ts.SourceFile): Finding[];
  ioInTransactions(file: ts.SourceFile): Finding[];
  unknownIo(file: ts.SourceFile): Finding[];
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
    if (installed === undefined || semver.satisfies(installed, adapter.versions, { includePrerelease: true })) return true;
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
    !file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file) && claims(file.fileName) === undefined;

  /** Effects found for every function a finished question reached: complete, since that set holds all they call. */
  const final = new Map<Owner, Map<EffectKind, Trace>>();

  const effectsOf = (owner: Owner): Map<EffectKind, Trace> => {
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
    const working = new Map<Owner, Map<EffectKind, Trace>>();
    for (const function_ of reached) {
      const own = new Map<EffectKind, Trace>();
      for (const site of summaryOf(function_).calls) {
        const kind = direct(site);
        if (kind !== undefined && !own.has(kind)) own.set(kind, { site, next: undefined });
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
    return final.get(owner) ?? new Map();
  };

  /** The effects a call has: its own, or those of the project functions it reaches, with the way there. */
  const effectsOfCall = (site: CallSite): Map<EffectKind, Trace> => {
    const found = new Map<EffectKind, Trace>();
    const own = direct(site);
    if (own !== undefined) found.set(own, { site, next: undefined });
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
    return `${first}, which reaches ${callee(last.site.named)}() (${relative(root, file.fileName)}:${line})`;
  };

  return {
    queriesInLoops(file) {
      const findings: Finding[] = [];
      for (const site of scoped(file)) {
        if (site.loop === undefined) continue;
        const found = effectsOfCall(site);
        const trace = found.get("db.read") ?? found.get("db.write");
        if (trace !== undefined && site.loop !== undefined) {
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
    stats() {
      const files = program.getSourceFiles().filter(isProject);
      const stats: ResolutionStats = { files: files.length, functions: 0, calls: 0, project: 0, dependency: 0, lib: 0, unresolvedAny: 0, unresolvedAbstract: 0 };
      for (const file of files) {
        for (const owner of ownersOf(file)) {
          stats.functions++;
          for (const site of summaryOf(owner).calls) {
            if (site.node === site.named) continue; // a function passed by name, not a call
            stats.calls++;
            const resolution = site.resolution;
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
 * from, under `node_modules`.
 */
function installedVersions(program: ts.Program): (name: string) => string | undefined {
  const versions = new Map<string, string | undefined>();
  return (name) => {
    if (versions.has(name)) return versions.get(name);
    const marker = `/node_modules/${name}/`;
    const file = program.getSourceFiles().find((source) => source.fileName.includes(marker));
    let version: string | undefined;
    if (file !== undefined) {
      const folder = file.fileName.slice(0, file.fileName.lastIndexOf(marker) + marker.length);
      try {
        const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { version?: unknown };
        version = typeof manifest.version === "string" ? manifest.version : undefined;
      } catch {
        version = undefined;
      }
    }
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

