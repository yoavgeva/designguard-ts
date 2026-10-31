import { defineAdapter } from "@designguard/core";

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
});
