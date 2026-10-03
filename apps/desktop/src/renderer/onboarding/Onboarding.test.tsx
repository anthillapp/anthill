/**
 * Onboarding (ANT-140): exactly two pages, Skip always there, the plugin cards
 * reporting what is really on this Mac, and Continue only once a tool is really
 * connected.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Onboarding } from "./Onboarding.js";

afterEach(cleanup);

function connection(harness: "claude-code" | "codex" | "vscode", over: Record<string, unknown> = {}) {
  const label = { "claude-code": "Claude Code", codex: "Codex", vscode: "VS Code" }[harness];
  return {
    harness,
    label,
    cli: { available: true, version: "1.0" },
    source: "/src/anthill",
    status: { harness, label, plugin: "anthill", toolFound: true, installed: false, enabled: false },
    ...over,
  };
}

let api: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  api = {
    pluginConnections: vi.fn(async () => [
      connection("claude-code"),
      connection("codex", { cli: { available: false } }),
      connection("vscode"),
    ]),
    pluginInstall: vi.fn(async () => ({ ok: true })),
    pluginGuide: vi.fn(async () => undefined),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
});

const show = () => {
  const props = { onFinish: vi.fn(), onSettings: vi.fn() };
  render(<Onboarding {...props} />);
  return props;
};

describe("the welcome page", () => {
  it("states the benefit without thanking anyone, and shows a workflow being drawn", () => {
    show();
    expect(screen.getByRole("heading", { name: "Welcome to Anthill" })).toBeTruthy();
    expect(screen.getByText("See your workflows take shape, as clearly as if you sketched them on paper.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/thank/i);
    // A real workflow's shape: its steps, its agents, and the rework path.
    for (const text of ["Start", "Implement", "Run tests", "Fix failures", "Done", "Developer", "Tester", "tests failed"]) {
      expect(document.querySelector(".ob-canvas")!.textContent).toContain(text);
    }
    expect(document.querySelector(".ob-ptr")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Step 1 of 2" })).toBeTruthy();
  });

  it("moves focus to the page it opens", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(document.activeElement?.textContent).toBe("Connect Codex, Claude Code or VS Code");
    expect(screen.getByRole("img", { name: "Step 2 of 2" })).toBeTruthy();
  });
});

describe("the connect page", () => {
  const toConnect = () => {
    const props = show();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    return props;
  };
  const card = (label: string) => screen.getByRole("group", { name: `${label} plugin` });

  it("is optional, offers each tool separately, and reports what it found", async () => {
    toConnect();
    expect(screen.getByText("Optional")).toBeTruthy();
    await waitFor(() => expect(within(card("Claude Code")).getByRole("button", { name: "Install for Claude Code" })).toBeTruthy());
    expect(within(card("Codex")).getByText("Not found")).toBeTruthy();
    expect(screen.getByText(/You can add any of them later from Settings ▸ Plugins/)).toBeTruthy();
    // VS Code installs from its own links, which the card opens.
    expect(within(card("VS Code")).getByRole("button", { name: "Install for VS Code" })).toBeTruthy();
  });

  it("installs through the card", async () => {
    toConnect();
    const install = await within(card("Claude Code")).findByRole("button", { name: "Install for Claude Code" });
    await act(async () => {
      fireEvent.click(install);
    });
    expect(api.pluginInstall).toHaveBeenCalledWith("claude-code");
  });

  it("can always be skipped, and goes back", async () => {
    const props = toConnect();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Welcome to Anthill" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(props.onFinish).toHaveBeenCalled();
  });

  it("offers Continue once a tool really answers, and still lets you skip", async () => {
    api.pluginConnections.mockResolvedValue([
      connection("claude-code", { status: { ...connection("claude-code").status, installed: true, enabled: true }, serverAnswers: true }),
      connection("codex"),
    ]);
    const props = toConnect();
    await waitFor(() => expect(within(card("Claude Code")).getByText("Ready")).toBeTruthy());
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toContain("Skip for now");
    fireEvent.click(screen.getAllByRole("button", { name: "Continue" }).at(-1)!);
    expect(props.onFinish).toHaveBeenCalled();
  });

  it("has no Continue while nothing is connected", async () => {
    toConnect();
    await waitFor(() => expect(within(card("Claude Code")).getByText("Plugin not installed")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});
