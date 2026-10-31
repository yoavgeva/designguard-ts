import { analysisFor, createRule, reportAll } from "../analysis.js";
import { type SharedOptions, sharedSchema } from "../options.js";

export const noUnknownIo = createRule<[SharedOptions], "finding">({
  name: "no-unknown-io",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Report calls returning promises from packages no adapter describes, or whose adapter doesn't describe the installed version, so the rules that follow calls can't check them",
    },
    messages: { finding: "{{message}}" },
    schema: [sharedSchema],
    defaultOptions: [{}],
  },
  create(context) {
    const { analysis, file, root } = analysisFor(context);
    return {
      Program() {
        reportAll(context, analysis.unknownIo(file), root);
      },
    };
  },
});
