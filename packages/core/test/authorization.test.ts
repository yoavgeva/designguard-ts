import { describe, expect, it } from "vitest";
import { analyze, defineAdapter } from "../src/index.js";
import { prismaStub, project, router, routerStub, stubPackage } from "./fixture.js";

const authStub = stubPackage(
  "auth",
  "1.0.0",
  `export declare function getServerSession(options: object): Promise<{ user: { id: string } } | null>;
   export declare function authorize(user: unknown, action: string): void;`,
);

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

/** The findings in `src/main.ts`, or another file, as `line: message`. */
function findings(rule: "unauthorizedWrites" | "unauthorizedReads", files: Record<string, string>, at = "src/main.ts"): string[] {
  const { program } = project({ ...prismaStub, ...routerStub, ...authStub, "src/db.ts": db, ...files });
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith(at));
  if (main === undefined) throw new Error(`no ${at}`);
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
          app.delete("/orders/:id", remove);
          app.post("/users/:id", async (req) => {
            await req.db.user.update({ where: { id: req.params.id }, data: {} });
          });
          app.post("/users/:id/mine", async (req) => {
            await req.db.user.update({ where: { id: req.params.id, ownerId: req.locals.user?.id }, data: {} });
          });`,
      }),
    ).toEqual([
      "7: the POST /orders/:id/cancel handler writes to the database through cancelOrder(), which reaches prisma.user.update() (src/orders.ts:4) with nothing checking that the user asking may",
      "18: the DELETE /orders/:id handler writes to the database through remove(), which reaches prisma.user.update() (src/orders.ts:10) with nothing checking that the user asking may",
      "20: the POST /users/:id handler writes to the database through req.db.user.update() with nothing checking that the user asking may",
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
          export async function assertCanEdit(id: string) {}
          export async function assertDashboardPassword(dashboard: { password: string | null }) {}`,
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
          import { archive, assertCanEdit, assertDashboardPassword } from "./archive.js";
          import { requireAdmin, authenticate } from "./middleware.js";
          const RANGES = ["10.0.", "192.168."];
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
          });
          app.post("/unsubscribe/:token", async (req) => {
            const subscriber = await prisma.user.findUnique({ where: { token: req.params.token } });
            await prisma.user.update({ where: { id: subscriber?.id }, data: {} });
          });
          app.post("/hooks", async (req) => {
            const signature = req.params["x-signature"];
            await prisma.user.update({ where: { id: String(signature) }, data: {} });
          });
          app.post("/sync", async (req) => {
            const secretHeader = req.headers["x-sync"];
            if (secretHeader !== process.env.SYNC) throw new Error("403");
            await prisma.user.update({ where: { id: "1" }, data: {} });
          });
          app.post("/verify", async (req) => {
            let code;
            code = req.params.passwordResetToken;
            await prisma.user.update({ where: { id: String(code) }, data: {} });
          });
          app.post("/workspaces/:id", async (req) => {
            await prisma.user.update({ where: { id: req.params.id, workspaceId: req.workspace?.id }, data: {} });
          });
          app.post("/postback/:id", async (req) => {
            const isAllowed = RANGES.some((range) => String(req.headers["x-forwarded-for"]).startsWith(range));
            if (!isAllowed) throw new Error("403");
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          });
          app.post("/dashboards/:id", async (req) => {
            await assertDashboardPassword({ password: null });
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          });
          app.post("/g/:id", async (req) => {
            const isEmpty = RANGES.length === 0;
            if (isEmpty) throw new Error("400");
            await prisma.user.update({ where: { id: req.params.id }, data: {} });
          });`,
      }),
    ).toEqual([
      "28: the POST /f/:id handler writes to the database through prisma.user.update() with nothing checking that the user asking may",
      "63: the POST /g/:id handler writes to the database through prisma.user.update() with nothing checking that the user asking may",
    ]);
  });

  it("passes handlers after middleware their router uses or is mounted behind, that is named for who may call or checks a secret, and on routers named for who may call", () => {
    const update = `async (req) => prisma.user.update({ where: { id: req.params.id }, data: {} })`;
    const files = {
        "src/middleware.ts": `
          import type { Request, Response } from "router";
          export function requireAdmin(req: Request, res: Response, next: () => void) { next(); }
          export function authenticate(req: Request, res: Response, next: () => void) { next(); }`,
        "src/main.ts": `
          import { router } from "router";
          import { prisma } from "./db.js";
          import { requireAdmin, authenticate } from "./middleware.js";
          const shop = router();
          shop.use(authenticate, requireAdmin);
          shop.post("/products", ${update});
          const api = router();
          api.post("/early", ${update});
          api.use(requireAdmin);
          api.post("/late", ${update});
          const app = router();
          app.use("/admin", requireAdmin);
          app.post("/admin/users", ${update});
          app.post("/administrator", ${update});
          app.post("/other", ${update});
          const publicRouter = router();
          publicRouter.post("/signup", ${update});
          import { users } from "./users.js";
          app.use("/users", requireAdmin, users);
          import internal from "./internal.js";
          import signedIn from "./signed-in.js";
          import { apiKeyAuth, signIn } from "./keys.js";
          app.use("/internal", apiKeyAuth, internal);
          app.use("/me", signIn, signedIn);
          import { requireRole, guard, logRequests } from "./factories.js";
          app.post("/factory/a", requireRole("admin"), ${update});
          app.post("/factory/b", guard(["admin"]), ${update});
          app.post("/factory/c", logRequests("factory"), ${update});`,
        "src/factories.ts": `
          import type { Request, Response } from "router";
          export function requireRole(role: string) {
            return (req: Request, res: Response, next: () => void) => next();
          }
          export function guard(allowedRoles: string[]) {
            return (req: Request, res: Response, next: () => void) => {
              if (!allowedRoles.includes(req.user?.id ?? "")) throw new Error("403");
              next();
            };
          }
          export function logRequests(label: string) {
            return (req: Request, res: Response, next: () => void) => next();
          }`,
        "src/keys.ts": `
          import type { Request, Response } from "router";
          export function apiKeyAuth(req: Request, res: Response, next: () => void) {
            if (req.headers["x-api-key"] !== process.env.API_KEY) throw new Error("403");
            next();
          }
          export function signIn(req: Request, res: Response, next: () => void) {
            if (req.user === undefined) throw new Error("401");
            next();
          }`,
        "src/internal.ts": `
          import { router } from "router";
          import { prisma } from "./db.js";
          const internal = router();
          internal.post("/:id", ${update});
          export default internal;`,
        "src/signed-in.ts": `
          import { router } from "router";
          import { prisma } from "./db.js";
          const signedIn = router();
          signedIn.post("/:id", ${update});
          export default signedIn;`,
        "src/users.ts": `
          import { router } from "router";
          import { prisma } from "./db.js";
          export const users = router();
          users.post("/:id", ${update});`,
    };
    expect(findings("unauthorizedWrites", files, "src/users.ts")).toEqual([]);
    expect(findings("unauthorizedWrites", files, "src/internal.ts")).toEqual([]);
    expect(findings("unauthorizedWrites", files, "src/signed-in.ts")).toEqual([
      "5: the POST /:id handler writes to the database through prisma.user.update() with nothing checking that the user asking may",
    ]);
    expect(findings("unauthorizedWrites", files)).toEqual([
      "9: the POST /early handler writes to the database through prisma.user.update() with nothing checking that the user asking may",
      "15: the POST /administrator handler writes to the database through prisma.user.update() with nothing checking that the user asking may",
      "16: the POST /other handler writes to the database through prisma.user.update() with nothing checking that the user asking may",
      "29: the POST /factory/c handler writes to the database through prisma.user.update() with nothing checking that the user asking may",
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

describe("standard entry points", () => {
  it("finds server functions, exported from a \"use server\" file or marked inline, and route handlers", () => {
    expect(
      findings("unauthorizedWrites", {
        "src/session.ts": `
          export async function getCurrentUser() { return { id: "1" }; }`,
        "src/main.ts": `
          "use server";
          import { prisma } from "./db.js";
          import { getCurrentUser } from "./session.js";
          export async function deletePost(id: string) {
            await prisma.user.update({ where: { id }, data: {} });
          }
          export async function renamePost(id: string) {
            const user = await getCurrentUser();
            await prisma.user.update({ where: { id, ownerId: user.id }, data: {} });
          }
          async function helper(id: string) {
            await prisma.user.update({ where: { id }, data: {} });
          }`,
      }),
    ).toEqual([
      "6: deletePost() writes to the database through prisma.user.update() with nothing checking that the user asking may",
    ]);
    expect(
      findings("unauthorizedWrites", {
        "src/main.ts": `
          import { prisma } from "./db.js";
          export function Page() {
            async function remove(id: string) {
              "use server";
              await prisma.user.update({ where: { id }, data: {} });
            }
            return remove;
          }`,
      }),
    ).toEqual([
      "6: remove() writes to the database through prisma.user.update() with nothing checking that the user asking may",
    ]);
  });

  it("finds route handlers: exported functions named for a method, taking a Request", () => {
    const routes = `
      import { prisma } from "./db.js";
      export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
        const { id } = await params;
        await prisma.user.update({ where: { id }, data: {} });
        return Response.json({});
      }
      export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
        const { id } = await params;
        return Response.json(await prisma.user.findUnique({ where: { id } }));
      }
      export async function PUT(id: string) {
        await prisma.user.update({ where: { id }, data: {} });
      }`;
    expect(findings("unauthorizedWrites", { "src/main.ts": routes })).toEqual([
      "5: POST() writes to the database through prisma.user.update() with nothing checking that the user asking may",
    ]);
    expect(
      findings("unauthorizedWrites", {
        "src/respond.ts": `
          export function respond(handler: (request: Request) => Promise<Response>) { return handler; }
          export function withAdmin(handler: (request: Request) => Promise<Response>) { return handler; }`,
        "src/main.ts": `
          import { prisma } from "./db.js";
          import { respond, withAdmin } from "./respond.js";
          async function remove(request: Request) {
            await prisma.user.update({ where: { id: "1" }, data: {} });
            return Response.json({});
          }
          export const DELETE = respond(remove);
          export const PATCH = withAdmin(async (request: Request) => {
            await prisma.user.update({ where: { id: "1" }, data: {} });
            return Response.json({});
          });`,
      }),
    ).toEqual([
      "8: DELETE() writes to the database through remove(), which reaches prisma.user.update() (src/main.ts:5) with nothing checking that the user asking may",
    ]);
    expect(findings("unauthorizedReads", { "src/main.ts": routes })).toEqual([
      "10: GET() reads a record by a key the request sends through prisma.user.findUnique(): nothing checks that the user asking may see it",
    ]);
  });

  it("passes route handlers a wrapper checks for, by its name or the handler it returns, through other wrappers and variables too", () => {
    expect(
      findings("unauthorizedWrites", {
        "src/api-auth.ts": `
          import { getServerSession } from "auth";
          type Handler = (request: Request, session: unknown) => Promise<Response>;
          export function withAuth(allowedRoles: string[], handler: Handler) {
            return async (request: Request) => {
              const session = await getServerSession({});
              if (session === null || !allowedRoles.includes(session.user.id)) return new Response(null, { status: 403 });
              return handler(request, session);
            };
          }
          export function withBackofficeAuth(handler: Handler) {
            return withAuth(["ADMIN", "CONSULTANT"], handler);
          }
          export function withTiming(handler: Handler) {
            return async (request: Request) => handler(request, undefined);
          }
          export function requirePermission(permission: string, handler: Handler) {
            return handler;
          }`,
        "src/main.ts": `
          import { prisma } from "./db.js";
          import { withBackofficeAuth, withTiming, requirePermission } from "./api-auth.js";
          export const DELETE = withBackofficeAuth(async (request: Request) => {
            await prisma.user.update({ where: { id: "1" }, data: {} });
            return Response.json({});
          });
          export const PATCH = withTiming(withTiming(async (request: Request) => {
            await prisma.user.update({ where: { id: "1" }, data: {} });
            return Response.json({});
          }));
          const putHandler = requirePermission("admin.settings", async (request: Request) => {
            await prisma.user.update({ where: { id: "1" }, data: {} });
            return Response.json({});
          });
          export const PUT = withTiming(putHandler);
          export const POST = withTiming(requirePermission("admin.settings", async (request: Request) => {
            await prisma.user.update({ where: { id: "1" }, data: {} });
            return Response.json({});
          }));`,
      }),
    ).toEqual([
      "9: PATCH() writes to the database through prisma.user.update() with nothing checking that the user asking may",
    ]);
  });
});
