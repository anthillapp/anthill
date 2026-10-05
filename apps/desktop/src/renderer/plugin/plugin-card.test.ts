/**
 * Every ending a plugin card can reach, and the one rule over all of them:
 * only an answer from the installed plugin's server turns a card Ready.
 */

import { describe, expect, it } from "vitest";

import type { PluginConnection, PluginHarnessStatus } from "../../shared/ipc.js";

import { pluginCard, readyTools, type LocalCardState } from "./plugin-card.js";

const idle: LocalCardState = { kind: "idle" };

function connection(
  over: Omit<Partial<PluginConnection>, "status"> & { status?: Partial<PluginHarnessStatus> } = {},
): PluginConnection {
  const { status, ...rest } = over;
  return {
    harness: "claude-code",
    label: "Claude Code",
    cli: { available: true, version: "2.1.278" },
    source: "/src/anthill",
    ...rest,
    status: {
      harness: "claude-code",
      label: "Claude Code",
      plugin: "anthill",
      toolFound: true,
      installed: false,
      enabled: false,
      ...status,
    },
  };
}

describe("before anything is known", () => {
  it("says it is looking, and offers nothing", () => {
    const view = pluginCard(undefined, idle, "Codex");
    expect(view.state).toBe("checking");
    expect(view.action).toBeUndefined();
  });
});

describe("a tool that is not here", () => {
  it("is Not found, and opens the tool's own install guide", () => {
    const view = pluginCard(connection({ cli: { available: false } }), idle, "Claude Code");
    expect(view).toMatchObject({ state: "missing", badge: "Not found", action: { kind: "guide", outlined: true } });
    expect(view.note).toBe("Claude Code isn't on this Mac yet. Its install guide opens in your browser.");
  });
});

describe("a tool without the plugin", () => {
  it("offers to install it, naming the version it found", () => {
    const view = pluginCard(connection(), idle, "Claude Code");
    expect(view).toMatchObject({ state: "available", badge: "Plugin not installed", action: { kind: "install", label: "Install for Claude Code" } });
    expect(view.note).toBe("Claude Code 2.1.278 is installed. Anthill can add its plugin for you.");
  });

  it("does not offer an install that has nothing to install from", () => {
    const view = pluginCard(connection({ source: undefined }), idle, "Claude Code");
    expect(view.state).toBe("available");
    expect(view.action).toMatchObject({ kind: "settings", label: "Show the steps" });
    expect(view.note).toContain("can't add the plugin by itself yet");
  });

  it("switches a Claude Code plugin back on; points a Codex one at Codex's settings", () => {
    const off = { installed: true, enabled: false, marketplace: "anthill" };
    expect(pluginCard(connection({ status: off }), idle, "Claude Code").action).toMatchObject({
      kind: "install",
      label: "Turn on for Claude Code",
    });
    const codex = connection({ harness: "codex", label: "Codex", status: { ...off, harness: "codex", plugin: "anthill" } });
    expect(pluginCard(codex, idle, "Codex").action).toMatchObject({ kind: "settings" });
  });
});

describe("installing", () => {
  it("says the tool may ask to confirm, whatever main last said", () => {
    const view = pluginCard(connection(), { kind: "installing" }, "Codex");
    expect(view).toMatchObject({ state: "installing", badge: "Installing…" });
    expect(view.note).toBe("Codex may ask you to confirm – look for its prompt.");
  });

  it("asks for a new session after an install, even though the server answered", () => {
    const view = pluginCard(
      connection({ status: { installed: true, enabled: true }, serverAnswers: true }),
      { kind: "installed" },
      "Claude Code",
    );
    expect(view).toMatchObject({ state: "reload", badge: "Restart needed", action: { kind: "check", label: "Check again" } });
  });

  it("says nothing changed only when nothing did", () => {
    const untouched = pluginCard(connection(), { kind: "failed", result: { ok: false, changed: false, error: "No." } }, "Codex");
    expect(untouched).toMatchObject({ state: "failed", detail: "No.", action: { kind: "install", label: "Try again" } });
    expect(untouched.note).toContain("Nothing on your machine was changed.");
    const partial = pluginCard(connection(), { kind: "failed", result: { ok: false, changed: true, error: "No." } }, "Codex");
    expect(partial.note).not.toContain("Nothing on your machine was changed.");
  });
});

describe("Ready", () => {
  it("is earned by the server answering", () => {
    const view = pluginCard(connection({ status: { installed: true, enabled: true }, serverAnswers: true }), idle, "Claude Code");
    expect(view).toMatchObject({ state: "ready", badge: "Ready" });
    expect(view.action).toBeUndefined();
    expect(view.note).toBe("Plugin enabled, and Anthill's local server answers from Claude Code.");
  });

  it("is never given for an install record alone", () => {
    const view = pluginCard(
      connection({ status: { installed: true, enabled: true }, serverAnswers: false, serverProblem: "Nothing says where the Anthill MCP server is." }),
      idle,
      "Claude Code",
    );
    expect(view).toMatchObject({ state: "silent", badge: "Not answering", detail: "Nothing says where the Anthill MCP server is." });
    expect(view.action).toMatchObject({ kind: "check" });
  });

  it("names only the tools that are really ready", () => {
    const ready = pluginCard(connection({ status: { installed: true, enabled: true }, serverAnswers: true }), idle, "Claude Code");
    const not = pluginCard(connection(), idle, "Codex");
    expect(readyTools([{ label: "Codex", view: not }, { label: "Claude Code", view: ready }])).toEqual(["Claude Code"]);
  });
});

