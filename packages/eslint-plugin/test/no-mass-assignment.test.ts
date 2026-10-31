import { join } from "node:path";
import plugin from "../src/index.js";
import { prisma, prismaFiles, typedProject } from "./fixture.js";

const { root, ruleTester } = typedProject(
  {
    ...prismaFiles,
    "src/db.ts": `
import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();`,
    "src/actions.ts": "",
  },
  [prisma],
);
const actions = join(root, "src/actions.ts");

ruleTester.run("no-mass-assignment", plugin.rules["no-mass-assignment"], {
  valid: [
    {
      name: "a server function that sets the role itself",
      filename: actions,
      code: `
"use server";
import { prisma } from "./db.js";
export async function updateProfile(id: string, profile: { name: string; role: string }) {
  await prisma.user.update({ where: { id }, data: { ...profile, role: "member" } });
}`,
    },
  ],
  invalid: [
    {
      name: "a server function that saves the profile it's sent",
      filename: actions,
      code: `
"use server";
import { prisma } from "./db.js";
export async function updateProfile(id: string, profile: { name: string; role: string }) {
  await prisma.user.update({ where: { id }, data: profile });
}`,
      errors: [
        {
          messageId: "finding",
          line: 5,
          data: { message: "updateProfile() saves what the request sends as it is through prisma.user.update(), so the request can set role" },
        },
      ],
    },
  ],
});
