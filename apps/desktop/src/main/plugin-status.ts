/**
 * Whether Anthill's plugin is installed in each coding tool that takes it (ANT-135).
 *
 * Read-only, and read from the tools' own records rather than by asking them:
 * this is a Settings page, opened whenever someone likes, and starting two
 * CLIs to answer it would be slow and would count as using them. Everything
 * below is a file each tool keeps about itself.
 *
 * - **Claude Code** keeps installs in `~/.claude/plugins/installed_plugins.json`
 *   (keyed `plugin@marketplace`), whether each is on in `~/.claude/settings.json`
 *   under `enabledPlugins`, and where each marketplace comes from in
 *   `~/.claude/plugins/known_marketplaces.json`.
 * - **Codex** keeps both in `~/.codex/config.toml` — `[plugins."plugin@market"]`
 *   with `enabled`, and `[marketplaces.market]` with `source` — and the
 *   installed copy under `~/.codex/plugins/cache/<market>/<plugin>/<version>/`.
 *
 * And one thing that is Anthill's own: the plugin is a launcher, and it finds
 * the MCP server it launches through `~/.anthill/plugin.json` (or two
 * environment variables this app cannot see, because they live in the
 * harness's environment). A plugin that is installed and enabled but whose
 * server cannot be found fails the moment it is used — so that is reported
 * beside it, as part of the same answer.
 *
 * Nothing is installed, enabled or written from here. The page says what is
 * true and shows the commands that change it; running them is the author's.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { CHECKED_PLUGIN_HARNESSES, PLUGIN_HARNESS_INFO, type CheckedPluginHarness } from "@anthill/workflow";

import type { PluginHarnessStatus, PluginServerStatus, PluginStatus } from "../shared/ipc.js";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The version a checkout's copy of a harness's plugin declares, when the checkout is on this disk. */
async function versionIn(checkout: string | undefined, harness: CheckedPluginHarness): Promise<string | undefined> {
  if (!checkout) return undefined;
  const { folder, manifest } = PLUGIN_HARNESS_INFO[harness];
  const value = await readJson(join(checkout, folder, manifest));
  return isRecord(value) && typeof value.version === "string" ? value.version : undefined;
}

/** What is said about a harness before anything is read about it. */
function unread(harness: CheckedPluginHarness, toolFound: boolean): PluginHarnessStatus {
  const { label, plugin } = PLUGIN_HARNESS_INFO[harness];
  return { harness, label, plugin, toolFound, installed: false, enabled: false };
}

export async function claudeCodeStatus(home: string): Promise<PluginHarnessStatus> {
  const { plugin } = PLUGIN_HARNESS_INFO["claude-code"];
  const root = join(home, ".claude");
  const base = unread("claude-code", existsSync(root));
  if (!base.toolFound) return base;

  const installs = await readJson(join(root, "plugins", "installed_plugins.json"));
  const plugins = isRecord(installs) && isRecord(installs.plugins) ? installs.plugins : {};
  // Any marketplace: the plugin is ours whichever name it was added under.
  const key = Object.keys(plugins).find((name) => name.startsWith(`${plugin}@`));
  const marketplace = key?.slice(plugin.length + 1);

  const known = await readJson(join(root, "plugins", "known_marketplaces.json"));
  const entry = marketplace && isRecord(known) && isRecord(known[marketplace]) ? known[marketplace] : undefined;
  const source = isRecord(entry?.source) ? entry.source : undefined;
  const checkout = source?.source === "directory" && typeof source.path === "string" ? source.path : undefined;
  const origin = checkout ?? (typeof source?.repo === "string" ? source.repo : typeof source?.url === "string" ? source.url : undefined);

  if (!key) return { ...base, ...(checkout ? { checkout } : {}) };

  const install = (Array.isArray(plugins[key]) ? plugins[key] : [plugins[key]]).find(isRecord);
  const settings = await readJson(join(root, "settings.json"));
  const enabledPlugins = isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};

  return {
    ...base,
    installed: true,
    // Claude Code writes `true` on install and `false` on disable; an entry it
    // has not written is a plugin nobody switched off.
    enabled: enabledPlugins[key] !== false,
    ...(typeof install?.version === "string" ? { installedVersion: install.version } : {}),
    ...(marketplace ? { marketplace } : {}),
    ...(origin ? { source: origin } : {}),
    ...(checkout ? { checkout, availableVersion: await versionIn(checkout, "claude-code") } : {}),
  };
}

/**
 * The two things this needs out of Codex's `config.toml`.
 *
 * Not a TOML parser, and it does not pretend to be one: section headers and
 * `key = "string"` / `key = true` lines, which is the whole of what Codex
 * writes for marketplaces and plugins. Anything it cannot read, it leaves out.
 */
