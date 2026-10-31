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

ruleTester.run("no-unbounded-queries", plugin.rules["no-unbounded-queries"], {
  valid: [
    {
      name: "a server function that loads a page",
      filename: actions,
      code: `
"use server";
import { prisma } from "./db.js";
export async function listPlans() {
  return prisma.plan.findMany({ take: 50 });
}`,
    },
  ],
  invalid: [
    {
      name: "a server function that loads every plan",
      filename: actions,
      code: `
"use server";
import { prisma } from "./db.js";
export async function listPlans() {
  return prisma.plan.findMany();
}`,
      errors: [
        {
          messageId: "finding",
          line: 5,
          data: { message: "listPlans() loads every row through prisma.plan.findMany(), so each request loads more as the table grows" },
        },
      ],
    },
  ],
});
