import { join } from "node:path";
import plugin from "../src/index.js";
import { prisma, prismaFiles, typedProject } from "./fixture.js";

const { root, ruleTester } = typedProject(
  {
    ...prismaFiles,
    "node_modules/@prisma/client/index.d.ts": prismaFiles["node_modules/@prisma/client/index.d.ts"]?.replace(
      "findUnique(args: object): Promise<{ id: string } | null>;",
      "findUnique(args: object): Promise<{ id: string; credits: number } | null>;",
    ) ?? "",
    "src/db.ts": `
import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();`,
    "src/credits.ts": "",
  },
  [prisma],
);
const credits = join(root, "src/credits.ts");

ruleTester.run("no-lost-updates", plugin.rules["no-lost-updates"], {
  valid: [
    {
      name: "a change the database makes",
      filename: credits,
      code: `
import { prisma } from "./db.js";
export async function spend(id: string, amount: number) {
  await prisma.user.update({ where: { id }, data: { credits: { decrement: amount } } });
}`,
    },
  ],
  invalid: [
    {
      name: "a value computed from one read before",
      filename: credits,
      code: `
import { prisma } from "./db.js";
export async function spend(id: string, amount: number) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (user === null) return;
  await prisma.user.update({ where: { id }, data: { credits: user.credits - amount } });
}`,
      errors: [
        {
          messageId: "finding",
          line: 6,
          data: {
            message:
              "sets credits from its value read through prisma.user.findUnique() (src/credits.ts:4): a request that changes it between that read and this write is lost",
          },
        },
      ],
    },
  ],
});
