/**
 * What the Live Session page is allowed to claim.
 *
 * These are mostly assertions that a guess did not get promoted: the graph only
 * moves on an announced step, a shared agent name attributes to nothing, and an
 * observation that stops leaves the step in flight as unknown rather than as
 * still running.
 */

import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { attribute, buildWorkflowIndex } from "./attribution.js";
import { finishedSteps, foldLiveSession, hasStepEvidence } from "./live-session.js";
import type { ObservationEvent } from "./observation-event.js";
import { createPendingRun, type PendingRun } from "./pending-run.js";

const workflow: Workflow = {
  id: "workflow-1",
  name: "Implement, test, fix",
  version: "1",
  target: "claude-code",
  nodes: [
    { id: "start", type: "start", name: "Start", config: {} },
    {
      id: "implement",
      type: "agent",
      name: "Make the change",
      config: { actionKind: "agent-step", task: "Write it", agentId: "agent-dev" },
    },
    {
      id: "test",
      type: "agent",
      name: "Run tests",
      config: { actionKind: "verify", task: "Run them", agentId: "agent-qa" },
    },
    {
      id: "fix",
      type: "agent",
      name: "Fix failures",
      config: { actionKind: "agent-step", task: "Fix", agentId: "agent-dev" },
    },
    { id: "end", type: "end", name: "Done", config: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "implement" },
    { id: "e2", source: "implement", target: "test" },
    { id: "e3", source: "test", target: "fix", kind: "rework" },
    { id: "e4", source: "test", target: "end" },
  ],
  metadata: {
    workflow: {
      formatVersion: 4,
      agents: [
        { id: "agent-dev", name: "Developer" },
        { id: "agent-qa", name: "Test Runner" },
      ],
    },
  },
};

const index = buildWorkflowIndex(workflow);

function run(partial: Partial<PendingRun> = {}): PendingRun {
  return {
    ...createPendingRun({
      anthillRunId: "ANT-1A2B3C4D",
      correlationNonce: "9f8e7d",
      selectedCli: "claude-code",
      promptVersion: "1",
      bootstrapPromptHash: "abcd1234",
      workflowId: "workflow-1",
      workflowName: "Implement, test, fix",
      now: "2026-08-29T10:00:00.000Z",
    }),
    state: "detected_live",
    detectedSessionId: "sess-1",
    ...partial,
  };
}

let seq = 0;
function event(partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">): ObservationEvent {
  seq += 1;
  return {
    runId: "ANT-1A2B3C4D",
    seq,
    at: new Date(Date.parse("2026-08-29T10:00:00.000Z") + seq * 1000).toISOString(),
    recordedAt: new Date(Date.parse("2026-08-29T10:00:00.000Z") + seq * 1000).toISOString(),
    cli: "claude-code",
    source: "hook",
    channel: "claude-code:hook",
    sessionId: "sess-1",
    ...partial,
  };
}

const step = (blockId: string) =>
  event({ kind: "step.marker", title: `Step ${blockId}`, blockId, source: "transcript", channel: "claude-code:transcript" });

describe("attributing one event", () => {
  it("takes an announced step as authoritative", () => {
    expect(attribute(step("test"), index, undefined)).toEqual({
      blockId: "test",
      confidence: "exact",
      how: "the agent announced this step",
    });
  });

  it("refuses a step id that is not in the workflow", () => {
    const bogus = { ...step("deploy"), blockId: "deploy" };
    const mapping = attribute(bogus, index, "implement");
    expect(mapping.confidence).toBe("unmapped");
    expect(mapping.how).toContain("not a step in this workflow");
  });

  it("maps by agent name when exactly one step uses that agent", () => {
    const mapping = attribute(
      event({ kind: "subagent.start", title: "Task", agentName: "test-runner" }),
      index,
      undefined,
    );
    expect(mapping).toEqual({
      blockId: "test",
      confidence: "likely",
      how: "test-runner – mapped by agent name",
    });
  });

  it("matches an agent name however it was written down", () => {
    expect(attribute(event({ kind: "subagent.start", title: "t", agentName: "Test Runner" }), index, undefined))
      .toMatchObject({ blockId: "test", confidence: "likely" });
  });

  it("attributes nothing when an agent carries out several steps", () => {
    const mapping = attribute(
      event({ kind: "subagent.start", title: "Task", agentName: "developer" }),
      index,
      undefined,
    );
    expect(mapping.confidence).toBe("unmapped");
    expect(mapping.how).toContain("2 steps");
  });

  it("calls activity inside an announced step likely, never exact", () => {
    const mapping = attribute(event({ kind: "tool.start", title: "Bash" }), index, "implement");
    expect(mapping).toEqual({
      blockId: "implement",
      confidence: "likely",
      how: "inside the step the agent announced",
    });
  });

  it("leaves activity unmapped when no step was ever announced", () => {
    const mapping = attribute(event({ kind: "tool.start", title: "Bash" }), index, undefined);
    expect(mapping.confidence).toBe("unmapped");
    expect(mapping.blockId).toBeUndefined();
  });
});

