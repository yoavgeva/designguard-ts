# writes-are-authorized

Flags a request handler that writes to the database, directly or through the functions it calls, with nothing
checking that the user asking may. An endpoint that changes a record by the id it's sent lets anyone change anyone's
record: the hole AI-written and generated CRUD endpoints leave most.

## What it flags

A handler an adapter finds, such as an Express or Hono route, a tRPC mutation, a NestJS controller method or GraphQL
mutation, a React server function or a route handler's `POST`, that reaches a database write, unless it:

- reads the user asking: from its request or context, as `req.user`, `ctx.session` or `c.get("user")` do, or as a
  parameter, as NestJS's `@CurrentUser() user` is;
- gives the user asking, or its context, to the code it calls, which can read them there;
- calls code that gets the user asking, as `auth()`, `getServerSession(authOptions)` or a `getCurrentUser()` of the
  project's own do;
- calls code that checks permissions: a function named for a check, as `assertCan()`, `authorize()` or `isAdmin()`
  are, or one an adapter names, as NestJS's `UseGuards` is;
- runs after middleware or under a decorator that checks, as `requireAdmin`, tRPC's `use(isAdmin)`, `@Roles("admin")`
  or `@UseGuards(...)` do;
- reads a secret the request sends, as a token in an unsubscribe link or a webhook's signature, which proves it may.

Handlers of requests that only ask to read, such as GET routes and tRPC queries, aren't flagged: what they write is
the server's bookkeeping.

```ts
"use server";

export async function cancelOrder(id: string) {
  await orders.cancel(id); // ✗ cancelOrder() writes to the database through orders.cancel(), which reaches
}                          //   prisma.order.update() (orders.ts:12) with nothing checking that the user asking may
```

Fixed: take the user asking and scope the change to them, or check their permissions.

```ts
export async function cancelOrder(id: string) {
  const user = await getCurrentUser();
  await orders.cancel(id, user.id); // updates where { id, ownerId: user.id }
}
```

Middleware that only signs the user in, as `authenticate` or tRPC's `protectedProcedure` does, doesn't count: it
proves who is asking, not that they may change this record.

## Not seen

Endpoints that URL rules in front of them authorize, and ones that are public by design, such as sign-up and log-in,
pass through no code designguard sees: leave them out with `exclude`.

## Options

The [shared options](../../README.md#turning-rules-on-off-and-down).

## Needs

Adapters for the framework that handles requests, such as `@designguard/adapter-express`, and for the database, such as
`@designguard/adapter-prisma`. React server functions and route handlers are built in.
