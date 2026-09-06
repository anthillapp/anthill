/**
 * Presence, and the one distinction the whole table exists for.
 *
 * A live session that has gone silent is still a live session. An agent
 * running a test suite writes nothing for a minute at a time, and drawing that
 * the same as "Anthill has lost track of it" would turn a normal pause into an
 * alarm. `quiet` therefore keeps the live tone and keeps moving; `lost` and
 * `stopped` do neither.
 */

import { describe, expect, it } from "vitest";

import type { LiveSessionState, PendingRun } from "@anthill/live";

import {
  needsPlaque,
  presenceKey,
  presenceLabel,
  presenceMoves,
  presenceStyle,
  QUIET_AFTER_MS,
  mostRelevant,
  runsFor,
} from "./presence.js";

const BASE = Date.parse("2026-08-31T10:00:00.000Z");

function run(state: LiveSessionState, lastObservedAt?: string): PendingRun {
  return {
    anthillRunId: "ANT-1A2B3C4D",
    correlationNonce: "9f8e7d",
    selectedCli: "claude-code",
    promptVersion: "1",
    bootstrapPromptHash: "abcd1234",
    createdAt: new Date(BASE).toISOString(),
    expiresAt: new Date(BASE + 1_800_000).toISOString(),
    state,
    ...(lastObservedAt ? { lastObservedAt } : {}),
  };
}

describe("splitting live into receiving and quiet", () => {
  it("is receiving while records keep arriving", () => {
    const at = new Date(BASE).toISOString();
    expect(presenceKey(run("detected_live", at), BASE + 10_000)).toBe("receiving");
  });

  it("becomes quiet after a silence worth mentioning", () => {
    const at = new Date(BASE).toISOString();
    expect(presenceKey(run("detected_live", at), BASE + QUIET_AFTER_MS + 1_000)).toBe("quiet");
  });

  it("keeps the live tone and keeps moving while quiet", () => {
    // The point of the split: quiet must not read as lost.
    expect(presenceStyle("quiet").tone).toBe(presenceStyle("receiving").tone);
    expect(presenceMoves("quiet")).toBe(true);
    expect(presenceStyle("quiet").tone).not.toBe(presenceStyle("lost").tone);
  });

  it("does not move for any state that is not live", () => {
    for (const key of ["pending", "lost", "ambiguous", "completed", "failed", "stopped"] as const) {
      expect(presenceMoves(key)).toBe(false);
    }
  });
});

describe("what each run state is called", () => {
  it("maps every state the machine can reach", () => {
    const states: LiveSessionState[] = [
      "idle",
      "pending_after_copy",
      "detected_live",
      "observation_lost",
      "ambiguous_match",
      "completed",
      "failed",
    ];
    for (const state of states) {
      expect(() => presenceStyle(presenceKey(run(state), BASE))).not.toThrow();
    }
  });

  it("keeps an ambiguous match apart from a confident one", () => {
    expect(presenceKey(run("ambiguous_match"), BASE)).toBe("ambiguous");
    expect(presenceStyle("ambiguous").tone).not.toBe(presenceStyle("receiving").tone);
  });
});

describe("naming the CLI", () => {
  it("names it once a session is actually being read", () => {
    expect(presenceLabel(run("detected_live"), "receiving")).toBe("Live · Claude Code");
    expect(presenceLabel(run("completed"), "completed")).toBe("Session finished · Claude Code");
  });

  it("does not name one while still waiting, which would imply a match", () => {
    expect(presenceLabel(run("pending_after_copy"), "pending")).toBe("Waiting for a session");
  });
});

describe("when the canvas says more than the chip", () => {
  it("stays quiet for a session that is plainly live", () => {
    expect(needsPlaque("receiving")).toBe(false);
  });

  it("explains every other state", () => {
    for (const key of ["quiet", "pending", "lost", "ambiguous", "completed", "failed", "stopped"] as const) {
      expect(needsPlaque(key)).toBe(true);
      expect(presenceStyle(key).note).not.toBe("");
    }
  });
});

describe("the two things a failed run can mean", () => {
  it("calls a session that failed a failure", () => {
    const failed = { ...run("failed"), detectedSessionId: "sess-1" };
    expect(presenceKey(failed, BASE)).toBe("failed");
    expect(presenceLabel(failed, "failed")).toBe("Session failed · Claude Code");
  });

  it("does not blame an agent for a session Anthill never found", () => {
    // The window ran out unmatched. Nothing failed; nothing was ever there.
    expect(presenceKey(run("failed"), BASE)).toBe("not_found");
    expect(presenceLabel(run("failed"), "not_found")).toBe("No session detected");
  });
});

describe("which runs a canvas may speak for", () => {
  /**
   * The bug this exists for: a workflow created seconds earlier showed
   * "Session finished · Claude Code" for a run belonging to a different
   * workflow, under a plaque saying nothing had been written back into "this
   * workflow" — about a workflow that run had never touched.
   */
  const mine = { ...run("completed"), anthillRunId: "ANT-MINE", workflowId: "w1" };
  const theirs = { ...run("completed"), anthillRunId: "ANT-THEIRS", workflowId: "w2" };
  const orphan = run("completed");

  it("takes only the runs started from this workflow", () => {
    expect(runsFor([mine, theirs, orphan], "w1")).toEqual([mine]);
  });

  it("gives a workflow with no id nothing to claim", () => {
    // Two absent ids are not a match. Without this, every run that never
    // recorded a workflow would attach itself to every canvas.
    expect(runsFor([orphan], undefined)).toEqual([]);
  });

  it("leaves a fresh workflow with nothing to say", () => {
    expect(mostRelevant(runsFor([theirs, orphan], "w-new"))).toBeUndefined();
  });
});
