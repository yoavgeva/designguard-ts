import { defineAdapter, findingsOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import authjs from "../src/index.js";

// The shape of next-auth's exports: v4's getServerSession, and v5's NextAuth(), whose result holds auth().
const files = {
  ...stubPackage(
    "next-auth",
    "4.24.11",
    `export interface Session { user?: { id?: string } }
     export interface NextAuthResult { auth: (() => Promise<Session | null>) & ((handler: (request: unknown) => unknown) => unknown) }
     export default function NextAuth(config: object): NextAuthResult;
     export declare function getServerSession(...args: unknown[]): Promise<Session | null>;`,
  ),
  ...stubPackage("db", "1.0.0", "export declare const db: { save(row: object): Promise<void> };"),
};

const db = defineAdapter({ name: "db", packages: ["db"], effects: [{ on: "*.save", kind: "db.write" }] });

const code = `
  "use server";
  import NextAuth, { getServerSession } from "next-auth";
  import { db } from "db";
  const authOptions = {};
  const { auth } = NextAuth(authOptions);
  export async function deletePost(id: string) {
    await db.save({ id });
  }
  export async function renamePost(id: string) {
    const session = await auth();
    await db.save({ id, owner: session?.user?.id });
  }
  export async function archivePost(id: string) {
    const session = await getServerSession(authOptions);
    await db.save({ id, owner: session?.user?.id });
  }`;

describe("authjs adapter", () => {
  it("reads the user asking from getServerSession(authOptions), which no name tells", () => {
    const deleted = "8: unauthorizedWrites: deletePost() writes to the database through db.save() with nothing checking that the user asking may";
    expect(findingsOf([db], { files, code })).toEqual([
      deleted,
      "16: unauthorizedWrites: archivePost() writes to the database through db.save() with nothing checking that the user asking may",
    ]);
    expect(findingsOf([authjs, db], { files, code })).toEqual([deleted]);
  });
});
