/**
 * Installing the plugin and checking it answers, against homes built in a
 * temporary directory.
 *
 * The tools' commands are never run for real here: a spawn stand-in records
 * what would have been run and answers with a tiny node process instead. The
 * server check does start a real process — a launcher written for the test —
 * because what it is checking is a real handshake.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SpawnFn } from "@anthill/runtimes";

import {
  autoUpdatePlugins,
  GITHUB_SOURCE,
  installPlugin,
  installSource,
  installSteps,
  pluginConnections,
  probeServer,
  updateSteps,
} from "./plugin-connect.js";
import type { PluginAutoUpdate, PluginHarnessStatus, PluginStatus } from "../shared/ipc.js";

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-connect-"));
  homes.push(dir);
  return dir;
}

async function put(path: string, content: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

/** A checkout offering both plugins, with the server built unless told otherwise. */
async function checkout(root: string, built = true): Promise<string> {
  const dir = join(root, "checkout");
  await put(join(dir, ".claude-plugin/marketplace.json"), { name: "anthill" });
  await put(join(dir, ".agents/plugins/marketplace.json"), { name: "anthill-local" });
  if (built) await put(join(dir, "apps/mcp/dist/server.js"), "// built");
  return dir;
}

/** Answers `initialize` the way Anthill's server does, then waits to be stopped. */
const ANSWERS = `
process.stdin.on("data", (chunk) => {
  const message = JSON.parse(String(chunk).split("\\n")[0]);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "anthill" } } }) + "\\n");
});
setInterval(() => {}, 1000);
`;

/** What the real launcher does when it cannot find a server. */
const LOST = `process.stderr.write("anthill plugin: Nothing says where the Anthill MCP server is.\\n"); process.exit(78);`;

/**
 * Stands in for the tools' CLIs: records each call and exits with the scripted
 * code. `effects` does to the home what the real command would have, for the
 * commands whose result is read back afterwards.
 */
