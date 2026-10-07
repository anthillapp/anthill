/**
 * Installing Anthill's plugin from Anthill, and checking that it works.
 *
 * `plugin-status.ts` reads what each tool has written down and runs nothing.
 * This is the other half, and it does run things — which is why it is a
 * separate file with its own rules:
 *
 * - **Only the tools' own commands.** `claude plugin …` and `codex plugin …`,
 *   the same ones the Plugins page shows. Anthill does not edit either tool's
 *   configuration itself; the tool does, and may ask the author to confirm.
 *   The one file Anthill writes is its own, `~/.anthill/plugin.json`, which
 *   says where the server is — and only when installing from a checkout.
 * - **From GitHub, unless there is a checkout.** Both tools take Anthill's
 *   repository as a marketplace (`anthillapp/anthill`), and each plugin carries its
 *   own copy of the server, so that is what an installed app installs from,
 *   with nothing to build. A local checkout of this repository — one either
 *   tool already knows about, the one the server path points into, or the one
 *   a development build runs from — is preferred when there is one, and the
 *   plugin is then pointed at that checkout's own server.
 * - **Nothing changes on a refusal found up front.** Everything that can be
 *   checked before a command runs is checked first, so "the install didn't
 *   finish, nothing was changed" is true when it is said.
 * - **Green means answered.** An install record is what the tool wrote; it is
 *   not proof the plugin works. The check starts the installed plugin's own
 *   launcher, exactly as the tool's `.mcp.json` would, and waits for Anthill's
 *   server to answer an MCP `initialize`. Only that makes a card Ready.
 * - **A new Anthill brings its plugins along (ANT-282).** The one thing run
 *   without a click: when the installed app starts, a plugin installed from
 *   GitHub that is an older release than the app is updated with the same
 *   commands the Plugins page shows. Nothing is asked, by the maintainer's
 *   decision — the plugin and the app are one release, and a plugin left
 *   behind describes behaviour the app no longer has. A developer's install,
 *   from a checkout or pointed at a checkout's server, is never touched.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runProcess, type SpawnFn } from "@anthill/runtimes";
import { PLUGIN_HARNESS_INFO, isInterpreterId, type CheckedPluginHarness } from "@anthill/workflow";

import type {
  InterpreterInfo,
  PluginAutoUpdate,
  PluginConnection,
  PluginHarnessStatus,
  PluginInstallResult,
  PluginStatus,
} from "../shared/ipc.js";
import { vscodeUserDir } from "./live/observers/vscode.js";
import { pluginStatus, readCodexConfig, readJsonc, vscodeInstall } from "./plugin-status.js";

/** Long enough for a slow machine to start node twice; short enough not to hang a card. */
const PROBE_TIMEOUT_MS = 12_000;
/** A plugin command that clones nothing should not take longer than this. */
const COMMAND_TIMEOUT_MS = 90_000;
/** Adding the marketplace from GitHub clones the repository, which can take longer. */
const CLONE_TIMEOUT_MS = 300_000;

/** Anthill's repository, which both tools accept as a marketplace source. */
export const GITHUB_SOURCE = "anthillapp/anthill";
/** Where the repository lived before it moved; GitHub still redirects there. */
const FORMER_GITHUB_SOURCES = ["nstr/anthill"];

/** Where the checkout keeps the built server. */
const SERVER_IN_CHECKOUT = join("apps", "mcp", "dist", "server.js");

/** A directory that offers both plugins, i.e. an Anthill checkout. */
export function isCheckout(dir: string): boolean {
  return (
    existsSync(join(dir, ".claude-plugin", "marketplace.json")) &&
    existsSync(join(dir, ".agents", "plugins", "marketplace.json"))
  );
}

/**
 * The checkout to install from, if there is one. Without one, the plugin is
 * installed from GitHub (`GITHUB_SOURCE`).
 *
 * In order of how deliberately it was chosen: one a tool already installs
 * from, then the one the server path the author wrote points into, then the
 * one this development build is running out of.
 */