describe("folding a session", () => {
  it("starts every step queued and says there is no evidence yet", () => {
    const view = foldLiveSession(workflow, run(), []);
    expect(Object.values(view.blocks).every((block) => block.state === "queued")).toBe(true);
    expect(view.empty).toBe(true);
    expect(hasStepEvidence(view)).toBe(false);
  });

  it("moves the graph only on an announced step", () => {
    const view = foldLiveSession(workflow, run(), [
      event({ kind: "session.start", title: "Session started" }),
      event({ kind: "tool.start", title: "Bash", toolName: "Bash" }),
    ]);
    expect(Object.values(view.blocks).every((block) => block.state === "queued")).toBe(true);
    expect(view.activeBlockId).toBeUndefined();
    expect(view.unmappedCount).toBe(2);
  });

  it("runs the announced step and finishes the one it left", () => {
    const view = foldLiveSession(workflow, run(), [step("implement"), step("test")]);
    expect(view.blocks.implement.state).toBe("done");
    expect(view.blocks.test.state).toBe("running");
    expect(view.blocks.test.confidence).toBe("exact");
    expect(view.activeBlockId).toBe("test");
    expect(view.blocks.fix.state).toBe("queued");
  });

  /*
    A move the workflow never drew. The agent's own decision to go somewhere
    the plan has no connection to is a fact about the session, and one the
    diagram was silently folding into "pass 2" — which reads as a rework loop
    the author designed rather than a detour the agent took.
  */
  it("records a move the workflow has no connection for", () => {
    const view = foldLiveSession(workflow, run(), [
      step("implement"),
      step("test"),
      step("fix"),
      step("implement"),
    ]);
    expect(view.detours).toEqual([
      expect.objectContaining({ from: "fix", to: "implement", pass: 2 }),
    ]);
    expect(view.detours[0].at).toBe(view.events[3].at);
  });

  it("leaves a rework loop the workflow drew alone", () => {
    const view = foldLiveSession(workflow, run(), [step("implement"), step("test"), step("fix")]);
    expect(view.detours).toEqual([]);
  });

  it("does not call the first announced step a detour, wherever it was", () => {
    const view = foldLiveSession(workflow, run(), [step("fix")]);
    expect(view.detours).toEqual([]);
  });

  it("does not count the same step announced again as a detour", () => {
    const view = foldLiveSession(workflow, run(), [step("implement"), step("implement")]);
    expect(view.detours).toEqual([]);
  });

  it("keeps a finished step counted while the agent is back in it", () => {
    const before = foldLiveSession(workflow, run(), [step("implement"), step("test"), step("fix")]);
    expect(finishedSteps(before)).toBe(2);
    const again = foldLiveSession(workflow, run(), [
      step("implement"),
      step("test"),
      step("fix"),
      step("implement"),
    ]);
    // "implement" finished once already; being back in it does not undo that.
    expect(finishedSteps(again)).toBe(3);
  });

  it("counts a second visit to a step as another pass", () => {
    const view = foldLiveSession(workflow, run(), [
      step("implement"),
      step("test"),
      step("fix"),
      step("test"),
    ]);
    expect(view.blocks.test.passes).toBe(2);
  });

  /**
   * ANT-48. A session with hooks installed announces each step twice — once in
   * the transcript, once in the hook log — and the graph counted both, so a
   * block entered once was drawn as "pass 2" with a rework loop that never
   * happened.
   */
  it("counts a step announced through two channels as one pass", () => {
    const at = "2026-08-29T10:00:05.000Z";
    const view = foldLiveSession(workflow, run(), [
      event({
        kind: "step.marker",
        title: "Step announced",
        detail: "implement",
        blockId: "implement",
        at,
        source: "transcript",
        channel: "claude-code:transcript",
      }),
      event({
        kind: "step.marker",
        title: "Step announced",
        detail: "implement",
        blockId: "implement",
        at: new Date(Date.parse(at) + 90).toISOString(),
        source: "hook",
        channel: "claude-code:hook",
      }),
    ]);
    expect(view.blocks.implement.passes).toBe(1);
    expect(view.blocks.implement.state).toBe("running");
  });

  it("still counts a step the agent really announced twice as two passes", () => {
    const view = foldLiveSession(workflow, run(), [
      step("implement"),
      step("test"),
      step("implement"),
    ]);
    expect(view.blocks.implement.passes).toBe(2);
  });

  it("marks the step as waiting on a person when the CLI says so", () => {
    const view = foldLiveSession(workflow, run(), [
      step("implement"),
      event({ kind: "notification", title: "Claude needs your permission", detail: "to run npm test" }),
    ]);
    expect(view.blocks.implement.state).toBe("needsYou");
    expect(view.blocks.implement.note).toBe("to run npm test");
    expect(view.activeBlockId).toBeUndefined();
  });

  it("does not treat silence as waiting on a person", () => {
    const view = foldLiveSession(workflow, run(), [step("implement")]);
    expect(view.blocks.implement.state).toBe("running");
  });

  /**
   * ANT-47. The agent announced a step, found it could not proceed, asked the
   * person a question and ended its turn. The record of the turn ending was
   * read, filed in the feed, and then ignored: the diagram said "Working"
   * while the session sat waiting to be answered, and five minutes later said
   * "Done" at the same step.
   */
  describe("a turn that ended", () => {
    const turnEnd = () => event({ kind: "turn.end", title: "The agent finished its turn" });

    it("puts the announced step in the hands of the person watching", () => {
      const view = foldLiveSession(workflow, run(), [
        step("implement"),
        event({ kind: "message", title: "Message", detail: "What's the idea you want brainstormed?" }),
        turnEnd(),
      ]);
      expect(view.blocks.implement.state).toBe("needsYou");
      expect(view.blocks.implement.note).toContain("ended its turn");
    });

    it("is not undone by work that was already in flight", () => {
      // The shape this was reported from: the subagent's completion landed two
      // seconds after the stop record. A closing record is the tail of work
      // that had already started, not the agent going again.
      const view = foldLiveSession(workflow, run(), [
        step("implement"),
        turnEnd(),
        event({ kind: "subagent.end", title: "Analyst", toolUseId: "t1" }),
        event({ kind: "tool.end", title: "Bash", toolUseId: "t2" }),
        event({ kind: "usage", title: "Token usage recorded" }),
      ]);
      expect(view.blocks.implement.state).toBe("needsYou");
    });

    it("gives the step back when the agent starts something", () => {
      const view = foldLiveSession(workflow, run(), [
        step("implement"),
        turnEnd(),
        event({ kind: "tool.start", title: "Bash", toolName: "Bash" }),
      ]);
      expect(view.blocks.implement.state).toBe("running");
      expect(view.blocks.implement.note).toBeUndefined();
      expect(view.activeBlockId).toBe("implement");
    });

    it("gives it back when the person answers", () => {
      const view = foldLiveSession(workflow, run(), [
        step("implement"),
        turnEnd(),
        event({ kind: "prompt.submit", title: "A prompt was submitted" }),
      ]);
      expect(view.blocks.implement.state).toBe("running");
    });

    it("is not declared finished by a run that went quiet, when the transcript is all there is", () => {
      // `completed` is read from a terminal stop reason plus a long silence,
      // which is this exact session: the silence is the person not having
      // answered yet. With no hook channel on the run, a turn ending with a
      // question and a turn ending because the work is done look identical,
      // and the step's own record outranks the inference.
      const view = foldLiveSession(workflow, run({ state: "completed" }), [
        step("implement"),
        { ...turnEnd(), source: "transcript", channel: "claude-code:transcript" },
      ]);
      expect(view.blocks.implement.state).toBe("needsYou");
    });

    /*
      ANT-78. The last step of every finished workflow ends with a turn
      ending — there is no later marker to move it on — so it landed in
      "Waiting on you" and End never went green, on a run whose closing
      message said every step had run. Once hooks carry the run, the two
      cases are told apart by a record: a real wait writes a `notification`
      (measured: one in 2281 events over six and a half hours, and none at
      the end), a turn ending because the work is done does not.
    */
    describe("at the end of a run the hooks were carrying", () => {
      const hookTurnEnd = () =>
        event({ kind: "turn.end", title: "The agent finished its turn", channel: "claude-code:hook" });

      it("finishes the last step when the run completes and nobody was asked for anything", () => {
        const view = foldLiveSession(workflow, run({ state: "completed" }), [
          step("implement"),
          step("test"),
          hookTurnEnd(),
          event({ kind: "subagent.end", title: "A subagent finished" }),
        ]);
        expect(view.blocks.implement.state).toBe("done");
        expect(view.blocks.test.state).toBe("done");
        expect(view.blocks.test.note).toBeUndefined();
      });

      it("still says waiting on you while the run is live – the turn has only just ended", () => {
        const view = foldLiveSession(workflow, run(), [step("implement"), hookTurnEnd()]);
        expect(view.blocks.implement.state).toBe("needsYou");
      });

      it("keeps a step the CLI said was waiting as waiting, even when the run completes", () => {
        const view = foldLiveSession(workflow, run({ state: "completed" }), [
          step("implement"),
          event({ kind: "notification", title: "Claude needs your permission", detail: "to use AskUserQuestion" }),
          hookTurnEnd(),
        ]);
        expect(view.blocks.implement.state).toBe("needsYou");
        expect(view.blocks.implement.note).toBe("to use AskUserQuestion");
      });

      it("does not hold an earlier step's notification against a later step", () => {
        // The measured run: one permission prompt mid-run, none at the end.
        const view = foldLiveSession(workflow, run({ state: "completed" }), [
          step("implement"),
          event({ kind: "notification", title: "Claude needs your permission", detail: "to use AskUserQuestion" }),
          event({ kind: "prompt.submit", title: "A prompt was submitted" }),
          step("test"),
          hookTurnEnd(),
        ]);
        expect(view.blocks.implement.state).toBe("done");
        expect(view.blocks.test.state).toBe("done");
      });

      it("goes back to work when the turn ending is followed by more", () => {
        const view = foldLiveSession(workflow, run(), [
          step("implement"),
          hookTurnEnd(),
          event({ kind: "tool.start", title: "Bash", toolName: "Bash" }),
        ]);
        expect(view.blocks.implement.state).toBe("running");
      });

      it("leaves a lost run's step unknown – only a finish settles it", () => {
        const view = foldLiveSession(workflow, run({ state: "observation_lost" }), [
          step("implement"),
          hookTurnEnd(),
        ]);
        expect(view.blocks.implement.state).not.toBe("done");
      });
    });

    it("still finishes a step the agent left running", () => {
      const view = foldLiveSession(workflow, run({ state: "completed" }), [step("implement")]);
      expect(view.blocks.implement.state).toBe("done");
    });

    it("keeps an explicitly completed Anthill step done after Codex ends its turn", () => {
      const view = foldLiveSession(workflow, run({ state: "completed" }), [
        step("implement"),
        event({
          kind: "session.end",
          title: "The harness reported the work as finished",
          source: "anthill",
          channel: "anthill:report",
        }),
        turnEnd(),
      ]);
      expect(view.blocks.implement.state).toBe("done");
    });

    it("says nothing about a turn that ended before any step was announced", () => {
      const view = foldLiveSession(workflow, run(), [turnEnd()]);
      expect(view.blocks.implement.state).toBe("queued");
      expect(view.activeBlockId).toBeUndefined();
    });
  });

  it("fails the announced step on a recorded error", () => {
    const view = foldLiveSession(workflow, run(), [
      step("test"),
      event({ kind: "error", title: "Command failed", detail: "3 tests failed" }),
    ]);
    expect(view.blocks.test.state).toBe("failed");
    expect(view.blocks.test.note).toBe("3 tests failed");
  });

  it("closes the last step when the run itself completed", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [step("implement")]);
    expect(view.blocks.implement.state).toBe("done");
  });

  it("makes the step in flight unknown when observation is lost", () => {
    const view = foldLiveSession(workflow, run({ state: "observation_lost" }), [step("implement")]);
    expect(view.blocks.implement.state).toBe("unknown");
    expect(view.blocks.implement.note).toContain("stopped being able to read");
  });

  it("keeps unmapped activity out of the graph but in the feed", () => {
    const view = foldLiveSession(workflow, run(), [
      event({ kind: "tool.start", title: "Read", toolName: "Read" }),
      step("implement"),
      event({ kind: "tool.start", title: "Bash", toolName: "Bash" }),
    ]);
    expect(view.events).toHaveLength(3);
    expect(view.unmappedCount).toBe(1);
    expect(view.events[0].mapping.confidence).toBe("unmapped");
    expect(view.events[2].mapping.confidence).toBe("likely");
  });

  it("rebuilds identically from the same log, so a replay can be trusted", () => {
    const log = [step("implement"), event({ kind: "tool.start", title: "Bash" }), step("test")];
    expect(foldLiveSession(workflow, run(), log)).toEqual(foldLiveSession(workflow, run(), log));
  });
});

