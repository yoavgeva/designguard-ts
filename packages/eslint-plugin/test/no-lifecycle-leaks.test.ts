import { join } from "node:path";
import plugin from "../src/index.js";
import { typedProject } from "./fixture.js";

// Custom elements need no adapter: the standards one knows them, and the listeners, timers and observers they start.
const { root, ruleTester } = typedProject({ "src/main.ts": "" }, []);
const filename = join(root, "src/main.ts");

ruleTester.run("no-lifecycle-leaks", plugin.rules["no-lifecycle-leaks"], {
  valid: [
    {
      filename,
      code: `
export class Clock extends HTMLElement {
  timer: ReturnType<typeof setInterval> | undefined;
  connectedCallback() {
    this.addEventListener("click", () => {});
    this.timer = setInterval(() => this.render(), 1000);
  }
  disconnectedCallback() { clearInterval(this.timer); }
  render() {}
}`,
    },
  ],
  invalid: [
    {
      filename,
      code: `
export class Theme extends HTMLElement {
  connectedCallback() {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.render());
  }
  render() {}
}`,
      errors: [
        {
          messageId: "finding",
          line: 4,
          data: {
            message:
              'starts a "change" listener with matchMedia(…).addEventListener() that disconnectedCallback() never stops: each time the element leaves the page it keeps running and keeps the element in memory',
          },
        },
      ],
    },
  ],
});