function tools(codes: Record<string, number> = {}, effects: Record<string, () => void> = {}) {
  const calls: string[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const code = Object.entries(codes).find(([prefix]) => line.startsWith(prefix))?.[1] ?? 0;
    if (code === 0) Object.entries(effects).find(([prefix]) => line.startsWith(prefix))?.[1]();
    return spawn(
      process.execPath,
      ["-e", code === 0 ? "" : `process.stderr.write("Error: refused\\n"); process.exit(${code})`],
      { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
  };
  return { calls, spawnFn };
}

const status = (over: Partial<PluginHarnessStatus> = {}): PluginHarnessStatus => ({
  harness: "claude-code",
  label: "Claude Code",
  plugin: "anthill",
  toolFound: true,
  installed: false,
  enabled: false,
  ...over,
});

describe("where the plugin is installed from", () => {
  it("prefers a checkout a tool already knows, then the server's, then the dev build's", async () => {
    const root = await home();
    const dir = await checkout(root);
    const base: PluginStatus = {
      harnesses: [status(), status({ harness: "codex", label: "Codex", plugin: "anthill" })],
      server: { configured: false, settingsFile: "/x" },
    };
    expect(installSource(base)).toBeUndefined();
    expect(installSource(base, dir)).toBe(dir);
    expect(
      installSource({ ...base, server: { configured: true, settingsFile: "/x", path: join(dir, "apps/mcp/dist/server.js"), exists: true } }),
    ).toBe(dir);
    expect(installSource({ ...base, harnesses: [status({ checkout: dir })] }, "/elsewhere")).toBe(dir);
  });

  it("never offers a directory that is not a checkout", async () => {
    const root = await home();
    expect(
      installSource({ harnesses: [status({ checkout: root })], server: { configured: false, settingsFile: "/x" } }, root),
    ).toBeUndefined();
  });
});

describe("the tools' own commands", () => {
  it("adds the marketplace only when the tool does not know it yet", () => {
    expect(installSteps(status(), "/src", false).map((step) => [step.command, ...step.args].join(" "))).toEqual([
      "claude plugin marketplace add /src",
      "claude plugin install anthill@anthill --scope user",
    ]);
    expect(installSteps(status(), "/src", true).map((step) => step.args.join(" "))).toEqual([
      "plugin install anthill@anthill --scope user",
    ]);
  });

  it("switches a disabled plugin back on instead of installing it again", () => {
    const off = status({ installed: true, enabled: false, marketplace: "anthill" });
    expect(installSteps(off, "/src", true).map((step) => step.args.join(" "))).toEqual(["plugin enable anthill@anthill"]);
  });

  it("uses Codex's own verbs and marketplace", () => {
    const codex = status({ harness: "codex", label: "Codex", plugin: "anthill" });
    expect(installSteps(codex, "/src", false).map((step) => [step.command, ...step.args].join(" "))).toEqual([
      "codex plugin marketplace add /src",
      "codex plugin add anthill@anthill-local",
    ]);
  });
});

describe("installing", () => {
  it("installs from GitHub when there is no checkout, with nothing to build and no server to name", async () => {
    const dir = await home();
    const { calls, spawnFn } = tools();
    const result = await installPlugin("claude-code", { home: dir, spawnFn, interpreters: async () => [] });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      `claude plugin marketplace add ${GITHUB_SOURCE}`,
      "claude plugin install anthill@anthill --scope user",
    ]);
    // The plugin starts the server it carries; a setting would only get in its way.
    expect(existsSync(join(dir, ".anthill/plugin.json"))).toBe(false);
  });

  /*
    VS Code has no command for plugins, but its own links install one, each
    after it asks. Anthill opens them in order, and only those: the renderer
    names the tool, never an address.
  */
  it("installs VS Code's plugin by opening VS Code's own two links, and runs nothing", async () => {
    const dir = await home();
    const { calls, spawnFn } = tools();
    const opened: string[] = [];
    const result = await installPlugin("vscode", {
      home: dir,
      spawnFn,
      interpreters: async () => [],
      openUrl: async (url) => {
        opened.push(url);
      },
    });
    expect(result).toEqual({ ok: true, confirm: true });
    expect(opened).toEqual([
      "vscode://chat-plugin/add-marketplace?ref=anthillapp/anthill",
      "vscode://chat-plugin/install?source=anthillapp/anthill&plugin=anthill",
    ]);
    expect(calls).toEqual([]);
  });

  it("says so when VS Code's links cannot be opened", async () => {
    const dir = await home();
    const failed = await installPlugin("vscode", {
      home: dir,
      interpreters: async () => [],
      openUrl: async () => {
        throw new Error("no handler for vscode://");
      },
    });
    expect(failed).toEqual({ ok: false, changed: false, error: "VS Code didn't open: no handler for vscode://" });
    expect((await installPlugin("vscode", { home: dir, interpreters: async () => [] })).ok).toBe(false);
  });

  it("installs Codex's plugin from GitHub the same way", async () => {
    const dir = await home();
    const { calls, spawnFn } = tools();
    expect(await installPlugin("codex", { home: dir, spawnFn, interpreters: async () => [] })).toEqual({ ok: true });
    expect(calls).toEqual([`codex plugin marketplace add ${GITHUB_SOURCE}`, "codex plugin add anthill@anthill-local"]);
  });

  it("refuses up front when the server it would launch is not built", async () => {
    const dir = await home();
    const source = await checkout(dir, false);
    const { calls, spawnFn } = tools();
    const result = await installPlugin("codex", { home: dir, appRoot: source, spawnFn, interpreters: async () => [] });
    expect(result).toMatchObject({ ok: false, changed: false });
    if (!result.ok) expect(result.error).toContain("not built");
    expect(calls).toEqual([]);
  });

  it("runs the commands, then tells the plugin where the server is", async () => {
    const dir = await home();
    const source = await checkout(dir);
    const { calls, spawnFn } = tools();
    const result = await installPlugin("claude-code", { home: dir, appRoot: source, spawnFn, interpreters: async () => [] });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      `claude plugin marketplace add ${source}`,
      "claude plugin install anthill@anthill --scope user",
    ]);
    expect(JSON.parse(await readFile(join(dir, ".anthill/plugin.json"), "utf8"))).toEqual({
      server: join(source, "apps/mcp/dist/server.js"),
    });
  });

  it("leaves a working server setting alone", async () => {
    const dir = await home();
    const source = await checkout(dir);
    const mine = join(dir, "mine.js");
    await put(mine, "//");
    await put(join(dir, ".anthill/plugin.json"), { server: mine });
    const { spawnFn } = tools();
    await installPlugin("claude-code", { home: dir, appRoot: source, spawnFn, interpreters: async () => [] });
    expect(JSON.parse(await readFile(join(dir, ".anthill/plugin.json"), "utf8"))).toEqual({ server: mine });
  });

  it("says what the tool said, and that something changed, when a later step fails", async () => {
    const dir = await home();
    const source = await checkout(dir);
    const { spawnFn } = tools({ "claude plugin install": 1 });
    const result = await installPlugin("claude-code", { home: dir, appRoot: source, spawnFn, interpreters: async () => [] });
    expect(result).toEqual({ ok: false, changed: true, error: "Error: refused" });
    expect(existsSync(join(dir, ".anthill/plugin.json"))).toBe(false);
  });

  it("says nothing changed when the very first command fails", async () => {
    const dir = await home();
    const source = await checkout(dir);
    const { spawnFn } = tools({ "codex plugin marketplace": 2 });
    const result = await installPlugin("codex", { home: dir, appRoot: source, spawnFn, interpreters: async () => [] });
    expect(result).toMatchObject({ ok: false, changed: false });
  });
});

