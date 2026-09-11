import { defineConfig } from "vitest/config";

/**
 * The CLI's tests are plain Node (the server, the argument parsing, the path
 * resolution). Scoped to `src/` so a `vitest run` from here does not walk up
 * to the monorepo root and collect the desktop's DOM tests.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
