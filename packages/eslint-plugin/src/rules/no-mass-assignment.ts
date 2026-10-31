import { analysisFor, createRule, reportAll } from "../analysis.js";
import { type SharedOptions, sharedSchema } from "../options.js";

export const noMassAssignment = createRule<[SharedOptions], "finding">({
  name: "no-mass-assignment",
  meta: {
    type: "problem",
    docs: { description: "Disallow request handlers that save what the request sends as it is, when it has a property the request shouldn't set, as role or ownerId" },
    messages: { finding: "{{message}}" },
    schema: [sharedSchema],
    defaultOptions: [{}],
  },
  create(context) {
    const { analysis, file, root } = analysisFor(context);
    return {
      Program() {
        reportAll(context, analysis.massAssignments(file), root);
      },
    };
  },
});
