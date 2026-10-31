import { describe, expect, it } from "vitest";
import { analyze, defineAdapter } from "../src/index.js";
import { prismaStub, project, stubPackage } from "./fixture.js";

const routerStub = stubPackage(
  "router",
  "1.0.0",
  `export interface Request { params: Record<string, string>; body: unknown; user?: { id: string } }
   export interface Response { json(value: unknown): void }
   export type Handler = (req: Request, res: Response, next: () => void) => unknown;
   export interface RouterMatcher { (path: string, ...handlers: Handler[]): void }
   export interface Router { get: RouterMatcher; post: RouterMatcher; delete: RouterMatcher }
   export declare function router(): Router;`,
);

const authStub = stubPackage(
  "auth",
  "1.0.0",
  `export declare function getServerSession(options: object): Promise<{ user: { id: string } } | null>;
   export declare function authorize(user: unknown, action: string): void;`,
);

const parameters = [
  { at: 0, holds: "context" },
  { at: 0, path: ["{body,params}"], holds: "input" },
  { at: 1, holds: "context" },
] as const;

const router = defineAdapter({
  name: "router",
  packages: ["router"],
  entryPoints: [
    { call: "Router.get", reads: true, parameters },
    { call: "Router.{post,delete}", parameters },
  ],
});

const auth = defineAdapter({ name: "auth", packages: ["auth"], users: ["getServerSession"] });

const prisma = defineAdapter({
  name: "prisma",
  packages: ["@prisma/client"],
  effects: [
    { on: "*Delegate.{findMany,findUnique}", kind: "db.read" },
    { on: "*Delegate.update", kind: "db.write" },
  ],
  lookups: ["*Delegate.findUnique"],
});

const db = `
  import { PrismaClient } from "@prisma/client";
  export const prisma = new PrismaClient();`;

/** The findings in `src/main.ts`, as `line: message`. */
function findings(rule: "unauthorizedWrites" | "unauthorizedReads", files: Record<string, string>): string[] {
  const { program } = project({ ...prismaStub, ...routerStub, ...authStub, "src/db.ts": db, ...files });
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
  if (main === undefined) throw new Error("no src/main.ts");
  return analyze(program, { adapters: [router, auth, prisma] })
    [rule](main)
    .map((finding) => `${String(main.getLineAndCharacterOfPosition(finding.node.getStart()).line + 1)}: ${finding.message}`);
}

describe("unauthorizedWrites", () => {
  it("flags handlers that write with nothing reading the user asking, directly, through other functions, or by reference", () => {
    expect(
      findings("unauthorizedWrites", {
        "src/orders.ts": `
          import { prisma } from "./db.js";
          export async function cancelOrder(id: string) {
            await prisma.user.update({ where: { id }, data: {} });
          }
          export async function renameFor(req: unknown, id: string) {
            await prisma.user.update({ where: { id }, data: {} });
          }
          export async function remove(req: { params: Record<string, string> }) {
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          }`,
        "src/main.ts": `
          import { router } from "router";
          import { prisma } from "./db.js";
          import { cancelOrder, renameFor, remove } from "./orders.js";
          const app = router();
          app.post("/orders/:id/cancel", async (req) => {
            await cancelOrder(req.params.id);
          });
          app.post("/orders/:id/rename", async (req) => {
            await prisma.user.update({ where: { id: req.params.id, ownerId: req.user?.id }, data: {} });
          });
          app.post("/orders/:id/rename-for", async (req) => {
            await renameFor(req, req.params.id);
          });
          app.get("/orders/:id/view", async (req) => {
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          });
          app.delete("/orders/:id", remove);`,
      }),
    ).toEqual([
      "7: the POST /orders/:id/cancel handler writes to the database through cancelOrder(), which reaches prisma.user.update() (src/orders.ts:4) with nothing checking that the user asking may",
      "18: the DELETE /orders/:id handler writes to the database through remove(), which reaches prisma.user.update() (src/orders.ts:10) with nothing checking that the user asking may",
    ]);
  });

  it("passes handlers that get the user asking or check permissions, themselves, through what they call, or in middleware", () => {
    expect(
      findings("unauthorizedWrites", {
        "src/session.ts": `
          import { getServerSession } from "auth";
          export async function getCurrentUser() {
            return (await getServerSession({}))?.user;
          }
          export async function sessionOf(options: object) {
            return getServerSession(options);
          }`,
        "src/archive.ts": `
          import { prisma } from "./db.js";
          import { authorize } from "auth";
          export async function archive(id: string, user: unknown) {
            authorize(user, "archive");
            await prisma.user.update({ where: { id }, data: {} });
          }
          export async function assertCanEdit(id: string) {}`,
        "src/middleware.ts": `
          import type { Request, Response } from "router";
          export function requireAdmin(req: Request, res: Response, next: () => void) { next(); }
          export function authenticate(req: Request, res: Response, next: () => void) {
            if (req.user === undefined) throw new Error("401");
            next();
          }`,
        "src/main.ts": `
          import { router } from "router";
          import { prisma } from "./db.js";
          import { getCurrentUser, sessionOf } from "./session.js";
          import { archive, assertCanEdit } from "./archive.js";
          import { requireAdmin, authenticate } from "./middleware.js";
          const app = router();
          app.post("/a/:id", async (req) => {
            await getCurrentUser();
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          });
          app.post("/b/:id", async (req) => {
            await sessionOf({});
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          });
          app.post("/c/:id", async (req) => {
            await archive(req.params.id, undefined);
          });
          app.post("/d/:id", async (req) => {
            await assertCanEdit(req.params.id);
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          });
          app.post("/e/:id", requireAdmin, async (req) => {
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          });
          app.post("/f/:id", authenticate, async (req) => {
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          });`,
      }),
    ).toEqual([
      "27: the POST /f/:id handler writes to the database through prisma.user.update() with nothing checking that the user asking may",
    ]);
  });
});

describe("unauthorizedReads", () => {
  it("flags handlers that read a record by a key the request sends with nothing reading the user asking", () => {
    expect(
      findings("unauthorizedReads", {
        "src/orders.ts": `
          import { prisma } from "./db.js";
          export async function findOrder(id: string) {
            return prisma.user.findUnique({ where: { id } });
          }
          export async function listOrders(status: string) {
            return prisma.user.findMany({ where: { status } });
          }`,
        "src/main.ts": `
          import { router } from "router";
          import { prisma } from "./db.js";
          import { findOrder, listOrders } from "./orders.js";
          const app = router();
          app.get("/orders/:id", async (req, res) => {
            res.json(await findOrder(req.params.id));
          });
          app.get("/orders/:id/mine", async (req, res) => {
            res.json(await prisma.user.findUnique({ where: { id: req.params.id, ownerId: req.user?.id } }));
          });
          app.get("/orders", async (req, res) => {
            res.json(await listOrders(req.params.status ?? ""));
          });
          app.get("/settings", async (req, res) => {
            res.json(await prisma.user.findUnique({ where: { id: "settings" } }));
          });`,
      }),
    ).toEqual([
      "7: the GET /orders/:id handler reads a record by a key the request sends through findOrder(), which reaches prisma.user.findUnique() (src/orders.ts:4): nothing checks that the user asking may see it",
    ]);
  });
});
