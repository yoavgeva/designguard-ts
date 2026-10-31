import { dirname, relative } from "node:path";
import ts from "typescript";
import type { Adapter, EffectKind } from "./adapter.js";
import { glob } from "./patterns.js";
import type { FunctionLike } from "./resolve.js";
import { type CallSite, type FunctionSummary, loopCalls, ownersOf, summarizeFunction } from "./summaries.js";

/** A finding, at the node the rule reports. */
export interface Finding {
  readonly node: ts.Node;
  readonly message: string;
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
  stats(): ResolutionStats;
}

const cache = new WeakMap<ts.Program, Map<string, Analysis>>();

/**
 * Summaries and loop calls, by the node they were made for and the adapters they were made with. typescript-eslint's
 * project service builds new programs as it opens files, and they share the source files that didn't change, so
 * each is read once.
 */
const summaryCache = new WeakMap<ts.Node, Map<string, FunctionSummary>>();
const loopCache = new WeakMap<ts.SourceFile, Map<string, CallSite[]>>();

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

/** The analysis of a program with these adapters, built once and shared by every rule and file. */
export function analyze(program: ts.Program, adapters: readonly Adapter[]): Analysis {
  const key = JSON.stringify(adapters);
  return cached(cache, program, key, () => build(program, adapters, key));
}

type Owner = FunctionLike | ts.SourceFile;

/**
 * The analysis reads code only as a question needs it: the loop calls of the file asked about, and the functions
 * those calls reach.
 */
function build(program: ts.Program, adapters: readonly Adapter[], key: string): Analysis {
  const checker = program.getTypeChecker();
  const root = projectRoot(program);
  const claims = claimsOf(adapters);
  const matchers = adapters.flatMap((adapter) =>
    (adapter.effects ?? []).map((effect) => ({ packages: adapter.packages, pattern: glob(effect.on), kind: effect.kind })),
  );
  const direct = (site: CallSite): EffectKind | undefined => {
    const resolution = site.resolution;
    if (resolution.kind !== "dependency") return undefined;
    return matchers.find((matcher) => matcher.packages.includes(resolution.package) && matcher.pattern.test(resolution.name))?.kind;
  };
  const summaryOf = (owner: Owner): FunctionSummary => cached(summaryCache, owner, key, () => summarizeFunction(program, checker, owner, claims));
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
    const first = `${callee(trace.site)}()`;
    let last = trace;
    while (last.next !== undefined) last = last.next;
    if (last === trace) return first;
    const file = last.site.node.getSourceFile();
    const line = file.getLineAndCharacterOfPosition(last.site.node.getStart()).line + 1;
    return `${first}, which reaches ${callee(last.site)}() (${relative(root, file.fileName)}:${line})`;
  };

  return {
    queriesInLoops(file) {
      const findings: Finding[] = [];
      for (const site of cached(loopCache, file, key, () => loopCalls(program, checker, file, claims))) {
        const found = effectsOfCall(site);
        const trace = found.get("db.read") ?? found.get("db.write");
        if (trace !== undefined && site.loop !== undefined) {
          findings.push({ node: site.node, message: `queries the database once per item: ${site.loop.label} calls ${describe(trace)}` });
        }
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
 * Which adapter's package a project file belongs to, for code a library generates into the project, as Prisma's
 * `prisma-client` generator writes the client to `generated/prisma`: the adapter claims it with `files`.
 */
function claimsOf(adapters: readonly Adapter[]): (fileName: string) => string | undefined {
  const claimed = adapters.flatMap((adapter) =>
    (adapter.files ?? []).map((pattern) => ({ pattern: glob(pattern), package: adapter.packages[0] ?? adapter.name })),
  );
  return (fileName) => claimed.find((claim) => claim.pattern.test(fileName))?.package;
}

/**
 * The text a message names a call by, on one line: `prisma.user.findUnique`, or for a chain of calls, where it starts
 * and the call that ends it, as `db.selectFrom(…).execute`.
 */
function callee(site: CallSite): string {
  const named = site.named;
  let first: ts.Expression | undefined;
  for (let node: ts.Expression = named; ; ) {
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) first = node;
    if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    else if (ts.isTaggedTemplateExpression(node)) node = node.tag;
    else break;
  }
  const text =
    first === undefined || !ts.isPropertyAccessExpression(named)
      ? oneLine(named.getText())
      : ts.isTaggedTemplateExpression(first)
        ? `${oneLine(first.tag.getText())}\`…\`.${named.name.text}`
        : `${oneLine((first as ts.CallExpression).expression.getText())}(…).${named.name.text}`;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, "");
}

/** The directory of the program's tsconfig, which message paths are relative to. */
function projectRoot(program: ts.Program): string {
  const config = program.getCompilerOptions().configFilePath;
  return typeof config === "string" ? dirname(config) : program.getCurrentDirectory();
}

