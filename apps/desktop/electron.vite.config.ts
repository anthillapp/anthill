import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * The app's version, from the one place that already has to be right.
 *
 * The launch screen used to carry it as a literal, and it drifted: the screen
 * said 0.4 while this file said 0.0.1, and the disk image was named after the
 * second. A number a person maintains in two places is a number that disagrees
 * with itself eventually, and the copy people read is the one that goes stale.
 */
const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

/**
 * The `@anthill/*` workspace packages are ESM, while the Electron main and
 * preload bundles are CJS. They are therefore bundled in (not externalized) so
 * rollup can convert them. `better-sqlite3` is a native addon and must stay
 * external so it is `require`d from node_modules at runtime.
 */
const anthillPackages = [
  "@anthill/builder",
  "@anthill/engine",
  "@anthill/exchange-store",
  "@anthill/live",
  "@anthill/workflow",
  "@anthill/workflow-exchange",
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
    define: { __ANTHILL_VERSION__: JSON.stringify(version) },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
