/**
 * The plugin page's answers, against homes built in a temporary directory.
 *
 * Never the real `~/.claude` or `~/.codex`: the files are shaped the way this
 * machine's copies were when this was written, and each test builds only the
 * part it is about.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pathToFileURL } from "node:url";

import { claudeCodeStatus, codexStatus, pluginStatus, readCodexConfig, readJsonc, serverStatus, vscodeStatus } from "./plugin-status.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-plugins-"));
  homes.push(dir);
  return dir;
}

async function put(path: string, content: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

/** A checkout offering both plugins at these versions. */
async function checkout(root: string, claude = "0.7.8", codex = "0.7.8+codex.1"): Promise<string> {
  const dir = join(root, "checkout");
  await put(join(dir, "plugins/anthill-claude/.claude-plugin/plugin.json"), { name: "anthill", version: claude });
  await put(join(dir, "plugins/anthill-codex/.codex-plugin/plugin.json"), { name: "anthill", version: codex });
  return dir;
}

describe("Claude Code", () => {
  it("says so when the tool has never been used here", async () => {
    const status = await claudeCodeStatus(await home());
    expect(status).toMatchObject({ toolFound: false, installed: false, enabled: false });
  });

  it("finds the tool but not the plugin", async () => {
    const dir = await home();
    await put(join(dir, ".claude/plugins/installed_plugins.json"), { version: 2, plugins: { "other@x": [] } });
    expect(await claudeCodeStatus(dir)).toMatchObject({ toolFound: true, installed: false });
  });

  it("reads an install, its marketplace, and what the checkout would install now", async () => {
    const dir = await home();
    const source = await checkout(dir, "0.7.8");
    await put(join(dir, ".claude/plugins/installed_plugins.json"), {
      version: 2,
      plugins: { "anthill@anthill": [{ scope: "user", version: "0.7.6", installPath: "/x" }] },
    });
    await put(join(dir, ".claude/plugins/known_marketplaces.json"), {
      anthill: { source: { source: "directory", path: source } },
    });
    await put(join(dir, ".claude/settings.json"), { enabledPlugins: { "anthill@anthill": true } });

    expect(await claudeCodeStatus(dir)).toEqual({
      harness: "claude-code",
      label: "Claude Code",
      plugin: "anthill",
      toolFound: true,
      installed: true,
      enabled: true,
      installedVersion: "0.7.6",
      marketplace: "anthill",
      source,
      checkout: source,
      availableVersion: "0.7.8",
    });
  });

  it("knows a plugin someone switched off", async () => {
    const dir = await home();
    await put(join(dir, ".claude/plugins/installed_plugins.json"), {
      version: 2,
      plugins: { "anthill@elsewhere": [{ version: "0.7.8" }] },
    });
    await put(join(dir, ".claude/settings.json"), { enabledPlugins: { "anthill@elsewhere": false } });
    expect(await claudeCodeStatus(dir)).toMatchObject({ installed: true, enabled: false, marketplace: "elsewhere" });
  });
});

describe("Codex's config.toml", () => {
  it("reads the plugin and marketplace sections and nothing else", () => {
    const config = readCodexConfig(`
model = "gpt-5.5"

[mcp_servers.computer-use]
enabled = true

[marketplaces.anthill-local]
source_type = "local"
source = "/Users/me/anthill"

[plugins."anthill@anthill-local"]
enabled = false

[plugins."pdf@openai-primary-runtime"]
enabled = true

[features]
enabled = true
`);
    expect(config.marketplaces).toEqual({ "anthill-local": { sourceType: "local", source: "/Users/me/anthill" } });
    expect(config.plugins).toEqual({
      "anthill@anthill-local": { enabled: false },
      "pdf@openai-primary-runtime": { enabled: true },
    });
  });
});

describe("Codex", () => {
  it("offers the checkout from a marketplace even before the plugin is added", async () => {
    const dir = await home();
    const source = await checkout(dir);
    await put(join(dir, ".codex/config.toml"), `[marketplaces.anthill-local]\nsource_type = "local"\nsource = "${source}"\n`);
    expect(await codexStatus(dir)).toMatchObject({ toolFound: true, installed: false, checkout: source });
  });

  it("reads the newest cached copy as the installed version", async () => {
    const dir = await home();
    const source = await checkout(dir, "0.7.8", "0.7.8+codex.2");
    await put(
      join(dir, ".codex/config.toml"),
      `[marketplaces.anthill-local]\nsource_type = "local"\nsource = "${source}"\n\n[plugins."anthill@anthill-local"]\nenabled = true\n`,
    );
    const cache = join(dir, ".codex/plugins/cache/anthill-local/anthill");
    await put(join(cache, "0.7.7+codex.1/.keep"), "");
    await put(join(cache, "0.7.8+codex.1/.keep"), "");
    await utimes(join(cache, "0.7.7+codex.1"), new Date(1_000), new Date(1_000));
    await utimes(join(cache, "0.7.8+codex.1"), new Date(2_000_000), new Date(2_000_000));

    expect(await codexStatus(dir)).toMatchObject({
      installed: true,
      enabled: true,
      installedVersion: "0.7.8+codex.1",
      availableVersion: "0.7.8+codex.2",
      marketplace: "anthill-local",
    });
  });

  it("does not call a plugin installed that is only listed, with nothing cached", async () => {
    const dir = await home();
    await put(join(dir, ".codex/config.toml"), `[plugins."anthill@anthill-local"]\nenabled = true\n`);
    expect(await codexStatus(dir)).toMatchObject({ installed: false });
  });
});

