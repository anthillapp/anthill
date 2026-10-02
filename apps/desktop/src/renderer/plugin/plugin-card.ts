/**
 * What a plugin card says, from what Anthill actually found.
 *
 * Every sentence a card can show is written here, once, and chosen from the
 * connection main reported plus the one thing only this window knows — that
 * an install is running, has just finished, or has just failed. Onboarding and
 * From a session draw the same card; keeping the words out of the component is
 * what stops the two from drifting into different claims about one machine.
 *
 * The rule the whole table serves: **only an answer turns a card green.** An
 * install record is what the tool wrote down; Ready means the installed
 * plugin's launcher was started and Anthill's server answered it. Opening a
 * listing, running a command, or an install that reported success are none of
 * them proof, and none of them is drawn as one.
 */

import { PLUGIN_HARNESS_INFO } from "@anthill/workflow";

import type { PluginConnection, PluginInstallResult } from "../../shared/ipc.js";

export type CardState =
  | "checking"
  | "missing"
  | "available"
  | "installing"
  | "reload"
  | "ready"
  | "failed"
  | "silent";

/** What this window knows that main does not. */
export type LocalCardState =
  | { kind: "idle" }
  | { kind: "installing" }
  | { kind: "installed" }
  | { kind: "failed"; result: Extract<PluginInstallResult, { ok: false }> };

export type CardAction = "install" | "check" | "guide" | "settings";

export type PluginCardView = {
  state: CardState;
  badge: string;
  note: string;
  /** The tool's own words, when something went wrong and it gave any. */
  detail?: string;
  action?: { kind: CardAction; label: string; outlined?: boolean };
};

/** The badge for each state. `silent` is the one the design has no row for, and needs. */
export const BADGE: Record<CardState, string> = {
  checking: "Checking…",
  missing: "Not found",
  available: "Plugin not installed",
  installing: "Installing…",
  reload: "Restart needed",
  ready: "Ready",
  failed: "Install failed",
  silent: "Not answering",
};

export function pluginCard(connection: PluginConnection | undefined, local: LocalCardState, label: string): PluginCardView {
  const view = (state: CardState, note: string, extra: Partial<PluginCardView> = {}): PluginCardView => ({
    state,
    badge: BADGE[state],
    note,
    ...extra,
  });

  if (local.kind === "installing") return view("installing", `${label} may ask you to confirm – look for its prompt.`);
  if (local.kind === "failed") {
    const { result } = local;
    return view(
      "failed",
      result.changed
        ? "The install didn't finish. Part of it ran – Settings ▸ Plugins shows where each tool now stands."
        : "The install didn't finish. Nothing on your machine was changed.",
      { detail: result.error, action: { kind: "install", label: "Try again" } },
    );
  }
  if (!connection) return view("checking", `Looking for ${label} on this Mac…`);

  const { cli, status } = connection;
  if (!cli.available) {
    return view("missing", `${label} isn't on this Mac yet. Its install guide opens in your browser.`, {
      action: { kind: "guide", label: "Open install guide ↗", outlined: true },
    });
  }

  const tool = cli.version ? `${label} ${cli.version}` : label;

  if (status.installed && status.enabled) {
    if (connection.serverAnswers) {
      // Just installed: whatever answered, a session already open has not
      // loaded it. Saying Ready here would send someone back to a session
      // that cannot see the plugin.
      if (local.kind === "installed") {
        return view("reload", `Installed. Start a new ${label} session so it loads the plugin.`, {
          action: { kind: "check", label: "Check again" },
        });
      }
      return view("ready", `Plugin enabled, and Anthill's local server answers from ${label}.`);
    }
    return view("silent", `The plugin is installed, but Anthill's local server didn't answer when ${label} would start it.`, {
      ...(connection.serverProblem ? { detail: connection.serverProblem } : {}),
      action: { kind: "check", label: "Check again" },
    });
  }

  if (status.installed && !status.enabled) {
    // Some tools have a command for it; others keep the switch in their own settings.
    return PLUGIN_HARNESS_INFO[status.harness].enablesFromCli && connection.source
      ? view("available", `The plugin is installed but switched off in ${label}. Anthill can switch it back on.`, {
          action: { kind: "install", label: `Turn on for ${label}` },
        })
      : view("available", `The plugin is installed but switched off. Turn it on in ${label}'s plugin settings.`, {
          action: { kind: "settings", label: "Show the steps", outlined: true },
        });
  }

  if (!connection.source) {
    // Nothing to install from. The main process names a checkout or GitHub
    // every time now; this is for a main process that left it out. A button
    // that could only fail is not offered.
    return view("available", `${tool} is installed. This build of Anthill can't add the plugin by itself yet – Settings ▸ Plugins has the steps.`, {
      action: { kind: "settings", label: "Show the steps", outlined: true },
    });
  }
  return view("available", `${tool} is installed. Anthill can add its plugin for you.`, {
    action: { kind: "install", label: `Install for ${label}` },
  });
}

/** The tools that are really connected, by name, in the order given. */
export function readyTools(views: { label: string; view: PluginCardView }[]): string[] {
  return views.filter((item) => item.view.state === "ready").map((item) => item.label);
}
