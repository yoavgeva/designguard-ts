import { describe, expect, it } from "vitest";
import { analyze, defineAdapter } from "../src/index.js";
import { prismaStub, project } from "./fixture.js";

const prisma = defineAdapter({
  name: "prisma",
  packages: ["@prisma/client"],
  effects: [{ on: "*Delegate.update", kind: "db.write" }],
  writes: [{ on: "*Delegate.update", argument: 0, property: "data" }],
});

/** The no-mass-assignment findings in `src/main.ts`, as `line: message`. */
function findings(files: Record<string, string>): string[] {
  const { program } = project({ ...prismaStub, ...files });
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
  if (main === undefined) throw new Error("no src/main.ts");
  return analyze(program, { adapters: [prisma] })
    .massAssignments(main)
    .map((finding) => `${String(main.getLineAndCharacterOfPosition(finding.node.getStart()).line + 1)}: ${finding.message}`);
}

describe("massAssignments", () => {
  it("flags handlers that save what the request sends as it is, when it has a property the request shouldn't set", () => {
    expect(
      findings({
        "src/db.ts": `
          import { PrismaClient } from "@prisma/client";
          export const prisma = new PrismaClient();`,
        "src/users.ts": `
          import { prisma } from "./db.js";
          export async function saveUser(id: string, user: { name: string; ownerId: string }) {
            await prisma.user.update({ where: { id }, data: user });
          }
          export async function getCurrentUser() { return { id: "1" }; }
          export async function assertCanEditUsers() {}`,
        "src/main.ts": `
          "use server";
          import { prisma } from "./db.js";
          import { saveUser, getCurrentUser, assertCanEditUsers } from "./users.js";
          type Profile = { name: string; role: string; isAdmin: boolean };
          export async function updateProfile(id: string, data: Profile) {
            await prisma.user.update({ where: { id }, data });
          }
          export async function updateOwnProfile(data: Profile) {
            const me = await getCurrentUser();
            await prisma.user.update({ where: { id: me.id }, data: { ...data, isAdmin: false } });
          }
          export async function renameProfile(id: string, data: Profile) {
            await prisma.user.update({ where: { id }, data: { ...data, role: "user", isAdmin: false } });
          }
          export async function copyProfile(id: string, data: Profile) {
            await prisma.user.update({ where: { id }, data: { name: data.name } });
          }
          export async function transferProfile(id: string, data: { name: string; ownerId: string }) {
            await saveUser(id, data);
          }
          export async function promoteProfile(id: string, data: Profile) {
            await assertCanEditUsers();
            await prisma.user.update({ where: { id }, data });
          }
          export async function describeProfile(id: string, data: { name: string; bio: string }) {
            await prisma.user.update({ where: { id }, data });
          }`,
      }),
    ).toEqual([
      "7: updateProfile() saves what the request sends as it is through prisma.user.update(), so the request can set role and isAdmin",
      "11: updateOwnProfile() saves what the request sends as it is through prisma.user.update(), so the request can set role",
      "20: transferProfile() saves what the request sends as it is through saveUser(), which reaches prisma.user.update() (src/users.ts:4), so the request can set ownerId",
    ]);
  });
});