/**
 * How long a finished step took.
 *
 * The span the record actually supports: from the agent announcing this step
 * to it announcing the next one. Not a measure of effort — a step that spent
 * half of it waiting for a person is not told apart here — and never a
 * prediction, because it only exists once the step has been left.
 */
describe("what a finished step cost", () => {
  const T0 = Date.parse("2026-08-29T10:00:00.000Z");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const marker = (blockId: string, when: number) => ({ ...step(blockId), at: at(when) });

  it("measures from this step's announcement to the next", () => {
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 60_000),
      marker("test", 5 * 60_000),
    ]);
    expect(view.blocks.implement.spentMs).toBe(4 * 60_000);
  });

  it("says nothing about the step still running", () => {
    const view = foldLiveSession(workflow, run(), [marker("implement", 60_000)]);
    expect(view.blocks.implement.spentMs).toBeUndefined();
    expect(view.blocks.implement.state).toBe("running");
  });

  it("adds the passes up, because a loop is still one step's cost", () => {
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 0),
      marker("test", 60_000),
      marker("implement", 120_000),
      marker("test", 300_000),
    ]);
    // A minute the first time round, three minutes the second.
    expect(view.blocks.implement.spentMs).toBe(4 * 60_000);
    expect(view.blocks.implement.passes).toBe(2);
  });

  it("counts a step's own waiting, which is time it took even so", () => {
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 0),
      { ...event({ kind: "turn.end", title: "The agent finished its turn" }), at: at(30_000) },
      marker("test", 120_000),
    ]);
    expect(view.blocks.implement.spentMs).toBe(120_000);
  });

  it("closes the last step on the last thing anything was recorded at", () => {
    // Nothing announced a departure, so there is no other moment to use.
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      marker("implement", 60_000),
      { ...event({ kind: "tool.end", title: "Bash" }), at: at(200_000) },
    ]);
    expect(view.blocks.implement.state).toBe("done");
    expect(view.blocks.implement.spentMs).toBe(140_000);
  });

  it("folds records read out of order in the order they happened", () => {
    // Stamps can arrive out of order across channels. Read in that order, the
    // later announcement looked like the earlier one and the cost came out
    // negative; the fold now reads the journal by when things were recorded
    // (ANT-159).
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 300_000),
      marker("test", 60_000),
    ]);
    expect(view.blocks.test.state).toBe("done");
    expect(view.blocks.test.spentMs).toBe(240_000);
    expect(view.blocks.implement.state).toBe("running");
  });

  it("leaves the total alone when a stamp cannot be read", () => {
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 60_000),
      { ...marker("test", 120_000), at: "not a time" },
    ]);
    expect(view.blocks.implement.state).toBe("done");
    expect(view.blocks.implement.spentMs).toBeUndefined();
  });

  it("does not put a cost on a step that failed, which did not finish", () => {
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 60_000),
      { ...event({ kind: "error", title: "It broke" }), at: at(120_000) },
    ]);
    expect(view.blocks.implement.state).toBe("failed");
    expect(view.blocks.implement.spentMs).toBeUndefined();
  });
});

