import { describe, expect, it } from "vitest";
import { analyze, defineAdapter } from "../src/index.js";
import { kyselyStub, prismaStub, project } from "./fixture.js";

const prisma = defineAdapter({
  name: "prisma",
  packages: ["@prisma/client"],
  effects: [
    { on: "*Delegate.{findMany,findUnique,findFirst,count}", kind: "db.read" },
    { on: "*Delegate.{create,update,upsert,delete}", kind: "db.write" },
  ],
});

/** The queries-in-loops findings in `src/main.ts`, as `line: message`. */
function findings(files: Record<string, string>): string[] {
  const { program } = project({ ...prismaStub, ...files });
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
  if (main === undefined) throw new Error("no src/main.ts");
  return analyze(program, { adapters: [prisma] })
    .queriesInLoops(main)
    .map((finding) => `${String(main.getLineAndCharacterOfPosition(finding.node.getStart()).line + 1)}: ${finding.message}`);
}

const users = `
  import { PrismaClient } from "@prisma/client";
  const prisma = new PrismaClient();
  export async function loadUser(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }
  export function label(id: string) {
    return id.toUpperCase();
  }
  export class Users {
    async rename(id: string) {
      return prisma.user.update({ where: { id }, data: {} });
    }
  }`;

describe("queriesInLoops", () => {
  it("flags a query made once per item, through other functions, in loops and in array callbacks", () => {
    expect(
      findings({
        "src/users.ts": users,
        "src/main.ts": `
          import { PrismaClient } from "@prisma/client";
          import { loadUser, Users } from "./users.js";
          const prisma = new PrismaClient();
          export async function show(ids: string[], service: Users) {
            for (const id of ids) {
              await loadUser(id);
            }
            await Promise.all(ids.map((id) => prisma.user.findUnique({ where: { id } })));
            await Promise.all(ids.map(loadUser));
            ids.forEach((id) => void service.rename(id));
          }`,
      }),
    ).toEqual([
      "7: queries the database once per item: the for…of loop calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
      "9: queries the database once per item: map() calls prisma.user.findUnique()",
      "10: queries the database once per item: map() calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
      "11: queries the database once per item: forEach() calls service.rename(), which reaches prisma.user.update() (src/users.ts:12)",
    ]);
  });

  it("names a query builder by where it starts and the call that runs it", () => {
    const kysely = defineAdapter({ name: "kysely", packages: ["kysely"], effects: [{ on: "SelectQueryBuilder.execute", kind: "db.read" }] });
    const { program } = project({
      ...kyselyStub,
      "src/main.ts": `
        import { Kysely } from "kysely";
        declare const db: Kysely<object>;
        export async function show(ids: string[]) {
          for (const id of ids) {
            await db
              .selectFrom("user")
              .where("id", "=", id)
              .execute();
          }
        }`,
    });
    const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
    if (main === undefined) throw new Error("no src/main.ts");
    expect(analyze(program, { adapters: [kysely] }).queriesInLoops(main).map((finding) => finding.message)).toEqual([
      "queries the database once per item: the for…of loop calls db.selectFrom(…).execute()",
    ]);
  });

  it("reads a client generated into the project as the adapter's package, when the adapter claims its files", () => {
    const generated = defineAdapter({ ...prisma, files: ["**/generated/prisma/**"] });
    const { program } = project({
      "src/generated/prisma/client.ts": `
        export interface UserDelegate { findUnique(args: object): Promise<{ id: string } | null> }
        export declare const prisma: { user: UserDelegate };`,
      "src/main.ts": `
        import { prisma } from "./generated/prisma/client.js";
        export async function show(ids: string[]) {
          for (const id of ids) await prisma.user.findUnique({ where: { id } });
        }`,
    });
    const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
    if (main === undefined) throw new Error("no src/main.ts");
    expect(analyze(program, { adapters: [generated] }).queriesInLoops(main).map((finding) => finding.message)).toEqual([
      "queries the database once per item: the for…of loop calls prisma.user.findUnique()",
    ]);
    expect(analyze(program, { adapters: [prisma] }).queriesInLoops(main)).toEqual([]);
  });

  it("passes queries outside loops, polling and retry loops, and loops that touch nothing outside the code", () => {
    expect(
      findings({
        "src/users.ts": users,
        "src/main.ts": `
          import { loadUser, label } from "./users.js";
          export async function show(ids: string[]) {
            const first = await loadUser(ids[0] ?? "");
            const labels = ids.map(label);
            for (const id of ids) label(id);
            const later = ids.map((id) => () => loadUser(id));
            let user = await loadUser("1");
            while (user === null) user = await loadUser("1");
            do user = await loadUser("1"); while (user === null);
            for (let attempt = 0; ; attempt++) if (await loadUser(String(attempt)) === null) break;
            const ATTEMPTS = 3;
            for (let attempt = 0; attempt < ATTEMPTS; attempt++) await loadUser(String(attempt));
            for (let attempt = 1; attempt <= 5; attempt++) await loadUser(String(attempt));
            const options = { maxRetries: ids.length };
            for (let i = 0; i < options.maxRetries; i++) await loadUser(String(i));
            return { first, labels, later };
          }`,
      }),
    ).toEqual([]);
  });

  it("passes loops over a list written in the code, which run the same number of times whatever the data", () => {
    expect(
      findings({
        "src/users.ts": users,
        "src/main.ts": `
          import { loadUser } from "./users.js";
          const roles = ["owner", "admin"] as const;
          export async function show(owner: string, admin: string, ids: string[]) {
            for (const [role, id] of [["owner", owner], ["admin", admin]] as const) await loadUser(role + id);
            for (const role of roles) await loadUser(role);
            await Promise.all([owner, admin].map(loadUser));
            for (const id of [owner, ...ids]) await loadUser(id);
            for (let i = 0; i < ids.length; i++) await loadUser(ids[i] ?? "");
          }`,
      }),
    ).toEqual([
      "8: queries the database once per item: the for…of loop calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
      "9: queries the database once per item: the for loop calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
    ]);
  });

  it("passes loops over chunks of the data, which make one query per chunk to keep each small", () => {
    expect(
      findings({
        "src/users.ts": users,
        "src/main.ts": `
          import { loadUser } from "./users.js";
          declare function chunk<T>(items: readonly T[], size: number): T[][];
          const BATCH_SIZE = 100;
          export async function show(ids: string[], groups: string[][]) {
            for (const batch of chunk(ids, 100)) await loadUser(batch.join());
            const batches = chunk(ids, 50);
            for (const [index, part] of batches.entries()) await loadUser(part.join() + String(index));
            await Promise.all(chunk(ids, 10).map((part) => loadUser(part.join())));
            for (let i = 0; i < ids.length; i += BATCH_SIZE) await loadUser(ids.slice(i, i + BATCH_SIZE).join());
            for (const group of groups) await loadUser(group.join());
            for (let i = 0; i < ids.length; i += 2) await loadUser(ids[i] ?? "");
            for (const batch of chunk(ids, 100)) await Promise.all(batch.map((id) => loadUser(id)));
            for (let i = 0; i < ids.length; i += BATCH_SIZE) {
              const idChunk = ids.slice(i, i + BATCH_SIZE);
              await Promise.all(idChunk.map(loadUser));
            }
          }`,
      }),
    ).toEqual([
      "11: queries the database once per item: the for…of loop calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
      "12: queries the database once per item: the for loop calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
      "13: queries the database once per item: map() calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
      "16: queries the database once per item: map() calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
    ]);
  });

  it("passes loops that count passes or rounds to a limit the code sets, wherever it's declared", () => {
    expect(
      findings({
        "src/users.ts": users,
        "src/limits.ts": "export const MAX_PASSES = 3;",
        "src/main.ts": `
          import { loadUser } from "./users.js";
          import { MAX_PASSES } from "./limits.js";
          const MAX_ROUNDS = 3;
          export async function show(ids: string[], ready: boolean) {
            for (let pass = 1; pass <= MAX_PASSES; pass++) await loadUser(String(pass));
            let pending = ids;
            for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round++) {
              await loadUser(pending[0] ?? "");
              pending = pending.slice(1);
            }
            for (let i = 0; i < ids.length && ready; i++) await loadUser(ids[i] ?? "");
          }`,
      }),
    ).toEqual([
      "12: queries the database once per item: the for loop calls loadUser(), which reaches prisma.user.findUnique() (src/users.ts:5)",
    ]);
  });

  it("passes queries that run only when a cache misses or goes stale, and flags look-alikes that run every time", () => {
    expect(
      findings({
        "src/keys.ts": `
          import { PrismaClient } from "@prisma/client";
          const prisma = new PrismaClient();
          declare function memoize<T>(key: string, load: () => Promise<T>): Promise<T>;
          declare function cache<F extends Function>(load: F): F;
          const local = new Map<string, unknown>();
          const memo = new Map<string, unknown>();
          export const userById = cache((id: string) => prisma.user.findUnique({ where: { id } }));
          export const allUsers = cache(async () => prisma.user.findMany());
          export class Keys {
            private current: Promise<unknown> | undefined;
            private first: Promise<unknown> | undefined;
            private refreshedAt = 0;
            async currentKey() {
              if (this.current === undefined) this.current = prisma.user.findMany();
              return this.current;
            }
            async firstKey() {
              return (this.first ??= prisma.user.findMany());
            }
            async keyFor(id: string) {
              return memoize(id, () => prisma.user.findUnique({ where: { id } }));
            }
            async lookup(id: string) {
              const cached = local.get(id);
              if (cached !== undefined) return cached;
              return prisma.user.findUnique({ where: { id } });
            }
            async peek(id: string) {
              return memo.get(id) ?? prisma.user.findUnique({ where: { id } });
            }
            isStale() {
              return Date.now() - this.refreshedAt > 60_000;
            }
            isCacheExpired() {
              return this.isStale();
            }
            hasAccess() {
              if (this.isStale()) void this.refresh();
              return true;
            }
            private async refresh() {
              this.refreshedAt = Date.now();
              await prisma.user.findMany();
            }
            async getCachedCount() {
              return prisma.user.findMany();
            }
            async reload(id: string) {
              if (id.length > 0) this.current = prisma.user.findUnique({ where: { id } });
              return this.current;
            }
            async find(id: string) {
              const found = local.get(id);
              if (found !== undefined) return found;
              return prisma.user.findUnique({ where: { id } });
            }
            async getCachedUser(id: string) {
              return prisma.user.findUnique({ where: { id } });
            }
            async signWith(id: string, credential: { certCache?: string }) {
              if (!credential.certCache) throw new Error("no certificate");
              return prisma.user.findUnique({ where: { id } });
            }
            async renderWith(id: string, credential: { certCache?: string }) {
              if (credential.certCache) await prisma.user.findUnique({ where: { id } });
            }
          }`,
        "src/main.ts": `
          import { allUsers, Keys, userById } from "./keys.js";
          export async function sign(ids: string[], keys: Keys) {
            for (const id of ids) {
              await keys.currentKey();
              await keys.firstKey();
              await keys.keyFor(id);
              await keys.lookup(id);
              await keys.peek(id);
              keys.hasAccess();
              await keys.getCachedCount();
              await keys.reload(id);
              await keys.find(id);
              await keys.getCachedUser(id);
              await userById(id);
              await allUsers();
              await keys.signWith(id, {});
              await keys.renderWith(id, {});
            }
          }
          declare const staleIds: string[];
          declare const store: Keys;
          export async function purgeStale() {
            if (staleIds.length === 0) return;
            for (const id of staleIds) await store.find(id);
          }`,
      }),
    ).toEqual([
      "12: queries the database once per item: the for…of loop calls keys.reload(), which reaches prisma.user.findUnique() (src/keys.ts:50)",
      "13: queries the database once per item: the for…of loop calls keys.find(), which reaches prisma.user.findUnique() (src/keys.ts:56)",
      "14: queries the database once per item: the for…of loop calls keys.getCachedUser(), which reaches prisma.user.findUnique() (src/keys.ts:59)",
      "15: queries the database once per item: the for…of loop calls userById(), which reaches prisma.user.findUnique() (src/keys.ts:8)",
      "17: queries the database once per item: the for…of loop calls keys.signWith(), which reaches prisma.user.findUnique() (src/keys.ts:63)",
      "18: queries the database once per item: the for…of loop calls keys.renderWith(), which reaches prisma.user.findUnique() (src/keys.ts:66)",
      "25: queries the database once per item: the for…of loop calls store.find(), which reaches prisma.user.findUnique() (src/keys.ts:56)",
    ]);
  });

  it("names the shortest way to a query, ties by the first call, whatever was asked before", () => {
    expect(
      findings({
        "src/lib.ts": `
          import { PrismaClient } from "@prisma/client";
          const prisma = new PrismaClient();
          export async function c() { return prisma.user.findMany(); }
          export async function a() { return c(); }
          export async function b() { return prisma.user.findUnique({ where: { id: "1" } }); }
          export async function outer() { await a(); await b(); }`,
        "src/main.ts": `
          import { a, outer } from "./lib.js";
          export async function first(ids: string[]) {
            for (const id of ids) await a();
          }
          export async function second(ids: string[]) {
            for (const id of ids) await outer();
          }`,
      }),
    ).toEqual([
      "4: queries the database once per item: the for…of loop calls a(), which reaches prisma.user.findMany() (src/lib.ts:4)",
      "7: queries the database once per item: the for…of loop calls outer(), which reaches prisma.user.findUnique() (src/lib.ts:6)",
    ]);
  });
});
