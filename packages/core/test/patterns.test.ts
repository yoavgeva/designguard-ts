import { describe, expect, it } from "vitest";
import { glob } from "../src/patterns.js";

describe("glob", () => {
  it("matches anything with *, either alternative with {a,b}, and wildcards inside alternatives", () => {
    const pattern = glob("{*Database,*Transaction}.transaction");
    expect(["PgDatabase.transaction", "SQLiteTransaction.transaction", "PgDatabase.select", "Database.transaction"].map((name) => pattern.test(name))).toEqual([
      true,
      true,
      false,
      true,
    ]);
    expect(glob("*Delegate.{findMany,update}").test("Prisma.UserDelegate.update")).toBe(true);
    expect(glob("fs.*").test("fs.promises.readFile")).toBe(true);
    expect(glob("$transaction").test("$transaction")).toBe(true);
  });
});
