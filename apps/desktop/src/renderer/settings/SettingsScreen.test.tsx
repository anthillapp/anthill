/**
 * Settings, as a page that owns itself.
 *
 * It was a modal with a card nested inside it, and the five problems the
 * review found were all one problem: nothing owned the page. The card brought
 * its own heading, its own two ways to close — one of which quietly did
 * something permanent under a neutral word — and a setting you change looked
 * exactly like a status you read.
 *
 * So most of these tests are about what the page refuses to contain.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ObservationHarnessSetup } from "../../shared/ipc.js";
import { PrivacyPage, SettingsScreen, type PageId } from "./SettingsScreen.js";

const HARNESS: ObservationHarnessSetup = {
  id: "claude-code" as const,
  label: "Claude Code",
  cliCommand: "claude",
  cliAvailable: true,
  version: "2.1.261",
  hookInstalled: true,
  hookEntriesPresent: true,
  hookLastEventAt: "2026-09-18T10:00:00.000Z",
  configPath: "~/.claude/settings.json",
  hookHandlerPath: "/Applications/Anthill.app/handler.js",
  installerAction: "Merge four hook entries",
  installCommand: "node handler.js",
  hookCommands: ["node handler.js PreToolUse"],
  eventCategories: ["Tool use", "Notification"],
  localDataBoundary: "Event metadata only.",
  changes: ["Adds four entries."],
};

function stub(
  over: {
    settings?: { stepNotifications: boolean };
    harnesses?: ObservationHarnessSetup[];
    probe?: { kind: "sent" } | { kind: "unsupported"; reason: string };
  } = {},
) {
  let stored = over.settings ?? { stepNotifications: false };
  const settingsWrite = vi.fn(async (patch: Partial<typeof stored>) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  const api = {
    settingsRead: vi.fn(async () => stored),
    settingsWrite,
    notificationsProbe: vi.fn(async () => over.probe ?? { kind: "sent" as const }),
    liveSetupStatus: vi.fn(async () => ({
      dismissed: false,
      trigger: "Shown after the first meaningful Workflow edit.",
      harnesses: over.harnesses ?? [HARNESS],
    })),
    liveSetupInstall: vi.fn(),
    liveSetupDisable: vi.fn(async () => ({
      ok: true as const,
      status: { dismissed: false, trigger: "", harnesses: [] },
      message: "Removed.",
    })),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return api;
}

/** Settings as it opens: on General, unless a test is about another page. */
const show = (onLeave = vi.fn(), initialPage?: PageId) => {
  render(<SettingsScreen onLeave={onLeave} {...(initialPage ? { initialPage } : {})} />);
  return { onLeave };
};

const page = (name: string) => screen.getByRole("button", { name });

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("the page owns itself", () => {
  it("has exactly one heading at the top of the outline", async () => {
    stub();
    show(undefined, "notifications");
    await waitFor(() => expect(screen.getAllByRole("switch")[0]).toBeTruthy());
    // One h1, and nothing nested brings a rival.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Notifications");
  });

  it("opens on General, in three groups: Anthill, Tools, Sessions", async () => {
    stub();
    show();
    await waitFor(() => expect(page("General").getAttribute("aria-current")).toBe("page"));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("General");
    const rail = screen.getByRole("navigation", { name: "Settings" });
    for (const group of ["Anthill", "Tools", "Sessions"]) expect(within(rail).getByText(group)).toBeTruthy();
    expect(within(rail).queryByText("Coding tools", { selector: "span:not(.label)" })).toBeNull();
  });

  it("keeps a quiet coffee link in the rail's footer, opening the support page by name", async () => {
    const api = stub() as ReturnType<typeof stub> & { openLink?: ReturnType<typeof vi.fn> };
    api.openLink = vi.fn(async () => undefined);
    show();
    const rail = screen.getByRole("navigation", { name: "Settings" });
    fireEvent.click(within(rail).getByRole("button", { name: "Buy me a coffee" }));
    expect(api.openLink).toHaveBeenCalledWith("support");
  });

  it("offers exactly one way out", async () => {
    stub();
    const { onLeave } = show();
    await waitFor(() => expect(screen.getByLabelText("Back to Anthill")).toBeTruthy());
    // No ✕, no Close, and above all no "Not now" — a neutral word on a
    // control that dismissed the prompt for good.
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "✕" })).toBeNull();

    fireEvent.click(screen.getByLabelText("Back to Anthill"));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("marks the page you are on, and moves when you move", async () => {
    stub();
    show();
    await waitFor(() => expect(page("General")).toBeTruthy());
    expect(page("General").getAttribute("aria-current")).toBe("page");

    fireEvent.click(page("About"));
    await act(async () => undefined);
    expect(page("About").getAttribute("aria-current")).toBe("page");
    expect(page("General").getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("About");
  });

  it("narrows the rail to what you searched for", async () => {
    stub();
    show();
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "obs" } });
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
    expect(page("Live observation")).toBeTruthy();
  });
});

