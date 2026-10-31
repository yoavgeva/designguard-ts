import { defineAdapter, type ParameterSpec } from "@designguard/core";

// A handler's context holds the user asking, as `c.get("user")` and `c.var.user` give it, and what the request
// sends, through `c.req`.
const parameters: ParameterSpec[] = [
  { at: 0, holds: "context" },
  { at: 0, path: ["req", "{json(),param(),query(),queries(),valid(),parseBody(),formData(),text(),arrayBuffer(),blob(),header()}"], holds: "input" },
];

/** Hono 4: the routes an application registers, with the middleware given before the handler. */
export default defineAdapter({
  name: "hono",
  packages: ["hono"],
  versions: ">=4 <5",
  entryPoints: [
    { call: "Hono.{get,options}", reads: true, parameters },
    { call: "Hono.{post,put,patch,delete,all}", parameters },
  ],
});
