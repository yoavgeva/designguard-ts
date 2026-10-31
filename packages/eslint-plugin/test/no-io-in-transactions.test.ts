import { join } from "node:path";
import plugin from "../src/index.js";
import { prisma, prismaFiles, typedProject } from "./fixture.js";

const { root, ruleTester } = typedProject(
  {
    ...prismaFiles,
    "src/notify.ts": `
export async function notify(url: string) {
  return fetch(url, { method: "POST" });
}`,
    "src/main.ts": "",
  },
  [prisma],
);
const main = join(root, "src/main.ts");

ruleTester.run("no-io-in-transactions", plugin.rules["no-io-in-transactions"], {
  valid: [
    {
      filename: main,
      code: `
import { PrismaClient } from "@prisma/client";
import { notify } from "./notify.js";
const prisma = new PrismaClient();
export async function pay(id: string) {
  await prisma.$transaction(async (tx) => tx.user.findUnique({ where: { id } }));
  await notify("https://hooks.example.com");
}`,
    },
  ],
  invalid: [
    {
      filename: main,
      code: `
import { PrismaClient } from "@prisma/client";
import { notify } from "./notify.js";
const prisma = new PrismaClient();
export async function pay(id: string) {
  await prisma.$transaction(async (tx) => {
    await tx.user.findUnique({ where: { id } });
    await notify("https://hooks.example.com");
  });
}`,
      errors: [
        {
          messageId: "finding",
          line: 8,
          data: {
            message:
              "makes an HTTP request inside prisma.$transaction() through notify(), which reaches fetch() (src/notify.ts:3): " +
              "the transaction holds its database connection while it waits, and a rollback can't undo the request",
          },
        },
      ],
    },
  ],
});