/**
 * A long session's early steps.
 *
 * ANT-73, at the level the bug actually bit. The fold is only as good as the
 * record it is handed, and the page was handing it the last thousand events —
 * a bound meant for how many cards to draw. This is what that did to the
 * diagram, and it is why the record must arrive whole.
 */
describe("a diagram folded from a record that lost its beginning", () => {
  const T0 = Date.parse("2026-08-29T10:00:00.000Z");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const marker = (blockId: string, when: number) => ({ ...step(blockId), at: at(when) });

  /** Two steps announced early, then a great deal of ordinary tool activity. */
  function wholeRun(): ObservationEvent[] {
    const noise = Array.from({ length: 1200 }, (_, index) =>
      event({ kind: "tool.start", title: "Bash", toolUseId: `t${index}`, at: at(600_000 + index * 1000) }),
    );
    return [marker("implement", 0), marker("test", 300_000), ...noise];
  }

  it("shows the announced steps when the whole record is folded", () => {
    const view = foldLiveSession(workflow, run(), wholeRun());
    expect(view.blocks.implement.state).toBe("done");
    expect(view.blocks.test.state).toBe("running");
  });

  it("forgets them entirely when the record arrives truncated", () => {
    // The failure, kept as a test so the cause stays legible: nothing is wrong
    // with the fold, and this is exactly what the page was doing to it.
    const view = foldLiveSession(workflow, run(), wholeRun().slice(-1000));
    expect(view.blocks.implement.state).toBe("queued");
    expect(view.blocks.test.state).toBe("queued");
    expect(hasStepEvidence(view)).toBe(false);
  });
});

