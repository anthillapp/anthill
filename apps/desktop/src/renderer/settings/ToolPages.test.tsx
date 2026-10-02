/**
 * The three pages about coding tools (ANT-135): what is connected, which
 * models a workflow can use, and whether the plugin is installed.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MODEL_PREFERENCES, type ModelPreferences } from "@anthill/workflow";

import type { InterpreterInfo, PluginStatus } from "../../shared/ipc.js";
import { SettingsScreen } from "./SettingsScreen.js";

const TOOLS: InterpreterInfo[] = [
  { id: "claude-code", label: "Claude Code", command: "claude", boundary: "", available: true, signedIn: true, version: "2.1.261" },
  { id: "codex", label: "Codex", command: "codex", boundary: "", available: true, signedIn: false, version: "0.130.0" },
  { id: "pi", label: "Pi", command: "pi", boundary: "", available: false },
];

const PLUGINS: PluginStatus = {
  harnesses: [
    {
      harness: "claude-code",
      label: "Claude Code",
      plugin: "anthill",
      toolFound: true,
      installed: true,
      enabled: true,
      installedVersion: "0.7.6",
      availableVersion: "0.7.8",
      marketplace: "anthill",
      checkout: "/Users/me/anthill",
    },
    { harness: "codex", label: "Codex", plugin: "anthill", toolFound: true, installed: false, enabled: false },
  ],
  server: { configured: true, settingsFile: "/Users/me/.anthill/plugin.json", path: "/Users/me/anthill/apps/mcp/dist/server.js", exists: true },
};

function stub() {
  let stored: ModelPreferences = DEFAULT_MODEL_PREFERENCES;
  const api = {
    settingsRead: vi.fn(async () => ({})),
    detectInterpreters: vi.fn(async () => TOOLS),
    signInToInterpreter: vi.fn(async () => ({ ok: true })),
    liveSetupStatus: vi.fn(async () => ({ dismissed: false, trigger: "", harnesses: [] })),
    codexModels: vi.fn(async () => ({
      agentSupport: "supported" as const,
      models: [{ id: "gpt-5.5", label: "GPT-5.5", efforts: [{ id: "low" }, { id: "high" }] }],
    })),
    piModels: vi.fn(async () => undefined),
    modelPreferencesRead: vi.fn(async () => stored),
    modelPreferencesWrite: vi.fn(async (next: ModelPreferences) => {
      stored = next;
      return stored;
    }),
    pluginStatus: vi.fn(async () => PLUGINS),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return api;
}

function open(name: string) {
  render(<SettingsScreen onLeave={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name }));
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("the Coding tools page", () => {
  it("lists every tool with its real status and what Anthill can do with it", async () => {
    stub();
    open("Coding tools");
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("Signed out")).toBeTruthy();
    expect(screen.getByText("Not installed")).toBeTruthy();
    expect(screen.getByText(/Per-agent models: no, one per session/)).toBeTruthy();
  });

  // ANT-181: Pi is observed passively, with nothing to set up.
  it("says Pi's live observation is passive, not unavailable", async () => {
    stub();
    open("Coding tools");
    const note = await screen.findByText(/Live observation: passive – reads its session file/);
    expect(note.textContent).toContain("Per-agent models: no, one per session");
    expect(note.textContent).not.toContain("not available");
  });

  it("connects through the same sheet, worded for a page with no agent behind it", async () => {
    stub();
    open("Coding tools");
    await screen.findByText("Signed out");
    fireEvent.click(screen.getAllByRole("button", { name: "Check again" })[0]);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByText(/unsaved changes to this agent/)).toBeNull();
    expect(within(sheet).getByText(/changes nothing in your workflows or agents/)).toBeTruthy();
  });
});

describe("the Models page", () => {
  it("shows each connected tool's models, and hides one from the editors on request", async () => {
    const api = stub();
    open("Models");
    const offer = await screen.findByRole("switch", { name: "Offer Haiku in the agent editors" });
    expect(offer.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(offer);
    await waitFor(() =>
      expect(api.modelPreferencesWrite).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: { "claude-code": ["haiku"] } }),
      ),
    );
  });

  it("maps a tier to a model and effort per tool", async () => {
    const api = stub();
    open("Models");
    // Codex is signed out here, so only Claude Code can be mapped.
    const strong = await screen.findByLabelText("Strong on Claude Code");
    expect((strong as HTMLSelectElement).value).toBe("sonnet");
    expect(screen.queryByLabelText("Strong on OpenAI Codex CLI")).toBeNull();
    fireEvent.change(strong, { target: { value: "opus" } });
    await waitFor(() =>
      expect(api.modelPreferencesWrite).toHaveBeenCalledWith(
        expect.objectContaining({ tiers: expect.objectContaining({ strong: { "claude-code": { id: "opus" } } }) }),
      ),
    );
  });

  it("sets what a new agent starts with", async () => {
    const api = stub();
    open("Models");
    fireEvent.change(await screen.findByLabelText("Starting model on Claude Code"), { target: { value: "opus" } });
    await waitFor(() =>
      expect(api.modelPreferencesWrite).toHaveBeenCalledWith(
        expect.objectContaining({ defaults: { "claude-code": { id: "opus" } } }),
      ),
    );
  });

  it("says a tool that is not connected has nothing to show, rather than no models", async () => {
    stub();
    open("Models");
    expect((await screen.findAllByText("Not connected")).length).toBeGreaterThan(0);
  });
});

describe("the Plugins page", () => {
  it("says which version is installed and gives the steps to update", async () => {
    stub();
    open("Plugins");
    expect(await screen.findByText("Update available")).toBeTruthy();
    expect(screen.getByText(/version 0\.7\.6 · 0\.7\.8 available/)).toBeTruthy();
    expect(screen.getByText("claude plugin update anthill@anthill")).toBeTruthy();
  });

  it("gives the install steps for a tool without it, with the checkout already filled in", async () => {
    stub();
    open("Plugins");
    expect(await screen.findByText("Not installed")).toBeTruthy();
    expect(screen.getByText("codex plugin marketplace add /Users/me/anthill")).toBeTruthy();
  });

  it("copies a command", async () => {
    stub();
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    open("Plugins");
    const command = await screen.findByText("claude plugin update anthill@anthill");
    fireEvent.click(within(command.parentElement!).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("claude plugin update anthill@anthill"));
    expect(await within(command.parentElement!).findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("reports the server the plugin launches", async () => {
    stub();
    open("Plugins");
    expect(await screen.findByText("Found")).toBeTruthy();
  });

  it("calls an unconfigured server the plugin's own, not a problem", async () => {
    const api = stub();
    api.pluginStatus.mockResolvedValue({ ...PLUGINS, server: { configured: false, settingsFile: "/Users/me/.anthill/plugin.json" } });
    open("Plugins");
    expect(await screen.findByText("Built into the plugin")).toBeTruthy();
    expect(screen.queryByText("Not configured")).toBeNull();
    expect(screen.getByText(/carries its own copy of Anthill's local MCP server/)).toBeTruthy();
  });
});
