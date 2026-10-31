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
 * argument at `body` runs inside it.
 */
export interface TransactionSpec {
  readonly on: string;
  readonly body: number;
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
}

export function defineAdapter<const A extends Adapter>(adapter: A): A {
  return adapter;
}
