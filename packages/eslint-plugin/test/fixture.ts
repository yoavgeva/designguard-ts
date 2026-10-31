import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/** A typed project on disk, its files by path, and a RuleTester that lints files in it with these adapters. */
export function typedProject(files: Record<string, string>, adapters: readonly unknown[]): { root: string; ruleTester: RuleTester } {
  const root = mkdtempSync(join(tmpdir(), "designguard-eslint-"));
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true, types: [] },
      include: ["src"],
    }),
    "package.json": JSON.stringify({ name: "fixture", type: "module" }),
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const ruleTester = new RuleTester({
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: root } },
    settings: { designguard: { adapters } },
  });
  return { root, ruleTester };
}

export const prismaFiles: Record<string, string> = {
  "node_modules/@prisma/client/package.json": JSON.stringify({ name: "@prisma/client", version: "6.1.0", types: "index.d.ts" }),
  "node_modules/@prisma/client/index.d.ts": `
    export declare namespace Prisma {
      interface UserDelegate {
        findUnique(args: object): Promise<{ id: string } | null>;
        update(args: object): Promise<{ id: string }>;
      }
      interface PlanDelegate { findMany(args?: object): Promise<{ id: string }[]> }
    }
    export declare class PrismaClient {
      user: Prisma.UserDelegate;
      plan: Prisma.PlanDelegate;
      $transaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T>;
    }`,
};

export const prisma = {
  name: "prisma",
  packages: ["@prisma/client"],
  effects: [
    { on: "*Delegate.{findUnique,findMany}", kind: "db.read" },
    { on: "*Delegate.update", kind: "db.write" },
  ],
  lookups: ["*Delegate.findUnique"],
  lists: [{ on: "*Delegate.findMany", argument: 0, bounds: "{where,take}" }],
  writes: [{ on: "*Delegate.update", argument: 0, property: "data" }],
  transactions: [{ on: "PrismaClient.$transaction", body: 0 }],
};
