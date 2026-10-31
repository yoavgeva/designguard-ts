import { defineAdapter, entryPointsOf, findingsOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import hono from "../src/index.js";

// The shape of hono 4's types: the routing methods are properties typed by a HandlerInterface of call signatures.
const files = {
  ...stubPackage(
    "hono",
    "4.12.12",
    `export interface HonoRequest {
       param(name: string): string;
       json<T = any>(): Promise<T>;
       valid(target: string): any;
     }
     export interface Context<V = {}> {
       req: HonoRequest;
       var: V;
       get<K extends keyof V>(key: K): V[K];
       json(value: unknown): Response;
     }
     export type Handler<V> = (c: Context<V>, next: () => Promise<void>) => unknown;
     export interface HandlerInterface<V> { (path: string, ...handlers: Handler<V>[]): Hono<V> }
     export declare class Hono<V = {}> {
       get: HandlerInterface<V>;
       post: HandlerInterface<V>;
       delete: HandlerInterface<V>;
       use: HandlerInterface<V>;
     }`,
  ),
  ...stubPackage("db", "1.0.0", "export declare const db: { save(row: object): Promise<void>; find(id: string): Promise<object> };"),
};

const db = defineAdapter({ name: "db", packages: ["db"], effects: [{ on: "*.save", kind: "db.write" }, { on: "*.find", kind: "db.read" }], lookups: ["*.find"] });

describe("hono adapter", () => {
  it("finds an application's routes, with the middleware before them, and not its use()", () => {
    expect(
      entryPointsOf(hono, {
        files,
        code: `
          import { Hono } from "hono";
          const app = new Hono();
          app.use("*", async (c, next) => { await next(); });
          app.get("/posts", (c) => c.json([]));
          app.post("/posts", async (c, next) => { await next(); }, (c) => c.json([]));`,
      }),
    ).toEqual(["5: the GET /posts handler (reads)", "6: the POST /posts handler, after inline middleware"]);
  });

  it("reads the user asking from the context's variables, and what the request sends from c.req", () => {
    expect(
      findingsOf([hono, db], {
        files,
        code: `
          import { Hono } from "hono";
          import { db } from "db";
          const app = new Hono<{ user: { id: string } }>();
          app.delete("/posts/:id", async (c) => {
            await db.save({ id: c.req.param("id") });
            return c.json({});
          });
          app.delete("/mine/:id", async (c) => {
            await db.save({ id: c.req.param("id"), owner: c.get("user").id });
            return c.json({});
          });
          app.post("/theirs", async (c) => {
            const body = await c.req.json<{ id: string }>();
            await db.save({ id: body.id, owner: c.var.user.id });
            return c.json({});
          });
          app.get("/posts/:id", async (c) => c.json(await db.find(c.req.param("id"))));`,
      }),
    ).toEqual([
      "6: unauthorizedWrites: the DELETE /posts/:id handler writes to the database through db.save() with nothing checking that the user asking may",
      "18: unauthorizedReads: the GET /posts/:id handler reads a record by a key the request sends through db.find(): nothing checks that the user asking may see it",
    ]);
  });
});