describe("the server the plugin launches", () => {
  it("is not configured when there is no settings file", async () => {
    expect(await serverStatus(await home())).toMatchObject({ configured: false });
  });

  it("names a server that is not there", async () => {
    const dir = await home();
    await put(join(dir, ".anthill/plugin.json"), { server: "/nowhere/server.js" });
    expect(await serverStatus(dir)).toMatchObject({ configured: true, exists: false, path: "/nowhere/server.js" });
  });

  it("refuses a relative path, as the launcher does", async () => {
    const dir = await home();
    await put(join(dir, ".anthill/plugin.json"), { server: "apps/mcp/dist/server.js" });
    expect(await serverStatus(dir)).toMatchObject({ exists: false, problem: expect.stringContaining("absolute") });
  });

  it("finds a server that is there", async () => {
    const dir = await home();
    const server = join(dir, "server.js");
    await put(server, "");
    await put(join(dir, ".anthill/plugin.json"), { server });
    expect(await serverStatus(dir)).toMatchObject({ configured: true, exists: true, path: server });
  });
});

it("answers for every tool and the server at once", async () => {
  const status = await pluginStatus(await home());
  expect(status.harnesses.map((item) => item.harness)).toEqual(["claude-code", "codex", "vscode"]);
  expect(status.server.configured).toBe(false);
});

describe("VS Code", () => {
  /** VS Code's plugin folder, as a checkout or a marketplace clone holds it. */
  async function vscodePlugin(dir: string, version = "0.8.7"): Promise<string> {
    await put(join(dir, "plugin.json"), { name: "anthill", version });
    await put(join(dir, "bin/anthill-mcp"), "");
    return dir;
  }

  it("reads settings written with comments and trailing commas", () => {
    expect(readJsonc('{\n  // a comment\n  "a": "x // not one",\n  /* block */ "b": [1, 2,],\n}\n')).toEqual({ a: "x // not one", b: [1, 2] });
    expect(readJsonc("{ not json")).toBeUndefined();
  });

  it("has nothing to say about a VS Code never used here", async () => {
    const dir = await home();
    expect(await vscodeStatus(dir, join(dir, "Code", "User"))).toMatchObject({ harness: "vscode", toolFound: false, installed: false });
  });

  it("finds the plugin in a checkout VS Code was pointed at, and what the checkout offers", async () => {
    const dir = await home();
    const root = join(dir, "anthill");
    await put(join(root, ".github/plugin/marketplace.json"), { plugins: [] });
    await vscodePlugin(join(root, "plugins/anthill-vscode"), "0.8.8");
    const user = join(dir, "Code", "User");
    await put(join(user, "settings.json"), `{\n  // mine\n  "chat.pluginLocations": { "${root}/plugins/anthill-vscode": true },\n}`);

    expect(await vscodeStatus(dir, user)).toEqual({
      harness: "vscode",
      label: "VS Code",
      plugin: "anthill",
      toolFound: true,
      installed: true,
      enabled: true,
      installedVersion: "0.8.8",
      source: join(root, "plugins/anthill-vscode"),
      checkout: root,
      availableVersion: "0.8.8",
    });
  });

  it("finds a marketplace install in VS Code's installed.json, and ignores a folder switched off", async () => {
    const dir = await home();
    const clone = await vscodePlugin(join(dir, ".vscode/agent-plugins/github.com/anthillapp/anthill/plugins/anthill-vscode"));
    await put(join(dir, ".vscode/agent-plugins/installed.json"), {
      version: 1,
      installed: [
        { pluginUri: pathToFileURL(join(dir, "elsewhere")).href, marketplace: "someone/else", name: "anthill" },
        { pluginUri: pathToFileURL(clone).href, marketplace: "anthillapp/anthill", name: "anthill" },
      ],
    });
    const user = join(dir, "Code", "User");
    await put(join(user, "settings.json"), { "chat.pluginLocations": { [clone]: false } });

    expect(await vscodeStatus(dir, user)).toMatchObject({
      installed: true,
      marketplace: "anthillapp/anthill",
      source: "anthillapp/anthill",
      installedVersion: "0.8.7",
    });
  });

  it("says not installed, naming a checkout offered as a marketplace", async () => {
    const dir = await home();
    const root = join(dir, "anthill");
    await put(join(root, ".github/plugin/marketplace.json"), { plugins: [] });
    const user = join(dir, "Code", "User");
    // As VS Code takes a local marketplace: a file URI. A bare path it ignores.
    await put(join(user, "settings.json"), { "chat.plugins.marketplaces": [root] });
    expect((await vscodeStatus(dir, user)).checkout).toBeUndefined();
    await put(join(user, "settings.json"), { "chat.plugins.marketplaces": [pathToFileURL(root).href] });
    expect(await vscodeStatus(dir, user)).toMatchObject({ toolFound: true, installed: false, checkout: root });
  });
});
