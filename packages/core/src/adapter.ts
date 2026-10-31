/** What a call does outside the code. */
export type EffectKind =
  | "db.read"
  | "db.write"
  | "network"
  | "mail"
  | "publish"
  | "file"
  | "process"
  | "clock"
  | "random"
  | "env";

/** Calls into a package that have an effect, as `{ on: "*Delegate.findMany", kind: "db.read" }`. */
export interface EffectSpec {
  /** A pattern over the qualified name of the declaration a call resolves to: `*` matches anything, `{a,b}` either. */
  readonly on: string;
  readonly kind: EffectKind;
}

/**
 * A call that runs a function inside a database transaction, as `{ on: "PrismaClient.$transaction", body: 0 }`: the
 * argument at `body` runs inside it, or the last one, as TypeORM's `transaction(isolation?, run)` takes it.
 */
export interface TransactionSpec {
  readonly on: string;
  readonly body: number | "last";
}

/**
 * Where requests come in: a call that registers handlers, a decorator on a method, a directive or a file's exports.
 *
 * - `call`: as Express's `IRouter.post`; `handler` is the argument that handles the request, `"last"` unless given.
 *   Function arguments before it are middleware, and so are those of the calls before it in a chain that match
 *   `middleware`, as tRPC's `ProcedureBuilder.use` in `t.procedure.use(isAdmin).mutation(...)`.
 * - `decorator`: on a method, as NestJS's `Post`; the method handles the request.
 * - `directive`: a function in a file that starts with it, or whose body does, as React's `"use server"`.
 * - `exports`: a file's exported functions with these names, whose first parameter's type, or a type it extends,
 *   matches `takes`, as the `POST(request: Request)` of a route handler.
 */
export interface EntryPointSpec {
  readonly call?: string;
  readonly handler?: number | "last";
  readonly middleware?: string;
  readonly decorator?: string;
  readonly directive?: string;
  readonly exports?: string;
  readonly takes?: string;
  /** Requests that only ask to read, as a GET does: what they write is the server's bookkeeping, not a change asked for. */
  readonly reads?: boolean;
  readonly parameters?: readonly ParameterSpec[];
}

/**
 * What a handler's parameter holds: what the request sends, the user asking, or a context the user asking can be read
 * from, as Express's `req` is. Without `at` or `decorator`, every parameter.
 */
export interface ParameterSpec {
  /** The parameter's position. */
  readonly at?: number;
  /** A pattern over the name of a decorator the parameter has, as NestJS's `Body`. */
  readonly decorator?: string;
  /** Where in it, as `["input"]` for tRPC's `opts.input`; a name ending in `()` is a method's result, as `json()`. */
  readonly path?: readonly string[];
  readonly holds: "input" | "context" | "user";
}

/**
 * Where a write takes the data it saves, as Prisma's `update({ data })`: the argument at `argument`, or, with
 * `property`, that property of it.
 */
export interface WriteSpec {
  readonly on: string;
  readonly argument: number;
  readonly property?: string;
}

/**
 * A read that loads every row unless something filters or limits it:
 *
 * - with `argument`, a property of that argument named by `bounds`, as Prisma's `findMany({ where, take })` has; a
 *   read given no such argument, or an object without those properties, loads every row;
 * - without it, a call in the chain after `on` named by `bounds`, as Drizzle's `db.select().from(t).where(...)` makes.
 *   The chain must run the query: end in a call `runs` names, as Kysely's `execute()`, or, without `runs`, be
 *   awaited.
 *
 * A read whose options or chain come from elsewhere, as a variable holds them, isn't reported: they may bound it.
 */
export interface ListSpec {
  readonly on: string;
  readonly argument?: number;
  readonly bounds: string;
  readonly runs?: string;
  /**
   * Calls or tags in its arguments or its chain's that make it return one row, as Drizzle's `count()` makes
   * `db.select({ n: count() }).from(t)` do.
   */
  readonly aggregates?: string;
}

/**
 * What designguard knows about a library: data, so ESLint can cache and print the configuration that holds it.
 * `packages` are the npm packages whose declarations the patterns match.
 */
export interface Adapter {
  readonly name: string;
  readonly packages: readonly string[];
  /**
   * The versions of the library the adapter describes, as a semver range such as `>=5 <8`, checked against the first
   * of `packages` installed. When the installed version is outside it, the adapter is off.
   */
  readonly versions?: string;
  /**
   * Patterns over the paths of project files that belong to the library: code it generates there, such as Prisma's
   * `generated/prisma` folder. Their declarations match the adapter's patterns as the first package's do.
   */
  readonly files?: readonly string[];
  readonly effects?: readonly EffectSpec[];
  readonly transactions?: readonly TransactionSpec[];
  readonly entryPoints?: readonly EntryPointSpec[];
  /** Calls that give the user asking, as Auth.js's `getServerSession`. */
  readonly users?: readonly string[];
  /** Calls and decorators that check what the user asking may do, as NestJS's `UseGuards`. */
  readonly checks?: readonly string[];
  /** Reads of one record by its key, as Prisma's `findUnique`. */
  readonly lookups?: readonly string[];
  readonly writes?: readonly WriteSpec[];
  readonly lists?: readonly ListSpec[];
}

export function defineAdapter<const A extends Adapter>(adapter: A): A {
  return adapter;
}
