import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";

/** A project written to a temporary directory: its files by path, `node_modules` stubs included. */
export function project(files: Record<string, string>): { root: string; program: ts.Program } {
  const root = mkdtempSync(join(tmpdir(), "designguard-"));
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx", skipLibCheck: true },
      include: ["src"],
    }),
    "package.json": JSON.stringify({ name: "fixture", type: "module" }),
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (config === undefined) throw new Error("no tsconfig");
  return { root, program: ts.createProgram(config.fileNames, config.options) };
}

/** A typed stub of a package, as `node_modules/<name>` with its `package.json`. */
export function stubPackage(name: string, version: string, declarations: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, version, types: "index.d.ts" }),
    [`node_modules/${name}/index.d.ts`]: declarations,
  };
}

export const kyselyStub = stubPackage(
  "kysely",
  "0.28.0",
  `export interface SelectQueryBuilder<O> {
     where(column: string, op: string, value: unknown): SelectQueryBuilder<O>;
     execute(): Promise<O[]>;
   }
   export declare class Kysely<DB> {
     selectFrom(table: string): SelectQueryBuilder<{ id: string }>;
   }`,
);

export const prismaStub = stubPackage(
  "@prisma/client",
  "6.1.0",
  `export declare namespace Prisma {
     interface UserDelegate {
       findMany(args?: object): Promise<{ id: string }[]>;
       findUnique(args: object): Promise<{ id: string } | null>;
       update(args: object): Promise<{ id: string }>;
     }
   }
   export declare class PrismaClient {
     user: Prisma.UserDelegate;
     $transaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T>;
   }`,
);
