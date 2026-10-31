# no-queries-in-loops

Flags a database query made once per item of a loop, directly or through the functions the loop calls: the N+1
query. Each item costs a round trip to the database, so a page that lists 50 orders makes 51 queries.

## What it flags

A call that runs once per item and reaches a query, as an adapter describes queries:

- inside a `for`, `for…of` or `for…in` loop;
- in the callback of an array, map or set method that calls it once per item: `map`, `forEach`, `flatMap`,
  `filter`, `reduce`, `some`, `every`, `find` and the like, `Promise.all(ids.map(...))` included;
- a function passed by name to one of those, as `ids.map(loadUser)` passes `loadUser`.

The query can be any number of calls away, in other files, through methods, interfaces and their implementations.
`while` and `do…while` loops aren't counted: they poll or retry rather than walk items.

```ts
// users.ts
export async function loadUser(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

// orders.ts
for (const order of orders) {
  order.user = await loadUser(order.userId); // ✗ queries the database once per item: the for…of loop calls
}                                           //   loadUser(), which reaches prisma.user.findUnique() (users.ts:2)
```

Fixed: one query for every item.

```ts
const users = await prisma.user.findMany({ where: { id: { in: orders.map((order) => order.userId) } } });
```

## Options

The [shared options](../../README.md#turning-rules-on-off-and-down): `include`, `exclude` and `excludeReaching`. For
example, `exclude: ["src/migrations/**"]` leaves one-off migration scripts out.

## Needs

An adapter for the database library: [Prisma](../../packages/adapters/prisma), [Drizzle](../../packages/adapters/drizzle),
[TypeORM](../../packages/adapters/typeorm), [Kysely](../../packages/adapters/kysely), or your own.
