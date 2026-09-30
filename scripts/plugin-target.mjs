#!/usr/bin/env node
/**
 * Point the harness plugins at the development build of Anthill, or back.
 *
 *   npm run plugin:target -- dev         build this checkout's MCP server, serve the dev build
 *   npm run plugin:target -- installed   serve the installed app again
 *   npm run plugin:target                say which it is now
 *
 * Both plugins — Claude Code's and Codex's — start the MCP server named in
 * `~/.anthill/plugin.json`, and the server reads `"target"` from the same file
 * (see apps/mcp/src/target.ts). So one edit here switches both, with no plugin
 * reinstalled and nothing committed. A harness reads its plugins when a session
 * starts: the switch takes effect in the next session.
 *
 * Switching to `dev` builds the server first, because the server is this
 * checkout's build and a build from another branch is the easiest way to test
 * the wrong thing. `--no-build` skips it.
 *
 * What the switch does not change: the skill text a harness reads comes from
 * the installed plugin copy, not this checkout. A change to the skill itself
 * needs `claude plugin update anthill@anthill` (or the Codex equivalent).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS = join(homedir(), ".anthill", "plugin.json");
const SERVER = join(ROOT, "apps", "mcp", "dist", "server.js");

function appData() {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}
const DATA = {
  installed: join(appData(), "@anthill", "desktop"),
  dev: join(appData(), "@anthill", "desktop-dev"),
};

/** The same test the server makes: a SingletonLock naming a live process. */
function running(dir) {
  try {
    const owner = readlinkSync(join(dir, "SingletonLock"));
    process.kill(Number(owner.slice(owner.lastIndexOf("-") + 1)), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function read() {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf8")) ?? {};
  } catch {
    console.error(`${SETTINGS} is not valid JSON; fix or remove it first.`);
    process.exit(1);
  }
}

function status(settings) {
  const target = settings.target === "dev" ? "dev" : "installed";
  console.log(`Plugins serve: ${target === "dev" ? "the development build" : "the installed app"}`);
  console.log(`  server:   ${settings.server ?? "(not set)"}`);
  console.log(`  exchange: ${DATA[target]}`);
  if (target === "dev") {
    console.log(`  dev app:  ${running(DATA.dev) ? "running" : "not running — start it with `npm run dev:desktop`"}`);
  }
}

const args = process.argv.slice(2);
const wanted = args.find((arg) => !arg.startsWith("-"));
if (wanted === undefined) {
  status(read());
  process.exit(0);
}
if (wanted !== "dev" && wanted !== "installed") {
  console.error("Usage: npm run plugin:target -- [dev | installed] [--no-build]");
  process.exit(2);
}

if (wanted === "dev" && !args.includes("--no-build")) {
  console.log("Building this checkout's MCP server…");
  execFileSync("npm", ["run", "build:deps"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("npm", ["run", "build", "--workspace=@anthill/mcp"], { cwd: ROOT, stdio: "inherit" });
}

const settings = read();
// The server this checkout builds, unless the file already names one.
settings.server ??= SERVER;
if (wanted === "dev") settings.target = "dev";
else delete settings.target;
mkdirSync(dirname(SETTINGS), { recursive: true });
writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);

status(settings);
console.log("Start a new harness session for the plugins to pick this up.");
