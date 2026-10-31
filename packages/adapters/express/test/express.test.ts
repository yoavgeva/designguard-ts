import { defineAdapter, entryPointsOf, findingsOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import express from "../src/index.js";

// The shape of @types/express: `express()` and `Router()` give routers declared in express-serve-static-core.
const files = {
  "node_modules/express/package.json": JSON.stringify({ name: "express", version: "5.1.0", main: "index.js" }),
  "node_modules/@types/express/package.json": JSON.stringify({ name: "@types/express", version: "5.0.3", types: "index.d.ts" }),
  "node_modules/@types/express/index.d.ts": `
    import * as core from "express-serve-static-core";
    declare function e(): core.Express;
    declare namespace e {
      function Router(): core.Router;
      interface Request extends core.Request {}
      interface Response extends core.Response {}
    }
    export = e;`,
  "node_modules/@types/express-serve-static-core/package.json": JSON.stringify({ name: "@types/express-serve-static-core", version: "5.0.6", types: "index.d.ts" }),
  "node_modules/@types/express-serve-static-core/index.d.ts": `
    export interface Request { params: Record<string, string>; body: any; query: Record<string, unknown>; user?: { id: string } }
    export interface Response { json(body: unknown): this; locals: Record<string, any> }
    export type RequestHandler = (req: Request, res: Response, next: () => void) => unknown;
    export interface IRouterMatcher<T> { (path: string, ...handlers: RequestHandler[]): T }
    export interface IRoute { get: IRouterMatcher<this>; post: IRouterMatcher<this> }
    export interface IRouter {
      get: IRouterMatcher<this>; post: IRouterMatcher<this>; put: IRouterMatcher<this>; delete: IRouterMatcher<this>;
      route(path: string): IRoute;
    }
    export interface Router extends IRouter {}
    export interface Express extends IRouter { listen(port: number): void }`,
  ...stubPackage("db", "1.0.0", "export declare const db: { save(row: object): Promise<void>; find(id: string): Promise<object> };"),
};

const db = defineAdapter({ name: "db", packages: ["db"], effects: [{ on: "*.save", kind: "db.write" }, { on: "*.find", kind: "db.read" }], lookups: ["*.find"] });

describe("express adapter", () => {
  it("finds the routes of an application, a router and a route, with the middleware before them", () => {
    expect(
      entryPointsOf(express, {
        files,
        code: `
          import express, { Router } from "express";
          const app = express();
          const router = Router();
          function requireAdmin(req: express.Request, res: express.Response, next: () => void) { next(); }
          app.get("/orders", (req, res) => res.json([]));
          app.post("/orders", requireAdmin, (req, res) => res.json(req.body));
          router.delete("/orders/:id", (req, res) => res.json(req.params.id));
          router.route("/items").post((req, res) => res.json(req.body));`,
      }),
    ).toEqual([
      "6: the GET /orders handler (reads)",
      "7: the POST /orders handler, after requireAdmin",
      "8: the DELETE /orders/:id handler",
      "9: the post() handler",
    ]);
  });

  it("reads the user asking from req.user and res.locals, and what the request sends from req.params", () => {
    expect(
      findingsOf([express, db], {
        files,
        code: `
          import express from "express";
          import { db } from "db";
          const app = express();
          app.post("/orders/:id", async (req, res) => {
            await db.save({ id: req.params.id });
          });
          app.post("/mine/:id", async (req, res) => {
            await db.save({ id: req.params.id, owner: req.user?.id });
          });
          app.post("/theirs/:id", async (req, res) => {
            await db.save({ id: req.params.id, owner: res.locals.user.id });
          });
          app.get("/orders/:id", async (req, res) => {
            res.json(await db.find(req.params.id));
          });`,
      }),
    ).toEqual([
      "6: unauthorizedWrites: the POST /orders/:id handler writes to the database through db.save() with nothing checking that the user asking may",
      "15: unauthorizedReads: the GET /orders/:id handler reads a record by a key the request sends through db.find(): nothing checks that the user asking may see it",
    ]);
  });
});
