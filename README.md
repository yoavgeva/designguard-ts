# designguard for TypeScript

Design rules for TypeScript code, AI-written code included, as an ESLint plugin. The rules follow calls across
files, so they find a database query three calls down a service, or an HTTP request inside a transaction, where a
check that reads one file at a time sees nothing.

> Status: in development. The plugin isn't published yet.

## Install

```sh
npm install --save-dev eslint-plugin-designguard @designguard/adapter-prisma
```

The rules need [typed linting](https://typescript-eslint.io/getting-started/typed-linting): typescript-eslint 8 with
`projectService`, on ESLint 9.15 or later. They run on whatever TypeScript typescript-eslint supports.

```js
// eslint.config.js
import tseslint from "typescript-eslint";
import designguard from "eslint-plugin-designguard";
import prisma from "@designguard/adapter-prisma";

export default tseslint.config(
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    settings: { designguard: { adapters: [prisma] } },
  },
  designguard.configs.recommended,
);
```

## Rules

| Rule | Flags | Recommended |
|---|---|---|
| [`no-queries-in-loops`](docs/rules/no-queries-in-loops.md) | a database query made once per item of a loop, directly or through other functions: N+1 | ✓ |
| [`no-io-in-transactions`](docs/rules/no-io-in-transactions.md) | HTTP requests, mail and messages inside a database transaction | ✓ |
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

designguard's core knows only the language and the platform: `fetch`, and Node's network, file and process modules.
Everything a library does comes from its **adapter**, data that names the library's calls and what they do. Adapters
are listed in `settings.designguard.adapters`; nothing is detected for you.

| Adapter | Library |
|---|---|
| `@designguard/adapter-prisma` | Prisma Client, `node_modules/.prisma/client` or a client generated into `generated/prisma` |
| `@designguard/adapter-drizzle` | Drizzle ORM |
| `@designguard/adapter-typeorm` | TypeORM |
| `@designguard/adapter-kysely` | Kysely |

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
});
```

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
