import { defineAdapter } from "@designguard/core";

const AGGREGATES = "{count,countDistinct,sum,sumDistinct,avg,avgDistinct,min,max,sql}";

/** Drizzle ORM: a database's query builders, which run when awaited, and the relational query API. */
export default defineAdapter({
  name: "drizzle",
  packages: ["drizzle-orm"],
  effects: [
    { on: "*Database.{select,selectDistinct,selectDistinctOn,$count,execute,all,get,values}", kind: "db.read" },
    { on: "RelationalQueryBuilder.{findMany,findFirst}", kind: "db.read" },
    { on: "*Database.{insert,update,delete,run}", kind: "db.write" },
  ],
  transactions: [{ on: "{*Database,*Transaction}.transaction", body: 0 }],
  lookups: ["RelationalQueryBuilder.findFirst"],
  // A select loads every row unless its chain filters or limits it, or it selects an aggregate, which sql`` may be.
  lists: [
    { on: "*Database.{select,selectDistinct}", bounds: "{where,limit,groupBy}", aggregates: AGGREGATES },
    { on: "RelationalQueryBuilder.findMany", argument: 0, bounds: "{where,limit}" },
  ],
  writes: [{ on: "{*InsertBuilder.values,*UpdateBuilder.set}", argument: 0 }],
});
