# no-mass-assignment

Flags a request handler that saves what the request sends as it is, when it has a property the request shouldn't
set: one that grants access, as `role` and `isAdmin` do, names an owner, as `userId`, `ownerId` and `teamId` do, or
records a check the server makes, as `emailVerified` and `approved` do. A handler that saves the user it's sent lets
anyone who adds `role: "admin"` make themselves an admin.

## What it flags

A handler whose input, as a whole, reaches what a write saves, as Prisma's `update({ data })`, Drizzle's and Kysely's
`set()` and `values()`, and TypeORM's `save()` and `update()` take, directly or through the functions it's given to,
when the input's type has such a property. Spreading it, as `{ ...input }` does, saves it as it is too; a property the
code sets after the spread is the code's.

```ts
export const updateAccount = protectedProcedure
  .input(z.object({ name: z.string(), role: z.enum(["member", "admin"]) }))
  .mutation(async ({ ctx, input }) => {
    await ctx.db.user.update({ where: { id: ctx.user.id }, data: input }); // ✗ the updateAccount mutation saves
  });                                                                      //   what the request sends as it is
                                                                           //   through ctx.db.user.update(), so the
                                                                           //   request can set role
```

Fixed: leave the property out of the input, or set it in the code.

```ts
.input(z.object({ name: z.string() }))
.mutation(async ({ ctx, input }) => ctx.db.user.update({ where: { id: ctx.user.id }, data: { name: input.name } }));
```

A handler that checks permissions passes, as [`writes-are-authorized`](writes-are-authorized.md) reads one: an admin
may set roles. Taking the user asking doesn't: a user changing their own account is the case this rule is about.
Input typed `any`, as Express's `req.body` is, has no properties to check.

## Options

The [shared options](../../README.md#turning-rules-on-off-and-down).

## Needs

Adapters for the framework that handles requests and for the database, whose `writes` name where its writes take the
data they save.
