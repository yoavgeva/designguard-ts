import type { TSESLint } from "@typescript-eslint/utils";
import { noQueriesInLoops } from "./rules/no-queries-in-loops.js";

const rules = {
  "no-queries-in-loops": noQueriesInLoops,
};

const plugin = {
  meta: { name: "eslint-plugin-designguard", version: "0.0.0" },
  rules,
  configs: {} as Record<"recommended" | "all", TSESLint.FlatConfig.Config>,
};

plugin.configs.recommended = {
  plugins: { designguard: plugin },
  rules: { "designguard/no-queries-in-loops": "error" },
};
plugin.configs.all = plugin.configs.recommended;

export default plugin;
