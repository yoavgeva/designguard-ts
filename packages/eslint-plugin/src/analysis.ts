import { appendFileSync } from "node:fs";
import { type Adapter, type Analysis, type Finding, analyze } from "@designguard/core";
import { type SharedOptions, reportable } from "./options.js";
import { ESLintUtils, type TSESLint } from "@typescript-eslint/utils";
import type ts from "typescript";

/** The adapters listed in `settings.designguard.adapters`. */
function adaptersOf(settings: TSESLint.SharedConfigurationSettings): readonly Adapter[] {
  const designguard = settings["designguard"] as { adapters?: unknown } | undefined;
  const adapters = designguard?.adapters ?? [];
  if (!Array.isArray(adapters)) throw new Error("settings.designguard.adapters must be a list of adapters");
  return adapters as Adapter[];
}

const reported = new WeakSet<ts.Program>();

/**
 * The directory selectors and message paths are relative to: the `tsconfigRootDir` the parser was given, else
 * ESLint's working directory.
 */
function rootOf(context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>): string {
  const parserOptions = context.languageOptions.parserOptions as { tsconfigRootDir?: unknown } | undefined;
  return typeof parserOptions?.tsconfigRootDir === "string" ? parserOptions.tsconfigRootDir : context.cwd;
}

/** The project's analysis, the TypeScript file being linted, and where paths are read from, for a rule on one file. */
export function analysisFor(context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>): {
  analysis: Analysis;
  file: ts.SourceFile;
  root: string;
} {
  const services = ESLintUtils.getParserServices(context);
  const program = services.program;
  const file = services.esTreeNodeToTSNodeMap.get(context.sourceCode.ast);
  const root = rootOf(context);
  const started = performance.now();
  const analysis = analyze(program, { adapters: adaptersOf(context.settings), root });
  // DESIGNGUARD_STATS names a file to append one line of resolution statistics to per program analyzed.
  const statsFile = process.env["DESIGNGUARD_STATS"];
  if (statsFile !== undefined && statsFile !== "" && !reported.has(program)) {
    reported.add(program);
    appendFileSync(statsFile, `${JSON.stringify({ ...analysis.stats(), milliseconds: Math.round(performance.now() - started) })}\n`);
  }
  return { analysis, file, root };
}

/** Reports the findings the rule's options let through. */
export function reportAll(
  context: Readonly<TSESLint.RuleContext<"finding", readonly [SharedOptions]>>,
  findings: readonly Finding[],
  root: string,
): void {
  const options = context.options[0] ?? {};
  for (const finding of findings) if (reportable(finding, options, root)) report(context, finding);
}

/** Reports a finding at its TypeScript node. */
function report(context: Readonly<TSESLint.RuleContext<"finding", readonly unknown[]>>, finding: Finding): void {
  const file = finding.node.getSourceFile();
  const start = file.getLineAndCharacterOfPosition(finding.node.getStart());
  const end = file.getLineAndCharacterOfPosition(finding.node.getEnd());
  context.report({
    loc: { start: { line: start.line + 1, column: start.character }, end: { line: end.line + 1, column: end.character } },
    messageId: "finding",
    data: { message: finding.message },
  });
}

export const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/yoavgeva/designguard-ts/blob/main/docs/rules/${name}.md`);