export function installSource(status: PluginStatus, appRoot?: string): string | undefined {
  const candidates = [
    ...status.harnesses.map((harness) => harness.checkout),
    status.server.path && status.server.path.endsWith(SERVER_IN_CHECKOUT)
      ? status.server.path.slice(0, -SERVER_IN_CHECKOUT.length - 1)
      : undefined,
    appRoot,
  ];
  return candidates.find((dir): dir is string => Boolean(dir) && isCheckout(dir!));
}

/** The repository a development build runs from; nothing for a packaged one. */
export function devCheckout(appPath: string, packaged: boolean): string | undefined {
  if (packaged) return undefined;
  const root = resolve(appPath, "..", "..");
  return isCheckout(root) ? root : undefined;
}

/** The nearest checkout at or above a directory, for a shell that runs out of one. */
export function checkoutAbove(dir: string): string | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (isCheckout(at)) return at;
    if (dirname(at) === at) return undefined;
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

type Step = { command: string; args: string[] };

/**
 * What differs between the tools when Anthill installs and checks the plugin:
 * where each keeps its installed copy, how each records a known marketplace,
 * and which of its own commands install the plugin.
 */
type Tool = {
  /**
   * The directory the tool installed the plugin into, given an installed
   * status. Claude Code and Codex key their installs by marketplace; VS Code
   * also loads a plugin straight from a folder, with no marketplace at all.
   */
  installedRoot(home: string, status: PluginHarnessStatus): Promise<string | undefined>;
  /** Whether the tool already offers the marketplace by this name. */
  marketplaceKnown(home: string, name: string): Promise<boolean>;
  installSteps(status: PluginHarnessStatus, id: string, source: string, marketplaceKnown: boolean): Step[];
  /**
   * The tool's own commands that bring an installed plugin up to what its
   * marketplace offers now: the ones the Plugins page shows for an update.
   * Nothing for a tool with no command for it.
   */
  updateSteps(status: PluginHarnessStatus, id: string, marketplace: string): Step[];
};

