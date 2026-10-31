import { defineAdapter, type ParameterSpec } from "@designguard/core";

// A procedure's resolver takes `{ ctx, input }`: the context the server made for the request, which holds the user
// asking, and the input it sent.
const parameters: ParameterSpec[] = [
  { at: 0, path: ["ctx"], holds: "context" },
  { at: 0, path: ["input"], holds: "input" },
];

/**
 * tRPC 10 and 11: queries and mutations, with the middleware the procedures they're built from `use()`, followed
 * through the builders kept in variables, as `const adminProcedure = authedProcedure.use(isAdmin)`.
 */
export default defineAdapter({
  name: "trpc",
  packages: ["@trpc/server"],
  versions: ">=10 <12",
  entryPoints: [
    { call: "ProcedureBuilder.query", handler: 0, reads: true, middleware: "ProcedureBuilder.use", parameters },
    { call: "ProcedureBuilder.mutation", handler: 0, middleware: "ProcedureBuilder.use", parameters },
  ],
});
