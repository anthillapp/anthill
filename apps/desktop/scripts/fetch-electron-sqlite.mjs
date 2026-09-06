/**
 * Fetch an Electron-ABI build of better-sqlite3 into `apps/desktop/native/`.
 *
 * A native addon is compiled against one runtime's ABI. The copy npm installs
 * targets the system Node, and Electron refuses to load it
 * (`NODE_MODULE_VERSION` mismatch / ERR_DLOPEN_FAILED). Rebuilding in place
 * would fix the app but break `@anthill/run-store`'s tests, which run under
 * plain Node — so we keep both binaries side by side:
 *
 *   node_modules/better-sqlite3/build/Release/better_sqlite3.node  <- Node ABI (tests)
 *   apps/desktop/native/better_sqlite3.node                        <- Electron ABI (app)
 *
 * The download happens in a throwaway directory that only holds a copy of
 * better-sqlite3's package.json. The real `node_modules` is never written to,
 * so a failure here cannot leave the workspace with the wrong binary — an
 * earlier version of this script restored the Node binary in a `finally` block
 * and still managed to clobber it.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repoRoot = resolve(appDir, "../..");

const require = createRequire(import.meta.url);
const electronVersion = require(join(repoRoot, "node_modules/electron/package.json")).version;

const moduleDir = join(repoRoot, "node_modules/better-sqlite3");
if (!existsSync(moduleDir)) {
  console.error(`Expected ${moduleDir} to exist. Run \`npm install\` first.`);
  process.exit(1);
}

const outDir = join(appDir, "native");
const outBinary = join(outDir, "better_sqlite3.node");

const staging = mkdtempSync(join(tmpdir(), "anthill-sqlite-"));
try {
  // prebuild-install reads name/version/binary config from package.json in cwd
  // and extracts into ./build/Release there.
  copyFileSync(join(moduleDir, "package.json"), join(staging, "package.json"));

  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/prebuild-install/bin.js"),
      "--runtime=electron",
      `--target=${electronVersion}`,
      "--tag-prefix=v",
      "--force",
    ],
    { cwd: staging, stdio: "inherit" },
  );

  if (result.status !== 0) {
    throw new Error(
      `prebuild-install failed (exit ${result.status}) for electron ${electronVersion}.`,
    );
  }

  const downloaded = join(staging, "build/Release/better_sqlite3.node");
  if (!existsSync(downloaded)) {
    throw new Error(`prebuild-install reported success but ${downloaded} is missing.`);
  }

  mkdirSync(outDir, { recursive: true });
  copyFileSync(downloaded, outBinary);
  console.log(`Electron-ABI better_sqlite3 written to ${outBinary}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
