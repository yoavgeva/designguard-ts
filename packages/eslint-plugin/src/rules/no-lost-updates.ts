import { analysisFor, createRule, reportAll } from "../analysis.js";
import { type SharedOptions, sharedSchema } from "../options.js";

export const noLostUpdates = createRule<[SharedOptions], "finding">({
  name: "no-lost-updates",
  meta: {
    type: "problem",
    docs: { description: "Disallow writing a value computed from one read before without a lock or a version check: a lost update" },
    messages: { finding: "{{message}}" },
    schema: [sharedSchema],
    defaultOptions: [{}],
  },
  create(context) {
    const { analysis, file, root } = analysisFor(context);
    return {
      Program() {
        reportAll(context, analysis.lostUpdates(file), root);
      },
    };
  },
});
