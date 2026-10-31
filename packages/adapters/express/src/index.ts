import { defineAdapter, type ParameterSpec } from "@designguard/core";

// A handler's `req` and `res` hold the user asking, as Passport's `req.user` and `res.locals.user` do; what the
// request sends is in `req.body`, `req.params` and `req.query`.
const parameters: ParameterSpec[] = [
  { at: 0, holds: "context" },
  { at: 0, path: ["{body,params,query}"], holds: "input" },
  { at: 1, holds: "context" },
];

/**
 * Express 4 and 5: the routes an application, a router or a `route(path)` registers, with the middleware given
 * before the handler. Its types come from `@types/express`, which declares the routers in
 * `@types/express-serve-static-core`.
 */
export default defineAdapter({
  name: "express",
  packages: ["express", "express-serve-static-core"],
  versions: ">=4 <6",
  entryPoints: [
    { call: "{IRouter,IRoute}.{get,head,options}", reads: true, parameters },
    { call: "{IRouter,IRoute}.{post,put,patch,delete,all}", parameters },
  ],
});
