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
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHECKED_PLUGIN_HARNESSES, PLUGIN_HARNESS_INFO, type CheckedPluginHarness } from "@anthill/workflow";

import type { PluginAutoUpdate, PluginHarnessStatus, PluginServerStatus, PluginStatus } from "../shared/ipc.js";
import { vscodeUserDir } from "./live/observers/vscode.js";

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

/** The release a version names, without a build suffix such as Codex's `+codex.<timestamp>`. */
export function releaseOf(version: string): string {
  return version.trim().split("+")[0] ?? "";
}

/**
 * Whether `installed` is an older release than `app`. Semver-ish, as the
 * MCP server's drift notice compares them: numbers between dots and dashes,
 * the build suffix ignored. A version it cannot read is not called older.
 */
export function olderRelease(installed: string, app: string): boolean {
  const [have, want] = [releaseOf(installed), releaseOf(app)];
  if (!have || !want) return false;
  const parts = (value: string) => value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(have), parts(want)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

/**
 * What a plugin installed from GitHub is due to update to (ANT-282).
 *
 * The marketplace on GitHub reads master, and every release's plugins carry
 * the app's own version (`npm run version:set` writes one version everywhere),
 * so the app that is running is the plugin version GitHub offers. Without
 * this, `availableVersion` came only from a checkout, and a plugin installed
 * from GitHub showed as up to date however far behind it was. Only ever
 * upward: an app older than its plugin offers nothing, never a downgrade.
 */
function dueFromApp(installedVersion: string | undefined, appVersion: string | undefined): { availableVersion?: string } {
  return installedVersion && appVersion && olderRelease(installedVersion, appVersion) ? { availableVersion: appVersion } : {};
}

/** What is said about a harness before anything is read about it. */
function unread(harness: CheckedPluginHarness, toolFound: boolean): PluginHarnessStatus {
  const { label, plugin } = PLUGIN_HARNESS_INFO[harness];
  return { harness, label, plugin, toolFound, installed: false, enabled: false };
}

export async function claudeCodeStatus(home: string, appVersion?: string): Promise<PluginHarnessStatus> {
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
    ...(typeof install?.scope === "string" ? { scope: install.scope } : {}),
    ...(marketplace ? { marketplace } : {}),
    ...(origin ? { source: origin } : {}),
    ...(checkout
      ? { checkout, availableVersion: await versionIn(checkout, "claude-code") }
      : dueFromApp(typeof install?.version === "string" ? install.version : undefined, appVersion)),
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

export async function codexStatus(home: string, appVersion?: string): Promise<PluginHarnessStatus> {
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
    ...(checkout ? { checkout, availableVersion: await versionIn(checkout, "codex") } : dueFromApp(installedVersion, appVersion)),
  };
}

/**
 * Read a VS Code settings file, which is JSON with comments and trailing
 * commas. Not a parser of its own: those two are taken out, outside strings,
 * and what is left goes to `JSON.parse`. Anything it cannot read is no answer.
 */
export function readJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
    } else if (char === ",") {
      // A comma with nothing but space before the closing bracket is dropped.
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      if (text[next] !== "}" && text[next] !== "]") out += char;
    } else {
      out += char;
    }
  }
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/** Where VS Code has the plugin from: a folder it was pointed at, or a marketplace install. */
type VSCodeInstall = { path: string; marketplace?: string; source: string; checkout?: string };

function expandHome(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

/** A checkout's root, when a path is its `plugins/anthill-vscode`. */
function checkoutOf(path: string): string | undefined {
  const { folder } = PLUGIN_HARNESS_INFO.vscode;
  const root = resolve(path, ...folder.split("/").map(() => ".."));
  return resolve(root, folder) === resolve(path) && existsSync(join(root, ".github", "plugin", "marketplace.json"))
    ? root
    : undefined;
}

/** Whether a folder holds Anthill's VS Code plugin, rather than something else called anthill. */
function isOurPlugin(path: string): boolean {
  const { manifest } = PLUGIN_HARNESS_INFO.vscode;
  return existsSync(join(path, manifest)) && existsSync(join(path, "bin", "anthill-mcp"));
}

/**
 * Where VS Code finds Anthill's plugin, if it does.
 *
 * A folder in `chat.pluginLocations` switched on, which VS Code runs from a
 * copy in its own data folder;
 * or an install from a marketplace, which VS Code clones into
 * `~/.vscode/agent-plugins/` and lists in its `installed.json`
 * (`{version, installed: [{pluginUri, marketplace, name?}]}`).
 */
export async function vscodeInstall(home: string, settings: unknown): Promise<VSCodeInstall | undefined> {
  const locations = isRecord(settings) && isRecord(settings["chat.pluginLocations"]) ? settings["chat.pluginLocations"] : {};
  for (const [raw, on] of Object.entries(locations)) {
    if (on !== true) continue;
    const path = expandHome(raw, home);
    if (!isAbsolute(path) || !isOurPlugin(path)) continue;
    const checkout = checkoutOf(path);
    return { path, source: path, ...(checkout ? { checkout } : {}) };
  }

  const installed = await readJson(join(home, ".vscode", "agent-plugins", "installed.json"));
  const entries = isRecord(installed) && Array.isArray(installed.installed) ? installed.installed : [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.pluginUri !== "string" || !entry.pluginUri.startsWith("file:")) continue;
    let path: string;
    try {
      path = fileURLToPath(entry.pluginUri);
    } catch {
      continue;
    }
    if (!isOurPlugin(path)) continue;
    const marketplace = typeof entry.marketplace === "string" ? entry.marketplace : undefined;
    return { path, source: marketplace ?? path, ...(marketplace ? { marketplace } : {}) };
  }
  return undefined;
}

