import { join } from "node:path";
import plugin from "../src/index.js";
import { prisma, prismaFiles, typedProject } from "./fixture.js";

const { root, ruleTester } = typedProject(
  {
    ...prismaFiles,
    "src/db.ts": `
import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();`,
    "src/session.ts": `
export async function getCurrentUser() { return { id: "1" }; }`,
    "src/actions.ts": "",
  },
  [prisma],
);
const actions = join(root, "src/actions.ts");

ruleTester.run("writes-are-authorized", plugin.rules["writes-are-authorized"], {
  valid: [
    {
      name: "a server function that gets the user asking",
      filename: actions,
      code: `
"use server";
import { prisma } from "./db.js";
import { getCurrentUser } from "./session.js";
export async function renamePost(id: string) {
  const user = await getCurrentUser();
  await prisma.user.update({ where: { id, ownerId: user.id }, data: {} });
}`,
    },
  ],
  invalid: [
    {
      name: "a server function that writes by the id it's given",
      filename: actions,
      code: `
"use server";
import { prisma } from "./db.js";
export async function deletePost(id: string) {
  await prisma.user.update({ where: { id }, data: {} });
}`,
      errors: [
        {
          messageId: "finding",
          line: 5,
          data: { message: "deletePost() writes to the database through prisma.user.update() with nothing checking that the user asking may" },
        },
      ],
    },
  ],
});

ruleTester.run("reads-are-authorized", plugin.rules["reads-are-authorized"], {
  valid: [
    {
      name: "a server function that reads a record of the user asking",
      filename: actions,
      code: `
"use server";
import { prisma } from "./db.js";
import { getCurrentUser } from "./session.js";
export async function loadPost(id: string) {
  const user = await getCurrentUser();
  return prisma.user.findUnique({ where: { id, ownerId: user.id } });
}`,
    },
  ],
  invalid: [
    {
      name: "a server function that reads a record by the id it's given",
      filename: actions,
      code: `
"use server";
import { prisma } from "./db.js";
export async function loadPost(id: string) {
  return prisma.user.findUnique({ where: { id } });
}`,
      errors: [
        {
          messageId: "finding",
          line: 5,
          data: {
            message: "loadPost() reads a record by a key the request sends through prisma.user.findUnique(): nothing checks that the user asking may see it",
          },
        },
      ],
    },
  ],
});
