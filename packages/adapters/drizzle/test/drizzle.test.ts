import { rolesOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import drizzle from "../src/index.js";

const drizzleOrm = stubPackage(
  "drizzle-orm",
  "0.45.3",
  `export declare class SelectBuilder { from(table: object): Promise<object[]> }
   export declare class RelationalQueryBuilder { findMany(): Promise<object[]> }
   export declare class BaseSQLiteDatabase {
     select(): SelectBuilder;
     insert(table: object): { values(row: object): Promise<void> };
     query: { users: RelationalQueryBuilder };
     transaction<T>(transaction: (tx: SQLiteTransaction) => Promise<T>): Promise<T>;
   }
   export declare class SQLiteTransaction extends BaseSQLiteDatabase {}`,
);

describe("drizzle adapter", () => {
  it("reads builders and relational queries as queries, and runs transaction's callback in a transaction", () => {
    expect(
      rolesOf(drizzle, {
        files: drizzleOrm,
        code: `
          import { BaseSQLiteDatabase } from "drizzle-orm";
          declare const db: BaseSQLiteDatabase;
          const users = {};
          await db.select().from(users);
          await db.query.users.findMany();
          await db.transaction(async (tx) => tx.insert(users).values({}));`,
      }),
    ).toEqual([
      "db.select(…).from(): drizzle-orm SelectBuilder.from",
      "db.select(): drizzle-orm BaseSQLiteDatabase.select, db.read",
      "db.query.users.findMany(): drizzle-orm RelationalQueryBuilder.findMany, db.read",
      "db.transaction(): drizzle-orm BaseSQLiteDatabase.transaction, transaction running its argument 1",
      "tx.insert(…).values(): drizzle-orm __type.values",
      "tx.insert(): drizzle-orm BaseSQLiteDatabase.insert, db.write",
    ]);
  });
});
