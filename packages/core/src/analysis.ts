import { dirname, relative } from "node:path";
import ts from "typescript";
import type { Adapter, EffectKind } from "./adapter.js";
import type { FunctionLike } from "./resolve.js";
import { type CallSite, type FunctionSummary, summarize } from "./summaries.js";

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

/** The analysis of a program with these adapters, built once and shared by every rule and file. */
export function analyze(program: ts.Program, adapters: readonly Adapter[]): Analysis {
  const key = JSON.stringify(adapters);
  let byAdapters = cache.get(program);
  if (byAdapters === undefined) {
    byAdapters = new Map();
    cache.set(program, byAdapters);
  }
  let analysis = byAdapters.get(key);
  if (analysis === undefined) {
    analysis = build(program, adapters);
    byAdapters.set(key, analysis);
  }
  return analysis;
}

function build(program: ts.Program, adapters: readonly Adapter[]): Analysis {
  const checker = program.getTypeChecker();
  const root = projectRoot(program);
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file));
  const summaries = new Map<FunctionLike | ts.SourceFile, FunctionSummary>();
  const byFile = new Map<ts.SourceFile, FunctionSummary[]>();
  for (const file of files) {
    const found = summarize(program, checker, file);
    byFile.set(file, found);
    for (const summary of found) summaries.set(summary.node, summary);
  }
  const matchers = adapters.flatMap((adapter) =>
    (adapter.effects ?? []).map((effect) => ({ packages: adapter.packages, pattern: glob(effect.on), kind: effect.kind })),
  );
  const direct = (site: CallSite): EffectKind | undefined => {
    const resolution = site.resolution;
    if (resolution.kind !== "dependency") return undefined;
    return matchers.find((matcher) => matcher.packages.includes(resolution.package) && matcher.pattern.test(resolution.name))?.kind;
  };
  const effects = propagate([...summaries.values()], summaries, direct);

  /** The effects a call has: its own, or those of the project functions it reaches, with the way there. */
  const effectsOfCall = (site: CallSite): Map<EffectKind, Trace> => {
    const found = new Map<EffectKind, Trace>();
    const own = direct(site);
    if (own !== undefined) found.set(own, { site, next: undefined });
    if (site.resolution.kind === "project") {
      for (const target of site.resolution.targets) {
        for (const [kind, trace] of effects.get(target) ?? []) {
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
      for (const summary of byFile.get(file) ?? []) {
        for (const site of summary.calls) {
          if (site.loop === undefined) continue;
          const found = effectsOfCall(site);
          const trace = found.get("db.read") ?? found.get("db.write");
          if (trace !== undefined) {
            findings.push({ node: site.node, message: `queries the database once per item: ${site.loop.label} calls ${describe(trace)}` });
          }
        }
      }
      return findings;
    },
    stats() {
      const stats: ResolutionStats = { files: files.length, functions: summaries.size, calls: 0, project: 0, dependency: 0, lib: 0, unresolvedAny: 0, unresolvedAbstract: 0 };
      const seen = new Set<ts.Node>();
      for (const summary of summaries.values()) {
        for (const site of summary.calls) {
          if (seen.has(site.node)) continue;
          seen.add(site.node);
          stats.calls++;
          const resolution = site.resolution;
          if (resolution.kind === "unresolved") {
            if (resolution.reason === "any") stats.unresolvedAny++;
            else stats.unresolvedAbstract++;
          } else stats[resolution.kind]++;
        }
      }
      return stats;
    },
  };
}

/** Each function's effects, reached through the project functions it calls, found by iterating to a fixpoint. */
function propagate(
  all: readonly FunctionSummary[],
  summaries: ReadonlyMap<FunctionLike | ts.SourceFile, FunctionSummary>,
  direct: (site: CallSite) => EffectKind | undefined,
): Map<FunctionLike | ts.SourceFile, Map<EffectKind, Trace>> {
  const effects = new Map<FunctionLike | ts.SourceFile, Map<EffectKind, Trace>>();
  for (const summary of all) {
    const own = new Map<EffectKind, Trace>();
    for (const site of summary.calls) {
      const kind = direct(site);
      if (kind !== undefined && !own.has(kind)) own.set(kind, { site, next: undefined });
    }
    effects.set(summary.node, own);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of all) {
      const own = effects.get(summary.node);
      if (own === undefined) continue;
      for (const site of summary.calls) {
        if (site.resolution.kind !== "project") continue;
        for (const target of site.resolution.targets) {
          if (!summaries.has(target)) continue;
          for (const [kind, trace] of effects.get(target) ?? []) {
            if (!own.has(kind)) {
              own.set(kind, { site, next: trace });
              changed = true;
            }
          }
        }
      }
    }
  }
  return effects;
}

/** The text a message names a call by, on one line: `prisma.user.findUnique`. */
function callee(site: CallSite): string {
  const text = site.named.getText().replace(/\s+/g, "");
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The directory of the program's tsconfig, which message paths are relative to. */
function projectRoot(program: ts.Program): string {
  const config = program.getCompilerOptions().configFilePath;
  return typeof config === "string" ? dirname(config) : program.getCurrentDirectory();
}

/** A pattern as a regular expression: `*` matches anything, `{a,b}` either alternative. */
function glob(pattern: string): RegExp {
  let source = "";
  for (const part of pattern.split(/(\*|\{[^}]*\})/)) {
    if (part === "*") source += ".*";
    else if (part.startsWith("{") && part.endsWith("}")) source += `(?:${part.slice(1, -1).split(",").map(escape).join("|")})`;
    else source += escape(part);
  }
  return new RegExp(`^${source}$`);
}

function escape(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