const TOOLS: Record<CheckedPluginHarness, Tool> = {
  "claude-code": {
    async installedRoot(home, status) {
      if (!status.marketplace) return undefined;
      const installs = await readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
      const entry = isRecord(installs) && isRecord(installs.plugins)
        ? installs.plugins[`${status.plugin}@${status.marketplace}`]
        : undefined;
      const first = (Array.isArray(entry) ? entry : [entry]).find(isRecord);
      return typeof first?.installPath === "string" ? first.installPath : undefined;
    },
    async marketplaceKnown(home, name) {
      const known = await readJson(join(home, ".claude", "plugins", "known_marketplaces.json"));
      return isRecord(known) && isRecord(known[name]);
    },
    installSteps(status, id, source, marketplaceKnown) {
      if (status.installed && !status.enabled) return [{ command: "claude", args: ["plugin", "enable", id] }];
      return [
        ...(marketplaceKnown ? [] : [{ command: "claude", args: ["plugin", "marketplace", "add", source] }]),
        { command: "claude", args: ["plugin", "install", id, "--scope", "user"] },
      ];
    },
    // `marketplace update` re-reads the marketplace (a GitHub one is fetched
    // again); `plugin update` then installs what it offers, at the scope the
    // install was made at — `user` when Anthill made it.
    updateSteps(status, id, marketplace) {
      return [
        { command: "claude", args: ["plugin", "marketplace", "update", marketplace] },
        { command: "claude", args: ["plugin", "update", id, "--scope", status.scope ?? "user"] },
      ];
    },
  },
  codex: {
    async installedRoot(home, status) {
      if (!status.marketplace) return undefined;
      // Codex keeps each installed version side by side; the newest is the one it loads.
      const dir = join(home, ".codex", "plugins", "cache", status.marketplace, status.plugin);
      try {
        const versions = await readdir(dir);
        const dated = await Promise.all(
          versions.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })),
        );
        const newest = dated.sort((a, b) => b.at - a.at)[0]?.name;
        return newest ? join(dir, newest) : undefined;
      } catch {
        return undefined;
      }
    },
    async marketplaceKnown(home, name) {
      try {
        return name in readCodexConfig(await readFile(join(home, ".codex", "config.toml"), "utf8")).marketplaces;
      } catch {
        return false;
      }
    },
    installSteps(_status, id, source, marketplaceKnown) {
      return [
        ...(marketplaceKnown ? [] : [{ command: "codex", args: ["plugin", "marketplace", "add", source] }]),
        { command: "codex", args: ["plugin", "add", id] },
      ];
    },
    // Codex has no `update`: `marketplace upgrade` refreshes the Git snapshot
    // of a marketplace (a local one has nothing to refresh), and adding the
    // plugin again installs the version it now offers, beside the old one in
    // Codex's cache.
    updateSteps(status, id, marketplace) {
      return [
        ...(status.checkout ? [] : [{ command: "codex", args: ["plugin", "marketplace", "upgrade", marketplace] }]),
        { command: "codex", args: ["plugin", "add", id] },
      ];
    },
  },
  vscode: {
    async installedRoot(home) {
      return (await vscodeInstall(home, await vscodeSettings(home)))?.path;
    },
    async marketplaceKnown(home) {
      const settings = await vscodeSettings(home);
      const marketplaces = isRecord(settings) && Array.isArray(settings["chat.plugins.marketplaces"]) ? settings["chat.plugins.marketplaces"] : [];
      return [GITHUB_SOURCE, ...FORMER_GITHUB_SOURCES].some((source) => marketplaces.includes(source));
    },
    // VS Code has no command for it. The card shows the steps instead, and
    // `installPlugin` refuses before it would run nothing and call it done.
    installSteps: () => [],
    // VS Code updates a plugin installed from its marketplace by itself, as it
    // does extensions; Anthill has nothing to run (RELEASING.md).
    updateSteps: () => [],
  },
};

async function vscodeSettings(home: string): Promise<unknown> {
  return readJsonc(await readFile(join(vscodeUserDir(home), "settings.json"), "utf8").catch(() => ""));
}

/** The directory the tool installed the plugin into, which holds the launcher it runs. */
export async function installedRoot(home: string, status: PluginHarnessStatus): Promise<string | undefined> {
  if (!status.installed) return undefined;
  return TOOLS[status.harness].installedRoot(home, status);
}

/**
 * Start the installed launcher and ask the server to introduce itself.
 *
 * `node <root>/bin/anthill-mcp` is the command both plugins' `.mcp.json`
 * declare, so this is the same process the tool would start, found the same
 * way. It is stopped the moment it answers.
 */
export async function probeServer(
  launcher: string,
  spawnFn?: SpawnFn,
): Promise<{ answers: boolean; problem?: string }> {
  if (!existsSync(launcher)) return { answers: false, problem: `The plugin's launcher is missing: ${launcher}` };
  const abort = new AbortController();
  let seen = "";
  let answered = false;
  const outcome = await runProcess({
    command: "node",
    args: [launcher],
    stdinPayload:
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "anthill-check", version: "1" },
        },
      }) + "\n",
    timeoutMs: PROBE_TIMEOUT_MS,
    signal: abort.signal,
    spawnFn,
    onOutput: (stream, chunk) => {
      if (stream !== "stdout" || answered) return;
      seen += chunk;
      for (const line of seen.split("\n")) {
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown };
          if (message.id === 1 && isRecord(message.result)) {
            answered = true;
            abort.abort();
            return;
          }
        } catch {
          // A partial line; the rest is still on its way.
        }
      }
    },
  });
  if (answered) return { answers: true };
  if (outcome.spawnError) return { answers: false, problem: "node was not found on your PATH, and the plugin runs under it." };
  const said = outcome.stderr
    .split("\n")
    .map((line) => line.replace(/^anthill plugin:\s*/, "").trim())
    .find(Boolean);
  if (outcome.timedOut) return { answers: false, problem: said ?? "Anthill's server did not answer in time." };
  return { answers: false, problem: said ?? "Anthill's server stopped without answering." };
}