describe("checking the server answers", () => {
  it("is Ready only on a real answer to initialize", async () => {
    const dir = await home();
    await put(join(dir, "bin/anthill-mcp"), ANSWERS);
    expect(await probeServer(join(dir, "bin/anthill-mcp"))).toEqual({ answers: true });
  });

  it("passes on the launcher's own reason when it cannot start the server", async () => {
    const dir = await home();
    await put(join(dir, "bin/anthill-mcp"), LOST);
    expect(await probeServer(join(dir, "bin/anthill-mcp"))).toEqual({
      answers: false,
      problem: "Nothing says where the Anthill MCP server is.",
    });
  });

  it("says the launcher is missing rather than starting nothing", async () => {
    expect((await probeServer("/nowhere/bin/anthill-mcp")).answers).toBe(false);
  });

  it("asks only a plugin that is installed and switched on, from the copy the tool installed", async () => {
    const dir = await home();
    const installPath = join(dir, ".claude/plugins/cache/anthill/anthill/0.7.9");
    await put(join(installPath, "bin/anthill-mcp"), ANSWERS);
    await put(join(dir, ".claude/plugins/installed_plugins.json"), {
      version: 2,
      plugins: { "anthill@anthill": [{ scope: "user", version: "0.7.9", installPath }] },
    });
    await mkdir(join(dir, ".codex"), { recursive: true });
    const connections = await pluginConnections({
      home: dir,
      interpreters: async () => [
        { id: "claude-code", label: "Claude Code", command: "claude", boundary: "", folderBoundary: "", available: true, version: "2.1.278" },
      ],
    });
    expect(connections[0]).toMatchObject({ harness: "claude-code", cli: { available: true, version: "2.1.278" }, serverAnswers: true });
    expect(connections[1]).toMatchObject({ harness: "codex", cli: { available: false } });
    expect(connections[1].serverAnswers).toBeUndefined();
  });

  it("asks VS Code's plugin loaded from a folder, which has no marketplace", async () => {
    // Settings ▸ Plugins said Installed while the onboarding card said the
    // tool's record named no installed copy: the check wanted a marketplace.
    if (process.platform === "win32") return;
    const dir = await home();
    const plugin = join(dir, "anthill/plugins/anthill-vscode");
    await put(join(plugin, "plugin.json"), { name: "anthill", version: "0.8.7" });
    await put(join(plugin, "bin/anthill-mcp"), ANSWERS);
    // Linux reads $XDG_CONFIG_HOME first, and CI runners set it to the real one.
    vi.stubEnv("XDG_CONFIG_HOME", join(dir, ".config"));
    const user = process.platform === "darwin"
      ? join(dir, "Library/Application Support/Code/User")
      : join(dir, ".config/Code/User");
    await put(join(user, "settings.json"), { "chat.pluginLocations": { [plugin]: true } });
    const connections = await pluginConnections({ home: dir, interpreters: async () => [] });
    expect(connections.find((item) => item.harness === "vscode")).toMatchObject({
      status: { installed: true },
      serverAnswers: true,
    });
  });
});

