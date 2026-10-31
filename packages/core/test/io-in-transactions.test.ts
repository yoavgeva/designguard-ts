import { describe, expect, it } from "vitest";
import { analyze, defineAdapter } from "../src/index.js";
import { prismaStub, project } from "./fixture.js";

const prisma = defineAdapter({
  name: "prisma",
  packages: ["@prisma/client"],
  effects: [{ on: "*Delegate.update", kind: "db.write" }],
  transactions: [{ on: "PrismaClient.$transaction", body: 0 }],
});

/** The io-in-transactions findings in `src/main.ts`, as `line: message`. */
function findings(files: Record<string, string>): string[] {
  const { program } = project({ ...prismaStub, ...files });
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
  if (main === undefined) throw new Error("no src/main.ts");
  return analyze(program, { adapters: [prisma] })
    .ioInTransactions(main)
    .map((finding) => `${String(main.getLineAndCharacterOfPosition(finding.node.getStart()).line + 1)}: ${finding.message}`);
}

const notify = `
  export async function notify(url: string) {
    return fetch(url, { method: "POST" });
  }`;

describe("ioInTransactions", () => {
  it("flags HTTP requests made inside a transaction, directly, through other functions, or by the function it runs", () => {
    expect(
      findings({
        "src/notify.ts": notify,
        "src/main.ts": `
          import { PrismaClient } from "@prisma/client";
          import { notify } from "./notify.js";
          const prisma = new PrismaClient();
          export async function pay(id: string) {
            await prisma.$transaction(async (tx) => {
              await tx.user.update({ where: { id }, data: {} });
              await notify("https://hooks.example.com");
              await fetch("https://audit.example.com");
            });
            await notify("https://hooks.example.com");
          }
          async function work(tx: PrismaClient) {
            await tx.user.update({ where: { id: "1" }, data: {} });
            await notify("https://hooks.example.com");
          }
          export async function payLater() {
            await prisma.$transaction(work);
          }`,
      }),
    ).toEqual([
      "8: makes an HTTP request inside prisma.$transaction() through notify(), which reaches fetch() (src/notify.ts:3): the transaction holds its database connection while it waits, and a rollback can't undo the request",
      "9: makes an HTTP request inside prisma.$transaction() through fetch(): the transaction holds its database connection while it waits, and a rollback can't undo the request",
      "18: makes an HTTP request inside prisma.$transaction() through work(), which reaches fetch() (src/notify.ts:3): the transaction holds its database connection while it waits, and a rollback can't undo the request",
    ]);
  });

  it("passes database work inside transactions, and requests outside them", () => {
    expect(
      findings({
        "src/notify.ts": notify,
        "src/main.ts": `
          import { PrismaClient } from "@prisma/client";
          import { notify } from "./notify.js";
          const prisma = new PrismaClient();
          export async function pay(id: string) {
            const user = await prisma.$transaction(async (tx) => tx.user.update({ where: { id }, data: {} }));
            await notify("https://hooks.example.com");
            return user;
          }`,
      }),
    ).toEqual([]);
  });
});
