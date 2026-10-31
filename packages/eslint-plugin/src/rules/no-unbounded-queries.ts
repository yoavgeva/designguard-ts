import { analysisFor, createRule, reportAll } from "../analysis.js";
import { type SharedOptions, sharedSchema } from "../options.js";

export const noUnboundedQueries = createRule<[SharedOptions], "finding">({
  name: "no-unbounded-queries",
  meta: {
    type: "problem",
    docs: { description: "Disallow request handlers that load every row of a table, directly or through other functions" },
    messages: { finding: "{{message}}" },
    schema: [sharedSchema],
    defaultOptions: [{}],
  },
  create(context) {
    const { analysis, file, root } = analysisFor(context);
    return {
      Program() {
        reportAll(context, analysis.unboundedQueries(file), root);
      },
    };
  },
});
