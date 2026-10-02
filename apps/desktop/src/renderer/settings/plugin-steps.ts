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
  /** A command to paste into a terminal, when the step is one. */
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

/** Each tool's own commands, as its `--help` gives them. */
type Commands = {
  addMarketplace(source: string): string;
  install(id: string): string;
  /** What switches a disabled plugin back on. */
  enable(id: string): PluginStep[];
  /** What installs the newer version a marketplace now offers. */
  update(status: PluginHarnessStatus, marketplace: string, id: string): PluginStep[];
};

const COMMANDS: Record<CheckedPluginHarness, Commands> = {
  "claude-code": {
    addMarketplace: (source) => `claude plugin marketplace add ${source}`,
    install: (id) => `claude plugin install ${id}`,
    enable: (id) => [{ says: "Switch the plugin back on.", command: `claude plugin enable ${id}` }],
    update: (status, marketplace, id) => [
      { says: "Have Claude Code read the marketplace again.", command: `claude plugin marketplace update ${marketplace}` },
      { says: `Update the plugin to ${status.availableVersion}.`, command: `claude plugin update ${id}` },
    ],
  },
  codex: {
    addMarketplace: (source) => `codex plugin marketplace add ${source}`,
    install: (id) => `codex plugin add ${id}`,
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
  },
};

/** The steps that move a tool from where it is to a working plugin. */
export function pluginSteps(status: PluginHarnessStatus): PluginStep[] {
  const verdict = pluginVerdict(status);
  // A checkout on this disk is offered as the source, for working on Anthill;
  // otherwise the repository on GitHub, which is what everyone else installs.
  const source = status.checkout ? shellPath(status.checkout) : GITHUB_SOURCE;
  const commands = COMMANDS[status.harness];
  const marketplace = status.marketplace ?? PLUGIN_HARNESS_INFO[status.harness].marketplace;
  const id = `${status.plugin}@${marketplace}`;
  const restart: PluginStep = {
    says: `Start a new ${status.label} session. Plugins are loaded when a session starts, so one already open will not see it.`,
  };

  switch (verdict) {
    case "no-tool":
      return [
        {
          says: `${status.label} has not been used on this machine yet. Install it and sign in first – the Coding tools page walks through that – then come back here.`,
        },
      ];

    case "missing":
      return [
        {
          says: status.checkout
            ? `Offer this Anthill checkout to ${status.label} as a plugin marketplace.`
            : `Add Anthill's plugin marketplace to ${status.label}, from GitHub.`,
          command: commands.addMarketplace(source),
        },
        {
          says: `Install the ${status.plugin} plugin from it.`,
          command: commands.install(id),
        },
        restart,
      ];

    case "off":
      return [...commands.enable(id), restart];

    case "update":
      return [...commands.update(status, marketplace, id), restart];

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
