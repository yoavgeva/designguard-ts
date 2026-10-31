import { describe, expect, it } from "vitest";
import { analyze, defineAdapter } from "../src/index.js";
import { kyselyStub, prismaStub, project, router, routerStub } from "./fixture.js";

const prisma = defineAdapter({
  name: "prisma",
  packages: ["@prisma/client"],
  effects: [{ on: "*Delegate.findMany", kind: "db.read" }],
  lists: [{ on: "*Delegate.findMany", argument: 0, bounds: "{where,take,cursor}" }],
});

const kysely = defineAdapter({
  name: "kysely",
  packages: ["kysely"],
  effects: [{ on: "SelectQueryBuilder.execute", kind: "db.read" }],
  lists: [{ on: "Kysely.selectFrom", bounds: "{where,limit}", runs: "execute" }],
});

/** The no-unbounded-queries findings in `src/main.ts`, as `line: message`. */
function findings(files: Record<string, string>): string[] {
  const { program } = project({ ...prismaStub, ...kyselyStub, ...routerStub, ...files });
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
  if (main === undefined) throw new Error("no src/main.ts");
  return analyze(program, { adapters: [router, prisma, kysely] })
    .unboundedQueries(main)
    .map((finding) => `${String(main.getLineAndCharacterOfPosition(finding.node.getStart()).line + 1)}: ${finding.message}`);
}

describe("unboundedQueries", () => {
  it("flags handlers that load every row, by options or by a chain, directly or through other functions", () => {
    expect(
      findings({
        "src/users.ts": `
          import { PrismaClient } from "@prisma/client";
          const prisma = new PrismaClient();
          export async function listAll() {
            return prisma.user.findMany();
          }
          export async function listActive() {
            return prisma.user.findMany({ where: { active: true } });
          }`,
        "src/main.ts": `
          import { router } from "router";
          import { PrismaClient } from "@prisma/client";
          import { Kysely } from "kysely";
          import { listAll, listActive } from "./users.js";
          const prisma = new PrismaClient();
          declare const db: Kysely<unknown>;
          declare const options: object;
          const app = router();
          app.get("/users", async (req, res) => res.json(await prisma.user.findMany()));
          app.get("/users/sorted", async (req, res) => res.json(await prisma.user.findMany({ orderBy: { name: "asc" } })));
          app.get("/users/page", async (req, res) => res.json(await prisma.user.findMany({ take: 20 })));
          app.get("/users/all", async (req, res) => res.json(await listAll()));
          app.get("/users/active", async (req, res) => res.json(await listActive()));
          app.get("/users/options", async (req, res) => res.json(await prisma.user.findMany(options)));
          app.get("/rows", async (req, res) => res.json(await db.selectFrom("users").execute()));
          app.get("/rows/one", async (req, res) => res.json(await db.selectFrom("users").where("id", "=", "1").execute()));
          export async function report() {
            return prisma.user.findMany();
          }`,
      }),
    ).toEqual([
      "10: the GET /users handler loads every row through prisma.user.findMany(), so each request loads more as the table grows",
      "11: the GET /users/sorted handler loads every row through prisma.user.findMany(), so each request loads more as the table grows",
      "13: the GET /users/all handler loads every row through listAll(), which reaches prisma.user.findMany() (src/users.ts:5), so each request loads more as the table grows",
      "16: the GET /rows handler loads every row through db.selectFrom(), so each request loads more as the table grows",
    ]);
  });
});
