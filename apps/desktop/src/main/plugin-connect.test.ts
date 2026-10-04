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
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SpawnFn } from "@anthill/runtimes";

import {
  GITHUB_SOURCE,
  installPlugin,
  installSource,
  installSteps,
  pluginConnections,
  probeServer,
} from "./plugin-connect.js";
import type { PluginHarnessStatus, PluginStatus } from "../shared/ipc.js";

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

/** Stands in for the tools' CLIs: records each call and exits with the scripted code. */
function tools(codes: Record<string, number> = {}) {
  const calls: string[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const code = Object.entries(codes).find(([prefix]) => line.startsWith(prefix))?.[1] ?? 0;
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
