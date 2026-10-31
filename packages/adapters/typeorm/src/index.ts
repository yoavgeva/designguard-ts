import { defineAdapter } from "@designguard/core";

const RECORDS = "{Repository,TreeRepository,MongoRepository,EntityManager,MongoEntityManager,BaseEntity}";

/** TypeORM: repositories, the entity manager, active-record entities and query builders. */
export default defineAdapter({
  name: "typeorm",
  packages: ["typeorm"],
  effects: [
    {
      on: `${RECORDS}.{find,findBy,findOne,findOneBy,findOneOrFail,findOneByOrFail,findAndCount,findAndCountBy,findByIds,count,countBy,exist,exists,existsBy,sum,average,minimum,maximum,query}`,
      kind: "db.read",
    },
    { on: "SelectQueryBuilder.{getMany,getOne,getOneOrFail,getRawMany,getRawOne,getCount,getExists,getManyAndCount,stream}", kind: "db.read" },
    {
      on: `${RECORDS}.{save,insert,update,upsert,delete,remove,softDelete,softRemove,restore,increment,decrement,clear}`,
      kind: "db.write",
    },
    { on: "{InsertQueryBuilder,UpdateQueryBuilder,DeleteQueryBuilder,SoftDeleteQueryBuilder}.execute", kind: "db.write" },
    { on: "QueryRunner.query", kind: "db.write" },
  ],
});
