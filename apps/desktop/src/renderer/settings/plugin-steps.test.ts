import { describe, expect, it } from "vitest";

import type { PluginHarnessStatus } from "../../shared/ipc.js";
import { CHECKOUT_PLACEHOLDER, pluginSteps, pluginVerdict, serverSteps } from "./plugin-steps.js";

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
  plugin: "anthill-cli",
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
      "codex plugin add anthill-cli@anthill-local",
    ]);
  });

  it("say plainly where a path has to be filled in", () => {
    const steps = pluginSteps(claude({ installed: false, checkout: undefined }));
    expect(steps[0].command).toBe(`claude plugin marketplace add ${CHECKOUT_PLACEHOLDER}`);
    expect(steps[0].says).toContain("Replace the path");
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

  it("builds and names it when nothing is configured", () => {
    const steps = serverSteps({ configured: false, settingsFile: file }, "/Users/me/anthill");
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
