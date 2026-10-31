import { findingsOf, rolesOf, stubPackage } from "@designguard/adapter-kit";
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

describe("prisma adapter's reads", () => {
  const files = {
    ...generated,
    ...stubPackage("@prisma/client", "6.16.1", "export {};"),
    "generated/prisma/client.ts": generated["generated/prisma/client.ts"].replace(
      "findMany(args?: object): Promise<{ id: string }[]>;",
      "findMany(args?: object): Promise<{ id: string }[]>;\n      findUnique(args: object): Promise<{ id: string } | null>;",
    ),
  };

  it("loads every row with findMany() given no where, take or cursor, and looks a record up with findUnique()", () => {
    expect(
      findingsOf([prisma], {
        files,
        code: `
          "use server";
          import { prisma } from "./generated/prisma/client.js";
          export async function list() { return prisma.user.findMany({ orderBy: { name: "asc" } }); }
          export async function page() { return prisma.user.findMany({ take: 20 }); }
          export async function one(id: string) { return prisma.user.findUnique({ where: { id } }); }`,
      }),
    ).toEqual([
      "4: unboundedQueries: list() loads every row through prisma.user.findMany(), so each request loads more as the table grows",
      "6: unauthorizedReads: one() reads a record by a key the request sends through prisma.user.findUnique(): nothing checks that the user asking may see it",
    ]);
  });
});
