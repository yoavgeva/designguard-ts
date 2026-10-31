# designguard for TypeScript

Design rules for TypeScript code, AI-written code included, as an ESLint plugin. The rules follow calls across
files, so they find a database query three calls down a service, an HTTP request inside a transaction, or an
endpoint that changes a record with nothing checking who asks, where a check that reads one file at a time sees
nothing.

> Status: in development. The plugin isn't published yet.

## Install

```sh
npm install --save-dev eslint-plugin-designguard @designguard/adapter-prisma @designguard/adapter-trpc
```

The rules need [typed linting](https://typescript-eslint.io/getting-started/typed-linting): typescript-eslint 8 with
`projectService`, on ESLint 9.15 or later. They run on whatever TypeScript typescript-eslint supports.

```js
// eslint.config.js
import tseslint from "typescript-eslint";
import designguard from "eslint-plugin-designguard";
import prisma from "@designguard/adapter-prisma";
import trpc from "@designguard/adapter-trpc";

export default tseslint.config(
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    settings: { designguard: { adapters: [prisma, trpc] } },
  },
  designguard.configs.recommended,
);
```

## Rules

| Rule | Flags | Recommended |
|---|---|---|
| [`no-queries-in-loops`](docs/rules/no-queries-in-loops.md) | a database query made once per item of a loop, directly or through other functions: N+1 | ✓ |
| [`no-io-in-transactions`](docs/rules/no-io-in-transactions.md) | HTTP requests, mail and messages inside a database transaction | ✓ |
| [`writes-are-authorized`](docs/rules/writes-are-authorized.md) | a request handler that writes to the database with nothing checking that the user asking may | |
| [`reads-are-authorized`](docs/rules/reads-are-authorized.md) | a request handler that reads a record by a key the request sends with nothing checking that the user asking may see it | |
| [`no-mass-assignment`](docs/rules/no-mass-assignment.md) | a request handler that saves what the request sends as it is, when it can set `role`, an owner or a verified flag | |
| [`no-unbounded-queries`](docs/rules/no-unbounded-queries.md) | a request handler that loads every row of a table | |
| [`no-lost-updates`](docs/rules/no-lost-updates.md) | a value computed from one read before and written back, with no lock or version check | |
| [`no-unknown-io`](docs/rules/no-unknown-io.md) | calls into packages no adapter describes, so the other rules can't check them | |

`designguard.configs.recommended` turns on the recommended rules; `designguard.configs.all` turns on every rule.

### Turning rules on, off and down

Each rule is an ESLint rule: `"off"`, `"warn"` or `"error"`, and ESLint's `files` and `ignores` pick the files it
runs on. Every rule also takes the same three options. Each is a list of selectors:

- a path glob, such as `src/legacy/**`;
- `path#name`, a function in matching files;
- `#name`, a function anywhere;
- `package#name`, a package's declarations, such as `@prisma/client#*PlanDelegate.*`.

In paths, `*` stays within a folder and `**` crosses folders. In names, `*` matches anything. Paths are relative to
the parser's `tsconfigRootDir`.

```js
rules: {
  "designguard/no-queries-in-loops": ["error", {
    exclude: ["src/migrations/**", "#seed"], // findings in these files or functions aren't reported
    excludeReaching: ["@prisma/client#*CountryDelegate.*"], // nor findings that lead to these
  }],
  "designguard/no-unknown-io": ["warn", { include: ["src/api/**"] }], // only findings here are reported
}
```

`exclude` and `include` pick where findings are reported. `excludeReaching` picks what they lead to, so code in an
excluded folder is still followed, and a route that reaches a query through it is still flagged. To adopt a rule on
existing code, ESLint's [bulk suppressions](https://eslint.org/docs/latest/use/suppressions) (`eslint
--suppress-all`) record today's findings and report only new ones.

## Adapters

designguard's core knows only the language and the platform: `fetch`, Node's network, file and process modules, and
where requests come in on the web's own terms: React's server functions (`"use server"`) and route handlers, exported
functions named for an HTTP method that take a `Request`. Everything a library does comes from its **adapter**, data
that names the library's calls and what they do. Adapters are listed in `settings.designguard.adapters`; nothing is
detected for you.

| Adapter | Library |
|---|---|
| `@designguard/adapter-prisma` | Prisma Client, `node_modules/.prisma/client` or a client generated into `generated/prisma` |
| `@designguard/adapter-drizzle` | Drizzle ORM |
| `@designguard/adapter-typeorm` | TypeORM |
| `@designguard/adapter-kysely` | Kysely |
| `@designguard/adapter-express` | Express 4 and 5 routes and their middleware |
| `@designguard/adapter-hono` | Hono 4 routes and their middleware |
| `@designguard/adapter-trpc` | tRPC 10 and 11 queries and mutations, and the middleware of their procedures |
| `@designguard/adapter-nestjs` | NestJS controllers and GraphQL resolvers, their guards and parameter decorators |
| `@designguard/adapter-authjs` | Auth.js and NextAuth's sessions |

An adapter matches the declarations calls resolve to, by their qualified names, not import paths. So calls through
an app's own `db` module, re-exports and subclasses are recognized. An adapter that declares `versions` turns off
when the installed version is outside them, and [`no-unknown-io`](docs/rules/no-unknown-io.md) says so.

### Writing one

```ts
import { defineAdapter } from "@designguard/adapter-kit";

export default defineAdapter({
  name: "my-orm",
  packages: ["my-orm"],
  versions: ">=2 <4",
  effects: [
    { on: "Table.{find,count}", kind: "db.read" },
    { on: "Table.{insert,update,delete}", kind: "db.write" },
  ],
  transactions: [{ on: "Database.transaction", body: 0 }], // the argument that runs inside the transaction
  lookups: ["Table.find"], // reads of one record by its key
  lists: [{ on: "Table.list", argument: 0, bounds: "{where,limit}" }], // reads of every row, unless bounded
  writes: [{ on: "Table.update", argument: 1 }], // where a write takes the data it saves
});
```

An adapter for a framework says where requests come in and what a handler's parameters hold:

```ts
// req holds the user asking, as req.user; what the request sends is in req.body and req.params.
const parameters = [
  { at: 0, holds: "context" },
  { at: 0, path: ["{body,params}"], holds: "input" },
] as const;

export default defineAdapter({
  name: "my-router",
  packages: ["my-router"],
  entryPoints: [
    { call: "Router.get", reads: true, parameters },
    { call: "Router.{post,put,delete}", parameters }, // the last argument handles the request; those before are middleware
  ],
  users: ["getSession"], // calls that give the user asking
  checks: ["Router.requireRole"], // calls and decorators that check what they may do
});
```

Calls named for the user asking, as `getCurrentUser()` and `auth()` are, and for a permission check, as `assertCan()`
and `isAdmin()` are, count without an adapter.

Patterns use `*` for anything and `{a,b}` for either. A project can describe its own wrappers the same way, with a
local adapter in its ESLint config. `rolesOf` from `@designguard/adapter-kit` shows what an adapter makes of each
call in a sample, with the qualified name its patterns must match:

```ts
expect(rolesOf(adapter, { files: stubPackage("my-orm", "3.0.0", declarations), code })).toEqual([
  "db.users.find(): my-orm Table.find, db.read",
]);
```

## Use it alongside

designguard checks what no single file shows. These tools check the rest, so it doesn't repeat them:

- **typescript-eslint:** dropped promises (`no-floating-promises`), `any`, and `@ts-ignore` (`ban-ts-comment`).
- **dependency-cruiser, ArchUnitTS:** import rules, layers and cycles.
- **knip:** unused exports, and exports only tests use (`--production`).
- **eslint-plugin-react-hooks:** hooks, and React Compiler's rules.
- **jsx-a11y:** accessibility.
- **CodeQL, Semgrep:** injection and other security flaws.

## License

MIT
