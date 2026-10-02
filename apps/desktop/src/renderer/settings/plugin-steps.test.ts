import { describe, expect, it } from "vitest";

import type { PluginHarnessStatus } from "../../shared/ipc.js";
import { GITHUB_SOURCE, pluginSteps, pluginVerdict, serverSteps } from "./plugin-steps.js";

const claude = (over: Partial<PluginHarnessStatus> = {}): PluginHarnessStatus => ({
  harness: "claude-code",
  label: "Claude Code",
  plugin: "anthill",
  toolFound: true,
  installed: true,
  enabled: true,
  installedVersion: "0.7.8",
  marketplace: "anthill",
  checkout: "/Users/me/anthill",
  availableVersion: "0.7.8",
  ...over,
});

const codex = (over: Partial<PluginHarnessStatus> = {}): PluginHarnessStatus => ({
  ...claude(),
  harness: "codex",
  label: "Codex",
  plugin: "anthill",
  marketplace: "anthill-local",
  installedVersion: "0.7.8+codex.1",
  availableVersion: "0.7.8+codex.1",
  ...over,
});

const commands = (status: PluginHarnessStatus) => pluginSteps(status).flatMap((step) => (step.command ? [step.command] : []));

describe("what the page claims", () => {
  it("tells each state apart", () => {
    expect(pluginVerdict(claude({ toolFound: false }))).toBe("no-tool");
    expect(pluginVerdict(claude({ installed: false }))).toBe("missing");
    expect(pluginVerdict(claude({ enabled: false }))).toBe("off");
    expect(pluginVerdict(claude({ installedVersion: "0.7.6" }))).toBe("update");
    expect(pluginVerdict(claude())).toBe("installed");
  });

  it("does not claim an update it cannot see", () => {
    // No checkout on this disk, so no version to compare against.
    expect(pluginVerdict(claude({ availableVersion: undefined, installedVersion: "0.7.6" }))).toBe("installed");
  });
});

describe("the steps", () => {
  it("are nothing for a plugin that is in and current", () => {
    expect(pluginSteps(claude())).toEqual([]);
  });

  it("install into Claude Code from the checkout it knows about", () => {
    expect(commands(claude({ installed: false, marketplace: undefined }))).toEqual([
      "claude plugin marketplace add /Users/me/anthill",
      "claude plugin install anthill@anthill",
    ]);
  });

  it("install into Codex with Codex's own words for it", () => {
    expect(commands(codex({ installed: false, marketplace: undefined }))).toEqual([
      "codex plugin marketplace add /Users/me/anthill",
      "codex plugin add anthill@anthill-local",
    ]);
  });

  it("install from GitHub when there is no checkout, as everyone but Anthill's authors does", () => {
    expect(commands(claude({ installed: false, checkout: undefined, marketplace: undefined }))).toEqual([
      `claude plugin marketplace add ${GITHUB_SOURCE}`,
      "claude plugin install anthill@anthill",
    ]);
    expect(commands(codex({ installed: false, checkout: undefined, marketplace: undefined }))).toEqual([
      `codex plugin marketplace add ${GITHUB_SOURCE}`,
      "codex plugin add anthill@anthill-local",
    ]);
  });

  it("update Codex from GitHub by fetching the marketplace first", () => {
    expect(commands(codex({ installedVersion: "0.7.6", checkout: undefined }))).toEqual([
      "codex plugin marketplace upgrade anthill-local",
      "codex plugin add anthill@anthill-local",
    ]);
  });

  it("quote a checkout path that needs it", () => {
    expect(commands(claude({ installed: false, checkout: "/Users/me/My Code/anthill" }))[0]).toBe(
      "claude plugin marketplace add '/Users/me/My Code/anthill'",
    );
  });

  it("update Claude Code by reading the marketplace again first", () => {
    expect(commands(claude({ installedVersion: "0.7.6" }))).toEqual([
      "claude plugin marketplace update anthill",
      "claude plugin update anthill@anthill",
    ]);
  });

  it("switch a Claude Code plugin back on with its own command", () => {
    expect(commands(claude({ enabled: false }))).toEqual(["claude plugin enable anthill@anthill"]);
  });

  it("always end on starting a new session, which is when plugins load", () => {
    const steps = pluginSteps(codex({ installed: false }));
    expect(steps.at(-1)?.says).toContain("new Codex session");
  });
});

describe("the server the plugin launches", () => {
  const file = "/Users/me/.anthill/plugin.json";

  it("needs nothing when it is named and there", () => {
    expect(serverSteps({ configured: true, settingsFile: file, path: "/x/server.js", exists: true }, "/x")).toEqual([]);
  });

  it("needs nothing when nothing is configured, because the plugin starts the server it carries", () => {
    expect(serverSteps({ configured: false, settingsFile: file }, "/Users/me/anthill")).toEqual([]);
    expect(serverSteps({ configured: false, settingsFile: file }, undefined)).toEqual([]);
  });

  it("builds and names it when the file cannot be read", () => {
    const steps = serverSteps({ configured: false, settingsFile: file, problem: "not JSON" }, "/Users/me/anthill");
    expect(steps.map((step) => step.command)).toEqual([
      "cd /Users/me/anthill && npm run build:deps && npm run build --workspace=@anthill/mcp",
      `mkdir -p ~/.anthill && printf '%s\\n' '{"server": "/Users/me/anthill/apps/mcp/dist/server.js"}' > ~/.anthill/plugin.json`,
    ]);
  });

  it("only builds when the file already names the right place", () => {
    const path = "/Users/me/anthill/apps/mcp/dist/server.js";
    const steps = serverSteps({ configured: true, settingsFile: file, path, exists: false }, "/Users/me/anthill");
    expect(steps).toHaveLength(1);
    expect(steps[0].command).toContain("npm run build");
  });
});

describe("VS Code, which has no command for plugins", () => {
  const vscode = (over: Partial<PluginHarnessStatus> = {}): PluginHarnessStatus => ({
    harness: "vscode",
    label: "VS Code",
    plugin: "anthill",
    toolFound: true,
    installed: false,
    enabled: false,
    ...over,
  });

  it("points VS Code at a checkout's plugin folder with one settings line", () => {
    const steps = pluginSteps(vscode({ checkout: "/Users/me/anthill" }));
    expect(steps[0]?.says).toContain("Preferences: Open User Settings (JSON)");
    expect(steps[0]?.command).toBe('"chat.pluginLocations": { "/Users/me/anthill/plugins/anthill-vscode": true }');
    expect(steps.at(-1)?.says).toContain("Start a new chat");
  });

  it("adds the GitHub marketplace when there is no checkout, and runs nothing in a terminal", () => {
    const steps = pluginSteps(vscode());
    expect(commands(vscode())).toEqual([`"chat.plugins.marketplaces": ["${GITHUB_SOURCE}"]`]);
    expect(steps.map((step) => step.says).join(" ")).toContain("Install anthill from the agent plugins VS Code then offers");
    expect(commands(vscode()).some((command) => /^(claude|codex|code) /.test(command))).toBe(false);
  });

  it("does not send someone to the Coding tools page for VS Code", () => {
    const [step] = pluginSteps(vscode({ toolFound: false }));
    expect(step?.says).toContain("VS Code has not been used on this machine yet");
    expect(step?.says).not.toContain("Coding tools");
  });
});
