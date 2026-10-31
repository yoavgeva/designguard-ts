import { defineAdapter } from "./adapter.js";

const NETWORK = "{http,https,http2,net,tls,dgram,node:http,node:https,node:http2,node:net,node:tls,node:dgram}";

/**
 * What the platform does, which every project has: `fetch`, and Node's network, file and process modules. TypeScript's
 * own library counts as the `typescript` package; Node's declarations come from `@types/node` and `undici-types`.
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
});
