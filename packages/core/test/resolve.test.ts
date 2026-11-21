import ts from "typescript";
import { describe, expect, it } from "vitest";
import { resolveCall } from "../src/resolve.js";
import { prismaStub, project, stubPackage } from "./fixture.js";

/** Every call in `src/main.ts`, by its callee's text, resolved. */
function resolutions(files: Record<string, string>, links: Record<string, string> = {}) {
  const { program } = project(files, links);
  const checker = program.getTypeChecker();
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
  if (main === undefined) throw new Error("no src/main.ts");
  const found: Record<string, unknown> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const resolution = resolveCall(program, checker, node);
      found[node.expression.getText()] =
        resolution.kind === "dependency"
          ? { kind: resolution.kind, package: resolution.package, name: resolution.name }
          : resolution.kind === "project"
            ? { kind: resolution.kind, targets: resolution.targets.map((target) => describeDeclaration(target)) }
            : { kind: resolution.kind };
    }
    ts.forEachChild(node, visit);
  };
  visit(main);
  return found;
}

function describeDeclaration(node: ts.Node): string {
  const file = node.getSourceFile().fileName.replace(/^.*\/src\//, "");
  const owner = ts.isClassDeclaration(node.parent) && node.parent.name !== undefined ? `${node.parent.name.text}.` : "";
  const name = (node as ts.NamedDeclaration).name;
  return `${file}#${owner}${name !== undefined && ts.isIdentifier(name) ? name.text : "<anonymous>"}`;
}

describe("resolveCall", () => {
  it("resolves project functions through imports, barrels, classes, objects and interfaces", () => {
    expect(
      resolutions({
        "src/users.ts": `
          export function loadUser(id: string) { return id; }
          export const users = { find(id: string) { return id; } };
          export class UserService { load(id: string) { return id; } }
          export interface Store { get(id: string): string }
          export class SqlStore implements Store { get(id: string) { return id; } }
          export class MemoryStore implements Store { get(id: string) { return id; } }`,
        "src/index.ts": `export { loadUser as fetchUser } from "./users.js";`,
        "src/main.ts": `
          import { fetchUser } from "./index.js";
          import { users, UserService, type Store } from "./users.js";
          declare const store: Store;
          class Handler {
            constructor(private readonly service: UserService) {}
            run() { return this.service.load("1"); }
          }
          fetchUser("1");
          users.find("1");
          store.get("1");
          new Handler(new UserService()).run();`,
      }),
    ).toEqual({
      fetchUser: { kind: "project", targets: ["users.ts#loadUser"] },
      "users.find": { kind: "project", targets: ["users.ts#find"] },
      "store.get": { kind: "project", targets: ["users.ts#SqlStore.get", "users.ts#MemoryStore.get"] },
      "this.service.load": { kind: "project", targets: ["users.ts#UserService.load"] },
      "new Handler(new UserService()).run": { kind: "project", targets: ["main.ts#Handler.run"] },
    });
  });

  it("names a dependency's package and qualified name, and doesn't follow calls through any", () => {
    expect(
      resolutions({
        ...prismaStub,
        "src/main.ts": `
          import { PrismaClient } from "@prisma/client";
          const prisma = new PrismaClient();
          declare const untyped: any;
          prisma.user.findMany();
          [1, 2].map((n) => n);
          untyped.load();`,
      }),
    ).toEqual({
      "prisma.user.findMany": { kind: "dependency", package: "@prisma/client", name: "Prisma.UserDelegate.findMany" },
      "[1, 2].map": { kind: "lib", },
      "untyped.load": { kind: "unresolved" },
    });
  });

  it("names a package in a dot folder of node_modules by the folder and its subfolder, as Prisma generates its client", () => {
    expect(
      resolutions({
        "node_modules/@prisma/client/package.json": JSON.stringify({ name: "@prisma/client", version: "6.1.0", types: "index.d.ts" }),
        "node_modules/@prisma/client/index.d.ts": `export * from ".prisma/client";`,
        "node_modules/.prisma/client/package.json": JSON.stringify({ name: "prisma-client-58827e45", types: "index.d.ts" }),
        "node_modules/.prisma/client/index.d.ts": `
          export interface UserDelegate { findMany(args?: object): Promise<{ id: string }[]> }
          export declare class PrismaClient { user: UserDelegate }`,
        "src/main.ts": `
          import { PrismaClient } from "@prisma/client";
          new PrismaClient().user.findMany();`,
      }),
    ).toEqual({
      "new PrismaClient().user.findMany": { kind: "dependency", package: ".prisma/client", name: "UserDelegate.findMany" },
    });
  });

  it("names a call through a property or variable of a function type by the property or variable", () => {
    expect(
      resolutions({
        ...stubPackage(
          "router",
          "1.0.0",
          `export interface RouterMatcher { (path: string, ...handlers: ((request: unknown) => void)[]): void }
           export interface Router { post: RouterMatcher; get: (path: string) => void }
           export declare const Post: (path?: string) => MethodDecorator;
           export declare function router(): Router;`,
        ),
        "src/main.ts": `
          import { router, Post } from "router";
          const app = router();
          app.post("/orders", () => {});
          app.get("/orders");
          Post("/orders");`,
      }),
    ).toEqual({
      router: { kind: "dependency", package: "router", name: "router" },
      "app.post": { kind: "dependency", package: "router", name: "Router.post" },
      "app.get": { kind: "dependency", package: "router", name: "Router.get" },
      Post: { kind: "dependency", package: "router", name: "Post" },
    });
  });

  it("names a workspace package typed by what it builds by its package.json, as a dependency, not the project's own", () => {
    expect(
      resolutions(
        {
          "packages/orm/package.json": JSON.stringify({ name: "@acme/orm", types: "dist/index.d.ts" }),
          "packages/orm/dist/index.d.ts": "export declare class Repo { find(): Promise<object[]> }",
          "src/env.d.ts": "declare function loadConfig(): Promise<object>;",
          "src/main.ts": `
            import { Repo } from "@acme/orm";
            new Repo().find();
            loadConfig();`,
        },
        { "node_modules/@acme/orm": "packages/orm" },
      ),
    ).toEqual({
      "new Repo().find": { kind: "dependency", package: "@acme/orm", name: "Repo.find" },
      loadConfig: { kind: "dependency", package: "", name: "loadConfig" },
    });
  });

  it("follows calls into a workspace package linked into node_modules as the project's own code", () => {
    expect(
      resolutions(
        {
          "packages/services/package.json": JSON.stringify({ name: "@acme/services", type: "module", exports: { ".": "./src/index.ts" } }),
          "packages/services/src/index.ts": "export function createKey(name: string) { return name; }",
          "src/main.ts": `
            import { createKey } from "@acme/services";
            createKey("ci");`,
        },
        { "node_modules/@acme/services": "packages/services" },
      ),
    ).toEqual({ createKey: { kind: "project", targets: ["index.ts#createKey"] } });
  });
});
