# no-lifecycle-leaks

Flags a listener, interval, observer, connection or worker that a part of the page starts and never stops when it
leaves: a Phoenix LiveView hook, which LiveView tells in `destroyed()`, or a custom element, which the browser tells in
`disconnectedCallback()`. Each time the part leaves the page, what it started keeps running, and keeps the part, its
element and everything they hold in memory. A page that comes and goes, as a list's rows or a LiveView's patches do,
leaks one each time.

## What it flags

In a part's code, other than the methods that run when it leaves, a call that starts something that runs until it's
stopped, directly or through the project's functions it calls, with no call stopping it in those methods or the
functions they call:

- `addEventListener` on anything other than the part's own element and the elements inside it, which leave with it,
  unless `removeEventListener` removes the same event, or the listener was given an `AbortSignal` that `abort()` stops;
- `setInterval`, unless `clearInterval`;
- `new IntersectionObserver`, `ResizeObserver`, `MutationObserver`, `PerformanceObserver` and `ReportingObserver`,
  unless `disconnect()`;
- `new WebSocket`, `EventSource` and `BroadcastChannel`, unless `close()`;
- `new Worker`, unless `terminate()`.

```ts
const Resize: Hook = {
  mounted() {
    window.addEventListener("resize", () => this.pushEvent("resized")); // ✗ starts a "resize" listener with
  },                                                                     //   window.addEventListener() that destroyed()
};                                                                       //   never stops: each time the hook leaves the
                                                                         //   page it keeps running and keeps the hook in
                                                                         //   memory
```

Fixed: the listener kept, and removed when the hook leaves.

```ts
const Resize: Hook & { onResize?: () => void } = {
  mounted() {
    this.onResize = () => this.pushEvent("resized");
    window.addEventListener("resize", this.onResize);
  },
  destroyed() {
    if (this.onResize) window.removeEventListener("resize", this.onResize);
  },
};
```

What's own: the part's element (`this.el` for a hook, `this` for a custom element); what's inside it, through
`querySelector`, `querySelectorAll`, `children` and the like, a `for…of` or `forEach` over them, and variables and
parameters given them; and elements the code makes, with `document.createElement` or `new Image()`. What's around
it is not: `ownerDocument`, `closest()`, `parentElement`.

One-shot timers, `setTimeout` and `requestAnimationFrame`, end on their own and aren't flagged.

## Options

The [shared options](../../README.md#turning-rules-on-off-and-down).

## Needs

Custom elements need nothing: the built-in standards adapter knows them, and the browser's listeners, timers and
observers. LiveView hooks need `@designguard/adapter-phoenix-live-view`. A hook must be typed to be found: an object
given the `Hook` type, as the values of `LiveSocket`'s `hooks` option are, or a class that extends `ViewHook`.