/*
  ANT-158, ANT-161. A session that says outright the work is over — Codex's
  `task_complete`, or the harness's own done — settles the step it ends on
  without the hooks having to vouch for the silence. A turn that merely
  ended still does not, and nothing unannounced is painted done.
*/
describe("an explicit ending", () => {
  const codex = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ cli: "codex", source: "rollout", channel: "codex:rollout", ...partial });
  const taskComplete = () =>
    codex({ kind: "turn.end", title: "Codex finished the turn", completion: "task_complete" });
  const turnEnd = () => event({ kind: "turn.end", title: "The agent finished its turn" });
  const codexStep = (blockId: string) =>
    codex({ kind: "step.marker", title: `Step ${blockId}`, blockId });
  const doneMarker = (channel = "claude-code:transcript") =>
    event({
      kind: "session.end",
      title: "The harness reported the work as finished",
      source: channel.endsWith(":hook") ? "hook" : "transcript",
      channel,
      completion: "done",
    });

  it("finishes Codex's last step on task_complete, with no hooks at all", () => {
    const view = foldLiveSession(workflow, run({ selectedCli: "codex", state: "completed" }), [
      codexStep("implement"),
      codexStep("test"),
      codex({ kind: "message", title: "Message", detail: "All tests pass.", author: { kind: "main" } }),
      taskComplete(),
    ]);
    expect(view.blocks.implement.state).toBe("done");
    expect(view.blocks.test.state).toBe("done");
    expect(view.blocks.test.note).toBeUndefined();
    expect(view.blocks.fix.state).toBe("queued");
    expect(view.endedAt).toBe(view.events[view.events.length - 1].at);
  });

  it("reads an older journal's task_complete, written before the field existed", () => {
    const { completion: _field, ...legacy } = taskComplete();
    const view = foldLiveSession(workflow, run({ selectedCli: "codex", state: "completed" }), [
      codexStep("test"),
      legacy,
    ]);
    expect(view.blocks.test.state).toBe("done");
  });

  it("finishes Claude Code's last step on ANTHILL-DONE before any hook has been read", () => {
    // ANT-93806CC0: the transcript arrived first, the hook batch half a
    // minute later. The done line is in the transcript.
    const view = foldLiveSession(workflow, run({ state: "detected_live" }), [
      step("test"),
      { ...turnEnd(), source: "transcript", channel: "claude-code:transcript" },
      doneMarker(),
    ]);
    expect(view.blocks.test.state).toBe("done");
  });

  it("is not reopened by the generic Stop and SessionEnd that follow it", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      step("test"),
      doneMarker(),
      event({ kind: "turn.end", title: "The agent finished its turn" }),
      event({ kind: "session.end", title: "The session ended", detail: "The session ended (other)." }),
    ]);
    expect(view.blocks.test.state).toBe("done");
  });

  it("counts one ending however many channels carried it", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      step("test"),
      doneMarker(),
      doneMarker("claude-code:hook"),
    ]);
    expect(view.blocks.test).toMatchObject({ state: "done", passes: 1 });
    expect(view.events.filter((e) => e.completion)).toHaveLength(1);
  });

  it("still says waiting on you for a real request made after it", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      step("test"),
      doneMarker(),
      event({ kind: "notification", title: "Claude needs your permission", detail: "to use Bash" }),
    ]);
    expect(view.blocks.test).toMatchObject({ state: "needsYou", note: "to use Bash" });
    expect(view.endedAt).toBeUndefined();
  });

  it("goes back to running when the session carries on after it", () => {
    const view = foldLiveSession(workflow, run({ selectedCli: "codex" }), [
      codexStep("test"),
      taskComplete(),
      codex({ kind: "tool.start", title: "exec_command", toolUseId: "call-9" }),
    ]);
    expect(view.blocks.test.state).toBe("running");
    expect(view.activeBlockId).toBe("test");
  });

  it("leaves a recorded failure a failure", () => {
    const view = foldLiveSession(workflow, run({ selectedCli: "codex", state: "completed" }), [
      codexStep("test"),
      codex({ kind: "error", title: "Codex recorded an error", detail: "stream closed" }),
      taskComplete(),
    ]);
    expect(view.blocks.test.state).toBe("failed");
  });

  it("does not take a subagent's done for the session's", () => {
    const view = foldLiveSession(workflow, run(), [
      step("test"),
      { ...doneMarker(), author: { kind: "subagent", name: "Test Runner" } },
    ]);
    expect(view.blocks.test.state).toBe("running");
  });

  it("does not settle a step on a turn that merely ended, without hooks", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      step("test"),
      { ...turnEnd(), source: "transcript", channel: "claude-code:transcript" },
    ]);
    expect(view.blocks.test.state).toBe("needsYou");
    // Cautious, not a claim that anything was asked.
    expect(view.blocks.test.waitReason).toBe("yielded");
  });

  it("says a step was asked about only on the CLI's own request record", () => {
    const view = foldLiveSession(workflow, run(), [
      step("test"),
      event({ kind: "notification", title: "Claude needs your permission", detail: "to use Bash" }),
    ]);
    expect(view.blocks.test).toMatchObject({ state: "needsYou", waitReason: "asked" });
  });
});

