/**
 * What the header indicator is allowed to say.
 *
 * Mostly negative assertions, because the risk here is not a missing label — it
 * is a label that implies Anthill is running or can stop someone's session.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingRun } from "@anthill/live";
import type { LiveSnapshot } from "../../shared/ipc.js";

import { LiveIndicator } from "./LiveIndicator.js";

function run(partial: Partial<PendingRun> = {}): PendingRun {
  return {
    anthillRunId: "ANT-1A2B3C4D",
    correlationNonce: "9f8e7d",
    selectedCli: "claude-code",
    promptVersion: "1",
    bootstrapPromptHash: "abcd1234",
    createdAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T10:30:00.000Z",
    workflowName: "Read the note",
    // The canvas only speaks for runs started from the workflow it is on, so
    // every fixture belongs to the one the indicator is rendered for.
    workflowId: "w1",
    state: "pending_after_copy",
    ...partial,
  };
}

function stub(snapshot: LiveSnapshot) {
  const api = {
    liveSnapshot: vi.fn(async () => snapshot),
    onLiveSnapshot: vi.fn(() => () => undefined),
    liveCancel: vi.fn(async () => ({ runs: [], capabilities: [] })),
    liveDismiss: vi.fn(async () => ({ runs: [], capabilities: [] })),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return api;
}

async function show(
  runs: PendingRun[],
  capabilities: LiveSnapshot["capabilities"] = [],
  onOpenSession?: (run: PendingRun) => void,
) {
  const api = stub({ runs, capabilities });
  render(
    onOpenSession ? (
      <LiveIndicator workflowId="w1" onOpenSession={onOpenSession} />
    ) : (
      <LiveIndicator workflowId="w1" />
    ),
  );
  await waitFor(() => expect(api.liveSnapshot).toHaveBeenCalledTimes(1));
  if (runs.length > 0) await screen.findByRole("button");
  return api;
}

/** What the one chip currently says. */
function chipLabel(): string {
  return (document.querySelector(".presence-label") as HTMLElement | null)?.textContent ?? "";
}

