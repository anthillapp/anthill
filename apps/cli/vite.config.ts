import { createRequire } from "node:module";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The app's version, from the one place that already has to be right.
 * Mirrors the desktop renderer build (apps/desktop/electron.vite.config.ts):
 * the renderer reads `__ANTHILL_VERSION__` as a build-time constant, so the
 * CLI bundle must define it the same way.
 */
const { version } = createRequire(import.meta.url)("./package.json") as {
  version: string;
};

/**
 * Bundle the desktop renderer into `out/renderer`.
 *
 * The renderer (`apps/desktop/src/renderer`) is pure React with zero
 * electron imports — it talks to `window.anthill` and, under the CLI,
 * `src/web-bridge.ts` provides that from the WebSocket. We therefore bundle
 * the same source the desktop bundles, rather than a copy: one renderer,
 * two shells. `src/web-bridge.ts` is the CLI-only entry; it is excluded
 * from tsc (the CLI tsconfig type-checks only the main-process files) and
 * is built here instead.
 */
export default defineConfig({
  root: resolve(__dirname, "../desktop/src/renderer"),
  plugins: [react()],
  // Every built CLI may report, once its author opts in (see diagnostics.ts).
  define: { __ANTHILL_VERSION__: JSON.stringify(version), __ANTHILL_DIAGNOSTICS__: "true" },
  build: {
    outDir: resolve(__dirname, "out/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // The renderer's own entry, unchanged.
        index: resolve(__dirname, "../desktop/src/renderer/index.html"),
        // The CLI's entry: installs `window.anthill` from the WebSocket.
        "web-bridge": resolve(__dirname, "src/web-bridge.ts"),
      },
    },
  },
});
