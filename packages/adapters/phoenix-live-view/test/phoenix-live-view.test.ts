import { findingsOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import liveView from "../src/index.js";

// The shape of phoenix_live_view 1's types: hooks are objects of callbacks typed `Hook`, as the `hooks` option takes
// them, or classes that extend `ViewHook`.
const declarations = `
  export interface HookInterface<E extends HTMLElement = HTMLElement> {
    el: E;
    pushEvent(event: string, payload?: object): void;
  }
  export interface Hook<T = object, E extends HTMLElement = HTMLElement> {
    mounted?: (this: T & HookInterface<E>) => void;
    updated?: (this: T & HookInterface<E>) => void;
    destroyed?: (this: T & HookInterface<E>) => void;
    [key: PropertyKey]: any;
  }
  export declare class ViewHook<E extends HTMLElement = HTMLElement> implements HookInterface<E> {
    el: E;
    pushEvent(event: string, payload?: object): void;
    mounted(): void;
    destroyed(): void;
  }
  export type HooksOptions = Record<string, typeof ViewHook | Hook<any, any>>;
  export declare class LiveSocket {
    constructor(url: string, socket: unknown, options?: { hooks?: HooksOptions });
  }`;

const files = stubPackage("phoenix_live_view", "1.2.11", declarations);

const leaks = (code: string, version = "1.2.11"): string[] =>
  findingsOf([liveView], { files: version === "1.2.11" ? files : stubPackage("phoenix_live_view", version, declarations), code });

describe("phoenix-live-view adapter", () => {
  it("flags what a hook starts on the page and never stops in destroyed()", () => {
    expect(
      leaks(`
        import type { Hook } from "phoenix_live_view";
        export const Resize: Hook = {
          mounted() {
            window.addEventListener("resize", () => this.pushEvent("resized"));
            setInterval(() => this.pushEvent("tick"), 1000);
          },
        };`),
    ).toEqual([
      `5: lifecycleLeaks: starts a "resize" listener with window.addEventListener() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory`,
      "6: lifecycleLeaks: starts an interval with setInterval() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory",
    ]);
  });

  it("passes what destroyed() stops, directly or through the hook's methods", () => {
    expect(
      leaks(`
        import type { Hook } from "phoenix_live_view";
        const onResize = () => {};
        let timer: ReturnType<typeof setInterval> | undefined;
        export const Resize: Hook = {
          mounted() {
            window.addEventListener("resize", onResize);
            timer = setInterval(() => {}, 1000);
          },
          destroyed() { this.stop(); },
          stop() { window.removeEventListener("resize", onResize); clearInterval(timer); },
        };`),
    ).toEqual([]);
  });

  it("passes the fixed example in the rule's docs", () => {
    expect(
      leaks(`
        import type { Hook } from "phoenix_live_view";
        export const Resize: Hook & { onResize?: () => void } = {
          mounted() {
            this.onResize = () => this.pushEvent("resized");
            window.addEventListener("resize", this.onResize);
          },
          destroyed() {
            if (this.onResize) window.removeEventListener("resize", this.onResize);
          },
        };`),
    ).toEqual([]);
  });

  it("finds hooks given as LiveSocket's hooks option, and classes that extend ViewHook", () => {
    expect(
      leaks(`
        import { LiveSocket, ViewHook } from "phoenix_live_view";
        class Chart extends ViewHook {
          observer = new ResizeObserver(() => {});
          mounted() { this.observer.observe(this.el); }
          destroyed() {}
        }
        new LiveSocket("/live", {}, {
          hooks: {
            Chart,
            Clock: { mounted() { setInterval(() => {}, 1000); } },
          },
        });`),
    ).toEqual([
      "4: lifecycleLeaks: starts an observer with new ResizeObserver() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory",
      "11: lifecycleLeaks: starts an interval with setInterval() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory",
    ]);
  });

  it("flags an observer a class hook makes in mounted() and never disconnects", () => {
    expect(
      leaks(`
        import { ViewHook } from "phoenix_live_view";
        export class Chart extends ViewHook {
          observer?: ResizeObserver;
          mounted() { this.observer = new ResizeObserver(() => {}); this.observer.observe(this.el); }
          destroyed() {}
        }`),
    ).toEqual([
      "5: lifecycleLeaks: starts an observer with new ResizeObserver() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory",
    ]);
  });

  it("passes listeners on the hook's element and the elements inside it, which leave with it", () => {
    expect(
      leaks(`
        import type { Hook } from "phoenix_live_view";
        export const Form: Hook = {
          mounted() {
            this.el.addEventListener("submit", () => {});
            this.el.querySelector("input")?.addEventListener("input", () => {});
            for (const button of this.el.querySelectorAll("button")) button.addEventListener("click", () => {});
            this.el.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {}));
            const span = document.createElement("span");
            span.addEventListener("animationend", () => span.remove());
            this.watch(this.el.querySelector("video"));
          },
          watch(video: HTMLVideoElement | null) { video?.addEventListener("play", () => {}); },
        };`),
    ).toEqual([]);
  });

  it("flags listeners on what's around the element: its document, its ancestors", () => {
    expect(
      leaks(`
        import type { Hook } from "phoenix_live_view";
        export const Menu: Hook = {
          mounted() {
            this.el.ownerDocument.addEventListener("keydown", () => {});
            this.el.closest("form")?.addEventListener("reset", () => {});
          },
        };`),
    ).toEqual([
      `5: lifecycleLeaks: starts a "keydown" listener with this.el.ownerDocument.addEventListener() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory`,
      `6: lifecycleLeaks: starts a "reset" listener with this.el.closest(…).addEventListener() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory`,
    ]);
  });

  it("follows the project's functions a hook calls, and what it passes them", () => {
    expect(
      leaks(`
        import type { Hook } from "phoenix_live_view";
        function listen(target: EventTarget) { target.addEventListener("scroll", () => {}); }
        export const Feed: Hook = {
          mounted() {
            listen(this.el);
            listen(window);
          },
        };`),
    ).toEqual([
      `7: lifecycleLeaks: calls listen(), which starts a "scroll" listener with target.addEventListener() (sample.ts:3), that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory`,
    ]);
  });

  it("matches a removal to its event, and an AbortSignal to an abort()", () => {
    expect(
      leaks(`
        import type { Hook } from "phoenix_live_view";
        const controller = new AbortController();
        const onKey = () => {};
        export const Keys: Hook = {
          mounted() {
            document.addEventListener("keydown", onKey);
            document.addEventListener("keyup", onKey, { signal: controller.signal });
            window.addEventListener("blur", onKey, { signal: controller.signal });
          },
          destroyed() { document.removeEventListener("keyup", onKey); },
        };
        export const Aborted: Hook = {
          mounted() { window.addEventListener("focus", onKey, { signal: controller.signal }); },
          destroyed() { controller.abort(); },
        };`),
    ).toEqual([
      `7: lifecycleLeaks: starts a "keydown" listener with document.addEventListener() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory`,
      `8: lifecycleLeaks: starts a "keyup" listener with document.addEventListener() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory`,
      `9: lifecycleLeaks: starts a "blur" listener with window.addEventListener() that destroyed() never stops: each time the hook leaves the page it keeps running and keeps the hook in memory`,
    ]);
  });

  it("leaves objects that aren't hooks alone, and turns off outside LiveView 1", () => {
    const code = `
      import type { Hook } from "phoenix_live_view";
      export const tools = { mounted() { window.addEventListener("resize", () => {}); } };
      export const Resize: Hook = { mounted() { window.addEventListener("resize", () => {}); } };`;
    expect(leaks(code)).toHaveLength(1);
    expect(leaks(code, "0.20.17")).toEqual([]);
  });
});