export type ConnectDeps = {
  home?: string;
  /** The running app's version, which a plugin installed from GitHub should be at (ANT-282). */
  appVersion?: string;
  /** What Anthill's own update did since it started, for the cards to say. */
  updates?: () => Partial<Record<CheckedPluginHarness, PluginAutoUpdate>>;
  /** The checkout a development build runs from, when it is one. */
  appRoot?: string;
  spawnFn?: SpawnFn;
  /** The interpreters, detected once for the window elsewhere; asked here when absent. */
  interpreters: () => Promise<InterpreterInfo[]>;
  /** Opens a tool's own install link with the system, for a tool installed that way. */
  openUrl?: (url: string) => Promise<void>;
};

/** Long enough for the tool to take the first link before the second arrives. */
const BETWEEN_LINKS_MS = 800;

export async function pluginConnections(deps: ConnectDeps): Promise<PluginConnection[]> {
  const home = deps.home ?? homedir();
  const [status, interpreters] = await Promise.all([
    pluginStatus(home, { appVersion: deps.appVersion, updates: deps.updates?.() }),
    deps.interpreters().catch(() => []),
  ]);
  const source = installSource(status, deps.appRoot) ?? GITHUB_SOURCE;

  return Promise.all(
    status.harnesses.map(async (harness) => {
      const cli = interpreters.find((item) => item.id === harness.harness);
      const connection: PluginConnection = {
        harness: harness.harness,
        label: harness.label,
        // A tool with no CLI Anthill detects — VS Code — is there when it has
        // been used here: its own folder is the evidence.
        cli: isInterpreterId(harness.harness)
          ? { available: cli?.available ?? false, ...(cli?.version ? { version: cli.version } : {}) }
          : { available: harness.toolFound },
        status: harness,
        source,
      };
      if (!harness.installed || !harness.enabled) return connection;
      const root = await installedRoot(home, harness);
      if (!root) return { ...connection, serverAnswers: false, serverProblem: "The tool's record of the plugin names no installed copy." };
      const probe = await probeServer(join(root, "bin", "anthill-mcp"), deps.spawnFn);
      return {
        ...connection,
        serverAnswers: probe.answers,
        ...(probe.problem ? { serverProblem: probe.problem } : {}),
      };
    }),
  );
}

/** The tool's own commands that take it from where it is to an installed, enabled plugin. */
export function installSteps(harness: PluginHarnessStatus, source: string, marketplaceKnown: boolean): Step[] {
  const { plugin, marketplace: defaultMarket } = PLUGIN_HARNESS_INFO[harness.harness];
  const id = `${plugin}@${harness.marketplace ?? defaultMarket}`;
  return TOOLS[harness.harness].installSteps(harness, id, source, marketplaceKnown);
}

/** The tool's own commands that update an installed plugin; none for VS Code. */
export function updateSteps(harness: PluginHarnessStatus): Step[] {
  const { plugin, marketplace: defaultMarket } = PLUGIN_HARNESS_INFO[harness.harness];
  const marketplace = harness.marketplace ?? defaultMarket;
  return TOOLS[harness.harness].updateSteps(harness, `${plugin}@${marketplace}`, marketplace);
}

/** Behind what is on offer: the same test as the Plugins page's `update` verdict. */
function behind(harness: PluginHarnessStatus): boolean {
  return Boolean(
    harness.installed &&
      harness.enabled &&
      harness.availableVersion &&
      harness.installedVersion &&
      harness.availableVersion !== harness.installedVersion,
  );
}

/** Whether the tool already offers Anthill's marketplace, so adding it again is not needed. */
function marketplaceKnown(home: string, harness: CheckedPluginHarness): Promise<boolean> {
  return TOOLS[harness].marketplaceKnown(home, PLUGIN_HARNESS_INFO[harness].marketplace);
}

