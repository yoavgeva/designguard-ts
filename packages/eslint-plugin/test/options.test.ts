import { join } from "node:path";
import plugin from "../src/index.js";
import { prisma, prismaFiles, typedProject } from "./fixture.js";

const { root, ruleTester } = typedProject(
  {
    ...prismaFiles,
    "src/db.ts": `
import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();`,
    "src/users.ts": `
import { prisma } from "./db.js";
export async function loadUser(id: string) {
  return prisma.user.findUnique({ where: { id } });
}`,
    "src/legacy/plans.ts": `
import { prisma } from "../db.js";
export async function loadPlans() {
  return prisma.plan.findMany();
}`,
    "src/main.ts": "",
    "src/scripts/seed.ts": "",
  },
  [prisma],
);

const code = `
import { loadUser } from "./users.js";
import { loadPlans } from "./legacy/plans.js";
export async function show(ids: string[]) {
  for (const id of ids) {
    await loadUser(id);
    await loadPlans();
  }
}`;
const main = join(root, "src/main.ts");
const userError = { messageId: "finding" as const, line: 6 };
const planError = { messageId: "finding" as const, line: 7 };

ruleTester.run("shared options", plugin.rules["no-queries-in-loops"], {
  valid: [
    { name: "exclude a file by its path", filename: main, code, options: [{ exclude: ["src/main.ts"] }] },
    { name: "exclude a function by its name", filename: main, code, options: [{ exclude: ["#show"] }] },
    { name: "include only other files", filename: main, code, options: [{ include: ["src/scripts/**"] }] },
  ],
  invalid: [
    { name: "with no options, both are found", filename: main, code, errors: [userError, planError] },
    {
      name: "excludeReaching a project folder",
      filename: main,
      code,
      options: [{ excludeReaching: ["src/legacy/**"] }],
      errors: [userError],
    },
    {
      name: "excludeReaching a package's declarations",
      filename: main,
      code,
      options: [{ excludeReaching: ["@prisma/client#*PlanDelegate.*"] }],
      errors: [userError],
    },
    {
      name: "include a function by file and name",
      filename: main,
      code,
      options: [{ include: ["src/*.ts#show"] }],
      errors: [userError, planError],
    },
  ],
});
