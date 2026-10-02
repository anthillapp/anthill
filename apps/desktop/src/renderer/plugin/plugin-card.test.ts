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