/** The last thing a failed command said, which is usually the reason. */
function reason(outcome: { stderr: string; stdout: string; timedOut: boolean }, label: string): string {
  if (outcome.timedOut) return `${label} did not finish in time.`;
  const lines = `${outcome.stderr}\n${outcome.stdout}`.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? `${label} stopped without saying why.`;
}

/**
 * Run the tool's commands in order, stopping at the first that fails.
 * `changed` says whether any of them had already finished by then.
 */
async function runSteps(
  steps: Step[],
  label: string,
  fromGitHub: boolean,
  spawnFn: SpawnFn | undefined,
): Promise<PluginInstallResult> {
  let changed = false;
  for (const step of steps) {
    const outcome = await runProcess({
      command: step.command,
      args: step.args,
      timeoutMs: fromGitHub && step.args.includes("marketplace") ? CLONE_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
      spawnFn,
    });
    if (outcome.spawnError) {
      return { ok: false, changed, error: `${label}'s command was not found on your PATH.` };
    }
    if (outcome.exitCode !== 0) {
      return { ok: false, changed, error: reason(outcome, `${step.command} ${step.args.slice(0, 2).join(" ")}`) };
    }
    changed = true;
  }
  return { ok: true };
}

/**
 * Bring an installed plugin up to what is on offer, with the tool's own
 * commands, then read the tool's records again to see that it happened.
 *
 * A command that exits 0 is not proof: a marketplace that does not offer the
 * new version yet leaves `update` with nothing to do, and it says so happily.
 * So "updated" is only said when the record now shows a version that is no
 * longer behind.
 */
async function updatePlugin(current: PluginHarnessStatus, home: string, deps: ConnectDeps): Promise<PluginInstallResult> {
  const steps = updateSteps(current);
  if (steps.length === 0) {
    return {
      ok: false,
      changed: false,
      error: `${current.label} has no command for updating a plugin. It updates the plugin by itself; Settings ▸ Plugins has the steps to do it now.`,
    };
  }
  const ran = await runSteps(steps, current.label, !current.checkout, deps.spawnFn);
  if (!ran.ok) return ran;
  const after = (await pluginStatus(home, { appVersion: deps.appVersion })).harnesses.find(
    (item) => item.harness === current.harness,
  );
  if (after && behind(after)) {
    return {
      ok: false,
      changed: true,
      error: `${current.label} still has ${after.installedVersion} after updating. Its marketplace may not offer ${after.availableVersion} yet.`,
    };
  }
  return { ok: true };
}

