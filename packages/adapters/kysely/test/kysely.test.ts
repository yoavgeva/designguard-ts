import { findingsOf, rolesOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import kysely from "../src/index.js";

const kyselyPackage = stubPackage(
  "kysely",
  "0.29.7",
  `export interface SelectQueryBuilder<O> { where(column: string, op: string, value: unknown): SelectQueryBuilder<O>; execute(): Promise<O[]> }
   export interface UpdateQueryBuilder { set(values: object): UpdateQueryBuilder; executeTakeFirst(): Promise<object> }
   export declare class Transaction<DB> extends Kysely<DB> {}
   export declare class TransactionBuilder<DB> { execute<T>(callback: (trx: Transaction<DB>) => Promise<T>): Promise<T> }
   export declare class Kysely<DB> {
     selectFrom(table: string): SelectQueryBuilder<{ id: string }>;
     updateTable(table: string): UpdateQueryBuilder;
     transaction(): TransactionBuilder<DB>;
   }`,
);

describe("kysely adapter", () => {
  it("reads executed builders as queries, and runs a transaction builder's callback in a transaction", () => {
    expect(
      rolesOf(kysely, {
        files: kyselyPackage,
        code: `
          import { Kysely } from "kysely";
          declare const db: Kysely<object>;
          await db.selectFrom("user").where("id", "=", "1").execute();
          await db.transaction().execute(async (trx) => trx.updateTable("user").set({}).executeTakeFirst());`,
      }),
    ).toEqual([
      "db.selectFrom(…).execute(): kysely SelectQueryBuilder.execute, db.read",
      "db.selectFrom(…).where(): kysely SelectQueryBuilder.where",
      "db.selectFrom(): kysely Kysely.selectFrom",
      "db.transaction(…).execute(): kysely TransactionBuilder.execute, transaction running its argument 1",
      "db.transaction(): kysely Kysely.transaction",
      "trx.updateTable(…).executeTakeFirst(): kysely UpdateQueryBuilder.executeTakeFirst, db.write",
      "trx.updateTable(…).set(): kysely UpdateQueryBuilder.set",
      "trx.updateTable(): kysely Kysely.updateTable",
    ]);
  });
});

describe("kysely adapter's reads", () => {
  // The shape of kysely's builders: Kysely extends QueryCreator, which declares selectFrom().
  const files = stubPackage(
    "kysely",
    "0.28.8",
    `export interface ExpressionBuilder { fn: { countAll(): { as(name: string): unknown } } }
     export interface SelectQueryBuilder<O> {
       selectAll(): SelectQueryBuilder<O>;
       select(selection: (eb: ExpressionBuilder) => unknown): SelectQueryBuilder<O>;
       where(column: string, op: string, value: unknown): SelectQueryBuilder<O>;
       limit(count: number): SelectQueryBuilder<O>;
       $if(condition: boolean, add: (qb: SelectQueryBuilder<O>) => SelectQueryBuilder<O>): SelectQueryBuilder<O>;
       execute(): Promise<O[]>;
       executeTakeFirst(): Promise<O | undefined>;
     }
     export declare class QueryCreator<DB> {
       selectFrom(table: string): SelectQueryBuilder<{ id: string }>;
       with(name: string, query: (db: QueryCreator<DB>) => unknown): QueryCreator<DB>;
     }
     export declare class Kysely<DB> extends QueryCreator<DB> {}`,
  );

  it("loads every row with a selectFrom() executed with no where, limit or aggregate, and looks a record up with executeTakeFirst()", () => {
    expect(
      findingsOf([kysely], {
        files,
        code: `
          "use server";
          import { Kysely } from "kysely";
          declare const db: Kysely<unknown>;
          export async function list() { return db.selectFrom("users").selectAll().execute(); }
          export async function some() { return db.selectFrom("users").selectAll().limit(20).execute(); }
          export async function total() { return db.selectFrom("users").select((eb) => eb.fn.countAll().as("n")).execute(); }
          export async function one(id: string) { return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst(); }
          export async function maybe(id?: string) { return db.selectFrom("users").selectAll().$if(id !== undefined, (qb) => qb.where("id", "=", id)).execute(); }
          export async function shared() { return db.with("mine", (q) => q.selectFrom("users").where("id", "=", "1")).selectFrom("mine").selectAll().execute(); }`,
      }),
    ).toEqual([
      "5: unboundedQueries: list() loads every row through db.selectFrom(), so each request loads more as the table grows",
      "8: unauthorizedReads: one() reads a record by a key the request sends through db.selectFrom(…).executeTakeFirst(): nothing checks that the user asking may see it",
    ]);
  });
});
