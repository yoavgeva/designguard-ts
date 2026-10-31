/** The words of a name, lower case: `getCurrentUser` is `get`, `current`, `user`; `user_id` is `user`, `id`. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/** Words that name the user asking, or what they're signed in with. */
const USER = new Set(["user", "session", "auth", "viewer", "actor", "principal", "identity", "member", "account", "me", "whoami", "claims", "authentication", "authorization", "jwt"]);

/** Words that say a call is about the user asking, rather than any user: `getCurrentUser`, `whoami`. */
const ASKING = new Set(["current", "me", "my", "whoami", "logged", "signed", "authenticated"]);

/** What a call that fetches the user asking with no arguments starts with: `getSession()`, `requireUser()`. */
const FETCHING = new Set(["get", "require", "ensure", "assert", "validate", "verify", "check", "load", "read", "fetch", "use"]);

/** Whether a property or variable name names the user asking, when it's read from a request's context. */
export function isUserName(name: string): boolean {
  return wordsOf(name).some((word) => USER.has(word));
}

/**
 * Whether a call by this name gives the user asking: one named for the user asking, as `getCurrentUser()` is, or
 * fetching a user or session with nothing to say whose, as `auth()`, `getSession()` and `requireUser()` do.
 */
export function isUserCall(name: string, argumentCount: number): boolean {
  const words = wordsOf(name);
  if (!words.some((word) => USER.has(word))) return false;
  if (words.some((word) => ASKING.has(word))) return true;
  if (argumentCount > 0) return false;
  return words.length === 1 || FETCHING.has(words[0] ?? "");
}

/** Words that name a permission check wherever they are in a name: `assertCan`, `authorize`, `checkPermission`. */
const CHECKING = new Set([
  "can",
  "cannot",
  "authorize",
  "authorized",
  "authorization",
  "permission",
  "permissions",
  "permitted",
  "permit",
  "policy",
  "policies",
  "ability",
  "abilities",
  "forbid",
  "forbidden",
  "unauthorized",
  "allowed",
  "allow",
  "acl",
  "rbac",
]);

/** Words that name a check when a name starts by asking: `isAdmin`, `requireAccess`, `hasRole`, `checkOwnership`. */
const CHECKED = new Set(["access", "owner", "owns", "ownership", "role", "roles", "admin", "member", "membership", "staff", "superuser", "scope", "scopes"]);
const ASKS = new Set(["has", "check", "require", "assert", "ensure", "verify", "validate", "is", "must", "can", "only"]);

/** Whether a function, method or decorator by this name checks what the user asking may do. */
export function isCheckName(name: string): boolean {
  const words = wordsOf(name);
  if (words.some((word) => CHECKING.has(word))) return true;
  return ASKS.has(words[0] ?? "") && words.slice(1).some((word) => CHECKED.has(word));
}