export async function installPlugin(harness: CheckedPluginHarness, deps: ConnectDeps): Promise<PluginInstallResult> {
  const home = deps.home ?? homedir();
  // The card's button on a plugin that is behind updates it — which is also
  // how a failed update at startup is tried again (ANT-282).
  const before = await pluginStatus(home, { appVersion: deps.appVersion });
  const installed = before.harnesses.find((item) => item.harness === harness);
  if (installed && behind(installed)) return updatePlugin(installed, home, deps);

  const links = PLUGIN_HARNESS_INFO[harness].installLinks;
  if (links) {
    // The tool installs it, after asking; Anthill only opens its links, which
    // are fixed in the table and never come from the renderer.
    if (!deps.openUrl) return { ok: false, changed: false, error: "This build of Anthill can't open links." };
    try {
      for (const [index, link] of links.entries()) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, BETWEEN_LINKS_MS));
        await deps.openUrl(link);
      }
    } catch (error) {
      return {
        ok: false,
        changed: false,
        error: `${PLUGIN_HARNESS_INFO[harness].label} didn't open: ${(error as Error)?.message ?? String(error)}`,
      };
    }
    return { ok: true, confirm: true };
  }
  if (!PLUGIN_HARNESS_INFO[harness].installsFromAnthill) {
    return {
      ok: false,
      changed: false,
      error: `${PLUGIN_HARNESS_INFO[harness].label} has no command for installing a plugin. Settings ▸ Plugins has the steps.`,
    };
  }
  const status = before;
  const current = installed!;
  const checkout = installSource(status, deps.appRoot);
  const source = checkout ?? GITHUB_SOURCE;

  // From a checkout, the plugin is pointed at the checkout's own server, so
  // that comes first: if the plugin would install and then fail to start it,
  // the install is not worth making. From GitHub the plugin starts the server
  // it carries, and there is nothing to build or name.
  const serverOk = !checkout || (status.server.configured && status.server.exists);
  const built = checkout ? join(checkout, SERVER_IN_CHECKOUT) : "";
  if (!serverOk && !existsSync(built)) {
    return {
      ok: false,
      changed: false,
      error: `Anthill's server is not built in ${source} yet. Build it there first: npm run build:deps && npm run build --workspace=@anthill/mcp`,
    };
  }

  const ran = await runSteps(
    installSteps(current, source, await marketplaceKnown(home, harness)),
    current.label,
    !checkout,
    deps.spawnFn,
  );
  if (!ran.ok) return ran;

  if (!serverOk) {
    await mkdir(dirname(status.server.settingsFile), { recursive: true });
    await writeFile(status.server.settingsFile, `${JSON.stringify({ server: built }, null, 2)}\n`, "utf8");
  }
  return { ok: true };
}

export type AutoUpdateDeps = ConnectDeps & {
  appVersion: string;
  /**
   * Whether this is the installed app. A development build never updates the
   * plugins: they are the developer's, installed however they chose.
   */
  packaged: boolean;
  /** Told as each tool starts and finishes, so a card asked meanwhile can say so. */
  report?: (harness: CheckedPluginHarness, update: PluginAutoUpdate) => void;
};

/**
 * A new Anthill updates the plugins it finds behind it (ANT-282).
 *
 * Run once per launch of the installed app, in the background after the
 * window is up. It keeps no record of which version last ran: a plugin that
 * is already at the app's version is simply not behind, so running it every
 * launch does nothing, and a launch after a failed update tries again by
 * itself.
 *
 * Each tool is tried on its own, one after the other — a missing CLI or a
 * refusal in one is reported for that one and the next is still tried — and
 * nothing is thrown out of here: the app does not depend on any of it.
 *
 * Left alone: a plugin not installed or switched off (that is the author's
 * choice), VS Code (it updates its own plugins and has no command), and a
 * developer's setup — a plugin installed from a checkout, or every plugin
 * when `~/.anthill/plugin.json` points them at a checkout's server.
 */
export async function autoUpdatePlugins(deps: AutoUpdateDeps): Promise<Partial<Record<CheckedPluginHarness, PluginAutoUpdate>>> {
  const results: Partial<Record<CheckedPluginHarness, PluginAutoUpdate>> = {};
  if (!deps.packaged) return results;
  const home = deps.home ?? homedir();
  const tell = (harness: CheckedPluginHarness, update: PluginAutoUpdate) => {
    try {
      deps.report?.(harness, update);
    } catch {
      // Whoever listens cannot stop the update.
    }
  };

  let status: PluginStatus;
  try {
    status = await pluginStatus(home, { appVersion: deps.appVersion });
  } catch {
    return results;
  }
  if (status.server.configured) return results;

  for (const harness of status.harnesses) {
    if (harness.checkout || !behind(harness) || updateSteps(harness).length === 0) continue;
    const version = harness.availableVersion!;
    tell(harness.harness, { state: "updating", version });
    let update: PluginAutoUpdate;
    try {
      const result = await updatePlugin(harness, home, deps);
      update = result.ok ? { state: "updated", version } : { state: "failed", version, error: result.error };
    } catch (error) {
      update = { state: "failed", version, error: (error as Error)?.message ?? String(error) };
    }
    results[harness.harness] = update;
    tell(harness.harness, update);
  }
  return results;
}
