#!/usr/bin/env node
/**
 * Which Anthill the harness plugins serve when nobody says `--dev` in the chat.
 *
 *   npm run plugin:target                    what it is now, and what is running
 *   npm run plugin:target -- app             the default: the installed app, or --dev in the chat
 *   npm run plugin:target -- electron-dev    build the server, serve `npm run dev:desktop`
 *   npm run plugin:target -- web             build the server and the CLI, serve the web shell
 *   … --no-build                             skip the build
 *   … --json                                 the status as JSON, for scripts and tests
 *
 * `installed` and `dev`, the spellings of the first version, still work.
 *
 * This is for scripted QA, where a run has no one to type `--dev`. In a chat,
 * `/anthill:workflow design --dev …` (or `$anthill design --dev …`) is the
 * normal way, and it outranks this setting. On Linux and Windows every chat
 * reaches the web shell whatever is written here.
 *
 * Both plugins — Claude Code's and Codex's — start the MCP server their
 * launcher finds (`ANTHILL_MCP_SERVER`, then `ANTHILL_REPO`, then `"server"` in
 * `~/.anthill/plugin.json`), and that server reads `"target"` from the same
 * file. So one edit here switches both, with nothing reinstalled and nothing
 * committed. A harness reads its plugins when a session starts: the switch
 * takes effect in the next session. Every other field in the file is kept as
 * it was, and `"server"` is only written when the file names none.
 *
 * The status is the server's own answer, not a second opinion: the server is
 * found the way the launcher finds it (plugins/anthill-claude/bin/anthill-mcp), and
 * the answer is computed by the `target.js` beside it (apps/mcp/src/target.ts),
 * so the two cannot drift apart. What it cannot see:
 *
 *   - the environment the harness was started with. `ANTHILL_MCP_SERVER` and
 *     `ANTHILL_REPO` are read from this shell, and an app launched from the
 *     Dock does not inherit a shell profile;
 *   - `--target`, `--dev` or `--data-dir` written into a plugin's `.mcp.json`,
 *     which neither plugin ships with.
 *
 * What the switch does not change: the skill text a harness reads comes from
 * the installed plugin copy, not this checkout. A change to the skill itself
 * needs `claude plugin update anthill@anthill` (or the Codex equivalent).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS = join(homedir(), ".anthill", "plugin.json");
const SERVER = join(ROOT, "apps", "mcp", "dist", "server.js");

const SPELLINGS = { app: "app", installed: "app", "electron-dev": "electron-dev", dev: "electron-dev", web: "web" };
const USAGE = "Usage: npm run plugin:target -- [app | electron-dev | web] [--no-build] [--json]";

/** What each target needs built before its server can serve it. */
const BUILDS = {
  app: [],
  "electron-dev": [["run", "build:deps"], ["run", "build", "--workspace=@anthill/mcp"]],
  web: [["run", "build:deps"], ["run", "build", "--workspace=@anthill/mcp"], ["run", "build", "--workspace=@anthill/cli"]],
};

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    fail(`${SETTINGS} is not valid JSON; fix or remove it first.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${SETTINGS} is not a JSON object; fix or remove it first.`);
  }
  return parsed;
}

