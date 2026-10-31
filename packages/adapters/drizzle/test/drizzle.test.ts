import { findingsOf, rolesOf, stubPackage } from "@designguard/adapter-kit";
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

describe("drizzle adapter's reads", () => {
  // The shape of drizzle-orm's builders: select() gives a builder whose from() gives a thenable select.
  const files = stubPackage(
    "drizzle-orm",
    "0.45.3",
    `export interface SQLiteSelect extends Promise<object[]> { where(condition: unknown): SQLiteSelect; limit(count: number): SQLiteSelect }
     export declare class SQLiteSelectBuilder { from(table: object): SQLiteSelect }
     export declare class RelationalQueryBuilder { findMany(config?: object): Promise<object[]>; findFirst(config?: object): Promise<object | undefined> }
     export declare class BaseSQLiteDatabase {
       select(fields?: object): SQLiteSelectBuilder;
       query: { users: RelationalQueryBuilder };
     }
     export declare function count(): number;
     export declare function eq(left: unknown, right: unknown): unknown;`,
  );

  it("loads every row with a select no where, limit or aggregate bounds, and looks a record up with findFirst()", () => {
    expect(
      findingsOf([drizzle], {
        files,
        code: `
          "use server";
          import { BaseSQLiteDatabase, count, eq } from "drizzle-orm";
          declare const db: BaseSQLiteDatabase;
          const users = { id: "id" };
          export async function list() { return db.select().from(users); }
          export async function some() { return db.select().from(users).limit(20); }
          export async function total() { return db.select({ n: count() }).from(users); }
          export async function everyone() { return db.query.users.findMany(); }
          export async function one(id: string) { return db.query.users.findFirst({ where: eq(users.id, id) }); }`,
      }),
    ).toEqual([
      "6: unboundedQueries: list() loads every row through db.select(), so each request loads more as the table grows",
      "9: unboundedQueries: everyone() loads every row through db.query.users.findMany(), so each request loads more as the table grows",
      "10: unauthorizedReads: one() reads a record by a key the request sends through db.query.users.findFirst(): nothing checks that the user asking may see it",
    ]);
  });
});