export function readCodexConfig(text: string): {
  plugins: Record<string, { enabled?: boolean }>;
  marketplaces: Record<string, { source?: string; sourceType?: string }>;
} {
  const plugins: Record<string, { enabled?: boolean }> = {};
  const marketplaces: Record<string, { source?: string; sourceType?: string }> = {};
  let section: { kind: "plugin" | "marketplace"; name: string } | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[(plugins|marketplaces)\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]$/.exec(line);
    if (header) {
      const name = header[2] ?? header[3];
      section = { kind: header[1] === "plugins" ? "plugin" : "marketplace", name };
      if (section.kind === "plugin") plugins[name] ??= {};
      else marketplaces[name] ??= {};
      continue;
    }
    if (line.startsWith("[")) {
      section = undefined;
      continue;
    }
    if (!section) continue;
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    const text = /^"((?:[^"\\]|\\.)*)"$/.exec(value)?.[1]?.replace(/\\(.)/g, "$1");
    if (section.kind === "plugin" && key === "enabled" && (value === "true" || value === "false")) {
      plugins[section.name].enabled = value === "true";
    } else if (section.kind === "marketplace" && key === "source" && text !== undefined) {
      marketplaces[section.name].source = text;
    } else if (section.kind === "marketplace" && key === "source_type" && text !== undefined) {
      marketplaces[section.name].sourceType = text;
    }
  }
  return { plugins, marketplaces };
}

/** The installed copy Codex keeps, newest first by when it was written. */
async function codexInstalledVersion(home: string, marketplace: string, plugin: string): Promise<string | undefined> {
  const dir = join(home, ".codex", "plugins", "cache", marketplace, plugin);
  try {
    const versions = await readdir(dir);
    const dated = await Promise.all(
      versions.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })),
    );
    return dated.sort((a, b) => b.at - a.at)[0]?.name;
  } catch {
    return undefined;
  }
}

export async function codexStatus(home: string): Promise<PluginHarnessStatus> {
  const { plugin, marketplace: defaultMarket } = PLUGIN_HARNESS_INFO.codex;
  const root = join(home, ".codex");
  const base = unread("codex", existsSync(root));
  if (!base.toolFound) return base;

  let config: ReturnType<typeof readCodexConfig>;
  try {
    config = readCodexConfig(await readFile(join(root, "config.toml"), "utf8"));
  } catch {
    return base;
  }

  const key = Object.keys(config.plugins).find((name) => name.startsWith(`${plugin}@`));
  const marketplace = key?.slice(plugin.length + 1);
  // A local checkout offered as a marketplace, whether or not the plugin is
  // installed from it yet: it is what the install commands should name.
  const offered = Object.entries(config.marketplaces).find(
    ([name, market]) => name === (marketplace ?? defaultMarket) && market.sourceType === "local",
  )?.[1];
  const checkout = offered?.source && isAbsolute(offered.source) ? offered.source : undefined;
  const source = marketplace ? config.marketplaces[marketplace]?.source : undefined;

  if (!key || !marketplace) return { ...base, ...(checkout ? { checkout } : {}) };

  const installedVersion = await codexInstalledVersion(home, marketplace, plugin);
  return {
    ...base,
    // Listed in the config is added; a cached copy is what makes it installed.
    installed: installedVersion !== undefined,
    enabled: config.plugins[key].enabled !== false,
    ...(installedVersion ? { installedVersion } : {}),
    marketplace,
    ...(source ? { source } : {}),
    ...(checkout ? { checkout, availableVersion: await versionIn(checkout, "codex") } : {}),
  };
}

/** How each harness's own records are read. */
const STATUS: Record<CheckedPluginHarness, (home: string) => Promise<PluginHarnessStatus>> = {
  "claude-code": claudeCodeStatus,
  codex: codexStatus,
};

/** Whether the launcher both plugins ship can find the server it launches. */
export async function serverStatus(home: string): Promise<PluginServerStatus> {
  const file = join(home, ".anthill", "plugin.json");
  if (!existsSync(file)) return { configured: false, settingsFile: file };
  const value = await readJson(file);
  const path = isRecord(value) && typeof value.server === "string" ? value.server.trim() : "";
  if (!path) return { configured: false, settingsFile: file, problem: `${file} does not name a server.` };
  if (!isAbsolute(path)) return { configured: true, settingsFile: file, path, exists: false, problem: "The path is relative; it has to be absolute." };
  return { configured: true, settingsFile: file, path, exists: existsSync(path) };
}

export async function pluginStatus(home: string = homedir()): Promise<PluginStatus> {
  const [harnesses, server] = await Promise.all([
    Promise.all(CHECKED_PLUGIN_HARNESSES.map((harness) => STATUS[harness](home))),
    serverStatus(home),
  ]);
  return { harnesses, server };
}