describe("a tool installed through its own links", () => {
  const vscode = (status: Partial<PluginHarnessStatus> = {}) =>
    connection({ harness: "vscode", label: "VS Code", cli: { available: true }, status: { harness: "vscode", label: "VS Code", ...status } });

  it("offers Install, and says VS Code asks to confirm", () => {
    const view = pluginCard(vscode(), idle, "VS Code");
    expect(view.state).toBe("available");
    expect(view.action).toEqual({ kind: "install", label: "Install for VS Code" });
    expect(view.note).toContain("VS Code asks you to confirm");
  });

  it("waits on VS Code's prompts rather than claiming an install, and offers the links again", () => {
    const view = pluginCard(vscode(), { kind: "confirming" }, "VS Code");
    expect(view.state).toBe("confirm");
    expect(view.badge).toBe("Confirm in VS Code");
    expect(view.note).toContain("Confirm both there");
    expect(view.action).toEqual({ kind: "install", label: "Open the links again", outlined: true });
  });

  it("reads a plugin that turned up while waiting as one just installed", () => {
    const view = pluginCard(vscode({ installed: true, enabled: true }), { kind: "confirming" }, "VS Code");
    expect(view.state).not.toBe("confirm");
    const answered = pluginCard(
      { ...vscode({ installed: true, enabled: true }), serverAnswers: true },
      { kind: "confirming" },
      "VS Code",
    );
    expect(answered.state).toBe("reload");
  });

  it("still turns green only when the installed plugin's server answers", () => {
    const status = { harness: "vscode" as const, label: "VS Code", installed: true, enabled: true };
    expect(pluginCard(connection({ harness: "vscode", status, serverAnswers: true }), idle, "VS Code").state).toBe("ready");
    expect(pluginCard(connection({ harness: "vscode", status, serverAnswers: false }), idle, "VS Code").state).toBe("silent");
  });
});

/*
  ANT-282: a plugin installed from GitHub that is behind the app. Anthill
  updates it by itself as it starts; the card says what happened, and its
  button is the retry when that did not work.
*/
describe("a plugin behind this Anthill", () => {
  const behind = (status: Partial<PluginHarnessStatus> = {}, rest: Partial<PluginConnection> = {}) =>
    connection({
      ...rest,
      status: { installed: true, enabled: true, installedVersion: "0.8.9", availableVersion: "0.9.0", ...status },
      serverAnswers: true,
    });

  it("offers the update, run with the tool's own commands", () => {
    const view = pluginCard(behind(), idle, "Claude Code");
    expect(view).toMatchObject({ state: "update", badge: "Update available", action: { kind: "install", label: "Update for Claude Code" } });
    expect(view.note).toBe("The plugin is 0.8.9; this Anthill comes with 0.9.0.");
  });

  it("says the update at launch is running, and offers nothing to click into it", () => {
    const view = pluginCard(behind({ autoUpdate: { state: "updating", version: "0.9.0" } }), idle, "Codex");
    expect(view).toMatchObject({ state: "installing", badge: "Updating…" });
    expect(view.action).toBeUndefined();
  });

  it("shows why the update at launch failed, and retries from the same button", () => {
    const view = pluginCard(
      behind({ autoUpdate: { state: "failed", version: "0.9.0", error: "Codex's command was not found on your PATH." } }),
      idle,
      "Codex",
    );
    expect(view).toMatchObject({
      state: "failed",
      badge: "Update failed",
      detail: "Codex's command was not found on your PATH.",
      action: { kind: "install", label: "Try again" },
    });
  });

  it("says it was updated along with Anthill, and that a new session picks it up", () => {
    const view = pluginCard(
      connection({ status: { installed: true, enabled: true, installedVersion: "0.9.0", autoUpdate: { state: "updated", version: "0.9.0" } }, serverAnswers: true }),
      idle,
      "Claude Code",
    );
    expect(view).toMatchObject({ state: "ready", badge: "Ready" });
    expect(view.note).toBe("Updated to 0.9.0 along with Anthill. Start a new Claude Code session to use it.");
  });

  it("forgets a failure once the plugin is no longer behind", () => {
    const view = pluginCard(
      connection({
        status: { installed: true, enabled: true, installedVersion: "0.9.0", autoUpdate: { state: "failed", version: "0.9.0", error: "offline" } },
        serverAnswers: true,
      }),
      idle,
      "Claude Code",
    );
    expect(view.state).toBe("ready");
  });

  it("says Updating and Update failed for a click on a plugin that is behind", () => {
    expect(pluginCard(behind(), { kind: "installing", update: true }, "Codex")).toMatchObject({ state: "installing", badge: "Updating…" });
    const failed = pluginCard(behind(), { kind: "failed", update: true, result: { ok: false, changed: false, error: "No." } }, "Codex");
    expect(failed).toMatchObject({ state: "failed", badge: "Update failed", action: { kind: "install", label: "Try again" } });
    expect(failed.note).toBe("The update didn't finish. Nothing on your machine was changed.");
    const done = pluginCard(connection({ status: { installed: true, enabled: true }, serverAnswers: true }), { kind: "installed", update: true }, "Codex");
    expect(done).toMatchObject({ state: "reload", note: "Updated. Start a new Codex session so it loads the new plugin." });
  });

  it("points VS Code at its own list of plugins, with nothing to run", () => {
    const view = pluginCard(
      behind({ harness: "vscode", label: "VS Code" }, { harness: "vscode", label: "VS Code", cli: { available: true } }),
      idle,
      "VS Code",
    );
    expect(view).toMatchObject({ state: "update", action: { kind: "settings", label: "Show the steps", outlined: true } });
    expect(view.note).toContain("VS Code updates it by itself");
  });
});
