/**
 * From a coding session: two tools, a real plugin card, and one complete
 * request with the task first and the command last.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginConnection } from "../../shared/ipc.js";

import { FromSessionScreen } from "./FromSessionScreen.js";

afterEach(cleanup);

function connection(harness: "claude-code" | "codex", over: Partial<PluginConnection> = {}): PluginConnection {
  const label = harness === "codex" ? "Codex" : "Claude Code";
  return {
    harness,
    label,
    cli: { available: true, version: harness === "codex" ? "0.153.4" : "2.1.278" },
    source: "/src/anthill",
    status: {
      harness,
      label,
      plugin: "anthill",
      toolFound: true,
      installed: false,
      enabled: false,
    },
    ...over,
  };
}

let api: {
  pluginConnections: ReturnType<typeof vi.fn>;
  pluginInstall: ReturnType<typeof vi.fn>;
  pluginGuide: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  api = {
    pluginConnections: vi.fn(async () => [connection("claude-code"), connection("codex", { cli: { available: false } })]),
    pluginInstall: vi.fn(async () => ({ ok: true })),
    pluginGuide: vi.fn(async () => undefined),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
});

const show = () => {
  const props = { onBack: vi.fn(), onSettings: vi.fn() };
  render(<FromSessionScreen {...props} />);
  return props;
};

const card = () => screen.getByRole("group", { name: /plugin$/ });

describe("the tools", () => {
  it("offers exactly Claude Code, Codex and VS Code, and calls Codex Codex", () => {
    show();
    const tabs = within(screen.getByRole("group", { name: "Coding tool" })).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Claude Code", "Codex", "VS Code"]);
    expect(document.body.textContent).not.toMatch(/OpenAI Codex CLI|Any other tool/);
  });

  it("switches the card and the request with the tab", async () => {
    show();
    await waitFor(() => expect(within(card()).getByText("Plugin not installed")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText("Use Anthill in Codex")).toBeTruthy();
    expect(within(card()).getByText("Not found")).toBeTruthy();
    fireEvent.click(within(card()).getByRole("button", { name: /Open install guide/ }));
    expect(api.pluginGuide).toHaveBeenCalledWith("codex");
  });

  // VS Code's agent lives in the editor: there is no terminal version to pick.
  it("shows VS Code in its app only, with the command its chat takes", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "VS Code" }));
    expect(screen.getByText("Use Anthill in VS Code")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Where you use it" })).toBeNull();
    expect(screen.getByText(/Agent mode, describe the task, then end with \/anthill:workflow design or watch/)).toBeTruthy();
  });
});

describe("installing from the card", () => {
  it("runs the install, then asks for a new session before calling it Ready", async () => {
    show();
    await waitFor(() => expect(within(card()).getByRole("button", { name: "Install for Claude Code" })).toBeTruthy());
    api.pluginConnections.mockResolvedValue([
      connection("claude-code", {
        status: { ...connection("claude-code").status, installed: true, enabled: true },
        serverAnswers: true,
      }),
      connection("codex"),
    ]);
    await act(async () => {
      fireEvent.click(within(card()).getByRole("button", { name: "Install for Claude Code" }));
    });
    expect(api.pluginInstall).toHaveBeenCalledWith("claude-code");
    await waitFor(() => expect(within(card()).getByText("Restart needed")).toBeTruthy());

    fireEvent.click(within(card()).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(within(card()).getByText("Ready")).toBeTruthy());
  });

  it("shows what the tool said when the install fails", async () => {
    api.pluginInstall.mockResolvedValue({ ok: false, changed: false, error: "Error: marketplace refused" });
    show();
    await waitFor(() => expect(within(card()).getByRole("button", { name: "Install for Claude Code" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(card()).getByRole("button", { name: "Install for Claude Code" }));
    });
    await waitFor(() => expect(within(card()).getByText("Install failed")).toBeTruthy());
    expect(within(card()).getByText("Error: marketplace refused")).toBeTruthy();
    expect(within(card()).getByText(/Nothing on your machine was changed/)).toBeTruthy();
  });
});

describe("the request", () => {
  it("puts the task first and the command last, in the app and in the terminal", () => {
    show();
    const demo = () => document.querySelector(".fs-demo")!.textContent ?? "";
    const order = (text: string, command: string) =>
      expect(text.indexOf("Build a checkout flow")).toBeLessThan(text.indexOf(command));
    order(demo(), "/anthill:workflow");
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByText(/Start claude, describe the task/)).toBeTruthy();
    order(demo(), "/anthill:workflow");

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText(/\$anthill design or \$anthill watch/)).toBeTruthy();
    order(demo(), "$anthill");
    fireEvent.click(screen.getByRole("button", { name: "App" }));
    expect(screen.getByText(/type @, pick Anthill/)).toBeTruthy();
    expect(screen.getByText("… @Anthill design")).toBeTruthy();
  });

  it("describes both modes and what happens after, without Ready for agent", () => {
    show();
    expect(screen.getByText("Design")).toBeTruthy();
    expect(screen.getByText("Watch")).toBeTruthy();
    expect(screen.getByText("Then, in Anthill")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Ready for agent");
    expect(screen.getByText(/never starts, stops or steers your agent/)).toBeTruthy();
  });

  it("goes back", () => {
    const { onBack } = show();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });
});