/** Written beside itself and renamed over, so a harness starting now reads the old file or the new one. */
function writeSettings(settings) {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  const partial = `${SETTINGS}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(partial, SETTINGS);
}

/** Whether the file names a server, by the launcher's reading of it. */
function namesServer(settings) {
  return typeof settings.server === "string" && settings.server.trim() !== "";
}

/**
 * The server the plugins' launcher would start, found the way it finds it
 * (plugins/anthill-claude/bin/anthill-mcp), or why it would start none.
 */
function locateServer(settings) {
  const direct = process.env.ANTHILL_MCP_SERVER?.trim();
  const repo = process.env.ANTHILL_REPO?.trim();
  const found = direct
    ? { path: direct, source: "ANTHILL_MCP_SERVER" }
    : repo
      ? { path: join(repo, "apps", "mcp", "dist", "server.js"), source: "ANTHILL_REPO" }
      : namesServer(settings)
        ? { path: settings.server.trim(), source: SETTINGS }
        : undefined;
  if (!found) return { problem: `nothing says where the Anthill MCP server is; ${SETTINGS} names no "server".` };
  if (!isAbsolute(found.path)) {
    return { ...found, problem: `${found.source} gives a relative path (${found.path}), which the launcher refuses.` };
  }
  if (!existsSync(found.path)) {
    return { ...found, problem: `${found.source} points at ${found.path}, and there is no file there.` };
  }
  return found;
}

/**
 * The checkout a server was built in, without needing the build: the same test
 * as `checkoutOf` in apps/mcp/src/target.ts, which is kept in step with this.
 */
function checkoutOf(server) {
  if (!/[\\/]apps[\\/]mcp[\\/]dist[\\/]server\.js$/.test(server)) return undefined;
  const root = dirname(dirname(dirname(dirname(server))));
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.name === "anthill" ? root : undefined;
  } catch {
    return undefined;
  }
}

/** npm itself, run by `node` so nothing goes through a shell (`npm.cmd` on Windows would). */
function npm() {
  if (process.env.npm_execpath) return [process.execPath, [process.env.npm_execpath]];
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundled)) return [process.execPath, [bundled]];
  return ["npm", []];
}

/**
 * The resolver of the server the plugins will actually start, or why there is
 * none to ask. A server built before the targets (`legacy`) still works: it
 * serves the installed app and ignores `"target"`.
 */
async function resolverOf(server) {
  const module = join(dirname(server), "target.js");
  const checkout = checkoutOf(server);
  const rebuild = `Build it: npm run build:deps && npm run build --workspace=@anthill/mcp${checkout ? ` (in ${checkout})` : ""}`;
  if (!existsSync(module)) {
    return { legacy: true, problem: `${server} has no target.js beside it, so it ignores "target" and serves the installed app. ${rebuild}` };
  }
  const target = await import(pathToFileURL(module).href);
  for (const name of ["resolveTarget", "currentEnvironment", "readTargetSetting", "targetDataDir", "appRunning", "webShellRunning", "checkoutOf"]) {
    if (typeof target[name] !== "function") {
      return { legacy: true, problem: `${server} was built before the app / electron-dev / web targets, so it ignores "target" and serves the installed app. ${rebuild}` };
    }
  }
  return { target };
}

/** The server the launcher would start and its resolver, or the reason there is neither. */
async function serverOf(settings) {
  const located = locateServer(settings);
  if (located.problem) return located;
  const resolver = await resolverOf(located.path);
  return resolver.problem ? { ...located, ...resolver } : { ...located, target: resolver.target };
}

async function status(settings, json, notes = []) {
  const found = await serverOf(settings);
  if (found.legacy) {
    // Nothing to ask, and nothing to ask it with; what such a server does is known.
    const warnings = [...notes, found.problem];
    if (json) {
      console.log(JSON.stringify({
        ok: true, settings: SETTINGS, server: found.path, serverFrom: found.source,
        target: "app", source: "server", label: "Anthill (installed app)", dataDir: null, running: null, warnings,
      }, null, 2));
    } else {
      for (const warning of warnings) console.error(`warning: ${warning}`);
      console.log("Plugins serve: Anthill (installed app)");
      console.log("  because:  the server predates the targets and serves nothing else");
      console.log(`  server:   ${found.path}${found.source === SETTINGS ? "" : ` (from ${found.source})`}`);
    }
    return;
  }
  if (found.problem) {
    const problem = `The plugins cannot serve any Anthill: ${found.problem}`;
    if (json) console.log(JSON.stringify({ ok: false, settings: SETTINGS, server: found.path ?? null, problem }, null, 2));
    else console.error(problem);
    process.exit(1);
  }

  const { target, path: server, source: serverFrom } = found;
  const environment = target.currentEnvironment();
  const written = settings.target;
  const setting = target.readTargetSetting(SETTINGS);
  const warnings = [...notes];
  if (written !== undefined && setting === undefined) {
    warnings.push(`"target": ${JSON.stringify(written)} in ${SETTINGS} is not a target the server knows, so it is ignored.`);
  }
  if (serverFrom !== SETTINGS) {
    warnings.push(`${serverFrom} is set in this shell, so the launcher starts ${server} rather than the server ${SETTINGS} names — if the harness sees it too.`);
  }
  const context = { ...environment, ...(setting ? { setting } : {}), checkout: target.checkoutOf(server) };
  const resolution = target.resolveTarget(context);
  if (!resolution.ok) fail(resolution.message);
  const { resolved } = resolution;

  const web = target.webShellRunning(target.targetDataDir("web", environment));
  const running = {
    ...(environment.platform === "darwin"
      ? {
          app: target.appRunning(target.targetDataDir("app", environment)),
          "electron-dev": target.appRunning(target.targetDataDir("electron-dev", environment)),
        }
      : {}),
    web: web ? { host: web.host, port: web.port } : false,
  };

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      settings: SETTINGS,
      setting: setting ?? null,
      server,
      serverFrom,
      target: resolved.target,
      source: resolved.source,
      label: resolved.label,
      dataDir: resolved.dataDir,
      checkout: resolved.checkout ?? null,
      running,
      warnings,
    }, null, 2));
    return;
  }

  const spelled = written === setting ? JSON.stringify(setting) : `${JSON.stringify(written)} (${setting})`;
  const because = {
    platform: `every chat on ${environment.platform} reaches the web shell`,
    settings: `"target": ${spelled} in ${SETTINGS}`,
    default: "the default; a chat's --dev still chooses the development build",
  }[resolved.source] ?? resolved.source;
  for (const warning of warnings) console.error(`warning: ${warning}`);
  console.log(`Plugins serve: ${resolved.label}`);
  console.log(`  because:  ${because}`);
  console.log(`  server:   ${server}${serverFrom === SETTINGS ? "" : ` (from ${serverFrom})`}`);
  console.log(`  exchange: ${resolved.dataDir}`);
  console.log("Running:");
  if ("app" in running) console.log(`  installed app: ${running.app ? "running" : "not running"}`);
  if ("electron-dev" in running) {
    console.log(`  dev build:     ${running["electron-dev"] ? "running" : "not running (a handover starts it: npm run dev:desktop)"}`);
  }
  console.log(`  web shell:     ${web ? `running on http://${web.host}:${web.port}` : "not running (start it from the checkout: anthill)"}`);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
const known = new Set(["--no-build", "--json"]);
const unknown = args.find((arg) => arg.startsWith("-") && !known.has(arg));
const positional = args.filter((arg) => !arg.startsWith("-"));
if (unknown || positional.length > 1) fail(USAGE, 2);
const json = args.includes("--json");

if (positional.length === 0) {
  await status(readSettings(), json);
  process.exit(0);
}

const wanted = SPELLINGS[positional[0]];
if (!wanted) fail(USAGE, 2);
const build = !args.includes("--no-build") && BUILDS[wanted].length > 0;

// Checked before anything is built or written, so a switch that cannot take
// effect leaves the file as it was and says why. The file as it will be: with
// this checkout's server when it names none.
const planned = (() => {
  const settings = readSettings();
  return namesServer(settings) ? settings : { ...settings, server: SERVER };
})();
const located = locateServer(planned);
// A server about to be built is allowed not to exist yet.
const builtHere = build && located.path !== undefined && isAbsolute(located.path) && checkoutOf(located.path) !== undefined && !existsSync(located.path);
if (located.problem && !builtHere) fail(`Not switched: ${located.problem}`);

const notes = [];
if (build) {
  const checkout = checkoutOf(located.path);
  if (!checkout) {
    notes.push(`${located.path} is not in an Anthill checkout, so nothing was built for it.`);
  } else {
    if (checkout !== ROOT) notes.push(`The plugins run the server in ${checkout}, so that checkout was built, not this one.`);
    console.error(`Building what ${wanted} needs in ${checkout}…`);
    const [command, prefix] = npm();
    for (const step of BUILDS[wanted]) {
      // Output goes to stderr, which keeps --json's stdout a single document.
      execFileSync(command, [...prefix, ...step], { cwd: checkout, stdio: ["ignore", 2, 2] });
    }
  }
}

// Removing "target" is always safe to write; a target is written only for a
// server that will read it.
if (wanted !== "app") {
  const found = await serverOf(planned);
  if (found.problem) fail(`Not switched: ${found.problem}`);
}

// Read again: nothing else should have written it during the build, but if
// something did, its fields are kept too.
const settings = readSettings();
if (!namesServer(settings)) settings.server = SERVER;
if (wanted === "app") delete settings.target;
else settings.target = wanted;
writeSettings(settings);

await status(settings, json, notes);
if (!json) console.log("Start a new harness session for the plugins to pick this up.");
