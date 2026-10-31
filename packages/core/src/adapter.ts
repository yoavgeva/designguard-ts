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
 * What designguard knows about a library: data, so ESLint can cache and print the configuration that holds it.
 * `packages` are the npm packages whose declarations the patterns match.
 */
export interface Adapter {
  readonly name: string;
  readonly packages: readonly string[];
  /**
   * Patterns over the paths of project files that belong to the library: code it generates there, such as Prisma's
   * `generated/prisma` folder. Their declarations match the adapter's patterns as the first package's do.
   */
  readonly files?: readonly string[];
  readonly effects?: readonly EffectSpec[];
}

export function defineAdapter<const A extends Adapter>(adapter: A): A {
  return adapter;
}
