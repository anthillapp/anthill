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

/** The steps that move a tool from where it is to a working plugin. */
export function pluginSteps(status: PluginHarnessStatus): PluginStep[] {
  const verdict = pluginVerdict(status);
  const checkout = shellPath(status.checkout ?? CHECKOUT_PLACEHOLDER);
  const claude = status.harness === "claude-code";
  const marketplace = status.marketplace ?? (claude ? "anthill" : "anthill-local");
  const id = `${status.plugin}@${marketplace}`;
  const tool = claude ? "claude" : "codex";
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
            : `Offer your Anthill checkout to ${status.label} as a plugin marketplace. Replace the path with where it is on this machine.`,
          command: claude
            ? `claude plugin marketplace add ${checkout}`
            : `codex plugin marketplace add ${checkout}`,
        },
        {
          says: `Install the ${status.plugin} plugin from it.`,
          command: claude ? `claude plugin install ${id}` : `codex plugin add ${id}`,
        },
        restart,
      ];

    case "off":
      return claude
        ? [{ says: "Switch the plugin back on.", command: `claude plugin enable ${id}` }, restart]
        : [
            {
              says: `Switch it back on in Codex's plugin settings, or set \`enabled = true\` under \`[plugins."${id}"]\` in ~/.codex/config.toml.`,
            },
            restart,
          ];

    case "update":
      return [
        ...(claude
          ? [
              { says: "Have Claude Code read the checkout again.", command: `claude plugin marketplace update ${marketplace}` },
              { says: `Update the plugin to ${status.availableVersion}.`, command: `claude plugin update ${id}` },
            ]
          : [{ says: `Install it again from the checkout, which now offers ${status.availableVersion}.`, command: `${tool} plugin add ${id}` }]),
        restart,
      ];

    case "installed":
      return [];
  }
}

/**
 * What to do about the server the plugin launches, if anything.
 *
 * Both plugins are launchers: they start Anthill's MCP server, which is found
 * through `~/.anthill/plugin.json`. The installed app does not ship that server
 * yet, so it comes from a checkout — built there, and named here.
 */
export function serverSteps(server: PluginServerStatus, checkout: string | undefined): PluginStep[] {
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
