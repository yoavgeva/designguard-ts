import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import plugin from "../src/index.js";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const root = mkdtempSync(join(tmpdir(), "designguard-eslint-"));
const files: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true },
    include: ["src"],
  }),
  "package.json": JSON.stringify({ name: "fixture", type: "module" }),
  "node_modules/@prisma/client/package.json": JSON.stringify({ name: "@prisma/client", version: "6.1.0", types: "index.d.ts" }),
  "node_modules/@prisma/client/index.d.ts": `
    export declare namespace Prisma {
      interface UserDelegate { findUnique(args: object): Promise<{ id: string } | null> }
    }
    export declare class PrismaClient { user: Prisma.UserDelegate }`,
  "src/users.ts": `
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
export async function loadUser(id: string) {
  return prisma.user.findUnique({ where: { id } });
}`,
  "src/main.ts": "",
};
for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const prisma = {
  name: "prisma",
  packages: ["@prisma/client"],
  effects: [{ on: "*Delegate.findUnique", kind: "db.read" }],
};

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: root } },
  settings: { designguard: { adapters: [prisma] } },
});

const rule = plugin.rules["no-queries-in-loops"];

ruleTester.run("no-queries-in-loops", rule, {
  valid: [
    {
      filename: join(root, "src/main.ts"),
      code: `
import { loadUser } from "./users.js";
export async function show(ids: string[]) {
  return loadUser(ids[0] ?? "");
}`,
    },
  ],
  invalid: [
    {
      filename: join(root, "src/main.ts"),
      code: `
import { loadUser } from "./users.js";
export async function show(ids: string[]) {
  for (const id of ids) {
    await loadUser(id);
  }
}`,
      errors: [
        {
          messageId: "finding",
          line: 5,
          data: {
            message:
              "queries the database once per item: the for…of loop calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
          },
        },
      ],
    },
  ],
});
