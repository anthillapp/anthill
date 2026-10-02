/**
 * ANT-120: an installed plugin copy that has fallen behind says so.
 */

import { describe, expect, it } from "vitest";

import { pluginDriftNotice } from "./plugin-drift.js";

describe("an installed plugin measured against the server", () => {
  it("says nothing when they agree, build suffix aside", () => {
    expect(pluginDriftNotice("0.7.8", "claude-code", "0.7.8")).toBeUndefined();
    expect(pluginDriftNotice("0.7.8+codex.20260924232516", "codex", "0.7.8")).toBeUndefined();
  });

  it("says nothing when the launcher reported no version at all", () => {
    // An older launcher, or a server started by hand: absent is not old.
    expect(pluginDriftNotice(undefined, undefined, "0.7.8")).toBeUndefined();
    expect(pluginDriftNotice("  ", "claude-code", "0.7.8")).toBeUndefined();
  });

  it("names both versions and the Claude Code update command when the copy is behind", () => {
    const notice = pluginDriftNotice("0.7.0", "claude-code", "0.7.8");
    expect(notice).toContain("installed in this harness is 0.7.0");
    expect(notice).toContain("talking to is 0.7.8");
    expect(notice).toContain("claude plugin update anthill@anthill");
  });

  it("tells a Codex copy to reinstall rather than to run a Claude command", () => {
    const notice = pluginDriftNotice("0.7.3+codex.1", "codex", "0.7.8");
    expect(notice).toContain("reinstall the Anthill plugin in Codex");
    expect(notice).not.toContain("claude plugin update");
  });

  it("gives Claude Code's command when the launcher named no harness, or one it does not know", () => {
    expect(pluginDriftNotice("0.7.0", undefined, "0.7.8")).toContain("claude plugin update anthill@anthill");
    expect(pluginDriftNotice("0.7.0", "elsewhere", "0.7.8")).toContain("claude plugin update anthill@anthill");
  });

  it("compares numerically, so 0.7.10 is newer than 0.7.9", () => {
    expect(pluginDriftNotice("0.7.9", "claude-code", "0.7.10")).toContain("out of date");
  });

  it("says the checkout is behind when the plugin is newer", () => {
    const notice = pluginDriftNotice("0.8.0", "claude-code", "0.7.8");
    expect(notice).toContain("newer than the Anthill it is talking to (0.7.8)");
    expect(notice).not.toContain("claude plugin update");
  });
});
