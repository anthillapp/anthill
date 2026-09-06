import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Two kinds of test live in this app, so two environments.
 *
 * Main-process modules are plain Node. Renderer screens need a DOM — and the
 * Live Run screen in particular is worth testing there, because most of what it
 * has to get right is what it refuses to offer: no Stop button on a session
 * Anthill does not own, no approval buttons where it cannot answer.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    environmentMatchGlobs: [["src/renderer/**", "jsdom"]],
    include: [
      "src/main/**/*.test.ts",
      "src/preload/**/*.test.ts",
      "src/shared/**/*.test.ts",
      "src/renderer/**/*.test.ts",
      "src/renderer/**/*.test.tsx",
    ],
  },
});
