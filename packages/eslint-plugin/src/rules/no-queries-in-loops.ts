import { analysisFor, createRule, reportAll } from "../analysis.js";
import { type SharedOptions, sharedSchema } from "../options.js";

export const noQueriesInLoops = createRule<[SharedOptions], "finding">({
  name: "no-queries-in-loops",
  meta: {
    type: "problem",
    docs: { description: "Disallow database queries made once per item of a loop, directly or through other functions: N+1" },
    messages: { finding: "{{message}}" },
    schema: [sharedSchema],
    defaultOptions: [{}],
  },
  create(context) {
    const { analysis, file, root } = analysisFor(context);
    return {
      Program() {
        reportAll(context, analysis.queriesInLoops(file), root);
      },
    };
  },
});
