import { describe, expect, it } from "vitest";
import { analyze, defineAdapter } from "../src/index.js";
import { prismaStub, project } from "./fixture.js";

const prisma = defineAdapter({
  name: "prisma",
  packages: ["@prisma/client"],
  effects: [
    { on: "*Delegate.{findMany,findUnique,findFirst,count}", kind: "db.read" },
    { on: "*Delegate.{create,update,upsert,delete}", kind: "db.write" },
  ],
});

/** The queries-in-loops findings in `src/main.ts`, as `line: message`. */
function findings(files: Record<string, string>): string[] {
  const { program } = project({ ...prismaStub, ...files });
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
  if (main === undefined) throw new Error("no src/main.ts");
  return analyze(program, [prisma])
    .queriesInLoops(main)
    .map((finding) => `${main.getLineAndCharacterOfPosition(finding.node.getStart()).line + 1}: ${finding.message}`);
}

const users = `
  import { PrismaClient } from "@prisma/client";
  const prisma = new PrismaClient();
  export async function loadUser(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }
  export function label(id: string) {
    return id.toUpperCase();
  }
  export class Users {
    async rename(id: string) {
      return prisma.user.update({ where: { id }, data: {} });
    }
  }`;

describe("queriesInLoops", () => {
  it("flags a query made once per item, through other functions, in loops and in array callbacks", () => {
    expect(
      findings({
        "src/users.ts": users,
        "src/main.ts": `
          import { PrismaClient } from "@prisma/client";
          import { loadUser, Users } from "./users.js";
          const prisma = new PrismaClient();
          export async function show(ids: string[], service: Users) {
            for (const id of ids) {
              await loadUser(id);
            }
            await Promise.all(ids.map((id) => prisma.user.findUnique({ where: { id } })));
            await Promise.all(ids.map(loadUser));
            ids.forEach((id) => void service.rename(id));
          }`,
      }),
    ).toEqual([
      "7: queries the database once per item: the for…of loop calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
      "9: queries the database once per item: map() calls prisma.user.findUnique()",
      "10: queries the database once per item: map() calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
      "11: queries the database once per item: forEach() calls service.rename(), which reaches prisma.user.update() (src/users.ts:12)",
    ]);
  });

  it("reads a client generated into the project as the adapter's package, when the adapter claims its files", () => {
    const generated = defineAdapter({ ...prisma, files: ["**/generated/prisma/**"] });
    const { program } = project({
      "src/generated/prisma/client.ts": `
        export interface UserDelegate { findUnique(args: object): Promise<{ id: string } | null> }
        export declare const prisma: { user: UserDelegate };`,
      "src/main.ts": `
        import { prisma } from "./generated/prisma/client.js";
        export async function show(ids: string[]) {
          for (const id of ids) await prisma.user.findUnique({ where: { id } });
        }`,
    });
    const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
    if (main === undefined) throw new Error("no src/main.ts");
    expect(analyze(program, [generated]).queriesInLoops(main).map((finding) => finding.message)).toEqual([
      "queries the database once per item: the for…of loop calls prisma.user.findUnique()",
    ]);
    expect(analyze(program, [prisma]).queriesInLoops(main)).toEqual([]);
  });

  it("passes queries outside loops, and loops that touch nothing outside the code", () => {
    expect(
      findings({
        "src/users.ts": users,
        "src/main.ts": `
          import { loadUser, label } from "./users.js";
          export async function show(ids: string[]) {
            const first = await loadUser(ids[0] ?? "");
            const labels = ids.map(label);
            for (const id of ids) label(id);
            const later = ids.map((id) => () => loadUser(id));
            return { first, labels, later };
          }`,
      }),
    ).toEqual([]);
  });
});
