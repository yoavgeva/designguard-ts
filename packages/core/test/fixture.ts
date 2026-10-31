import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { defineAdapter } from "../src/index.js";

/**
 * A project written to a temporary directory: its files by path, `node_modules` stubs included, and `links` from
 * paths to the folders they point at, as a workspace links its packages into `node_modules`.
 */
export function project(files: Record<string, string>, links: Record<string, string> = {}): { root: string; program: ts.Program } {
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
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(join(root, target), join(root, path));
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

/** A router like Express's: `router()` gives routes whose handlers take a request and a response. */
export const routerStub = stubPackage(
  "router",
  "1.0.0",
  `export interface Request {
     params: Record<string, string>;
     headers: Record<string, string | undefined>;
     body: unknown;
     user?: { id: string };
     workspace?: { id: string };
     db: import("@prisma/client").PrismaClient;
     locals: { user?: { id: string } };
   }
   export interface Response { json(value: unknown): void }
   export type Handler = (req: Request, res: Response, next: () => void) => unknown;
   export interface RouterMatcher { (path: string, ...handlers: Handler[]): void }
   export interface Router { get: RouterMatcher; post: RouterMatcher; delete: RouterMatcher }
   export declare function router(): Router;`,
);

const parameters = [
  { at: 0, holds: "context" },
  { at: 0, path: ["{body,params,headers}"], holds: "input" },
  { at: 1, holds: "context" },
] as const;

export const router = defineAdapter({
  name: "router",
  packages: ["router"],
  entryPoints: [
    { call: "Router.get", reads: true, parameters },
    { call: "Router.{post,delete}", parameters },
  ],
});
