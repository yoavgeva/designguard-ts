import { join } from "node:path";
import plugin from "../src/index.js";
import { prisma, prismaFiles, typedProject } from "./fixture.js";

const { root, ruleTester } = typedProject(
  {
    ...prismaFiles,
    "node_modules/stripe/package.json": JSON.stringify({ name: "stripe", version: "18.0.0", types: "index.d.ts" }),
    "node_modules/stripe/index.d.ts": "export declare class Stripe { charges: { create(args: object): Promise<{ id: string }> } }",
    "src/main.ts": "",
  },
  [prisma],
);
const main = join(root, "src/main.ts");

ruleTester.run("no-unknown-io", plugin.rules["no-unknown-io"], {
  valid: [
    {
      filename: main,
      code: `
import { PrismaClient } from "@prisma/client";
export const load = (id: string) => new PrismaClient().user.findUnique({ where: { id } });`,
    },
  ],
  invalid: [
    {
      filename: main,
      code: `
import { Stripe } from "stripe";
export const charge = () => new Stripe().charges.create({});`,
      errors: [
        {
          messageId: "finding",
          line: 3,
          data: {
            message: "calls new Stripe().charges.create(), from stripe 18.0.0, which no adapter describes, so designguard can't tell what it does",
          },
        },
      ],
    },
  ],
});
