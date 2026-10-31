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
  // transaction(run) or transaction(isolationLevel, run).
  transactions: [{ on: "{DataSource,EntityManager}.transaction", body: "last" }],
  lookups: [`${RECORDS}.{findOne,findOneBy,findOneOrFail,findOneByOrFail}`, "SelectQueryBuilder.{getOne,getOneOrFail}"],
  // A repository's find(options) and the entity manager's find(Entity, options) load every row unless the options
  // filter or limit them; a query builder does unless its chain does.
  lists: [
    { on: "{Repository,TreeRepository,MongoRepository,BaseEntity}.{find,findAndCount}", argument: 0, bounds: "{where,take}" },
    { on: "{EntityManager,MongoEntityManager}.{find,findAndCount}", argument: 1, bounds: "{where,take}" },
    {
      on: "*.createQueryBuilder",
      bounds: "{where,andWhere,orWhere,whereInIds,take,limit,groupBy}",
      runs: "{getMany,getRawMany,getManyAndCount}",
    },
  ],
  writes: [
    { on: "{Repository,TreeRepository,MongoRepository}.{save,insert,create,upsert}", argument: 0 },
    { on: "{Repository,TreeRepository,MongoRepository}.update", argument: 1 },
    { on: "{InsertQueryBuilder.values,UpdateQueryBuilder.set}", argument: 0 },
  ],
  // find options' lock, a query builder's setLock(), and @VersionColumn(), which makes a save over a newer row fail.
  locks: "{lock,setLock}",
  versioned: "VersionColumn",
});