/**
 * Whether VS Code has Anthill's plugin, from what it keeps on disk.
 *
 * Whether a plugin is switched on VS Code keeps in its own state database,
 * not in a file, so an installed plugin is taken as on. The card's check —
 * starting the installed launcher and hearing the server answer — is what
 * says it works.
 */
export async function vscodeStatus(
  home: string,
  userDir: string = vscodeUserDir(home),
  appVersion?: string,
): Promise<PluginHarnessStatus> {
  const base = unread("vscode", existsSync(userDir));
  if (!base.toolFound) return base;

  const settings = readJsonc(await readFile(join(userDir, "settings.json"), "utf8").catch(() => ""));
  const install = await vscodeInstall(home, settings);
  // A checkout offered as a marketplace, whether or not anything is installed
  // from it yet: it is what the steps should name. VS Code takes a local
  // marketplace only as a `file://` URI; a bare path there it ignores.
  const offered = (isRecord(settings) && Array.isArray(settings["chat.plugins.marketplaces"]) ? settings["chat.plugins.marketplaces"] : [])
    .filter((value): value is string => typeof value === "string" && /^file:\/\//i.test(value.trim()))
    .map((value) => {
      try {
        return fileURLToPath(value.trim());
      } catch {
        return "";
      }
    })
    .find((value) => isAbsolute(value) && existsSync(join(value, ".github", "plugin", "marketplace.json")));
  const checkout = install?.checkout ?? offered;
  if (!install) return { ...base, ...(checkout ? { checkout } : {}) };

  const manifest = await readJson(join(install.path, PLUGIN_HARNESS_INFO.vscode.manifest));
  const installedVersion = isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : undefined;
  return {
    ...base,
    installed: true,
    enabled: true,
    ...(installedVersion ? { installedVersion } : {}),
    ...(install.marketplace ? { marketplace: install.marketplace } : {}),
    source: install.source,
    // VS Code updates a plugin from its marketplace by itself, and has no
    // command Anthill could run for it, so this only lets the page say so.
    ...(checkout ? { checkout, availableVersion: await versionIn(checkout, "vscode") } : dueFromApp(installedVersion, appVersion)),
  };
}

/** How each harness's own records are read. */
const STATUS: Record<CheckedPluginHarness, (home: string, appVersion?: string) => Promise<PluginHarnessStatus>> = {
  "claude-code": claudeCodeStatus,
  codex: codexStatus,
  vscode: (home, appVersion) => vscodeStatus(home, undefined, appVersion),
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

export type PluginStatusOptions = {
  /**
   * The running app's version (`app.getVersion()`), which is what a plugin
   * installed from GitHub should be at (ANT-282). Passed in rather than read
   * here, so this stays free of Electron; a shell without one leaves it out.
   */
  appVersion?: string;
  /** What Anthill's own update did since it started, per tool. */
  updates?: Partial<Record<CheckedPluginHarness, PluginAutoUpdate>>;
};

export async function pluginStatus(home: string = homedir(), options: PluginStatusOptions = {}): Promise<PluginStatus> {
  const [harnesses, server] = await Promise.all([
    Promise.all(CHECKED_PLUGIN_HARNESSES.map((harness) => STATUS[harness](home, options.appVersion))),
    serverStatus(home),
  ]);
  return {
    harnesses: harnesses.map((harness) => {
      const autoUpdate = options.updates?.[harness.harness];
      return autoUpdate ? { ...harness, autoUpdate } : harness;
    }),
    server,
  };
}
