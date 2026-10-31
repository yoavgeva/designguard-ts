import { defineAdapter } from "@designguard/core";

/**
 * Auth.js: NextAuth 4's `getServerSession` and `getToken`, and the `auth()` NextAuth 5 makes, which give the session of
 * the user asking. Calls named for the session, as `auth()` and `getSession()` are, count without it; the adapter
 * adds those given options, as `getServerSession(authOptions)` is.
 */
export default defineAdapter({
  name: "authjs",
  packages: ["next-auth", "@auth/core"],
  versions: ">=4 <6",
  users: ["{getServerSession,unstable_getServerSession,getToken,getSession,auth}"],
});
