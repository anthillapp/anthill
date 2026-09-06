import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    // Components are authored with the automatic JSX runtime (`jsx: react-jsx`).
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    css: false,
  },
});
