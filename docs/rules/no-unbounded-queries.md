# no-unbounded-queries

Flags a request handler that loads every row of a table, directly or through the functions it calls. Each request
loads more as the table grows, until the page times out or the server runs out of memory.

## What it flags

A read an adapter describes as a list, given nothing that filters, limits or aggregates it:

- options without a filter or a limit, as Prisma's `findMany()` or `findMany({ orderBy })` and TypeORM's `find()` are;
- a query builder whose chain has no filter or limit, as Drizzle's `db.select().from(users)` and Kysely's
  `db.selectFrom("users").selectAll().execute()` are, run where it's written: awaited, executed, or returned from an
  async function.

```ts
export async function GET(request: Request) {
  return Response.json(await prisma.product.findMany()); // ✗ GET() loads every row through
}                                                        //   prisma.product.findMany(), so each request loads more
                                                         //   as the table grows
```

Fixed: take a page, or filter to what the response shows.

```ts
return Response.json(await prisma.product.findMany({ take: 50, cursor: after ? { id: after } : undefined }));
```

Options or a chain that come from elsewhere, as a variable holds them, aren't flagged: they may be bounded there. A
table that stays small, such as a list of countries or of an application's settings, can stay whole: leave its
handler out with `exclude`, or its model with `excludeReaching`. For that reason this rule isn't recommended.

## Options

The [shared options](../../README.md#turning-rules-on-off-and-down).

## Needs

Adapters for the framework that handles requests and for the database, whose `lists` name its reads of many rows.
