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
 *   repository as a marketplace (`nstr/anthill`), and each plugin carries its
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
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runProcess, type SpawnFn } from "@anthill/runtimes";

import type {
  InterpreterInfo,
  PluginConnection,
  PluginHarnessStatus,
  PluginInstallResult,
  PluginStatus,
} from "../shared/ipc.js";
import { PLUGINS, pluginStatus, readCodexConfig } from "./plugin-status.js";

export type Harness = "claude-code" | "codex";

/** The page each tool's own makers keep for installing it. Fixed: nothing else is opened. */
export const INSTALL_GUIDES: Record<Harness, string> = {
  "claude-code": "https://code.claude.com/docs/en/setup",
  codex: "https://developers.openai.com/codex/cli",
};

/** Long enough for a slow machine to start node twice; short enough not to hang a card. */
const PROBE_TIMEOUT_MS = 12_000;
/** A plugin command that clones nothing should not take longer than this. */
const COMMAND_TIMEOUT_MS = 90_000;
/** Adding the marketplace from GitHub clones the repository, which can take longer. */
const CLONE_TIMEOUT_MS = 300_000;

/** Anthill's repository, which both tools accept as a marketplace source. */
export const GITHUB_SOURCE = "nstr/anthill";

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

/** The directory the tool installed the plugin into, which holds the launcher it runs. */
export async function installedRoot(home: string, status: PluginHarnessStatus): Promise<string | undefined> {
  if (!status.installed || !status.marketplace) return undefined;
  if (status.harness === "claude-code") {
    const installs = await readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
    const entry = isRecord(installs) && isRecord(installs.plugins)
      ? installs.plugins[`${status.plugin}@${status.marketplace}`]
      : undefined;
    const first = (Array.isArray(entry) ? entry : [entry]).find(isRecord);
    return typeof first?.installPath === "string" ? first.installPath : undefined;
  }
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
  /** The checkout a development build runs from, when it is one. */
  appRoot?: string;
  spawnFn?: SpawnFn;
  /** The interpreters, detected once for the window elsewhere; asked here when absent. */
  interpreters: () => Promise<InterpreterInfo[]>;
};

export async function pluginConnections(deps: ConnectDeps): Promise<PluginConnection[]> {
  const home = deps.home ?? homedir();
  const [status, interpreters] = await Promise.all([pluginStatus(home), deps.interpreters().catch(() => [])]);
  const source = installSource(status, deps.appRoot) ?? GITHUB_SOURCE;

  return Promise.all(
    status.harnesses.map(async (harness) => {
      const cli = interpreters.find((item) => item.id === harness.harness);
      const connection: PluginConnection = {
        harness: harness.harness,
        label: harness.label,
        cli: { available: cli?.available ?? false, ...(cli?.version ? { version: cli.version } : {}) },
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

type Step = { command: string; args: string[] };

/** The tool's own commands that take it from where it is to an installed, enabled plugin. */
export function installSteps(harness: PluginHarnessStatus, source: string, marketplaceKnown: boolean): Step[] {
  const { plugin, marketplace: defaultMarket } = PLUGINS[harness.harness];
  const market = harness.marketplace ?? defaultMarket;
  const id = `${plugin}@${market}`;
  if (harness.harness === "claude-code") {
    if (harness.installed && !harness.enabled) return [{ command: "claude", args: ["plugin", "enable", id] }];
    return [
      ...(marketplaceKnown ? [] : [{ command: "claude", args: ["plugin", "marketplace", "add", source] }]),
      { command: "claude", args: ["plugin", "install", id, "--scope", "user"] },
    ];
  }
  return [
    ...(marketplaceKnown ? [] : [{ command: "codex", args: ["plugin", "marketplace", "add", source] }]),
    { command: "codex", args: ["plugin", "add", id] },
  ];
}

/** Whether the tool already offers Anthill's marketplace, so adding it again is not needed. */
async function marketplaceKnown(home: string, harness: Harness): Promise<boolean> {
  const name = PLUGINS[harness].marketplace;
  if (harness === "claude-code") {
    const known = await readJson(join(home, ".claude", "plugins", "known_marketplaces.json"));
    return isRecord(known) && isRecord(known[name]);
  }
  try {
    return name in readCodexConfig(await readFile(join(home, ".codex", "config.toml"), "utf8")).marketplaces;
  } catch {
    return false;
  }
}

/** The last thing a failed command said, which is usually the reason. */
function reason(outcome: { stderr: string; stdout: string; timedOut: boolean }, label: string): string {
  if (outcome.timedOut) return `${label} did not finish in time.`;
  const lines = `${outcome.stderr}\n${outcome.stdout}`.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? `${label} stopped without saying why.`;
}

export async function installPlugin(harness: Harness, deps: ConnectDeps): Promise<PluginInstallResult> {
  const home = deps.home ?? homedir();
  const status = await pluginStatus(home);
  const current = status.harnesses.find((item) => item.harness === harness)!;
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

  let changed = false;
  for (const step of installSteps(current, source, await marketplaceKnown(home, harness))) {
    const outcome = await runProcess({
      command: step.command,
      args: step.args,
      timeoutMs: !checkout && step.args.includes("marketplace") ? CLONE_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
      spawnFn: deps.spawnFn,
    });
    if (outcome.spawnError) {
      return { ok: false, changed, error: `${current.label}'s command was not found on your PATH.` };
    }
    if (outcome.exitCode !== 0) {
      return { ok: false, changed, error: reason(outcome, `${step.command} ${step.args.slice(0, 2).join(" ")}`) };
    }
    changed = true;
  }

  if (!serverOk) {
    await mkdir(dirname(status.server.settingsFile), { recursive: true });
    await writeFile(status.server.settingsFile, `${JSON.stringify({ server: built }, null, 2)}\n`, "utf8");
  }
  return { ok: true };
}
