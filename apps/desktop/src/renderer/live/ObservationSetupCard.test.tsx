import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MarkerCli, ObservationSetupActionResult, ObservationSetupStatus } from "../../shared/ipc.js";

import { ObservationSetupCard } from "./ObservationSetupCard.js";

function status(overrides: Partial<ObservationSetupStatus> = {}): ObservationSetupStatus {
  return {
    dismissed: false,
    trigger: "Shown after the first meaningful Workflow edit: a workflow is open and the edit makes it unsaved.",
    harnesses: [
      {
        id: "claude-code",
        label: "Claude Code",
        cliCommand: "claude",
        cliAvailable: true,
        version: "1.0.0",
        hookInstalled: false,
        hookEntriesPresent: false,
        configPath: "/tmp/home/.claude/settings.json",
        hookHandlerPath: "/tmp/anthill/live-hook-handler.js",
        installerAction:
          "No shell installer command is run. Anthill backs up and merges Anthill-owned hook entries after Enable.",
        installCommand: 'node "/tmp/anthill/live-hook-handler.js" anthill-observation-hook claude-code SessionStart',
        hookCommands: [
          'node "/tmp/anthill/live-hook-handler.js" anthill-observation-hook claude-code SessionStart',
          'node "/tmp/anthill/live-hook-handler.js" anthill-observation-hook claude-code PreToolUse',
        ],
        eventCategories: ["Session start", "Tool start"],
        localDataBoundary: "Events remain local. MCP is optional and not required.",
        changes: ["Back up config before changing it.", "Do not start, attach to, stop, or steer any session."],
      },
      {
        id: "codex",
        label: "Codex CLI",
        cliCommand: "codex",
        cliAvailable: false,
        reason: "Codex CLI was not found on your PATH.",
        hookInstalled: false,
        hookEntriesPresent: false,
        configPath: "/tmp/home/.codex/hooks.json",
        hookHandlerPath: "/tmp/anthill/live-hook-handler.js",
        installerAction:
          "No shell installer command is run. Anthill backs up and merges Anthill-owned hook entries after Enable.",
        installCommand: 'node "/tmp/anthill/live-hook-handler.js" anthill-observation-hook codex SessionStart',
        hookCommands: [
          'node "/tmp/anthill/live-hook-handler.js" anthill-observation-hook codex SessionStart',
        ],
        eventCategories: ["Session start"],
        localDataBoundary: "Events remain local.",
        changes: ["Back up config before changing it."],
      },
    ],
    ...overrides,
  };
}

