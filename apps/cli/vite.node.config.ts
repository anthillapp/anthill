import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The `workflow export` entry, built for **Node** — unlike the renderer
 * bundle (browser), it reads the workflow folder and writes the file, so
 * `node:fs` and friends stay real modules, not browser externalizations.
 *
 * It lands in the renderer's output directory as `workflow-export.js`,
 * where `cli.ts` imports it at the point of use. This build runs after the
 * renderer build (which empties the directory) and adds one file to it.
 */
export default defineConfig({
  build: {
    outDir: resolve(__dirname, "out/renderer"),
    emptyOutDir: false,
    ssr: resolve(__dirname, "src/workflow-export-entry.ts"),
    rollupOptions: {
      output: { entryFileNames: "workflow-export.js" },
    },
  },
});
