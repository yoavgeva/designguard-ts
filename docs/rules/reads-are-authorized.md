# reads-are-authorized

Flags a request handler that reads a record by a key the request sends, with nothing checking that the user asking
may see it. A handler that loads a record by the id in the URL shows anyone's record to whoever changes the id: broken
object level authorization, first on OWASP's API Security Top 10.

## What it flags

A handler an adapter finds whose input, such as a route's params, a tRPC input or a server function's arguments,
reaches the key of a lookup of one record, as Prisma's `findUnique`, Drizzle's `findFirst`, TypeORM's `findOneBy` or
Kysely's `executeTakeFirst` are, directly or through the functions it's given to. It passes on the terms
[`writes-are-authorized`](writes-are-authorized.md) reads.

```ts
app.get("/invoices/:id", async (req, res) => {
  res.json(await invoices.find(req.params.id)); // ✗ the GET /invoices/:id handler reads a record by a key the
});                                             //   request sends through invoices.find(), which reaches
                                                //   prisma.invoice.findUnique() (invoices.ts:8): nothing checks
                                                //   that the user asking may see it
```

Fixed: scope the query to the user asking.

```ts
app.get("/invoices/:id", async (req, res) => {
  res.json(await invoices.find(req.params.id, req.user.id)); // findUnique({ where: { id, ownerId } })
});
```

Many records are public by design, such as published articles, products and profiles, so this rule isn't
recommended: turn it on for the handlers that show private data, with `include`, or leave the public ones out with
`exclude`.

## Options

The [shared options](../../README.md#turning-rules-on-off-and-down).

## Needs

Adapters for the framework that handles requests and for the database, whose `lookups` name its reads of one record.
