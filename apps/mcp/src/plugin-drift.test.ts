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

  it("says the server is behind when the plugin is newer", () => {
    const notice = pluginDriftNotice("0.8.0", "claude-code", "0.7.8");
    expect(notice).toContain("newer than the Anthill server it is talking to (0.7.8)");
    expect(notice).not.toContain("claude plugin update");
  });

  /*
    ANT-302. ~/.anthill/plugin.json pointed every plugin at a checkout's build
    still at 0.8.10, the plugins were 0.8.11, and the installed app was 0.8.11
    too. "Checkout or app is behind" sent Codex to tell the user to update the
    app, which changed nothing.
  */
  it("names a checkout's server, and never sends the user to update the app", () => {
    const notice = pluginDriftNotice("0.8.11+codex.1", "codex", "0.8.10", "/Users/me/dev/apps/anthill/apps/mcp/dist/server.js");
    expect(notice).toContain("the server it starts is the Anthill checkout at /Users/me/dev/apps/anthill, which is 0.8.10");
    expect(notice).toContain("not the Anthill app");
    expect(notice).toContain("cd /Users/me/dev/apps/anthill && git pull && npm install && npm run build:deps && npm run build --workspace=@anthill/mcp");
    expect(notice).not.toMatch(/update(?:s|ing)? (?:the )?(?:Anthill )?app to/i);
  });

  it("names any other server it runs from by its path", () => {
    const notice = pluginDriftNotice("0.8.11", "claude-code", "0.8.10", "/opt/anthill/server.js");
    expect(notice).toContain("(0.8.10, at /opt/anthill/server.js)");
  });

  it("still says nothing when a checkout's server and the plugin agree", () => {
    expect(pluginDriftNotice("0.8.11", "codex", "0.8.11", "/Users/me/dev/apps/anthill/apps/mcp/dist/server.js")).toBeUndefined();
  });
});
