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
  lookups: ["SelectQueryBuilder.{executeTakeFirst,executeTakeFirstOrThrow}"],
  // selectFrom() starts a query that loads every row when it's executed with nothing filtering, limiting or
  // aggregating it, as eb.fn.countAll() does.
  lists: [
    {
      on: "{QueryCreator,Kysely,Transaction}.selectFrom",
      bounds: "{where,whereRef,limit,top,groupBy}",
      runs: "{execute,stream}",
      aggregates: "{count,countAll,sum,avg,min,max,agg}",
    },
  ],
  writes: [{ on: "{InsertQueryBuilder.values,UpdateQueryBuilder.set}", argument: 0 }],
});
