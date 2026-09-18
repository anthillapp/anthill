/**
 * What earns an interruption, and the much longer list of what does not.
 *
 * A notification is the one thing Anthill does that reaches past its own
 * window, so almost every test here is a refusal. The ones that matter most are
 * the two that would be indistinguishable from a working feature until someone
 * was actually using it: a lost run being picked back up and replaying every
 * step it ever announced, and a marker naming a block this run cannot name.
 */

import { describe, expect, it } from "vitest";
import type { ObservationEvent, PendingRun } from "@anthill/live";

import { forgetAnnounced, noticesFor, type AnnouncedSteps } from "./step-notices.js";

const RUN: PendingRun = {
  anthillRunId: "ANT-1",
  workflowName: "Implement and check",
  promptVersion: "1",
  selectedCli: "claude-code",
  createdAt: "2026-09-18T10:00:00.000Z",
  expiresAt: "2026-09-18T11:00:00.000Z",
  correlationNonce: "nonce",
  bootstrapPromptHash: "hash",
  state: "detected_live",
  detectedSessionId: "sess-1",
  steps: [
    { id: "implement", name: "Implement the change" },
    { id: "review", name: "Review the change" },
  ],
};

function marker(blockId: string, at = "2026-09-18T10:05:00.000Z"): ObservationEvent {
  return {
    runId: RUN.anthillRunId,
    seq: 1,
    recordedAt: at,
    at,
    cli: "claude-code",
    source: "transcript",
    channel: "claude-code:transcript",
    sessionId: "sess-1",
    kind: "step.marker",
    title: "Step announced",
    detail: blockId,
    blockId,
  };
}

const fresh = (): AnnouncedSteps => new Map();

describe("a step transition", () => {
  it("is announced once, in the author's own words", () => {
    const notices = noticesFor(RUN, [marker("implement")], fresh());
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe("Implement and check");
    expect(notices[0].body).toBe("Started: Implement the change");
    expect(notices[0].stepId).toBe("implement");
  });

  it("is not announced twice for the same step", () => {
    // Sessions repeat themselves: a step re-announced after a tool call is the
    // same step, and a loop coming back round to one already reported is too.
    const announced = fresh();
    expect(noticesFor(RUN, [marker("implement")], announced)).toHaveLength(1);
    expect(noticesFor(RUN, [marker("implement")], announced)).toHaveLength(0);
  });

  it("is announced again when the session moves on and comes back", () => {
    const announced = fresh();
    noticesFor(RUN, [marker("implement")], announced);
    expect(noticesFor(RUN, [marker("review")], announced)).toHaveLength(1);
    // A loop returning to the first step is a transition, because it changed.
    expect(noticesFor(RUN, [marker("implement")], announced)).toHaveLength(1);
  });

  it("collapses a burst down to the step actually reached", () => {
    const announced = fresh();
    const notices = noticesFor(
      RUN,
      [marker("implement"), marker("implement"), marker("review")],
      announced,
    );
    expect(notices.map((notice) => notice.stepId)).toEqual(["implement", "review"]);
  });
});

describe("what is refused", () => {
  it("a run whose session Anthill has not found", () => {
    const pending: PendingRun = { ...RUN, state: "pending_after_copy", detectedSessionId: undefined };
    expect(noticesFor(pending, [marker("implement")], fresh())).toEqual([]);
  });

  it("but not a live run reporting through the CLI, which has no session id", () => {
    // That channel carries both halves of the marker and is the one built for
    // announcing steps. Requiring a session id would refuse the least
    // ambiguous reports Anthill gets.
    const reported: PendingRun = { ...RUN, detectedSessionId: undefined };
    expect(noticesFor(reported, [marker("implement")], fresh())).toHaveLength(1);
  });

  it("a run whose marker two sessions carry", () => {
    // The case this exists for: naming a step would be silently picking one.
    const ambiguous: PendingRun = { ...RUN, state: "ambiguous_match" };
    expect(noticesFor(ambiguous, [marker("implement")], fresh())).toEqual([]);
  });

  it("a run Anthill has given up on, or closed", () => {
    expect(noticesFor({ ...RUN, state: "observation_lost" }, [marker("implement")], fresh())).toEqual([]);
    expect(
      noticesFor({ ...RUN, closedAt: "2026-09-18T10:30:00.000Z" }, [marker("implement")], fresh()),
    ).toEqual([]);
  });

  it("a step this run cannot name", () => {
    // The marker carries an id, and an id is not something to put in front of
    // someone. A run started before step names were carried has none at all.
    expect(noticesFor(RUN, [marker("n7")], fresh())).toEqual([]);
    expect(noticesFor({ ...RUN, steps: undefined }, [marker("implement")], fresh())).toEqual([]);
    expect(
      noticesFor({ ...RUN, steps: [{ id: "implement", name: "  " }] }, [marker("implement")], fresh()),
    ).toEqual([]);
  });

  it("anything that is not a step being announced", () => {
    const other: ObservationEvent = { ...marker("implement"), kind: "message", blockId: undefined };
    const finished: ObservationEvent = { ...marker("implement"), kind: "turn.end" };
    expect(noticesFor(RUN, [other, finished], fresh())).toEqual([]);
  });
});

describe("the record of what has been said", () => {
  it("is kept even when the notice is thrown away", () => {
    // The caller drops notices while the setting is off. The bookkeeping still
    // has to happen, or turning it back on delivers a burst of catching-up
    // notifications about steps nobody was watching for.
    const announced = fresh();
    noticesFor(RUN, [marker("implement")], announced); // caller ignores these
    expect(announced.get(RUN.anthillRunId)).toBe("implement");
    expect(noticesFor(RUN, [marker("implement")], announced)).toEqual([]);
  });

  it("goes when the run does", () => {
    const announced = fresh();
    noticesFor(RUN, [marker("implement")], announced);
    forgetAnnounced(announced, RUN.anthillRunId);
    expect(announced.has(RUN.anthillRunId)).toBe(false);
  });

  it("is per run, so two workflows never speak for each other", () => {
    const announced = fresh();
    const other: PendingRun = { ...RUN, anthillRunId: "ANT-2", workflowName: "Something else" };
    expect(noticesFor(RUN, [marker("implement")], announced)).toHaveLength(1);
    const second = noticesFor(other, [{ ...marker("implement"), runId: "ANT-2" }], announced);
    expect(second).toHaveLength(1);
    expect(second[0].title).toBe("Something else");
  });
});