/*
  ANT-159. The journal is in the order Anthill read things. After a restart
  Codex's session_meta was re-read and appended after task_complete, and the
  fold took it for the latest thing that happened: the session's last moment
  became its first, and the opening record put the finished step back to
  running.
*/
describe("a record read late", () => {
  const codex = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ cli: "codex", source: "rollout", channel: "codex:rollout", ...partial });
  const T = (s: number) => new Date(Date.parse("2026-09-27T00:37:00.000Z") + s * 1000).toISOString();

  const journal = () => [
    codex({ kind: "prompt.submit", title: "The workflow was pasted in", at: T(7) }),
    codex({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(10) }),
    codex({ kind: "step.marker", title: "Step test", blockId: "test", at: T(25) }),
    codex({ kind: "turn.end", title: "Codex finished the turn", completion: "task_complete", at: T(37) }),
  ];

  it("gives the same blocks, clock and feed whether or not it was there all along", () => {
    const live = foldLiveSession(workflow, run({ selectedCli: "codex", state: "completed" }), journal());
    const late = codex({ kind: "session.start", title: "Session started", at: T(6) });
    const replay = foldLiveSession(workflow, run({ selectedCli: "codex", state: "completed" }), [...journal(), late]);

    for (const view of [live, replay]) {
      expect(view.blocks.test.state).toBe("done");
      expect(view.startedAt).toBe(T(7));
      expect(view.lastSeenAt).toBe(T(37));
      expect(view.endedAt).toBe(T(37));
    }
    expect(replay.blocks.test.spentMs).toBe(live.blocks.test.spentMs);
    expect(replay.events.map((e) => e.kind)[0]).toBe("session.start");
    expect(replay.events.slice(1).map((e) => e.at)).toEqual(live.events.map((e) => e.at));
  });

  it("does not let a late batch of earlier hook records reopen a finished step", () => {
    const hook = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
      event({ channel: "claude-code:hook", source: "hook", ...partial });
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      event({ kind: "step.marker", title: "Step test", blockId: "test", channel: "claude-code:transcript", source: "transcript", at: T(10) }),
      event({ kind: "session.end", title: "The harness reported the work as finished", channel: "claude-code:transcript", source: "transcript", completion: "done", at: T(30) }),
      // Read afterwards, written before.
      hook({ kind: "session.start", title: "Session started", at: T(1) }),
      hook({ kind: "prompt.submit", title: "A prompt was submitted", at: T(20) }),
      hook({ kind: "turn.end", title: "The agent finished its turn", at: T(31) }),
    ]);
    expect(view.blocks.test.state).toBe("done");
    expect(view.lastSeenAt).toBe(T(31));
  });
});

