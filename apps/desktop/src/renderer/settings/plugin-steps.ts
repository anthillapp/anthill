/**
 * What the Plugins page says about each tool, and what it tells the author to
 * run (ANT-135).
 *
 * Kept apart from the page so every ending is written down in one place and
 * can be checked: the page's worth is entirely in whether these sentences and
 * commands are right. The commands are the tools' own — `claude plugin …` and
 * `codex plugin …`, as their `--help` gives them — and Anthill runs none of
 * them. Installing a plugin changes another program's configuration, and that
 * is the author's to do.
 */

import { PLUGIN_HARNESS_INFO, type CheckedPluginHarness } from "@anthill/workflow";

import type { PluginHarnessStatus, PluginServerStatus } from "../../shared/ipc.js";

export type PluginVerdict = "installed" | "update" | "off" | "missing" | "no-tool";

export type PluginStep = {
  /** One sentence saying what the step is for. */
  says: string;
  /**
   * Something to paste, when the step is one: a command for a terminal, or —
   * for a tool with no command for it — a line for its settings. `says` says
   * which.
   */
  command?: string;
};

/** Where a checkout's path goes in a command when none is known. */
export const CHECKOUT_PLACEHOLDER = "/path/to/anthill";

/** Anthill's repository, which both tools accept as a marketplace source. */
export const GITHUB_SOURCE = "nstr/anthill";

export function pluginVerdict(status: PluginHarnessStatus): PluginVerdict {
  if (!status.toolFound) return "no-tool";
  if (!status.installed) return "missing";
  if (!status.enabled) return "off";
  if (status.availableVersion && status.installedVersion && status.availableVersion !== status.installedVersion) {
    return "update";
  }
  return "installed";
}

