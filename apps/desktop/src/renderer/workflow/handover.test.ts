/**
 * What the toolbar and the notice card say about a handover.
 *
 * These used to be mostly about a button: when `Ready for agent` appeared and
 * what blocked it. The button is gone, so what is pinned here is what is left
 * — that the pill tells a binding apart from a live session, that a run which
 * has already taken a copy of the graph is said out loud, and that none of it
 * asks the user for permission.
 */

import { expect, it } from "vitest";
import type { PendingRun } from "@anthill/live";
import type { ExchangeView } from "../../shared/ipc.js";
import { handoverModel, type HandoverInput } from "./handover.js";

const view: ExchangeView = {
  workflowId: "w",
  revision: 1,
  digest: "d1",
  state: "ready_for_agent",
  mode: "design",
  source: { harness: "claude-code", sessionId: "s1", taskText: "The user's own words" },
  problems: [],
  bindings: [],
};

function model(over: Partial<ExchangeView> = {}, input: Partial<HandoverInput> = {}) {
  return handoverModel({
    view: { ...view, ...over },
    problemCount: 0,
    runs: [],
    ...input,
  });
}

const liveRun = (runId: string): PendingRun =>
  ({ anthillRunId: runId, state: "detected_live" }) as unknown as PendingRun;

it("has no button to press, whatever state the handover is in", () => {
  for (const state of ["draft", "ready_for_agent", "bound"] as const) {
    expect(model({ state })).not.toHaveProperty("primary");
  }
});

/**
 * Readiness is not a badge any more (ANT-116).
 *
 * `Draft` and `Ready` said in a pill what a blocked or unblocked Save says
 * where the user is about to act. A handover nobody has run shows nothing.
 */
it("shows no pill before a session has done anything with it", () => {
  expect(model().pill).toBeUndefined();
  expect(model({ state: "draft" }, { problemCount: 2 }).pill).toBeUndefined();
});

/**
 * The claim this pill exists to keep honest.
 *
 * A binding is a revision being pinned. It happens before the session has done
 * anything, and often before one starts, so calling it "running" would report
 * a session alive on no evidence at all.
 */
it("tells a binding apart from a session that is actually reporting", () => {
  const bound = { state: "bound" as const, bindings: [{ runId: "ANT-1", revision: 2 }] };

  const pinned = model(bound);
  expect(pinned.pill?.label).toBe("Bound to revision 2");
  expect(pinned.pill?.title).toContain("not evidence");

  const live = model(bound, { runs: [liveRun("ANT-1")] });
  expect(live.pill?.label).toBe("Running revision 2");
});

it("says a session is working from an older revision than the canvas", () => {
  const { notice } = model({
    revision: 3,
    state: "ready_for_agent",
    bindings: [{ runId: "ANT-1", revision: 1 }],
  });
  expect(notice?.tone).toBe("warning");
  expect(notice?.text).toContain("revision 1");
  expect(notice?.text).toContain("revision 3");
  expect(notice?.text).toContain("only to future sessions");
});

it("says a workflow that has been run keeps what it ran, even with no edits since", () => {
  const { notice } = model({ state: "bound", bindings: [{ runId: "ANT-1", revision: 1 }] });
  expect(notice?.text).toContain("already been run");
  expect(notice?.text).toContain("only to future sessions");
});

it("has nothing to say about a handover nobody has run", () => {
  expect(model().notice).toBeUndefined();
});

/**
 * The one red in this feature, and the one state a person has to act on: the
 * canvas and the exchange disagree, so what a session would be handed is not
 * what is on screen.
 */
it("reports a save that did not land, above anything else", () => {
  const { notice } = model(
    { state: "bound", bindings: [{ runId: "ANT-1", revision: 1 }] },
    { saveError: "EACCES: permission denied" },
  );
  expect(notice?.tone).toBe("error");
  expect(notice?.text).toContain("EACCES: permission denied");
  expect(notice?.text).toContain("not saved");
  // It must not also claim nothing was lost from the canvas *and* leave the
  // reader thinking the run notice was the important one.
  expect(notice?.text).not.toContain("already been run");
});

it("never asks the user to authorise anything, in any state", () => {
  for (const over of [
    {},
    { state: "draft" as const },
    { state: "bound" as const, bindings: [{ runId: "ANT-1", revision: 1 }] },
  ]) {
    const { pill, notice } = model(over);
    const prose = `${pill?.label ?? ""} ${pill?.title ?? ""} ${notice?.text ?? ""}`.toLowerCase();
    for (const word of ["approve", "approval", "ready for agent", "withdraw", "authoris", "authoriz"]) {
      expect(prose, `"${word}" in ${JSON.stringify(over)}`).not.toContain(word);
    }
  }
});