/**
 * General: desktop Save writes into the configured folder automatically.
 */
describe("the General page", () => {
  it("shows the default folder, and keeps the one chosen in the dialog", async () => {
    const api = stub() as ReturnType<typeof stub> & { chooseWorkflowFolder?: ReturnType<typeof vi.fn> };
    api.chooseWorkflowFolder = vi.fn(async () => ({ workflowFolder: "/Users/me/work/flows" }));
    show();
    expect(await screen.findByText("~/Documents/Anthill")).toBeTruthy();
    expect(screen.getByText(/saved here as soon as it has a name/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    expect(await screen.findByText("/Users/me/work/flows")).toBeTruthy();
    expect(api.chooseWorkflowFolder).toHaveBeenCalledTimes(1);
  });

  it("leaves the folder alone when the dialog is cancelled", async () => {
    const api = stub() as ReturnType<typeof stub> & { chooseWorkflowFolder?: ReturnType<typeof vi.fn> };
    api.chooseWorkflowFolder = vi.fn(async () => null);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Change…" }));
    await waitFor(() => expect(api.chooseWorkflowFolder).toHaveBeenCalled());
    expect(screen.getByText("~/Documents/Anthill")).toBeTruthy();
  });

  it("offers no change in the CLI, which saves into its workspace", async () => {
    const api = stub() as ReturnType<typeof stub> & { capabilities?: ReturnType<typeof vi.fn> };
    api.capabilities = vi.fn(async () => ({ contract: 24, channels: [], shell: "cli" }));
    show();
    expect(await screen.findByText(/saves new workflows into the workspace/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change…" })).toBeNull();
  });
});

describe("the About page", () => {
  it("opens each listed page by name", async () => {
    stub();
    const openLink = vi.fn(async () => undefined);
    (window.anthill as unknown as { openLink: typeof openLink }).openLink = openLink;
    show();
    fireEvent.click(page("About"));
    for (const [text, name] of [
      ["github.com/anthillapp/anthill", "source"],
      ["r/AnthillApp", "community"],
      ["getanthill.ai", "website"],
      ["Buy me a coffee", "support"],
    ]) {
      // In the page, not the rail, which has a coffee link of its own.
      const body = document.querySelector(".settings-body") as HTMLElement;
      fireEvent.click(await within(body).findByRole("button", { name: text }));
      expect(openLink).toHaveBeenLastCalledWith(name);
    }
    expect(screen.queryByText(/Nothing here is sent anywhere/)).toBeNull();
  });

  // ANT-189: About said diagnostics were off until turned on, while Privacy
  // shows them on by default. It now says what Privacy says.
  it("does not claim diagnostics are off until turned on", async () => {
    stub();
    show();
    fireEvent.click(page("About"));
    expect(await screen.findByText(/Anonymous diagnostics can be turned off under Privacy/)).toBeTruthy();
    expect(screen.queryByText(/unless you turn it on/)).toBeNull();
  });

  // ANT-154: the product's statement of scope, on every platform, and the
  // way to report a Windows problem.
  it("says where Anthill runs, and links the Windows issue form", async () => {
    stub();
    const openLink = vi.fn(async () => undefined);
    (window.anthill as unknown as { openLink: typeof openLink }).openLink = openLink;
    show();
    fireEvent.click(page("About"));
    expect(
      await screen.findByText(
        "macOS: desktop app and CLI. Linux: CLI. Windows support is coming soon – building from source is possible for experimentation, but Windows is not yet officially supported and some features may not work.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Report a Windows issue" }));
    expect(openLink).toHaveBeenLastCalledWith("windowsIssue");
  });
});

describe("privacy controls", () => {
  it("cannot be turned on outside the release build", async () => {
    const api = stub();
    show();
    fireEvent.click(page("Privacy"));
    const analytics = await screen.findByRole("switch", { name: "Anonymous product analytics" });
    await waitFor(() => expect(api.settingsRead).toHaveBeenCalled());
    fireEvent.click(analytics);
    expect(api.settingsWrite).not.toHaveBeenCalled();
    expect(screen.getByText(/This build never sends diagnostics/)).toBeTruthy();
  });

  it("offers no native crash reports in the CLI's browser page", async () => {
    const api = stub();
    (api as unknown as { capabilities: () => Promise<unknown> }).capabilities = async () => ({ contract: 0, channels: [], shell: "cli" });
    render(<PrivacyPage available />);
    await screen.findByText(/never from this page/);
    expect(screen.queryByRole("switch", { name: "Native crash reports" })).toBeNull();
  });

  // ANT-156: the public description of what is collected, and how to get a
  // new identifier.
  it("links the privacy notes by name, and says how to get a new identifier", async () => {
    const api = stub();
    const openLink = vi.fn(async () => undefined);
    (api as unknown as { openLink: typeof openLink }).openLink = openLink;
    render(<PrivacyPage available />);
    fireEvent.click(await screen.findByRole("button", { name: "Read the privacy notes" }));
    expect(openLink).toHaveBeenCalledWith("privacy");
    expect(screen.getByText(/turning it back on starts a new one/)).toBeTruthy();
  });

  it("starts with sharing off and writes analytics consent only after a click", async () => {
    const api = stub();
    render(<PrivacyPage available />);
    const analytics = await screen.findByRole("switch", { name: "Anonymous product analytics" });
    expect(analytics.getAttribute("aria-checked")).toBe("false");
    expect(api.settingsWrite).not.toHaveBeenCalled();
    fireEvent.click(analytics);
    await waitFor(() => expect(api.settingsWrite).toHaveBeenCalledWith({ analyticsEnabled: true }));
  });
});

describe("the notification setting", () => {
  /** The first switch: a step starting, the one that existed before the others. */
  const theSwitch = () => screen.getAllByRole("switch")[0];

  it("is a switch rather than a checkbox, so the global input rule cannot stretch it", async () => {
    stub();
    show(undefined, "notifications");
    await waitFor(() => expect(theSwitch()).toBeTruthy());
    expect(theSwitch().tagName).toBe("BUTTON");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  // ANT-132: one switch per moment, each asked for on its own.
  it("offers one switch per kind of moment, each writing its own preference", async () => {
    const api = stub();
    show(undefined, "notifications");
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(6));
    fireEvent.click(screen.getByRole("switch", { name: "A loop comes back round" }));
    await waitFor(() => expect(api.settingsWrite).toHaveBeenCalledWith({ loopNotifications: true }));
    fireEvent.click(screen.getByRole("switch", { name: "The session finishes or fails" }));
    await waitFor(() =>
      expect(api.settingsWrite).toHaveBeenCalledWith({ finishedNotifications: true }),
    );
  });

  it("shows what is stored and writes what is changed", async () => {
    const api = stub();
    show(undefined, "notifications");
    await waitFor(() => expect(theSwitch().getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(theSwitch());
    await waitFor(() => expect(api.settingsWrite).toHaveBeenCalledWith({ stepNotifications: true }));
    expect(theSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("asks about macOS permission only once something would be sent", async () => {
    // A permission row while nothing would be sent is a question nobody asked.
    stub();
    show(undefined, "notifications");
    await waitFor(() => expect(theSwitch()).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Send a test" })).toBeNull();

    fireEvent.click(theSwitch());
    await waitFor(() => expect(screen.getByRole("button", { name: "Send a test" })).toBeTruthy());
    expect(screen.getByText(/System Settings ▸ Notifications ▸ Anthill/)).toBeTruthy();
  });

  it("names the likely culprit honestly when a test is sent", async () => {
    stub({ settings: { stepNotifications: true } });
    show(undefined, "notifications");
    fireEvent.click(await screen.findByRole("button", { name: "Send a test" }));
    expect(
      await screen.findByText(/macOS is holding it back rather than Anthill/),
    ).toBeTruthy();
  });

  it("drops a stale test result when the switch is turned off", async () => {
    stub({ settings: { stepNotifications: true } });
    show(undefined, "notifications");
    fireEvent.click(await screen.findByRole("button", { name: "Send a test" }));
    await screen.findByText(/macOS is holding it back/);
    fireEvent.click(theSwitch());
    await waitFor(() => expect(screen.queryByText(/macOS is holding it back/)).toBeNull());
  });
});

describe("live observation", () => {
  const observation = async () => {
    stub();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Live observation" }));
    return screen.findByRole("button", { name: "Review setup" });
  };

  it("brings no heading of its own – the page already has one", async () => {
    await observation();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Live observation");
    expect(screen.queryByText(/Enable local hooks for honest/)).toBeNull();
  });

  it("says nothing about a trigger, because nothing triggered it", async () => {
    await observation();
    expect(screen.queryByText(/^Trigger:/)).toBeNull();
    expect(screen.queryByText(/first meaningful Workflow edit/)).toBeNull();
  });

  it("offers one action per harness, and it is the one that only reads", async () => {
    const review = await observation();
    expect(review.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Disable/ })).toBeNull();
  });

  it("keeps the destructive action inside the detail, named in full", async () => {
    // A destructive action should cost a deliberate step and never sit as a
    // peer of a read action.
    const review = await observation();
    fireEvent.click(review);
    expect(review.getAttribute("aria-expanded")).toBe("true");
    const disable = screen.getByRole("button", { name: "Disable hooks for Claude Code" });
    expect(disable.className).toContain("set-btn-danger");
    expect(screen.getByText("Observation falls back to session records.")).toBeTruthy();
  });

  it("reports a harness rather than offering one", async () => {
    await observation();
    // A chip you read, and the word carries it — never colour alone.
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("does not guess Codex permissions from missing hook events", async () => {
    stub({
      harnesses: [
        { ...HARNESS, id: "codex", label: "Codex CLI", hookLastEventAt: undefined },
      ],
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Live observation" }));
    expect(await screen.findByText("Not verified")).toBeTruthy();
    expect(screen.queryByText(/has never called it/)).toBeNull();
  });

  it("says so plainly when there is no CLI to report on", async () => {
    stub({ harnesses: [] });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Live observation" }));
    expect(await screen.findByText(/No supported CLI was found/)).toBeTruthy();
  });
});

describe("about", () => {
  it("says which version this is", async () => {
    stub();
    show();
    fireEvent.click(page("About"));
    const group = screen.getByText("Version").closest(".set-row") as HTMLElement;
    expect(within(group).getByText(__ANTHILL_VERSION__)).toBeTruthy();
    // A shell without an updater still says where new versions come from (ANT-76).
    expect(await screen.findByRole("button", { name: "Releases on GitHub" })).toBeTruthy();
    await act(async () => undefined);
  });
});

/**
 * A preference the disk refused (ANT-97).
 *
 * Main used to swallow the write failure and answer with the new settings, so
 * a switch the disk had rejected looked accepted until the next launch and
 * then quietly went back. Main now raises; this is the screen's half.
 */
it("says a preference was not saved, and leaves the switch where it is", async () => {
  const api = stub();
  api.settingsWrite = vi.fn(async () => {
    throw new Error("ENOSPC: no space left on device");
  });
  const theSwitch = () => screen.getAllByRole("switch")[0];
  show(undefined, "notifications");
  await waitFor(() => expect(theSwitch().getAttribute("aria-checked")).toBe("false"));

  fireEvent.click(theSwitch());

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("not saved");
  expect(alert.textContent).toContain("ENOSPC");
  // The switch reports storage, not intent.
  expect(theSwitch().getAttribute("aria-checked")).toBe("false");
});
