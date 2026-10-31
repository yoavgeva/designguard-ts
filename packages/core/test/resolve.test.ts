import ts from "typescript";
import { describe, expect, it } from "vitest";
import { resolveCall } from "../src/resolve.js";
import { prismaStub, project } from "./fixture.js";

/** Every call in `src/main.ts`, by its callee's text, resolved. */
function resolutions(files: Record<string, string>) {
  const { program } = project(files);
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
});