/*
  ANT-163. Which block something belongs to, when more than one can be at
  work: a subagent's work goes to the step it was started from, a step with a
  subagent still out stays running after the session moves on, and a message
  can name its step with a tag that is never another pass.
*/
describe("telling blocks apart", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-27T05:00:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const mark = (blockId: string, s: number) => tx({ kind: "step.marker", title: `Step ${blockId}`, blockId, at: T(s) });
  const dispatch = (id: string, s: number, background = false) =>
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: id, at: T(s), ...(background ? { background } : {}) });
  const result = (id: string, s: number) => tx({ kind: "tool.end", title: "Tool finished", toolUseId: id, at: T(s) });
  const bySub = (id: string, partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    tx({ author: { kind: "subagent", name: "Developer" }, parentToolUseId: id, ...partial });

  it("keeps a step running while its subagent works, after the session has moved on", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      dispatch("call-a", 2),
      mark("test", 3),
      dispatch("call-b", 4),
    ]);
    expect(view.blocks.implement.state).toBe("running");
    expect(view.blocks.test.state).toBe("running");
    expect(view.activeBlockIds.sort()).toEqual(["implement", "test"]);
    expect(view.activeBlockId).toBe("test");
  });

  it("gives each subagent's work to the step it was started from", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      dispatch("call-a", 2),
      mark("test", 3),
      dispatch("call-b", 4),
      bySub("call-a", { kind: "tool.start", title: "Edit", toolUseId: "t1", at: T(5) }),
      bySub("call-b", { kind: "message", title: "Message", detail: "Running the suite.", at: T(6) }),
      bySub("call-a", { kind: "usage", title: "Token usage recorded", tokens: { in: 100, out: 10 }, at: T(7) }),
    ]);
    const by = (at: string) => view.events.find((e) => e.at === at)?.mapping;
    expect(by(T(5))).toMatchObject({ blockId: "implement", confidence: "exact" });
    expect(by(T(6))).toMatchObject({ blockId: "test", confidence: "exact" });
    expect(by(T(7))).toMatchObject({ blockId: "implement" });
  });

  it("finishes the earlier step when its subagent comes back, and not before", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      dispatch("call-a", 2),
      mark("test", 3),
      result("call-a", 10),
    ]);
    expect(view.blocks.implement.state).toBe("done");
    expect(view.blocks.implement.spentMs).toBe(9_000);
    expect(view.blocks.test.state).toBe("running");
  });

  it("holds a step open for a background subagent until the subagent itself ends its turn", () => {
    const events = [
      mark("implement", 1),
      dispatch("call-a", 2, true),
      result("call-a", 2.1),
      mark("test", 3),
    ];
    expect(foldLiveSession(workflow, run(), events).blocks.implement.state).toBe("running");
    const later = foldLiveSession(workflow, run(), [
      ...events,
      bySub("call-a", { kind: "turn.end", title: "The agent finished its turn", at: T(20) }),
    ]);
    expect(later.blocks.implement.state).toBe("done");
  });

  it("does not read a subagent's turn ending as the session waiting for a person", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      dispatch("call-a", 2),
      bySub("call-a", { kind: "turn.end", title: "The agent finished its turn", at: T(5) }),
    ]);
    expect(view.blocks.implement.state).toBe("running");
  });

  it("does not call a fan-out a detour", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      dispatch("call-a", 2),
      mark("fix", 3),
    ]);
    // implement → fix is not a connection, but implement never stopped.
    expect(view.detours).toEqual([]);
  });

  it("settles every open step on an explicit ending", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      mark("implement", 1),
      dispatch("call-a", 2),
      mark("test", 3),
      tx({ kind: "session.end", title: "The harness reported the work as finished", completion: "done", at: T(9) }),
    ]);
    expect(view.blocks.implement.state).toBe("done");
    expect(view.blocks.test.state).toBe("done");
    expect(view.activeBlockIds).toEqual([]);
  });

  it("measures overlapping steps over their own spans", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 0),
      dispatch("call-a", 1),
      mark("test", 2),
      result("call-a", 10),
      mark("fix", 12),
    ]);
    expect(view.spans).toEqual([
      { blockId: "implement", pass: 1, startedAt: T(0), endedAt: T(10) },
      { blockId: "test", pass: 1, startedAt: T(2), endedAt: T(12) },
      { blockId: "fix", pass: 1, startedAt: T(12) },
    ]);
  });

  it("gives each subagent to the step its call names, when every step was announced first", () => {
    // Measured (ANT-DFB8D21C): both step lines from one command, then both
    // subagents from one message — at dispatch the session was on the last.
    const tagged = (id: string, tag: string, s: number) =>
      tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: id, stepTag: tag, background: true, at: T(s) });
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      mark("test", 1),
      tagged("call-a", "implement", 2),
      tagged("call-b", "test", 2),
      result("call-a", 2.1),
      result("call-b", 2.1),
      bySub("call-a", { kind: "tool.start", title: "Edit", toolUseId: "t1", at: T(4) }),
    ]);
    expect(view.blocks.implement).toMatchObject({ state: "running", passes: 1 });
    expect(view.blocks.test.state).toBe("running");
    expect(view.events.find((e) => e.toolUseId === "t1")?.mapping.blockId).toBe("implement");
    expect(view.spans.filter((s) => s.blockId === "implement")).toEqual([
      { blockId: "implement", pass: 1, startedAt: T(1) },
    ]);

    const done = foldLiveSession(workflow, run(), [
      ...[mark("implement", 1), mark("test", 1), tagged("call-a", "implement", 2), tagged("call-b", "test", 2)],
      bySub("call-a", { kind: "turn.end", title: "The agent finished its turn", at: T(30) }),
    ]);
    expect(done.blocks.implement).toMatchObject({ state: "done", spentMs: 29_000 });
    expect(done.blocks.test.state).toBe("running");
  });

  it("does not keep the detour a fan-out looked like before its subagents were started", () => {
    const tagged = (id: string, tag: string, s: number) =>
      tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: id, stepTag: tag, background: true, at: T(s) });
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      mark("fix", 2), // implement → fix is no connection
      tagged("call-a", "implement", 3),
    ]);
    expect(view.detours).toEqual([]);
    expect(view.blocks.implement.state).toBe("running");
  });

  it("does not read the session's turn ending as waiting on you while its subagents are out", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      dispatch("call-a", 2, true),
      result("call-a", 2.1),
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(3) }),
    ]);
    expect(view.blocks.implement.state).toBe("running");
    // Once they are back, a turn ending is a turn ending again.
    const later = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      dispatch("call-a", 2, true),
      result("call-a", 2.1),
      bySub("call-a", { kind: "turn.end", title: "The agent finished its turn", at: T(9) }),
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(10) }),
    ]);
    expect(later.blocks.implement.state).toBe("needsYou");
  });

  it("begins a step nothing announced when a subagent is started for it", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-f", stepTag: "fix", at: T(2) }),
    ]);
    expect(view.blocks.fix).toMatchObject({ state: "running", passes: 1 });
    expect(view.activeBlockId).toBe("implement");
  });

  describe("a message's step tag", () => {
    const said = (tag: string, s: number) =>
      tx({ kind: "message", title: "Message", detail: "…", author: { kind: "main" }, stepTag: tag, at: T(s) });

    it("starts a step nothing announced, as the fallback for a forgotten step line", () => {
      const view = foldLiveSession(workflow, run(), [mark("implement", 1), said("test", 5)]);
      expect(view.blocks.implement.state).toBe("done");
      expect(view.blocks.test).toMatchObject({ state: "running", passes: 1 });
    });

    it("is confirmed, not repeated, by the step line that follows it", () => {
      const view = foldLiveSession(workflow, run(), [said("implement", 1), mark("implement", 2), said("implement", 3)]);
      expect(view.blocks.implement).toMatchObject({ state: "running", passes: 1 });
    });

    it("names a finished step without reopening it", () => {
      const view = foldLiveSession(workflow, run(), [mark("implement", 1), mark("test", 5), said("implement", 6)]);
      expect(view.blocks.implement.state).toBe("done");
      expect(view.blocks.test.state).toBe("running");
      expect(view.events.at(-1)?.mapping).toMatchObject({ blockId: "implement", confidence: "exact" });
    });

    it("is never another pass, however many messages carry it", () => {
      const view = foldLiveSession(workflow, run(), [
        mark("implement", 1),
        said("implement", 2),
        said("implement", 3),
        said("implement", 4),
      ]);
      expect(view.blocks.implement.passes).toBe(1);
    });
  });
});
