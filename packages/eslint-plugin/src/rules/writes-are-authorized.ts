import { analysisFor, createRule, reportAll } from "../analysis.js";
import { type SharedOptions, sharedSchema } from "../options.js";

export const writesAreAuthorized = createRule<[SharedOptions], "finding">({
  name: "writes-are-authorized",
  meta: {
    type: "problem",
    docs: { description: "Disallow request handlers that write to the database with nothing checking that the user asking may" },
    messages: { finding: "{{message}}" },
    schema: [sharedSchema],
    defaultOptions: [{}],
  },
  create(context) {
    const { analysis, file, root } = analysisFor(context);
    return {
      Program() {
        reportAll(context, analysis.unauthorizedWrites(file), root);
      },
    };
  },
});
