import { describe, expect, it } from "vitest";
import { analyze, defineAdapter } from "../src/index.js";
import { prismaStub, project, stubPackage } from "./fixture.js";

const stripe = stubPackage(
  "stripe",
  "18.0.0",
  `export declare class Stripe {
     charges: { create(args: object): Promise<{ id: string }> };
     webhooks: { constructEvent(body: string): { type: string } };
   }`,
);

function findings(adapters: Parameters<typeof analyze>[1]["adapters"]): string[] {
  const { program } = project({
    ...prismaStub,
    ...stripe,
    "src/main.ts": `
      import { Stripe } from "stripe";
      import { PrismaClient } from "@prisma/client";
      const stripe = new Stripe();
      const prisma = new PrismaClient();
      export async function pay(body: string) {
        stripe.webhooks.constructEvent(body);
        await stripe.charges.create({});
        await stripe.charges.create({});
        return prisma.user.findMany();
      }`,
  });
  const main = program.getSourceFiles().find((file) => file.fileName.endsWith("src/main.ts"));
  if (main === undefined) throw new Error("no src/main.ts");
  return analyze(program, { adapters })
    .unknownIo(main)
    .map((finding) => `${String(main.getLineAndCharacterOfPosition(finding.node.getStart()).line + 1)}: ${finding.message}`);
}

describe("unknownIo", () => {
  it("names each package whose promises no adapter describes, once per file", () => {
    const prisma = defineAdapter({ name: "prisma", packages: ["@prisma/client"], versions: ">=5 <8", effects: [] });
    expect(findings([prisma])).toEqual([
      "8: calls stripe.charges.create(), from stripe 18.0.0, which no adapter describes, so designguard can't tell what it does",
    ]);
  });

  it("says when an adapter doesn't describe the installed version", () => {
    const prisma = defineAdapter({ name: "prisma", packages: ["@prisma/client"], versions: ">=7", effects: [] });
    expect(findings([prisma])).toEqual([
      "8: calls stripe.charges.create(), from stripe 18.0.0, which no adapter describes, so designguard can't tell what it does",
      "10: calls prisma.user.findMany(), from @prisma/client 6.1.0, which the prisma adapter doesn't describe: it describes >=7",
    ]);
  });
});
