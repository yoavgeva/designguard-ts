import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Adapter, analyze } from "@designguard/core";
import ts from "typescript";

export { type Adapter, defineAdapter } from "@designguard/core";

/** A typed stub of a package, as files for `node_modules/<name>`: its `package.json` and `index.d.ts`. */
export function stubPackage(name: string, version: string, declarations: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, version, types: "index.d.ts" }),
    [`node_modules/${name}/index.d.ts`]: declarations,
  };
}

export interface Sample {
  /** Files of the sample project, the stubs of the packages it calls included, by path. */
  readonly files: Record<string, string>;
  /** The code that calls the packages, as an ES module. */
  readonly code: string;
}

/**
 * What an adapter makes of each call a sample makes into a package, in the order the calls start, as
 * `users.find(): typeorm Repository.find, db.read`. A call it gives no role still shows the qualified name its
 * patterns would have to match.
 */
export function rolesOf(adapter: Adapter, sample: Sample): string[] {
  const root = mkdtempSync(join(tmpdir(), "designguard-adapter-"));
  try {
    const files: Record<string, string> = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true, types: [] },
        include: ["sample.ts"],
      }),
      "package.json": JSON.stringify({ name: "sample", type: "module" }),
      ...sample.files,
      "sample.ts": sample.code,
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    });
    if (config === undefined) throw new Error("the sample's tsconfig didn't parse");
    const program = ts.createProgram(config.fileNames, config.options);
    const file = program.getSourceFile(join(root, "sample.ts"));
    if (file === undefined) throw new Error("the sample didn't compile");
    return analyze(program, { adapters: [adapter], standards: false })
      .roles(file)
      .map((role) => {
        const what =
          role.off !== undefined
            ? `, off: ${role.off}`
            : `${role.effect === undefined ? "" : `, ${role.effect}`}${role.transaction === undefined ? "" : `, transaction running its argument ${String(role.transaction)}`}`;
        return `${role.callee}(): ${role.package} ${role.name}${what}`;
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
