import { defineAdapter } from "@designguard/core";

/**
 * Prisma Client: the model delegates' queries, and raw SQL. Prisma 5 and 6 generate the client's types into
 * `node_modules/.prisma/client`, which `@prisma/client` re-exports.
 */
export default defineAdapter({
  name: "prisma",
  packages: ["@prisma/client", ".prisma/client"],
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
});
