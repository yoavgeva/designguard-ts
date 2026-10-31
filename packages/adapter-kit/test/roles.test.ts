import { defineAdapter } from "@designguard/core";
import { describe, expect, it } from "vitest";
import { rolesOf, stubPackage } from "../src/index.js";

const typeorm = stubPackage(
  "typeorm",
  "0.3.20",
  `export declare class Repository<T> { find(): Promise<T[]>; save(entity: T): Promise<T> }
   export declare class EntityManager { getRepository<T>(target: new () => T): Repository<T> }
   export declare class DataSource {
     transaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T>;
     transaction<T>(isolation: string, run: (manager: EntityManager) => Promise<T>): Promise<T>;
   }`,
);

describe("rolesOf", () => {
  it("names each call's declaration and the role the adapter gives it", () => {
    const adapter = defineAdapter({
      name: "typeorm",
      packages: ["typeorm"],
      effects: [
        { on: "Repository.find", kind: "db.read" },
        { on: "Repository.save", kind: "db.write" },
      ],
      transactions: [{ on: "DataSource.transaction", body: "last" }],
    });
    expect(
      rolesOf(adapter, {
        files: typeorm,
        code: `
          import { DataSource, Repository } from "typeorm";
          class User {}
          declare const data: DataSource;
          declare const users: Repository<User>;
          await users.find();
          await data.transaction("SERIALIZABLE", async (manager) => manager.getRepository(User).save(new User()));`,
      }),
    ).toEqual([
      "users.find(): typeorm Repository.find, db.read",
      'data.transaction(): typeorm DataSource.transaction, transaction running its argument 2',
      "manager.getRepository(…).save(): typeorm Repository.save, db.write",
      "manager.getRepository(): typeorm EntityManager.getRepository",
    ]);
  });

  it("says when the installed version is outside the adapter's range", () => {
    const adapter = defineAdapter({ name: "typeorm", packages: ["typeorm"], versions: ">=1", effects: [{ on: "Repository.find", kind: "db.read" }] });
    expect(
      rolesOf(adapter, {
        files: typeorm,
        code: `
          import { Repository } from "typeorm";
          declare const users: Repository<object>;
          await users.find();`,
      }),
    ).toEqual(["users.find(): typeorm Repository.find, off: typeorm 0.3.20 is outside >=1"]);
  });
});
