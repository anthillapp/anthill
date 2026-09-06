/**
 * The announcement, and the reason it is allowed to interrupt at all.
 *
 * A modal takes someone off what they were doing, so the bar for showing one
 * is the strongest evidence Anthill has: the session's own records carry the
 * marker. A match Anthill is unsure of never earns that, and neither does a
 * session it has lost — those stay in the chip, where a reader goes looking
 * rather than being pulled.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LiveSessionState, PendingRun } from "@anthill/live";

import {
  forgetAnnouncements,
  markAnnounced,
  SessionStartedDialog,
  shouldAnnounce,
} from "./SessionStartedDialog.js";

function run(state: LiveSessionState, detectedSessionId?: string): PendingRun {
  return {
    anthillRunId: "ANT-1A2B3C4D",
    correlationNonce: "9f8e7d",
    selectedCli: "claude-code",
    promptVersion: "1",
    bootstrapPromptHash: "abcd1234",
    createdAt: "2026-08-31T10:00:00.000Z",
    expiresAt: "2026-08-31T10:30:00.000Z",
    workflowName: "Implement, test, fix",
    state,
    ...(detectedSessionId ? { detectedSessionId } : {}),
  };
}

afterEach(() => {
  cleanup();
  forgetAnnouncements();
});

describe("when observation may interrupt", () => {
  it("announces a confirmed match", () => {
    expect(shouldAnnounce(run("detected_live", "sess-1"))).toBe(true);
  });

  it("never announces a match it is unsure of", () => {
    // "Something might be yours" is not worth taking someone off their work.
    expect(shouldAnnounce(run("ambiguous_match"))).toBe(false);
  });

  it("never announces a run still waiting, lost, finished or failed", () => {
    for (const state of [
      "pending_after_copy",
      "observation_lost",
      "completed",
      "failed",
    ] as const) {
      expect(shouldAnnounce(run(state, "sess-1"))).toBe(false);
    }
  });

  it("announces once per run, not once per poll", () => {
    const detected = run("detected_live", "sess-1");
    expect(shouldAnnounce(detected)).toBe(true);
    markAnnounced(detected.anthillRunId);
    expect(shouldAnnounce(detected)).toBe(false);
  });
});

describe("what the dialog says", () => {
  function show() {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(
      <SessionStartedDialog
        run={run("detected_live", "sess-5d90a7")}
        workflowName="Implement, test, fix"
        onOpenSession={onOpen}
        onDismiss={onDismiss}
      />,
    );
    return { onOpen, onDismiss };
  }

  it("names the workflow, the session and how the match was made", () => {
    show();
    expect(screen.getByText("A session started running this workflow")).toBeTruthy();
    expect(screen.getByText("Implement, test, fix")).toBeTruthy();
    expect(screen.getByText("sess-5d90a7")).toBeTruthy();
    expect(screen.getByText("run marker in the session record · confirmed")).toBeTruthy();
  });

  it("states the boundary rather than implying control", () => {
    show();
    expect(screen.getByText(/did not start it and cannot answer it/)).toBeTruthy();
    expect(screen.getByText(/Observation changes nothing about\s+the session/)).toBeTruthy();
  });

  it("offers no control over the session itself", () => {
    show();
    const labels = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    for (const forbidden of ["Stop", "Pause", "Answer", "Reply", "Kill", "Attach"]) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
  });

  it("opens the session on the primary action", () => {
    const { onOpen } = show();
    fireEvent.click(screen.getByRole("button", { name: "Open the live session" }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("can be left without going anywhere", () => {
    const { onDismiss } = show();
    fireEvent.click(screen.getByRole("button", { name: "Stay in the workflow" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const { onDismiss } = show();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("closes on the backdrop but not on the dialog itself", () => {
    const { onDismiss } = show();
    fireEvent.click(document.querySelector(".session-started") as Element);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector(".session-started-backdrop") as Element);
    expect(onDismiss).toHaveBeenCalled();
  });
});
