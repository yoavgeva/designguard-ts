# no-unknown-io

Reports calls that return a promise from a package no adapter describes, once per package per file. The rules that
follow calls can't tell what those calls do, so this shows what they don't check. It also reports a package whose
adapter is off because the installed version is outside the adapter's `versions`.

It isn't in the recommended config. Turn it on to see where designguard is blind, then add or write adapters.

```ts
import Stripe from "stripe";

await stripe.charges.create({ amount }); // ✗ calls stripe.charges.create(), from stripe 18.0.0, which no adapter
                                          //   describes, so designguard can't tell what it does
```

```ts
await prisma.user.findMany(); // ✗ calls prisma.user.findMany(), from @prisma/client 4.16.0, which the prisma
                              //   adapter doesn't describe: it describes >=5 <8
```

## Options

The [shared options](../../README.md#turning-rules-on-off-and-down). `excludeReaching: ["zod#*"]` stops reporting a
package whose promises touch nothing outside the code.
