import tseslint from "typescript-eslint";
import designguard from "./packages/eslint-plugin/dist/index.js";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "eslint.config.js", "vitest.config.ts"] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
  // designguard's own rules on its own code.
  designguard.configs.all,
  {
    files: ["packages/*/test/**", "packages/adapters/*/test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
