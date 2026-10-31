import { describe, expect, it } from "vitest";
import { analyze, defineAdapter } from "../src/index.js";
import { project, stubPackage } from "./fixture.js";

// A Prisma-like client, and a TypeORM-like repository with its decorators.
const shop = stubPackage(
  "shop",
  "1.0.0",
  `export interface Product { id: string; name: string; stock: number; version: number }
   export interface ProductDelegate {
     findUnique(args: object): Promise<Product | null>;
     update(args: object): Promise<Product>;
   }
   export declare class Client {
     product: ProductDelegate;
     $transaction<T>(fn: (tx: Client) => Promise<T>): Promise<T>;
   }
   export declare class Repository<T> {
     findOne(options: object): Promise<T | null>;
     save(entity: T): Promise<T>;
   }
   export declare function Entity(): ClassDecorator;
   export declare function Column(): PropertyDecorator;
   export declare function VersionColumn(): PropertyDecorator;`,
);

const adapter = defineAdapter({
  name: "shop",
  packages: ["shop"],
  effects: [
    { on: "{ProductDelegate.findUnique,Repository.findOne}", kind: "db.read" },
    { on: "{ProductDelegate.update,Repository.save}", kind: "db.write" },
  ],
  transactions: [{ on: "Client.$transaction", body: 0 }],
  writes: [
    { on: "ProductDelegate.update", argument: 0, property: "data" },
    { on: "Repository.save", argument: 0 },
  ],
  locks: "lock",
  versioned: "VersionColumn",
});

/** The no-lost-updates findings in `src/main.ts`, as `line: message`. */
function findings(code: string): string[] {
  const { program } = project({ ...shop, "src/main.ts": code });
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
  if (main === undefined) throw new Error("no src/main.ts");
  return analyze(program, { adapters: [adapter] })
    .lostUpdates(main)
    .map((finding) => `${String(main.getLineAndCharacterOfPosition(finding.node.getStart()).line + 1)}: ${finding.message}`);
}

describe("lostUpdates", () => {
  it("flags writes of a value computed from one read before, in or out of a transaction", () => {
    expect(
      findings(`
        import { Client } from "shop";
        declare const db: Client;
        export async function sell(id: string, quantity: number) {
          const product = await db.product.findUnique({ where: { id } });
          if (product === null) return;
          await db.product.update({ where: { id }, data: { stock: product.stock - quantity } });
        }
        export async function sellInTransaction(id: string, quantity: number) {
          await db.$transaction(async (tx) => {
            const product = await tx.product.findUnique({ where: { id } });
            await tx.product.update({ where: { id }, data: { stock: (product?.stock ?? 0) - quantity } });
          });
        }
        export async function sellAtomically(id: string, quantity: number) {
          await db.product.update({ where: { id }, data: { stock: { decrement: quantity } } });
        }
        export async function rename(id: string) {
          const product = await db.product.findUnique({ where: { id } });
          await db.product.update({ where: { id }, data: { name: product?.name + "!" } });
        }
        export async function sellChecked(id: string, quantity: number) {
          const product = await db.product.findUnique({ where: { id } });
          if (product === null) return;
          await db.product.update({ where: { id, version: product.version }, data: { stock: product.stock - quantity } });
        }`),
    ).toEqual([
      "7: sets stock from its value read through db.product.findUnique() (src/main.ts:5): a request that changes it between that read and this write is lost",
      "12: sets stock from its value read through tx.product.findUnique() (src/main.ts:11): a request that changes it between that read and this write is lost",
    ]);
  });

  it("flags an entity changed from its own value and saved, unless it's read with a lock or has a version column", () => {
    expect(
      findings(`
        import { Repository, Entity, Column, VersionColumn } from "shop";
        @Entity() class Product { @Column() id = ""; @Column() stock = 0; }
        @Entity() class Account { @Column() id = ""; @Column() balance = 0; @VersionColumn() version = 0; }
        declare const products: Repository<Product>;
        declare const accounts: Repository<Account>;
        export async function sell(id: string, quantity: number) {
          const product = await products.findOne({ where: { id } });
          if (product === null) return;
          product.stock -= quantity;
          await products.save(product);
        }
        export async function sellLocked(id: string, quantity: number) {
          const product = await products.findOne({ where: { id }, lock: { mode: "pessimistic_write" } });
          if (product === null) return;
          product.stock = product.stock - quantity;
          await products.save(product);
        }
        export async function pay(id: string, amount: number) {
          const account = await accounts.findOne({ where: { id } });
          if (account === null) return;
          account.balance -= amount;
          await accounts.save(account);
        }`),
    ).toEqual([
      "11: sets stock from its value read through products.findOne() (src/main.ts:8): a request that changes it between that read and this write is lost",
    ]);
  });
});
