import { defineAdapter, entryPointsOf, findingsOf, stubPackage } from "@designguard/adapter-kit";
import { describe, expect, it } from "vitest";
import trpc from "../src/index.js";

// The shape of @trpc/server 11's builders: initTRPC makes a root object whose procedure is a ProcedureBuilder.
const files = {
  ...stubPackage(
    "@trpc/server",
    "11.4.3",
    `export type MiddlewareFunction<Ctx> = (opts: { ctx: Ctx; next: () => Promise<unknown> }) => Promise<unknown>;
     export interface Procedure { readonly procedure: true }
     export interface ProcedureBuilder<Ctx, Input> {
       input<I>(parser: (value: unknown) => I): ProcedureBuilder<Ctx, I>;
       use(fn: MiddlewareFunction<Ctx>): ProcedureBuilder<Ctx, Input>;
       query<O>(resolver: (opts: { ctx: Ctx; input: Input }) => O): Procedure;
       mutation<O>(resolver: (opts: { ctx: Ctx; input: Input }) => O): Procedure;
     }
     export interface TRPCRootObject<Ctx> {
       procedure: ProcedureBuilder<Ctx, undefined>;
       router<R extends Record<string, Procedure>>(routes: R): R;
       middleware(fn: MiddlewareFunction<Ctx>): MiddlewareFunction<Ctx>;
     }
     export declare const initTRPC: { context<Ctx>(): { create(): TRPCRootObject<Ctx> } };`,
  ),
  ...stubPackage("db", "1.0.0", "export declare const db: { save(row: object): Promise<void>; find(id: string): Promise<object> };"),
  "server/trpc.ts": `
    import { initTRPC } from "@trpc/server";
    const t = initTRPC.context<{ session: { user: { id: string; admin: boolean } } | null }>().create();
    const isAuthed = t.middleware(async ({ ctx, next }) => {
      if (ctx.session === null) throw new Error("UNAUTHORIZED");
      return next();
    });
    const isAdmin = t.middleware(async ({ ctx, next }) => {
      if (ctx.session?.user.admin !== true) throw new Error("FORBIDDEN");
      return next();
    });
    export const router = t.router;
    export const publicProcedure = t.procedure;
    export const authedProcedure = t.procedure.use(isAuthed);
    export const adminProcedure = authedProcedure.use(isAdmin);`,
  "server/remove.ts": `
    import { db } from "db";
    export async function removeHandler(opts: { ctx: { session: { user: { id: string } } | null }; input: { id: string } }) {
      await db.save({ id: opts.input.id, owner: opts.ctx.session?.user.id });
    }`,
};

const db = defineAdapter({ name: "db", packages: ["db"], effects: [{ on: "*.save", kind: "db.write" }, { on: "*.find", kind: "db.read" }], lookups: ["*.find"] });
const id = "(value: unknown) => value as { id: string }";

describe("trpc adapter", () => {
  it("finds queries and mutations by the keys they're registered under, with the middleware of their procedures", () => {
    expect(
      entryPointsOf(trpc, {
        files,
        code: `
          import { router, publicProcedure, authedProcedure, adminProcedure } from "./server/trpc.js";
          export const posts = router({
            list: publicProcedure.query(() => []),
            remove: authedProcedure.input(${id}).mutation(() => null),
            purge: adminProcedure.mutation(() => null),
          });`,
      }),
    ).toEqual([
      "4: the list query (reads)",
      "5: the remove mutation, after isAuthed",
      "6: the purge mutation, after isAuthed, isAdmin",
    ]);
  });

  it("reads the user asking from ctx, and passes resolvers behind an admin check or that give ctx to their handler", () => {
    expect(
      findingsOf([trpc, db], {
        files,
        code: `
          import { db } from "db";
          import { router, publicProcedure, authedProcedure, adminProcedure } from "./server/trpc.js";
          import { removeHandler } from "./server/remove.js";
          export const posts = router({
            remove: authedProcedure.input(${id}).mutation(async ({ input }) => {
              await db.save({ id: input.id });
            }),
            rename: authedProcedure.input(${id}).mutation(async ({ ctx, input }) => {
              await db.save({ id: input.id, owner: ctx.session?.user.id });
            }),
            purge: adminProcedure.input(${id}).mutation(async ({ input }) => {
              await db.save({ id: input.id });
            }),
            removeLater: authedProcedure.input(${id}).mutation(async (opts) => removeHandler(opts)),
            byId: publicProcedure.input(${id}).query(async ({ input }) => db.find(input.id)),
          });`,
      }),
    ).toEqual([
      "7: unauthorizedWrites: the remove mutation writes to the database through db.save() with nothing checking that the user asking may",
      "16: unauthorizedReads: the byId query reads a record by a key the request sends through db.find(): nothing checks that the user asking may see it",
    ]);
  });
});
