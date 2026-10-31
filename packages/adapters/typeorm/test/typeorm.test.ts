import { findingsOf, rolesOf, stubPackage } from "@designguard/adapter-kit";
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

describe("typeorm adapter's reads", () => {
  const files = stubPackage(
    "typeorm",
    "0.3.27",
    `export declare class Repository<T> {
       find(options?: object): Promise<T[]>;
       findOneBy(where: object): Promise<T | null>;
       createQueryBuilder(alias: string): SelectQueryBuilder<T>;
     }
     export declare class SelectQueryBuilder<T> { where(condition: string): this; take(count: number): this; getMany(): Promise<T[]> }
     export declare class EntityManager { find<T>(target: new () => T, options?: object): Promise<T[]> }`,
  );

  it("loads every row with find() or a query builder nothing filters or limits, and looks a record up with findOneBy()", () => {
    expect(
      findingsOf([typeorm], {
        files,
        code: `
          "use server";
          import { EntityManager, Repository } from "typeorm";
          class User {}
          declare const users: Repository<User>;
          declare const manager: EntityManager;
          export async function list() { return users.find({ order: { name: "ASC" } }); }
          export async function some() { return users.find({ take: 20 }); }
          export async function all() { return manager.find(User); }
          export async function built() { return users.createQueryBuilder("user").getMany(); }
          export async function page() { return users.createQueryBuilder("user").take(20).getMany(); }
          export async function one(id: string) { return users.findOneBy({ id }); }`,
      }),
    ).toEqual([
      "7: unboundedQueries: list() loads every row through users.find(), so each request loads more as the table grows",
      "9: unboundedQueries: all() loads every row through manager.find(), so each request loads more as the table grows",
      "10: unboundedQueries: built() loads every row through users.createQueryBuilder(), so each request loads more as the table grows",
      "12: unauthorizedReads: one() reads a record by a key the request sends through users.findOneBy(): nothing checks that the user asking may see it",
    ]);
  });
});
