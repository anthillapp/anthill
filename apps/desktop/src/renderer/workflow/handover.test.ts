import { expect, it } from "vitest";
import type { PendingRun } from "@anthill/live";
import type { ExchangeView } from "../../shared/ipc.js";
import { handoverModel, type HandoverInput } from "./handover.js";

const view: ExchangeView = {
  workflowId: "w",
  revision: 1,
  digest: "d1",
  mode: "approval-gate",
  state: "draft",
  source: { harness: "claude-code", sessionId: "s1", taskText: "The user's own words" },
  problems: [],
  bindings: [],
};

function model(over: Partial<ExchangeView> = {}, input: Partial<HandoverInput> = {}) {
  return handoverModel({
    view: { ...view, ...over },
    dirty: false,
    matches: true,
    problemCount: 0,
    runs: [],
    ...input,
  });
}

it("offers the approval only where the decision can be made", () => {
  expect(model().primary?.label).toBe("Ready for agent");
  // Show-and-go has no gate to open, and an approved head has nothing left to
  // decide. A button in either place would offer a decision that is not there.
  expect(model({ mode: "show-and-go" }).primary).toBeUndefined();
  expect(model({ state: "ready_for_agent" }).primary).toBeUndefined();
  expect(model({ state: "bound", bindings: [{ runId: "r", revision: 1 }] }).primary).toBeUndefined();
});

it("blocks the approval with a reason rather than removing it", () => {
  const stale = model({}, { matches: false });
  expect(stale.primary?.label).toBe("Ready for agent");
  expect(stale.primary?.blocked).toContain("Save them, then approve revision 1");

  /*
   * Dirty alone does not block, and that is the point of keeping the two
   * claims apart: an edit that was undone leaves the document unwritten and
   * its content identical to the revision the exchange holds, and refusing
   * there would refuse an approval of exactly what is on screen.
   */
  expect(model({}, { dirty: true }).primary?.blocked).toBeUndefined();

  expect(model({}, { problemCount: 1 }).primary?.blocked).toBe(
    "1 problem in the workflow blocks approval. Open the problems list and fix it first.",
  );
  expect(model({}, { problemCount: 3 }).primary?.blocked).toBe(
    "3 problems in the workflow block approval. Open the problems list and fix them first.",
  );
});

/*
 * The distinction the design draws in two places at once, in words and in
 * colour. A binding is a revision being pinned — it happens before the session
 * has done anything, and often before one starts.
 */
it("does not call a bound run a running one until its reports arrive", () => {
  const bound = { state: "bound" as const, bindings: [{ runId: "r", revision: 2 }] };
  const quiet = model(bound);
  expect(quiet.pill).toMatchObject({ label: "Bound to revision 2", tone: "bound" });
  expect(quiet.pill.title).toContain("not evidence that the external session is running");

  const live = model(bound, {
    runs: [{ anthillRunId: "r", state: "detected_live" } as unknown as PendingRun],
  });
  expect(live.pill).toMatchObject({ label: "Running revision 2", tone: "running" });
});

it("names the two readies apart", () => {
  expect(model({ state: "ready_for_agent" }).pill.label).toBe("Approved");
  expect(model({ state: "ready_for_agent", mode: "show-and-go" }).pill.label).toBe("Ready");
  expect(model({ mode: "show-and-go" }).pill.label).toBe("Draft");
  expect(model().pill.label).toBe("Waiting for you");
});

/*
 * The case a panel once got wrong by promising more than the store had said.
 * Approve, edit, approve, edit, withdraw leaves the approval from two edits
 * ago standing, and a new run is given it the moment the newer is taken back —
 * immediately after the user acted to stop exactly that.
 */
it("says what withdrawing a standing approval would leave behind", () => {
  const alone = model({ revision: 2, approved: { revision: 1, withdrawable: true } });
  expect(alone.notice?.text).toContain("this handover is left with nothing approved");
  expect(alone.notice?.withdraw).toEqual({ revision: 1 });

  const stacked = model({ revision: 3, approved: { revision: 2, withdrawable: true, below: 1 } });
  expect(stacked.notice?.text).toContain("revision 1 — approved before it and never withdrawn");

  // Under show-and-go an approval is not permission, so there is nothing a
  // withdrawal would change and no control is offered.
  const idle = model({ revision: 2, mode: "show-and-go", approved: { revision: 1, withdrawable: false } });
  expect(idle.notice?.withdraw).toBeUndefined();
});

it("says that editing did not change what a bound session is doing", () => {
  const diverged = model({
    revision: 2,
    state: "bound",
    bindings: [{ runId: "r", revision: 1 }],
  });
  expect(diverged.notice?.text).toBe(
    "Running revision 1 · your edits are revision 2. Editing did not change what the session is doing, and will not.",
  );
  expect(diverged.notice?.tone).toBe("warning");
});

/*
 * Red is reserved. A standing approval and diverged edits are situations, not
 * faults; only a write that did not happen is an error, and the sentence says
 * what did *not* happen rather than what went wrong.
 */
it("reserves the red card for a write that did not land", () => {
  const failed = model({}, { writeError: "EEXIST" });
  expect(failed.notice?.tone).toBe("error");
  expect(failed.notice?.text).toContain("Nothing was recorded; reload and try again");
  expect(model({ revision: 2, approved: { revision: 1, withdrawable: true } }).notice?.tone).toBe("warning");
});

it("says nothing at all in the states that have nothing to say", () => {
  expect(model().notice).toBeUndefined();
  expect(model({ state: "ready_for_agent" }).notice).toBeUndefined();
  expect(model({ state: "bound", bindings: [{ runId: "r", revision: 1 }] }).notice).toBeUndefined();
});
