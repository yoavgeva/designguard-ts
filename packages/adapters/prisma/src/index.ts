import { defineAdapter } from "@designguard/core";

/**
 * Prisma Client: the model delegates' queries, and raw SQL. Prisma 5 and 6 generate the client's types into
 * `node_modules/.prisma/client`, which `@prisma/client` re-exports; the `prisma-client` generator writes the client
 * into the project, at the `output` the schema names, usually a `generated/prisma` folder.
 */
export default defineAdapter({
  name: "prisma",
  packages: ["@prisma/client", ".prisma/client"],
  files: ["**/generated/prisma/**"],
  effects: [
    {
      on: "*.{findMany,findUnique,findUniqueOrThrow,findFirst,findFirstOrThrow,count,aggregate,groupBy,$queryRaw,$queryRawUnsafe}",
      kind: "db.read",
    },
    {
      on: "*.{create,createMany,createManyAndReturn,update,updateMany,updateManyAndReturn,upsert,delete,deleteMany,$executeRaw,$executeRawUnsafe}",
      kind: "db.write",
    },
  ],
  // The interactive form runs its callback in the transaction; the batch form takes an array of queries.
  transactions: [{ on: "*.$transaction", body: 0 }],
  lookups: ["*.{findUnique,findUniqueOrThrow,findFirst,findFirstOrThrow}"],
  lists: [{ on: "*.findMany", argument: 0, bounds: "{where,take,cursor}" }],
  writes: [
    { on: "*.{create,createMany,createManyAndReturn,update,updateMany,updateManyAndReturn}", argument: 0, property: "data" },
    { on: "*.upsert", argument: 0, property: "{create,update}" },
  ],
});
