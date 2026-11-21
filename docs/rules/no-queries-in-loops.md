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
`while` and `do…while` loops aren't counted: they poll or retry rather than walk items. Neither are loops that run as
often whatever the data: a `for` loop with no condition, or one counting to a number the code gives, here or in a
module it imports, or to a limit of attempts or passes, as `i < maxAttempts` and `round < MAX_ROUNDS && pending` do,
and a loop over a list written in the code, as `for (const role of ["owner", "admin"])`. Nor are loops over the data a
chunk at a time, which make one query per chunk to keep each small: `for (const batch of chunk(ids, 100))`,
`batches.map(...)`, `for (let batch = 0; ...)` and `i += BATCH_SIZE`.

A query that runs only when a cache misses or goes stale isn't made once per item either: one in a function named for
a cache, as `getCachedKey()` and `refreshIfStale()` are, one in a function given to a cache, as
`memoize(key, () => load())` and `cache(async () => load())` are, one past a return of what a cache holds, as
`if (cached) return cached;` is, one a cache falls back on, as in `cache.get(key) ?? load(key)`, one that runs when a
cache is stale, as under `if (this.isStale())`, and one kept in the field a check reads, as `this.key ??= loadKey()`
is. A cached function that takes arguments is cached by them, as React's `cache((id) => ...)` is, so calling it with
each item's own still queries once per item, and is flagged.

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
