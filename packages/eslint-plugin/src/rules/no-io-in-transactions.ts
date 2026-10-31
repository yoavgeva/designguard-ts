import { analysisFor, createRule, reportAll } from "../analysis.js";
import { type SharedOptions, sharedSchema } from "../options.js";

export const noIoInTransactions = createRule<[SharedOptions], "finding">({
  name: "no-io-in-transactions",
  meta: {
    type: "problem",
    docs: { description: "Disallow HTTP requests, mail and messages inside a database transaction, directly or through other functions" },
    messages: { finding: "{{message}}" },
    schema: [sharedSchema],
    defaultOptions: [{}],
  },
  create(context) {
    const { analysis, file, root } = analysisFor(context);
    return {
      Program() {
        reportAll(context, analysis.ioInTransactions(file), root);
      },
    };
  },
});