function stub(initial: ObservationSetupStatus) {
  let current = initial;
  const api = {
    liveSetupStatus: vi.fn(async () => current),
    liveSetupDismiss: vi.fn(async () => {
      current = { ...current, dismissed: true };
      return current;
    }),
    liveSetupInstall: vi.fn(async (harness: MarkerCli): Promise<ObservationSetupActionResult> => {
      current = {
        ...current,
        dismissed: true,
        harnesses: current.harnesses.map((item) =>
          item.id === harness ? { ...item, hookInstalled: true } : item,
        ),
      };
      return { ok: true, status: current, message: `${harness} enabled` };
    }),
    liveSetupDisable: vi.fn(async (harness: MarkerCli): Promise<ObservationSetupActionResult> => {
      current = {
        ...current,
        dismissed: true,
        harnesses: current.harnesses.map((item) =>
          item.id === harness ? { ...item, hookInstalled: false } : item,
        ),
      };
      return { ok: true, status: current, message: `${harness} disabled` };
    }),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return api;
}

afterEach(() => {
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("local observation setup card", () => {
  it("stays hidden until a first meaningful Workflow edit or explicit reopen", async () => {
    const api = stub(status());
    render(<ObservationSetupCard firstMeaningfulEdit={false} forceOpen={false} onClose={() => undefined} />);

    await waitFor(() => expect(api.liveSetupStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Live observation setup")).toBeNull();
  });

  it("appears after the first meaningful Workflow edit and shows only installed local CLIs", async () => {
    stub(status());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    expect(await screen.findByText("Enable local hooks for honest Live Session progress")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.queryByText("Codex CLI")).toBeNull();
    expect(screen.getByText(/first meaningful Workflow edit/)).toBeTruthy();
  });

  it("persists Not now and closes without installing anything", async () => {
    const api = stub(status());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));

    await waitFor(() => expect(api.liveSetupDismiss).toHaveBeenCalledTimes(1));
    expect(api.liveSetupInstall).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Live observation setup")).toBeNull();
  });

  it("shows the exact review details before enabling hooks", async () => {
    stub(status());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review setup" }));

    expect(screen.getByText("/tmp/home/.claude/settings.json")).toBeTruthy();
    expect(screen.getByText("/tmp/anthill/live-hook-handler.js")).toBeTruthy();
    expect(screen.getByText(/No shell installer command is run/)).toBeTruthy();
    expect(screen.getByText(/claude-code PreToolUse/)).toBeTruthy();
    expect(screen.getByText("Tool start")).toBeTruthy();
    expect(screen.getAllByText(/MCP is optional/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Do not start, attach to, stop, or steer any session/)).toBeTruthy();
  });

  it("does not write setup until the explicit Enable action is clicked", async () => {
    const api = stub(status());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review setup" }));
    expect(api.liveSetupInstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Enable for Claude Code" }));

    await waitFor(() => expect(api.liveSetupInstall).toHaveBeenCalledWith("claude-code"));
    expect(screen.getByText("claude-code enabled")).toBeTruthy();
  });

  it("offers no runner, attach, listen, or watch controls", async () => {
    stub(status());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    await screen.findByLabelText("Live observation setup");
    const labels = [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
    for (const forbidden of ["Start", "Run ", "Attach", "Listen", "Watch", "Join"]) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
  });

  it("can be reopened later even when dismissed and no supported CLI is available", async () => {
    stub(status({ dismissed: true, harnesses: status().harnesses.map((item) => ({ ...item, cliAvailable: false })) }));
    render(<ObservationSetupCard firstMeaningfulEdit={false} forceOpen onClose={() => undefined} />);

    expect(await screen.findByText(/No supported local CLI was found/)).toBeTruthy();
  });
});

/**
 * Three states, because there were always three.
 *
 * ANT-23. The card had a boolean: Enabled or Available. A harness whose every
 * hook had been failing since installation sat under a green Enabled chip,
 * which is the one state it was not in. What the config says and what the
 * harness can run are different facts, and the card now shows both.
 */
describe("a harness whose hooks are installed and not running", () => {
  const broken = () =>
    status({
      harnesses: status().harnesses.map((item) =>
        item.id === "claude-code"
          ? {
              ...item,
              hookInstalled: false,
              hookEntriesPresent: true,
              hookProblem:
                "The hook command exited with 127: sh: node: command not found. Re-enable observation to rewrite the hook entries.",
            }
          : item,
      ),
    });

  it("does not call itself enabled", async () => {
    stub(broken());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    await screen.findByText("Claude Code");
    expect(screen.queryByText("Enabled")).toBeNull();
    expect(screen.getByText("Not working")).toBeTruthy();
  });

  it("says what went wrong, and what still works meanwhile", async () => {
    stub(broken());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    expect(await screen.findByText(/node: command not found/)).toBeTruthy();
    expect(screen.getByText(/session records only/)).toBeTruthy();
  });

  it("offers to repair rather than to enable, since the entries already exist", async () => {
    const api = stub(broken());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review setup" }));
    expect(screen.queryByRole("button", { name: "Enable for Claude Code" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Repair Claude Code hooks" }));
    await waitFor(() => expect(api.liveSetupInstall).toHaveBeenCalledWith("claude-code"));
  });

  it("keeps Disable reachable, because there is something installed to remove", async () => {
    stub(broken());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    expect(await screen.findByRole("button", { name: "Disable Anthill hooks" })).toBeTruthy();
  });

  it("comes back on its own: a broken install is unfinished setup", async () => {
    // Dismissal is a "not now" about a decision the user has not made. A
    // harness that is failing has not finished being set up, so the card is
    // due again on the next meaningful edit.
    stub(broken());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);
    expect(await screen.findByLabelText("Live observation setup")).toBeTruthy();
  });
});

describe("a harness whose hooks were never installed", () => {
  it("shows Available, offers Enable, and has nothing to disable", async () => {
    stub(status());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);

    await screen.findByText("Claude Code");
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disable Anthill hooks" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(screen.getByRole("button", { name: "Enable for Claude Code" })).toBeTruthy();
  });
});

describe("a harness whose hooks run", () => {
  it("shows Enabled, explains no problem, and offers no repair", async () => {
    stub(
      status({
        harnesses: status().harnesses.map((item) =>
          item.id === "claude-code"
            ? {
                ...item,
                hookInstalled: true,
                hookEntriesPresent: true,
                // Enabled is a claim about delivery, so it takes an event.
                hookLastEventAt: "2026-09-04T11:00:00.000Z",
              }
            : item,
        ),
      }),
    );
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen onClose={() => undefined} />);

    await screen.findByText("Claude Code");
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(document.querySelector(".setup-problem")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(screen.queryByRole("button", { name: /Repair|Enable for/ })).toBeNull();
  });
});


/**
 * ANT-42. Hooks that run when Anthill calls them, in a config the harness
 * never reads. Every other check passes and nothing arrives.
 */
describe("a harness whose hooks have never fired", () => {
  const silent = (installedAt = "2026-09-01T10:00:00.000Z") =>
    status({
      harnesses: status().harnesses.map((item) =>
        item.id === "claude-code"
          ? {
              ...item,
              hookInstalled: true,
              hookEntriesPresent: true,
              hookInstalledAt: installedAt,
            }
          : item,
      ),
    });

  it("does not read as Enabled", async () => {
    stub(silent());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen onClose={() => undefined} />);

    await screen.findByText("Claude Code");
    expect(screen.getByText("Not seen firing")).toBeTruthy();
    expect(screen.queryByText("Enabled")).toBeNull();
  });

  it("is worded apart from a command that fails", async () => {
    stub(silent());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen onClose={() => undefined} />);

    await screen.findByText("Claude Code");
    // Not the red "installed and not running" paragraph: nothing is broken.
    expect(document.querySelector(".setup-problem")).toBeNull();
    const said = document.querySelector(".setup-quiet-problem")?.textContent ?? "";
    expect(said).toContain("has never called it");
    expect(said).toContain("may simply be how this build works");
  });

  it("says what still works, and what does not", async () => {
    stub(silent());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen onClose={() => undefined} />);

    await screen.findByText("Claude Code");
    const said = document.querySelector(".setup-quiet-problem")?.textContent ?? "";
    expect(said).toContain("session records");
    expect(said).toContain("baseline");
    expect(said).toContain("permission and notification events");
  });

  it("gives the silence a length", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    stub(silent(threeDaysAgo));
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen onClose={() => undefined} />);

    await screen.findByText("Claude Code");
    expect(document.querySelector(".setup-quiet-problem")?.textContent).toContain("3 days");
  });

  it("offers nothing to repair, because nothing here is broken", async () => {
    stub(silent());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen onClose={() => undefined} />);

    await screen.findByText("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(screen.queryByRole("button", { name: /Repair|Enable for/ })).toBeNull();
  });

  it("does not reopen the card on its own the way a broken install does", async () => {
    // A broken install is unfinished setup. This may be permanent and correct,
    // and nagging about it every session would be nagging about nothing.
    stub(silent());
    render(<ObservationSetupCard firstMeaningfulEdit forceOpen={false} onClose={() => undefined} />);
    await waitFor(() => expect(window.anthill.liveSetupStatus).toHaveBeenCalled());
    expect(document.querySelector(".observation-setup")).toBeNull();
  });
});
