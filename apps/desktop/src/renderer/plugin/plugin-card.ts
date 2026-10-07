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
import { pluginVerdict } from "../settings/plugin-steps.js";

export type CardState =
  | "checking"
  | "missing"
  | "available"
  | "installing"
  | "confirm"
  | "update"
  | "reload"
  | "ready"
  | "failed"
  | "silent";

/**
 * What this window knows that main does not. `update`: the click was on a
 * plugin that is behind, so main updated it rather than installing (ANT-282).
 */
export type LocalCardState =
  | { kind: "idle" }
  | { kind: "installing"; update?: boolean }
  /** The tool's own install links were opened; the tool asks before it installs. */
  | { kind: "confirming" }
  | { kind: "installed"; update?: boolean }
  | { kind: "failed"; result: Extract<PluginInstallResult, { ok: false }>; update?: boolean };

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
  confirm: "Confirm in the tool",
  update: "Update available",
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

  if (local.kind === "installing") {
    return local.update
      ? view("installing", `Updating the plugin with ${label}'s own commands…`, { badge: "Updating…" })
      : view("installing", `${label} may ask you to confirm – look for its prompt.`);
  }
  if (local.kind === "failed") {
    const { result } = local;
    const what = local.update ? "update" : "install";
    return view(
      "failed",
      result.changed
        ? `The ${what} didn't finish. Part of it ran – Settings ▸ Plugins shows where each tool now stands.`
        : `The ${what} didn't finish. Nothing on your machine was changed.`,
      { detail: result.error, action: { kind: "install", label: "Try again" }, ...(local.update ? { badge: "Update failed" } : {}) },
    );
  }
  if (!connection) return view("checking", `Looking for ${label} on this Mac…`);

  const { cli, status } = connection;

  // Waiting on the tool's own prompts. Once the plugin turns up, it is read
  // like any install that just finished.
  if (local.kind === "confirming" && !status.installed) {
    return view(
      "confirm",
      `${label} asks twice: to add Anthill's marketplace, then to install the plugin. Confirm both there; Anthill checks again when you come back.`,
      { badge: `Confirm in ${label}`, action: { kind: "install", label: "Open the links again", outlined: true } },
    );
  }
  const justInstalled = local.kind === "installed" || local.kind === "confirming";
  const justUpdated = local.kind === "installed" && local.update;

  // Anthill updating the plugin by itself as it started (ANT-282). Asked while
  // it runs, the card says so and offers nothing to click into the middle of it.
  if (status.autoUpdate?.state === "updating") {
    return view("installing", `Updating the plugin to ${status.autoUpdate.version} along with Anthill…`, { badge: "Updating…" });
  }

  if (!cli.available) {
    return view("missing", `${label} isn't on this Mac yet. Its install guide opens in your browser.`, {
      action: { kind: "guide", label: "Open install guide ↗", outlined: true },
    });
  }

  const tool = cli.version ? `${label} ${cli.version}` : label;

  if (status.installed && status.enabled) {
    // Behind the version on offer (ANT-282): the plugin is updated before
    // anything else about it is worth saying — an old plugin that answers
    // still describes an Anthill that is gone.
    if (pluginVerdict(status) === "update") {
      const { installedVersion: have, availableVersion: want } = status;
      const offer = status.checkout ? `the checkout has ${want}` : `this Anthill comes with ${want}`;
      if (status.autoUpdate?.state === "failed") {
        return view("failed", `Anthill couldn't update the plugin to ${want} as it started. It tries again next time, or now:`, {
          badge: "Update failed",
          detail: status.autoUpdate.error,
          action: { kind: "install", label: "Try again" },
        });
      }
      const info = PLUGIN_HARNESS_INFO[status.harness];
      // Claude Code and Codex: their own commands, run from here.
      if (info.installsFromAnthill && !info.installLinks) {
        return view("update", `The plugin is ${have}; ${offer}.`, {
          action: { kind: "install", label: `Update for ${label}` },
        });
      }
      // VS Code updates its plugins by itself and has no command to run.
      return view("update", `The plugin is ${have}; ${offer}. ${label} updates it by itself, or update it now from its list of agent plugins.`, {
        action: { kind: "settings", label: "Show the steps", outlined: true },
      });
    }
    if (connection.serverAnswers) {
      if (justUpdated) {
        return view("reload", `Updated. Start a new ${label} session so it loads the new plugin.`, {
          action: { kind: "check", label: "Check again" },
        });
      }
      // Just installed: whatever answered, a session already open has not
      // loaded it. Saying Ready here would send someone back to a session
      // that cannot see the plugin.
      if (justInstalled) {
        return view("reload", `Installed. Start a new ${label} session so it loads the plugin.`, {
          action: { kind: "check", label: "Check again" },
        });
      }
      // Updated as Anthill started: a session already open keeps the old
      // plugin until a new one starts, and nobody clicked anything to learn
      // that, so the card says it.
      if (status.autoUpdate?.state === "updated") {
        return view("ready", `Updated to ${status.autoUpdate.version} along with Anthill. Start a new ${label} session to use it.`);
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

  if (PLUGIN_HARNESS_INFO[status.harness].installLinks) {
    return view("available", `${tool} is here. Anthill opens ${label}'s own install links, and ${label} asks you to confirm.`, {
      action: { kind: "install", label: `Install for ${label}` },
    });
  }

  if (!PLUGIN_HARNESS_INFO[status.harness].installsFromAnthill) {
    // No command to run for it: the tool takes plugins from its own settings,
    // which are the author's to edit. A button that could only fail is not offered.
    return view("available", `${tool} is here. Add the plugin from its own settings – Settings ▸ Plugins has the line to paste.`, {
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
