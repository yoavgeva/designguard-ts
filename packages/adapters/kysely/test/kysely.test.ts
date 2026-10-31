import { rolesOf, stubPackage } from "@designguard/adapter-kit";
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
