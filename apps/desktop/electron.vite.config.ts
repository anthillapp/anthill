import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * The `@anthill/*` workspace packages are ESM, while the Electron main and
 * preload bundles are CJS. They are therefore bundled in (not externalized) so
 * rollup can convert them. `better-sqlite3` is a native addon and must stay
 * external so it is `require`d from node_modules at runtime.
 */
const anthillPackages = [
  "@anthill/builder",
  "@anthill/engine",
  "@anthill/live",
  "@anthill/workflow",
  "@anthill/run-store",
  "@anthill/runtimes",
  "@anthill/ui",
  "@anthill/workflow-schema",
  "@anthill/workspace",
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: anthillPackages })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "live-hook-handler": resolve(__dirname, "src/main/live/hook-handler.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: anthillPackages })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
