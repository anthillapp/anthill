#!/usr/bin/env node
/**
 * Put the Anthill MCP server inside each plugin, as one file.
 *
 *   npm run plugin:bundle     build the server, then write both copies
 *
 * A plugin installed from a marketplace or a directory is a copy of its own
 * folder and nothing else, so a server it has to find elsewhere is a server a
 * person has to point it at. This writes two files into plugins/anthill
 * (Claude Code) and plugins/anthill-cli (Codex), each one ES module with
 * everything it imports, the @anthill packages and the npm ones, that needs
 * nothing but Node:
 *
 *   server/anthill-mcp.mjs     the MCP server; the launcher starts it when
 *                              nothing names another (plugins/anthill/bin/anthill-mcp)
 *   server/anthill-report.mjs  `run/step/done` alone (apps/cli/src/report-main.ts);
 *                              the server hands it to a harness with no
 *                              `anthill` on its PATH (apps/mcp/src/report-command.ts)
 *
 * Readable on purpose: not minified, names kept, so what a plugin runs can be
 * read in the plugin — the Claude directory holds code it cannot read for a
 * reviewer. The version is written into the file, because there is no
 * package.json beside it to read one from; apps/mcp/src/versions.test.ts fails
 * when a copy's version is not the release's, so a release cannot ship a
 * stale one. Run it after `npm run version:set` (RELEASING.md).
 */

import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGINS = ["plugins/anthill", "plugins/anthill-cli"];
const BUNDLES = [
  { entry: join(ROOT, "apps", "mcp", "dist", "server.js"), file: "anthill-mcp.mjs", title: "MCP server" },
  { entry: join(ROOT, "apps", "cli", "src", "report-main.ts"), file: "anthill-report.mjs", title: "progress reporter" },
];

const version = JSON.parse(readFileSync(join(ROOT, "apps", "mcp", "package.json"), "utf8")).version;

for (const bundle of BUNDLES) {
  const result = await build({
    entryPoints: [bundle.entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: false,
    keepNames: true,
    legalComments: "inline",
    write: false,
    logLevel: "warning",
    define: { __ANTHILL_MCP_VERSION__: JSON.stringify(version) },
    // Some of what is bundled is CommonJS and calls require() for Node's own
    // modules, which an ES module does not have.
    banner: {
      js: [
        `// Anthill ${bundle.title} ${version}, built by scripts/build-plugin-server.mjs`,
        "// from https://github.com/nstr/anthill. Do not edit: run",
        "// `npm run plugin:bundle` to write it again. MIT licensed.",
        'import { createRequire as __anthillCreateRequire } from "node:module";',
        "const require = __anthillCreateRequire(import.meta.url);",
      ].join("\n"),
    },
  });

  const [output] = result.outputFiles;
  for (const plugin of PLUGINS) {
    const file = join(ROOT, plugin, "server", bundle.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, output.contents);
    const kib = Math.round(statSync(file).size / 1024);
    process.stdout.write(`wrote ${relative(ROOT, file)} (${kib} KiB, ${version})\n`);
  }
}
