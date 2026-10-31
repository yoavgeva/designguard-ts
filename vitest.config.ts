import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run on the sources, so the plugin's tests use the core's sources too.
    alias: {
      "@designguard/core": new URL("packages/core/src/index.ts", import.meta.url).pathname,
      "@designguard/adapter-kit": new URL("packages/adapter-kit/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
