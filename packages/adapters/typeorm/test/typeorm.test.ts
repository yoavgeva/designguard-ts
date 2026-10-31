import { rolesOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import typeorm from "../src/index.js";

const typeormPackage = stubPackage(
  "typeorm",
  "0.3.20",
  `export declare class Repository<T> { find(): Promise<T[]>; save(entity: T): Promise<T> }
   export declare class SelectQueryBuilder<T> { where(condition: string): this; getMany(): Promise<T[]> }
   export declare class EntityManager {
     getRepository<T>(target: new () => T): Repository<T>;
     transaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T>;
     transaction<T>(isolation: string, run: (manager: EntityManager) => Promise<T>): Promise<T>;
   }
   export declare class DataSource {
     createQueryBuilder<T>(target: new () => T, alias: string): SelectQueryBuilder<T>;
     transaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T>;
     transaction<T>(isolation: string, run: (manager: EntityManager) => Promise<T>): Promise<T>;
   }`,
);

describe("typeorm adapter", () => {
  it("reads repositories and query builders as queries, and runs transaction's last argument in a transaction", () => {
    expect(
      rolesOf(typeorm, {
        files: typeormPackage,
        code: `
          import { DataSource, Repository } from "typeorm";
          class User {}
          declare const data: DataSource;
          declare const users: Repository<User>;
          await users.find();
          await data.createQueryBuilder(User, "user").where("user.active").getMany();
          await data.transaction("SERIALIZABLE", async (manager) => manager.getRepository(User).save(new User()));`,
      }),
    ).toEqual([
      "users.find(): typeorm Repository.find, db.read",
      "data.createQueryBuilder(…).getMany(): typeorm SelectQueryBuilder.getMany, db.read",
      "data.createQueryBuilder(…).where(): typeorm SelectQueryBuilder.where",
      "data.createQueryBuilder(): typeorm DataSource.createQueryBuilder",
      "data.transaction(): typeorm DataSource.transaction, transaction running its argument 2",
      "manager.getRepository(…).save(): typeorm Repository.save, db.write",
      "manager.getRepository(): typeorm EntityManager.getRepository",
    ]);
  });
});
