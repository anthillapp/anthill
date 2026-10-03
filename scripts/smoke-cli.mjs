#!/usr/bin/env node
/**
 * Start the installed `anthill` CLI and fetch its page once.
 *
 * CI runs it on Linux and Windows after the README's from-source steps, so a
 * green job means: it installs, builds, starts and serves the app on
 * 127.0.0.1. It does not mean the app works there — no window is opened, no
 * workflow is handed over, no session is observed. That would be end-to-end
 * use, which only a person on that platform does (AGENTS.md, "What a check
 * proves").
 *
 * The run uses a throwaway data directory whose settings turn analytics and
 * error reporting off, so a CI runner never reports anything.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 4199;
const URL = `http://127.0.0.1:${PORT}/`;
const windows = process.platform === "win32";

const dataDir = mkdtempSync(join(tmpdir(), "anthill-smoke-"));
writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({ version: 2, settings: { analyticsEnabled: false, errorReportingEnabled: false, nativeCrashReportingEnabled: false } }),
);

const child = spawn("anthill", ["--no-browser", "--port", String(PORT), "--data-dir", dataDir], {
  shell: windows, // `anthill` is a .cmd shim there
  stdio: ["ignore", "inherit", "inherit"],
});
let exited;
child.on("exit", (code) => (exited = code));

function stop() {
  if (exited !== undefined) return;
  if (windows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

let result = 1;
try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`anthill exited with ${exited} before serving ${URL}`);
    try {
      const response = await fetch(URL);
      const body = await response.text();
      if (response.ok && /<html/i.test(body)) {
        console.log(`anthill served ${URL} (${response.status}, ${body.length} bytes).`);
        result = 0;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (result) console.error(`anthill did not serve ${URL} within 60 s.`);
} catch (error) {
  console.error(error.message);
} finally {
  stop();
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(result);
