# no-lost-updates

Flags a write of a value computed from one read before: two requests at once both read the same stock, and the
second write undoes the first. A transaction doesn't prevent it at the isolation level databases use by default.

## What it flags

A write that sets a property from its own old value, read from the database earlier in the same function:

- in what it saves, as `data: { stock: product.stock - quantity }` and `.set({ balance: account.balance.add(amount) })`
  do;
- on an entity it saves, changed after the read, as `product.stock -= quantity` then `repository.save(product)` does.

The value must be counted: arithmetic on a number or a bigint, or a decimal's `add()`, `minus()` and the like.
Joining text, as `name + "!"` does, isn't counting.

```ts
const product = await prisma.product.findUnique({ where: { id } });
await prisma.product.update({ where: { id }, data: { stock: product.stock - quantity } });
// ✗ sets stock from its value read through prisma.product.findUnique() (shop.ts:4): a request that changes it
//   between that read and this write is lost
```

Fixed: let the database do the arithmetic, or make the write fail when the row has changed.

```ts
await prisma.product.update({ where: { id }, data: { stock: { decrement: quantity } } });
```

## What passes

- a read that locks the row, as TypeORM's `lock` option, Drizzle's `.for("update")` and Kysely's `forUpdate()` do;
- an entity with a version column, as TypeORM's `@VersionColumn()`, which makes a write over a newer row fail;
- a write that checks the version it read, as `where: { id, version: product.version }` does.

## Options

The [shared options](../../README.md#turning-rules-on-off-and-down).

## Needs

A database adapter whose `writes` name where its writes take the data they save.