/*
  ANT-282: a new Anthill brings the plugins installed from GitHub up to its
  own version as it starts, with the tools' own commands and no question.
*/
describe("a new Anthill updates its plugins", () => {
  const APP = "0.9.0";

  /** Claude Code's records of a plugin installed from GitHub at this version. */
  function claudeAt(dir: string, version: string, scope = "user"): void {
    mkdirSync(join(dir, ".claude/plugins"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "anthill@anthill": [{ scope, version }] } }),
    );
    writeFileSync(
      join(dir, ".claude/plugins/known_marketplaces.json"),
      JSON.stringify({ anthill: { source: { source: "github", repo: GITHUB_SOURCE } } }),
    );
  }

  /** Codex's records of a plugin added from the GitHub marketplace, with a cached copy at this version. */
  async function codexAt(dir: string, version: string): Promise<void> {
    await put(
      join(dir, ".codex/config.toml"),
      `[marketplaces.anthill-local]\nsource_type = "git"\nsource = "https://github.com/${GITHUB_SOURCE}.git"\n\n[plugins."anthill@anthill-local"]\nenabled = true\n`,
    );
    const copy = join(dir, ".codex/plugins/cache/anthill-local/anthill", version);
    await put(join(copy, ".keep"), "");
    await utimes(copy, new Date(1_000), new Date(1_000));
  }

  /** What `codex plugin add` leaves behind: a newer copy beside the old one. */
  const codexAdds = (dir: string, version: string) => () =>
    mkdirSync(join(dir, ".codex/plugins/cache/anthill-local/anthill", version), { recursive: true });

  const deps = (dir: string, spawnFn: SpawnFn, over: { packaged?: boolean } = {}) => ({
    home: dir,
    spawnFn,
    interpreters: async () => [],
    appVersion: APP,
    packaged: over.packaged ?? true,
  });

  it("runs each tool's own update commands, in order, and says each is updated", async () => {
    const dir = await home();
    claudeAt(dir, "0.8.9");
    await codexAt(dir, "0.8.9+codex.20260901000000");
    const { calls, spawnFn } = tools({}, {
      "claude plugin update": () => claudeAt(dir, APP),
      "codex plugin add": codexAdds(dir, `${APP}+codex.20261004000000`),
    });
    const reported: [string, PluginAutoUpdate][] = [];
    const results = await autoUpdatePlugins({
      ...deps(dir, spawnFn),
      report: (harness, update) => reported.push([harness, update]),
    });
    expect(calls).toEqual([
      "claude plugin marketplace update anthill",
      "claude plugin update anthill@anthill --scope user",
      "codex plugin marketplace upgrade anthill-local",
      "codex plugin add anthill@anthill-local",
    ]);
    expect(results).toEqual({
      "claude-code": { state: "updated", version: APP },
      codex: { state: "updated", version: APP },
    });
    expect(reported).toEqual([
      ["claude-code", { state: "updating", version: APP }],
      ["claude-code", { state: "updated", version: APP }],
      ["codex", { state: "updating", version: APP }],
      ["codex", { state: "updated", version: APP }],
    ]);
  });

  it("runs nothing when the plugins are at the app's version, or newer", async () => {
    const dir = await home();
    claudeAt(dir, APP);
    await codexAt(dir, "0.9.1+codex.20261101000000");
    const { calls, spawnFn } = tools();
    expect(await autoUpdatePlugins(deps(dir, spawnFn))).toEqual({});
    expect(calls).toEqual([]);
  });

  it("runs nothing from a development build", async () => {
    const dir = await home();
    claudeAt(dir, "0.8.9");
    const { calls, spawnFn } = tools();
    expect(await autoUpdatePlugins(deps(dir, spawnFn, { packaged: false }))).toEqual({});
    expect(calls).toEqual([]);
  });

  it("leaves a plugin installed from a checkout alone", async () => {
    const dir = await home();
    const source = await checkout(dir);
    await put(join(dir, ".claude/plugins/installed_plugins.json"), {
      version: 2,
      plugins: { "anthill@anthill": [{ scope: "user", version: "0.8.9" }] },
    });
    await put(join(dir, ".claude/plugins/known_marketplaces.json"), {
      anthill: { source: { source: "directory", path: source } },
    });
    const { calls, spawnFn } = tools();
    expect(await autoUpdatePlugins(deps(dir, spawnFn))).toEqual({});
    expect(calls).toEqual([]);
  });

  it("leaves every plugin alone when plugin.json points them at a server", async () => {
    const dir = await home();
    claudeAt(dir, "0.8.9");
    await codexAt(dir, "0.8.9+codex.1");
    await put(join(dir, ".anthill/plugin.json"), { server: "/Users/me/anthill/apps/mcp/dist/server.js" });
    const { calls, spawnFn } = tools();
    expect(await autoUpdatePlugins(deps(dir, spawnFn))).toEqual({});
    expect(calls).toEqual([]);
  });

  it("leaves a plugin someone switched off alone", async () => {
    const dir = await home();
    claudeAt(dir, "0.8.9");
    await put(join(dir, ".claude/settings.json"), { enabledPlugins: { "anthill@anthill": false } });
    const { calls, spawnFn } = tools();
    expect(await autoUpdatePlugins(deps(dir, spawnFn))).toEqual({});
    expect(calls).toEqual([]);
  });

  it("runs nothing for VS Code, which updates its own plugins", async () => {
    if (process.platform === "win32") return;
    const dir = await home();
    const clone = join(dir, ".vscode/agent-plugins/github.com/anthillapp/anthill/plugins/anthill-vscode");
    await put(join(clone, "plugin.json"), { name: "anthill", version: "0.8.9" });
    await put(join(clone, "bin/anthill-mcp"), "");
    await put(join(dir, ".vscode/agent-plugins/installed.json"), {
      version: 1,
      installed: [{ pluginUri: `file://${clone}`, marketplace: GITHUB_SOURCE }],
    });
    vi.stubEnv("XDG_CONFIG_HOME", join(dir, ".config"));
    const user = process.platform === "darwin" ? join(dir, "Library/Application Support/Code/User") : join(dir, ".config/Code/User");
    await put(join(user, "settings.json"), {});
    const { calls, spawnFn } = tools();
    expect(await autoUpdatePlugins(deps(dir, spawnFn))).toEqual({});
    expect(calls).toEqual([]);
    // The page still says it is behind; a click explains rather than runs.
    const connections = await pluginConnections({ home: dir, interpreters: async () => [], appVersion: APP });
    expect(connections.find((item) => item.harness === "vscode")?.status).toMatchObject({
      installedVersion: "0.8.9",
      availableVersion: APP,
    });
    const click = await installPlugin("vscode", { home: dir, interpreters: async () => [], appVersion: APP, openUrl: async () => undefined });
    expect(click).toMatchObject({ ok: false, changed: false });
    expect(calls).toEqual([]);
  });

  it("reports a failing tool in its own words, still tries the next, and throws nothing", async () => {
    const dir = await home();
    claudeAt(dir, "0.8.9");
    await codexAt(dir, "0.8.9+codex.1");
    const { calls, spawnFn } = tools({ "claude plugin marketplace update": 1 }, {
      "codex plugin add": codexAdds(dir, `${APP}+codex.2`),
    });
    const results = await autoUpdatePlugins(deps(dir, spawnFn));
    expect(results).toEqual({
      "claude-code": { state: "failed", version: APP, error: "Error: refused" },
      codex: { state: "updated", version: APP },
    });
    expect(calls).toEqual([
      "claude plugin marketplace update anthill",
      "codex plugin marketplace upgrade anthill-local",
      "codex plugin add anthill@anthill-local",
    ]);
  });

  it("says a tool's command is missing, rather than failing the launch", async () => {
    const dir = await home();
    claudeAt(dir, "0.8.9");
    const spawnFn: SpawnFn = (_command, args, options) =>
      spawn(join(dir, "no-such-claude"), args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const results = await autoUpdatePlugins(deps(dir, spawnFn));
    expect(results["claude-code"]).toEqual({
      state: "failed",
      version: APP,
      error: "Claude Code's command was not found on your PATH.",
    });
  });

  it("does not call it updated when the commands succeed but the plugin is still behind", async () => {
    // A marketplace that does not offer the new version yet: `update` finds
    // nothing to do, and says so with exit 0.
    const dir = await home();
    claudeAt(dir, "0.8.9");
    const { spawnFn } = tools();
    const results = await autoUpdatePlugins(deps(dir, spawnFn));
    expect(results["claude-code"]).toEqual({
      state: "failed",
      version: APP,
      error: `Claude Code still has 0.8.9 after updating. Its marketplace may not offer ${APP} yet.`,
    });
  });

  it("updates on the card's click too, which is the retry", async () => {
    const dir = await home();
    claudeAt(dir, "0.8.9");
    const { calls, spawnFn } = tools({}, { "claude plugin update": () => claudeAt(dir, APP) });
    const result = await installPlugin("claude-code", { home: dir, spawnFn, interpreters: async () => [], appVersion: APP });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["claude plugin marketplace update anthill", "claude plugin update anthill@anthill --scope user"]);
  });

  it("updates at the scope the plugin was installed at, and skips refreshing a local Codex marketplace", () => {
    const claude = status({ installed: true, enabled: true, marketplace: "anthill", scope: "project" });
    expect(updateSteps(claude).map((step) => step.args.join(" "))).toEqual([
      "plugin marketplace update anthill",
      "plugin update anthill@anthill --scope project",
    ]);
    const codex = status({ harness: "codex", label: "Codex", installed: true, enabled: true, checkout: "/src" });
    expect(updateSteps(codex).map((step) => step.args.join(" "))).toEqual(["plugin add anthill@anthill-local"]);
    expect(updateSteps(status({ harness: "vscode", label: "VS Code" }))).toEqual([]);
  });
});
