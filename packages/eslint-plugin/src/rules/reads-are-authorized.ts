import { analysisFor, createRule, reportAll } from "../analysis.js";
import { type SharedOptions, sharedSchema } from "../options.js";

export const readsAreAuthorized = createRule<[SharedOptions], "finding">({
  name: "reads-are-authorized",
  meta: {
    type: "problem",
    docs: { description: "Disallow request handlers that read a record by a key the request sends with nothing checking that the user asking may see it" },
    messages: { finding: "{{message}}" },
    schema: [sharedSchema],
    defaultOptions: [{}],
  },
  create(context) {
    const { analysis, file, root } = analysisFor(context);
    return {
      Program() {
        reportAll(context, analysis.unauthorizedReads(file), root);
      },
    };
  },
});
