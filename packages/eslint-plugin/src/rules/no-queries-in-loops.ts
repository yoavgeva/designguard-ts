import { analysisFor, createRule, report } from "../analysis.js";

export const noQueriesInLoops = createRule({
  name: "no-queries-in-loops",
  meta: {
    type: "problem",
    docs: { description: "Disallow database queries made once per item of a loop, directly or through other functions: N+1" },
    messages: { finding: "{{message}}" },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const { analysis, file } = analysisFor(context);
    return {
      Program() {
        for (const finding of analysis.queriesInLoops(file)) report(context, finding);
      },
    };
  },
});
