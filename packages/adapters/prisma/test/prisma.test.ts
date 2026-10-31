import { rolesOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import prisma from "../src/index.js";

// The shape of a client the prisma-client generator writes into the project: model delegates and $transaction.
const generated = {
  "generated/prisma/client.ts": `
    export interface UserDelegate {
      findMany(args?: object): Promise<{ id: string }[]>;
      update(args: object): Promise<{ id: string }>;
    }
    export interface PrismaClient {
      user: UserDelegate;
      $transaction<R>(fn: (tx: Omit<PrismaClient, "$transaction">) => Promise<R>): Promise<R>;
    }
    export declare const prisma: PrismaClient;`,
};

describe("prisma adapter", () => {
  it("reads delegates as queries and runs $transaction's callback in a transaction, in a generated client", () => {
    expect(
      rolesOf(prisma, {
        files: { ...generated, ...stubPackage("@prisma/client", "6.16.1", "export {};") },
        code: `
          import { prisma } from "./generated/prisma/client.js";
          await prisma.user.findMany();
          await prisma.$transaction(async (tx) => tx.user.update({ where: {}, data: {} }));`,
      }),
    ).toEqual([
      "prisma.user.findMany(): @prisma/client UserDelegate.findMany, db.read",
      "prisma.$transaction(): @prisma/client PrismaClient.$transaction, transaction running its argument 1",
      "tx.user.update(): @prisma/client UserDelegate.update, db.write",
    ]);
  });
});
