import { analysisFor, createRule, reportAll } from "../analysis.js";
import { type SharedOptions, sharedSchema } from "../options.js";

export const noLifecycleLeaks = createRule<[SharedOptions], "finding">({
  name: "no-lifecycle-leaks",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow listeners, intervals, observers and connections a part of the page starts and never stops when it leaves, as a LiveView hook's destroyed() or a custom element's disconnectedCallback() should",
    },
    messages: { finding: "{{message}}" },
    schema: [sharedSchema],
    defaultOptions: [{}],
  },
  create(context) {
    const { analysis, file, root } = analysisFor(context);
    return {
      Program() {
        reportAll(context, analysis.lifecycleLeaks(file), root);
      },
    };
  },
});
