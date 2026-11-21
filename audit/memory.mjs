// Lints directories in this process and prints how long it took and the heap: its peak, sampled between files, and
// what a full GC leaves at the end. With OUT set, also writes designguard's findings there as JSON, and with SNAPSHOT,
// a heap snapshot. Run with --expose-gc.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { writeHeapSnapshot } from "node:v8";

const require = createRequire("/tools/package.json");
const { ESLint } = await import(require.resolve("eslint"));
const dirs = process.argv.slice(2);
const mb = (bytes) => Math.round(bytes / 1048576);
let peak = 0;
const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 20);
const start = performance.now();
const results = await new ESLint({ overrideConfigFile: "eslint.audit.mjs", warnIgnored: false, errorOnUnmatchedPattern: false }).lintFiles(dirs);
const seconds = (performance.now() - start) / 1000;
clearInterval(timer);
globalThis.gc();
const retained = process.memoryUsage().heapUsed;
const findings = results.reduce((sum, result) => sum + result.messages.filter((message) => !message.fatal).length, 0);
const fatal = results.reduce((sum, result) => sum + result.messages.filter((message) => message.fatal).length, 0);
console.log(JSON.stringify({ dir: dirs.join(" "), designguard: process.env.DG === "1", files: results.length, findings, fatal, seconds: Math.round(seconds * 10) / 10, peakMB: mb(peak), retainedMB: mb(retained) }));
if (process.env.OUT) {
  const found = results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId?.startsWith("designguard/"))
      .map((message) => ({ rule: message.ruleId.slice(12), file: relative(process.cwd(), result.filePath), line: message.line, message: message.message })),
  );
  writeFileSync(process.env.OUT, JSON.stringify(found, null, 1));
}
if (process.env.SNAPSHOT) writeHeapSnapshot(process.env.SNAPSHOT);
