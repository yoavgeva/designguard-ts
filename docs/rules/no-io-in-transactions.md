# no-io-in-transactions

Flags an HTTP request, mail or a published message inside a database transaction, directly or through the functions
the transaction runs. The transaction holds its database connection, and often row locks, while it waits on the
outside world, and a rollback can't undo what was sent.

## What it flags

A call inside the function an adapter's transaction call runs, such as `prisma.$transaction(async (tx) => ...)` or
`dataSource.transaction(run)`, that reaches:

- `fetch`, or Node's `http`, `https`, `net` and `tls` modules, which the built-in standards adapter describes;
- network, mail or publishing calls that an adapter describes.

```ts
await prisma.$transaction(async (tx) => {
  await tx.order.update({ where: { id }, data: { paid: true } });
  await notifyWarehouse(id); // ✗ makes an HTTP request inside prisma.$transaction() through notifyWarehouse(),
});                          //   which reaches fetch() (warehouse.ts:4): the transaction holds its database
                             //   connection while it waits, and a rollback can't undo the request
```

Fixed: the request after the transaction commits, or through an outbox table the transaction writes to.

```ts
await prisma.$transaction(async (tx) => tx.order.update({ where: { id }, data: { paid: true } }));
await notifyWarehouse(id);
```

## Options

The [shared options](../../README.md#turning-rules-on-off-and-down).

## Needs

An adapter that describes the library's transactions, such as `@designguard/adapter-prisma`.
