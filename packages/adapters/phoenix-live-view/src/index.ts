import { defineAdapter } from "@designguard/core";

/**
 * Phoenix LiveView 1's JavaScript hooks: an object given the `Hook` type, as the values of `LiveSocket`'s `hooks`
 * option are, or a class that extends `ViewHook`. A hook lives while its element is on the page, `this.el`; when the
 * element leaves, LiveView calls `destroyed`, which must stop what the hook started.
 */
export default defineAdapter({
  name: "phoenix-live-view",
  packages: ["phoenix_live_view"],
  versions: ">=1 <2",
  lifecycles: [{ type: "{Hook,ViewHook,HookInterface}", stops: "destroyed", element: ["el"], part: "the hook" }],
});