/** A path as a shell word: quoted only when it has to be. */
function shellPath(path: string): string {
  return /^[\w./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * What each tool needs for each ending, from what the page knows.
 *
 * `source` is the marketplace to add, already a shell word; `id` is
 * `plugin@marketplace`. Claude Code and Codex have commands for it, as their
 * `--help` gives them. VS Code has none: its ways in are its own settings,
 * which are the author's to edit, so its steps are lines to paste there.
 */
type ToolSteps = {
  missing(status: PluginHarnessStatus, source: string, id: string, keys: Keys): PluginStep[];
  /** What switches a disabled plugin back on. */
  enable(id: string, keys: Keys): PluginStep[];
  /** What installs the newer version a marketplace now offers. */
  update(status: PluginHarnessStatus, marketplace: string, id: string): PluginStep[];
  /** What a running session has to do before it sees the change. */
  restart(status: PluginHarnessStatus): PluginStep;
  /** What to do when the tool has not been used here, when the usual words do not fit. */
  noTool?: PluginStep;
};

/** Offering the marketplace and installing from it, with the tool's two commands. */
function fromMarketplace(status: PluginHarnessStatus, add: string, install: string): PluginStep[] {
  return [
    {
      says: status.checkout
        ? `Offer this Anthill checkout to ${status.label} as a plugin marketplace.`
        : `Add Anthill's plugin marketplace to ${status.label}, from GitHub.`,
      command: add,
    },
    { says: `Install the ${status.plugin} plugin from it.`, command: install },
  ];
}

const newSession = (status: PluginHarnessStatus): PluginStep => ({
  says: `Start a new ${status.label} session. Plugins are loaded when a session starts, so one already open will not see it.`,
});

/** Where VS Code's own settings are opened from, said the way its Command Palette says it. */
const VSCODE_SETTINGS = "Preferences: Open User Settings (JSON)";

/**
 * VS Code's shortcuts for the steps, on the system Anthill runs on. VS Code
 * 1.140 binds Open Agents Window to CtrlCmd+Shift+Alt+A from an editor window.
 * Both are given when the system is not known.
 */
type Keys = { palette: string; agents: string };

export function vscodeKeys(platform: string | undefined): Keys {
  if (platform === "darwin") return { palette: "⇧⌘P", agents: "⇧⌥⌘A" };
  if (platform === "win32" || platform === "linux") return { palette: "Ctrl+Shift+P", agents: "Ctrl+Shift+Alt+A" };
  return { palette: "⇧⌘P / Ctrl+Shift+P", agents: "⇧⌥⌘A / Ctrl+Shift+Alt+A" };
}

const STEPS: Record<CheckedPluginHarness, ToolSteps> = {
  "claude-code": {
    missing: (status, source, id) =>
      fromMarketplace(status, `claude plugin marketplace add ${source}`, `claude plugin install ${id}`),
    enable: (id) => [{ says: "Switch the plugin back on.", command: `claude plugin enable ${id}` }],
    update: (status, marketplace, id) => [
      { says: "Have Claude Code read the marketplace again.", command: `claude plugin marketplace update ${marketplace}` },
      { says: `Update the plugin to ${status.availableVersion}.`, command: `claude plugin update ${id}` },
    ],
    restart: newSession,
  },
  codex: {
    missing: (status, source, id) => fromMarketplace(status, `codex plugin marketplace add ${source}`, `codex plugin add ${id}`),
    enable: (id) => [
      {
        says: `Switch it back on in Codex's plugin settings, or set \`enabled = true\` under \`[plugins."${id}"]\` in ~/.codex/config.toml.`,
      },
    ],
    update: (status, marketplace, id) => [
      ...(status.checkout
        ? []
        : [{ says: "Have Codex fetch the marketplace again.", command: `codex plugin marketplace upgrade ${marketplace}` }]),
      { says: `Install it again from the marketplace, which now offers ${status.availableVersion}.`, command: `codex plugin add ${id}` },
    ],
    restart: newSession,
  },
  vscode: {
    // Pointing VS Code at a checkout's folder is the whole install; VS Code
    // runs it from a copy it keeps in its own data folder. From GitHub it is
    // two moves in VS Code itself: the marketplace in its settings, then the
    // plugin from that marketplace, which is where people got lost.
    missing: (status, _source, _id, keys) =>
      status.checkout
        ? [
            {
              says: `Point VS Code at this checkout's plugin folder: open the Command Palette (${keys.palette}), run ${VSCODE_SETTINGS} and add this line.`,
              command: `"chat.pluginLocations": { ${JSON.stringify(`${status.checkout}/${PLUGIN_HARNESS_INFO.vscode.folder}`)}: true }`,
            },
          ]
        : [
            {
              says: `To install the plugin, first add Anthill's marketplace to VS Code's settings: open the Command Palette (${keys.palette}), run ${VSCODE_SETTINGS} and add this line.`,
              command: `"chat.plugins.marketplaces": [${JSON.stringify(GITHUB_SOURCE)}]`,
            },
            {
              says: `Then install the plugin from that marketplace. Open the Agents window (Open Agents Window in the Command Palette, or ${keys.agents}), then Customizations ▸ Plugins ▸ Browse Marketplace.`,
            },
            { says: `Search for ${status.plugin}, choose Install, and Trust ${GITHUB_SOURCE} when VS Code asks.` },
          ],
    enable: (_id, keys) => [
      {
        says: `Switch it back on with the switch next to anthill in Customizations ▸ Plugins, in the Agents window (${keys.agents}).`,
      },
    ],
    update: (status) => [
      { says: `Update it in VS Code's list of agent plugins, which now offers ${status.availableVersion}.` },
    ],
    restart: () => ({
      says: "Start a new session in the Agents window. VS Code loads plugins when a session starts, so one already open will not see it.",
    }),
    noTool: { says: "VS Code has not been used on this machine yet. Install it and sign in to GitHub Copilot, then come back here." },
  },
};

/** The steps that move a tool from where it is to a working plugin. */
/**
 * `platform` is the system Anthill runs on (`process.platform`), for the
 * shortcuts a step names; unknown, a step names both.
 */
export function pluginSteps(status: PluginHarnessStatus, platform?: string): PluginStep[] {
  const verdict = pluginVerdict(status);
  // A checkout on this disk is offered as the source, for working on Anthill;
  // otherwise the repository on GitHub, which is what everyone else installs.
  const source = status.checkout ? shellPath(status.checkout) : GITHUB_SOURCE;
  const steps = STEPS[status.harness];
  const marketplace = status.marketplace ?? PLUGIN_HARNESS_INFO[status.harness].marketplace;
  const id = `${status.plugin}@${marketplace}`;
  const keys = vscodeKeys(platform);

  switch (verdict) {
    case "no-tool":
      return [
        steps.noTool ?? {
          says: `${status.label} has not been used on this machine yet. Install it and sign in first – the Coding tools page walks through that – then come back here.`,
        },
      ];

    case "missing":
      return [...steps.missing(status, source, id, keys), steps.restart(status)];

    case "off":
      return [...steps.enable(id, keys), steps.restart(status)];

    case "update":
      return [...steps.update(status, marketplace, id), steps.restart(status)];

    case "installed":
      return [];
  }
}

/**
 * What to do about the server the plugin launches, if anything.
 *
 * Both plugins are launchers. Each carries its own copy of Anthill's MCP
 * server and starts it, unless `~/.anthill/plugin.json` names another — a
 * checkout's own build, for working on Anthill. So there is something to do
 * only when the file names a server that is not there, or cannot be read:
 * the launcher then refuses to start rather than guess.
 */
export function serverSteps(server: PluginServerStatus, checkout: string | undefined): PluginStep[] {
  if (!server.configured && !server.problem) return [];
  if (server.configured && server.exists) return [];
  const root = checkout ?? CHECKOUT_PLACEHOLDER;
  const path = `${root}/apps/mcp/dist/server.js`;
  const build: PluginStep = {
    says: checkout
      ? "Build the server in the checkout."
      : "Build the server in your Anthill checkout. Replace the path with where it is on this machine.",
    command: `cd ${shellPath(root)} && npm run build:deps && npm run build --workspace=@anthill/mcp`,
  };
  // A command only for a path that needs no quoting inside the JSON inside the
  // shell quotes; anything else is said in words rather than risked.
  const point: PluginStep = /^[\w./~-]+$/.test(path)
    ? {
        says: `Tell the plugin where the server is, in ${server.settingsFile}.`,
        command: `mkdir -p ~/.anthill && printf '%s\\n' '{"server": "${path}"}' > ~/.anthill/plugin.json`,
      }
    : { says: `Tell the plugin where the server is: in ${server.settingsFile}, write {"server": "${path}"}.` };

  // Named already, and named right: the file is simply not built yet.
  if (server.configured && server.path === path && !server.problem) return [build];
  return [build, point];
}
