import { defineAdapter } from "@designguard/core";

const EXECUTE = "{execute,executeTakeFirst,executeTakeFirstOrThrow}";

/** Kysely: queries run when a builder is executed. */
export default defineAdapter({
  name: "kysely",
  packages: ["kysely"],
  effects: [
    { on: `SelectQueryBuilder.{${EXECUTE.slice(1, -1)},stream}`, kind: "db.read" },
    { on: "RawBuilder.execute", kind: "db.read" },
    { on: `{InsertQueryBuilder,UpdateQueryBuilder,DeleteQueryBuilder,MergeQueryBuilder}.${EXECUTE}`, kind: "db.write" },
  ],
  // db.transaction().execute(async (trx) => ...)
  transactions: [{ on: "TransactionBuilder.execute", body: 0 }],
});
