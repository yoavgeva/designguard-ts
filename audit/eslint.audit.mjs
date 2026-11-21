// The audit's ESLint config, copied into each app: typescript-eslint's typed promise rules, which a project that
// lints with types runs anyway, plus every designguard rule with every adapter when DG=1, so the two runs differ only
// by designguard.
import { createRequire } from "node:module";

const require = createRequire("/tools/package.json");
const load = async (name) => (await import(require.resolve(name))).default;
const tseslint = await load("typescript-eslint");
const designguard = await load("eslint-plugin-designguard");
const names = ["prisma", "drizzle", "typeorm", "kysely", "express", "hono", "trpc", "nestjs", "authjs"];
const loaded = await Promise.all(names.map((name) => load(`@designguard/adapter-${name}`)));
// FORKS="typeorm=@n8n/typeorm" points an adapter at a fork published under another name, whatever its version.
const forks = (process.env.FORKS ?? "").split(",").filter(Boolean).map((fork) => fork.split("="));
const adapters = [
  ...loaded,
  ...forks.map(([name, fork]) => ({ ...loaded[names.indexOf(name)], name: `${name}:${fork}`, packages: [fork], versions: undefined })),
];
const withDesignguard = process.env.DG === "1";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/*.{test,spec}.{ts,tsx}", "**/__tests__/**", "**/__mocks__/**", "**/generated/**", "**/*.d.ts"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: process.cwd() } },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
    plugins: { "@typescript-eslint": tseslint.plugin, ...(withDesignguard ? { designguard } : {}) },
    settings: { designguard: { adapters } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      ...(withDesignguard ? { ...designguard.configs.all.rules, "designguard/no-unknown-io": "off" } : {}),
    },
  },
];
