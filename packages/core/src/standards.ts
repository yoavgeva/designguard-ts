import { defineAdapter, type ParameterSpec } from "./adapter.js";

const NETWORK = "{http,https,http2,net,tls,dgram,node:http,node:https,node:http2,node:net,node:tls,node:dgram}";

// A route handler's request is a context the user asking can be read from, and its body, its URL and the route's
// params, its second argument's, are what the request sends.
const request: ParameterSpec[] = [
  { at: 0, holds: "context" },
  { at: 0, path: ["{json(),formData(),text(),arrayBuffer(),blob(),body,url,nextUrl,headers,cookies}"], holds: "input" },
  { at: 1, path: ["params"], holds: "input" },
];

/**
 * What the platform does, which every project has: `fetch`, and Node's network, file and process modules. TypeScript's
 * own library counts as the `typescript` package; Node's declarations come from `@types/node` and `undici-types`.
 *
 * Where requests come in on the web's own terms: React's server functions, which the client calls with arguments it
 * chooses, and route handlers, exported functions named for an HTTP method that take a `Request`, as Next.js,
 * SvelteKit's and others' are.
 */
export const standards = defineAdapter({
  name: "standards",
  packages: ["typescript", "node", "undici-types"],
  effects: [
    { on: "fetch", kind: "network" },
    { on: `${NETWORK}.{request,get,connect,createConnection}`, kind: "network" },
    { on: "{fs,fs/promises,node:fs,node:fs/promises}.*", kind: "file" },
    { on: "{child_process,node:child_process}.*", kind: "process" },
  ],
  entryPoints: [
    { directive: "use server", parameters: [{ holds: "input" }] },
    { exports: "{GET,HEAD,OPTIONS}", takes: "Request", reads: true, parameters: request },
    { exports: "{POST,PUT,PATCH,DELETE}", takes: "Request", parameters: request },
  ],
});
