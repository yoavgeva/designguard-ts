import type { TSESLint } from "@typescript-eslint/utils";
import { noIoInTransactions } from "./rules/no-io-in-transactions.js";
import { noQueriesInLoops } from "./rules/no-queries-in-loops.js";
import { noUnknownIo } from "./rules/no-unknown-io.js";

const rules = {
  "no-io-in-transactions": noIoInTransactions,
  "no-queries-in-loops": noQueriesInLoops,
  "no-unknown-io": noUnknownIo,
};

const plugin = {
  meta: { name: "eslint-plugin-designguard", version: "0.0.0" },
  rules,
  configs: {} as Record<"recommended" | "all", TSESLint.FlatConfig.Config>,
};

/** The rules worth holding any project to. */
const recommended = ["no-io-in-transactions", "no-queries-in-loops"] as const;

plugin.configs.recommended = {
  plugins: { designguard: plugin },
  rules: Object.fromEntries(recommended.map((name) => [`designguard/${name}`, "error"])),
};
plugin.configs.all = {
  plugins: { designguard: plugin },
  rules: Object.fromEntries(Object.keys(rules).map((name) => [`designguard/${name}`, "error"])),
};

export default plugin;