afterEach(() => {
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("what the indicator shows", () => {
  it("shows nothing at all when no prompt has been copied", async () => {
    await show([]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("waits, without claiming anything, after a copy", async () => {
    await show([run()]);
    expect(chipLabel()).toBe("Waiting for a session");
  });

  it("pulses only for a session it actually found", async () => {
    await show([run({ state: "detected_live", detectedSessionId: "sess-1", confidence: "strong" })]);
    // One breathing border is the whole "this is live" vocabulary.
    expect(document.querySelector(".presence-ring.chip-breathe")).toBeTruthy();
    expect(document.querySelector(".presence-dot.dot-pulse")).toBeTruthy();
    expect(chipLabel()).toContain("Live");
  });

  it("never draws an ambiguous match like a live one", async () => {
    await show([run({ state: "ambiguous_match", confidence: "medium" })]);
    expect(chipLabel()).toBe("Ambiguous session");
    expect(document.querySelector(".presence-ring.chip-breathe")).toBeNull();
  });

  it("says observation was lost rather than pretending to still know", async () => {
    await show([run({ state: "observation_lost", detectedSessionId: "sess-1" })]);
    expect(screen.getByText("Observation lost")).toBeTruthy();
  });

  it("distinguishes a failed session from one that was never found", async () => {
    await show([run({ state: "failed" })]);
    expect(chipLabel()).toBe("No session detected");
  });

  it("puts the live run in the header when several are open", async () => {
    await show([
      run({ anthillRunId: "ANT-A", state: "failed" }),
      run({ anthillRunId: "ANT-B", state: "detected_live", detectedSessionId: "sess-1" }),
    ]);
    expect(chipLabel()).toContain("Live");
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("prefers a session that just finished over one it gave up on an hour ago", async () => {
    // A result outranks the absence of one. Ranking "completed" below
    // "observation lost" put an hour-old dead run in the header and left the
    // run that had just finished unreachable.
    await show([
      run({
        anthillRunId: "ANT-OLDLOST",
        state: "observation_lost",
        createdAt: "2026-08-29T09:00:00.000Z",
        workflowName: "Gave up on this one",
      }),
      run({
        anthillRunId: "ANT-JUSTDONE",
        state: "completed",
        detectedSessionId: "sess-1",
        createdAt: "2026-08-29T10:00:00.000Z",
        workflowName: "Finished just now",
      }),
    ]);
    expect(chipLabel()).toContain("Session finished");
  });

  it("reflects the newest run when several are in the same state", async () => {
    await show([
      run({
        anthillRunId: "ANT-OLD",
        workflowName: "An older workflow",
        createdAt: "2026-08-29T09:00:00.000Z",
      }),
      run({
        anthillRunId: "ANT-NEW",
        workflowName: "The one just copied",
        createdAt: "2026-08-29T10:00:00.000Z",
      }),
    ]);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("ANT-NEW")).toBeTruthy();
    expect(screen.queryByText("ANT-OLD")).toBeNull();
  });
});

describe("opening the live session page", () => {
  it("navigates from a live session instead of opening the popover", async () => {
    const open = vi.fn();
    await show([run({ state: "detected_live", detectedSessionId: "sess-1" })], [], open);

    fireEvent.click(screen.getByRole("button"));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ anthillRunId: "ANT-1A2B3C4D" }),
      undefined,
    );
    expect(document.querySelector(".live-popover")).toBeNull();
  });

  it("navigates from a session that finished, because there is a record to read", async () => {
    // The run is over, but the CLI recorded that its turn ended and the journal
    // holds the whole of it. Refusing to open it left the author watching a
    // session live and then locked out of it the moment it finished.
    const open = vi.fn();
    await show([run({ state: "completed", detectedSessionId: "sess-1" })], [], open);

    fireEvent.click(screen.getByRole("button"));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ anthillRunId: "ANT-1A2B3C4D" }),
      undefined,
    );
    expect(document.querySelector(".live-popover")).toBeNull();
  });

  it("opens the popover for every state that is not a confident match", async () => {
    for (const state of ["pending_after_copy", "ambiguous_match", "observation_lost", "failed"] as const) {
      const open = vi.fn();
      await show([run({ state })], [], open);
      fireEvent.click(screen.getAllByRole("button")[0]);
      // There is no page worth opening for a session Anthill is not observing.
      expect(open).not.toHaveBeenCalled();
      expect(document.querySelector(".live-popover")).toBeTruthy();
      cleanup();
    }
  });
});

describe("what the indicator refuses to offer", () => {
  it("has no start, run, attach, listen, or watch control", async () => {
    await show([run({ state: "detected_live", detectedSessionId: "sess-1" })]);
    fireEvent.click(screen.getByRole("button"));
    const labels = [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
    for (const forbidden of ["Start", "Run", "Attach", "Listen", "Join", "Watch", "Stop session"]) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
  });

  it("offers only to stop observing in Anthill, and says the session continues unchanged", async () => {
    const api = await show([run({ state: "detected_live", detectedSessionId: "sess-1" })]);
    fireEvent.click(screen.getByRole("button", { name: /Live/ }));

    const stop = screen.getByRole("button", { name: "Stop observing in Anthill" });
    expect(stop.getAttribute("title")).toContain("Only Anthill stops observing this workflow");
    expect(stop.getAttribute("title")).toContain("session continues unchanged");
    fireEvent.click(stop);
    await waitFor(() => expect(api.liveCancel).toHaveBeenCalledWith("ANT-1A2B3C4D"));
  });

  it("states plainly that Anthill is not running the session", async () => {
    await show([run({ state: "detected_live", detectedSessionId: "sess-1" })]);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/Anthill is not running this session/)).toBeTruthy();
    expect(screen.getByText(/never the model's private reasoning/)).toBeTruthy();
  });

  it("marks a low-confidence match as a guess in the detail", async () => {
    await show([
      run({ state: "ambiguous_match", confidence: "weak", evidenceChannel: "claude-code:transcript" }),
    ]);
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector(".conf-weak")).toBeTruthy();
  });

  it("repeats a CLI's own limits instead of hiding them", async () => {
    await show(
      [run({ state: "pending_after_copy" })],
      [
        {
          cli: "claude-code",
          available: false,
          root: "/home/x/.claude/projects",
          note: "Claude Code has written no local sessions on this machine, so there is nothing to read.",
          reportsCompletion: true,
          reportsFailure: false,
        },
      ],
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/no local sessions on this machine/)).toBeTruthy();
  });
});
