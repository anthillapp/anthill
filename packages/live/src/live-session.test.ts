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

const announce = (blockId: string) =>
  event({ kind: "step.marker", title: `Step ${blockId}`, blockId, source: "transcript", channel: "claude-code:transcript" });
/**
 * A step line, as a session writes one: followed by some work in the step.
 * A step left with nothing done in it is a different case (ANT-164) that the
 * tests for it build by hand with `announce`.
 */
const step = (blockId: string) => announce(blockId);
const worked = () => event({ kind: "tool.start", title: "Bash", source: "transcript", channel: "claude-code:transcript" });

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
    const view = foldLiveSession(workflow, run(), [step("implement"), worked(), step("test")]);
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
      worked(),
      step("test"),
      worked(),
      step("fix"),
      worked(),
      step("implement"),
    ]);
    expect(view.detours).toEqual([
      expect.objectContaining({ from: "fix", to: "implement", pass: 2 }),
    ]);
    expect(view.detours[0].at).toBe(view.events[6].at);
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
    const before = foldLiveSession(workflow, run(), [step("implement"), worked(), step("test"), worked(), step("fix")]);
    expect(finishedSteps(before)).toBe(2);
    const again = foldLiveSession(workflow, run(), [
      step("implement"),
      worked(),
      step("test"),
      worked(),
      step("fix"),
      worked(),
      step("implement"),
    ]);
    // "implement" finished once already; being back in it does not undo that.
    expect(finishedSteps(again)).toBe(3);
  });

  it("counts a second visit to a step as another pass", () => {
    const view = foldLiveSession(workflow, run(), [
      step("implement"),
      worked(),
      step("test"),
      worked(),
      step("fix"),
      worked(),
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
      worked(),
      step("test"),
      worked(),
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
  const work = (when: number) => ({ ...worked(), at: at(when) });

  it("measures from this step's announcement to the next", () => {
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 60_000),
      work(61_000),
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
      work(1_000),
      marker("test", 60_000),
      work(61_000),
      marker("implement", 120_000),
      work(121_000),
      marker("test", 300_000),
    ]);
    // A minute the first time round, three minutes the second.
    expect(view.blocks.implement.spentMs).toBe(4 * 60_000);
    expect(view.blocks.implement.passes).toBe(2);
  });

  it("counts a step's own waiting, which is time it took even so", () => {
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 0),
      work(1_000),
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
      work(61_000),
    ]);
    expect(view.blocks.test.state).toBe("done");
    expect(view.blocks.test.spentMs).toBe(240_000);
    expect(view.blocks.implement.state).toBe("running");
  });

  it("leaves the total alone when a stamp cannot be read", () => {
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 60_000),
      work(61_000),
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
      event({ kind: "tool.start", title: "Bash", toolUseId: `t${index}`, source: "transcript", channel: "claude-code:transcript", at: at(600_000 + index * 1000) }),
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
      tx({ kind: "tool.start", title: "Bash", toolUseId: "own-1", at: T(3) }),
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
      const view = foldLiveSession(workflow, run(), [
        mark("implement", 1),
        tx({ kind: "tool.start", title: "Bash", toolUseId: "own-1", at: T(2) }),
        mark("test", 5),
        said("implement", 6),
      ]);
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

/*
  ANT-164. Claude Code announces every parallel step first and only then
  starts their subagents. The step it left with nothing done in it used to be
  drawn done — with a detour — for the seconds until its subagent started.
*/
describe("a step left with nothing done in it", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-27T06:00:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const printed = (blockId: string, call: string, s: number) => [
    tx({ kind: "tool.start", title: "Bash", toolUseId: call, at: T(s) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: call, at: T(s + 0.3) }),
    tx({ kind: "step.marker", title: `Step ${blockId}`, blockId, printedBy: call, at: T(s + 0.3) }),
  ];
  const dispatch = (id: string, tag: string, s: number) =>
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: id, stepTag: tag, background: true, at: T(s) });
  const receipt = (id: string, s: number) => tx({ kind: "tool.end", title: "Tool finished", toolUseId: id, at: T(s) });
  const own = (s: number) => tx({ kind: "tool.start", title: "Edit", toolUseId: `own-${s}`, at: T(s) });

  it("stays running, with no detour, from its line until its subagent starts", () => {
    // implement → fix is no connection: the batch looked like a jump.
    const journal = [
      ...printed("implement", "p1", 1),
      ...printed("fix", "p2", 2),
      dispatch("call-a", "implement", 7),
      receipt("call-a", 7.2),
      dispatch("call-b", "fix", 8),
      receipt("call-b", 8.2),
    ];
    for (let n = 1; n <= journal.length; n += 1) {
      const view = foldLiveSession(workflow, run(), journal.slice(0, n));
      if (view.blocks.fix.state !== "queued") {
        expect(view.blocks.implement.state).toBe("running");
        expect(view.detours).toEqual([]);
      }
    }
  });

  it("is closed as of when it was left once the session gets on with work elsewhere", () => {
    const view = foldLiveSession(workflow, run(), [
      ...printed("implement", "p1", 1),
      ...printed("fix", "p2", 2),
      own(9),
    ]);
    expect(view.blocks.implement).toMatchObject({ state: "done", spentMs: 1_000 });
    expect(view.spans[0]).toEqual({ blockId: "implement", pass: 1, startedAt: T(1.3), endedAt: T(2.3) });
    // Nothing started it, so it was a move away after all.
    expect(view.detours).toEqual([expect.objectContaining({ from: "implement", to: "fix", at: T(2.3) })]);
  });

  it("is closed as of when it was left if the session ends", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      ...printed("implement", "p1", 1),
      ...printed("test", "p2", 2),
      tx({ kind: "session.end", title: "The harness reported the work as finished", completion: "done", at: T(20) }),
    ]);
    expect(view.blocks.implement).toMatchObject({ state: "done", spentMs: 1_000 });
    expect(view.blocks.test.state).toBe("done");
  });

  it("does not count set-up done under a step's tag, before its line, as work in it", () => {
    // Measured: the session's first message, while it wrote the agent files,
    // already carried the first step's tag.
    const view = foldLiveSession(workflow, run(), [
      tx({ kind: "message", title: "Message", detail: "Setting up.", author: { kind: "main" }, stepTag: "implement", at: T(0) }),
      own(0.5),
      ...printed("implement", "p1", 1),
      ...printed("fix", "p2", 2),
    ]);
    expect(view.blocks.implement.state).toBe("running");
    expect(view.detours).toEqual([]);
  });

  it("holds a step open for a subagent Claude Code sent off on its own, known only from the receipt", () => {
    // Measured (ANT-8CF59ECF): no run_in_background on the call, and the
    // result "Async agent launched" 0.3 s later.
    const view = foldLiveSession(workflow, run(), [
      ...printed("implement", "p1", 1),
      tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-a", stepTag: "implement", at: T(3) }),
      tx({ kind: "tool.end", title: "Tool finished", toolUseId: "call-a", background: true, at: T(3.3) }),
      ...printed("test", "p2", 4),
      own(5),
    ]);
    expect(view.blocks.implement.state).toBe("running");
  });

  it("does not count the step the session is on, said again, as another pass", () => {
    // A Stop hook reads the line out of the last message, ten seconds after
    // the command that printed it.
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      ...printed("test", "p1", 1),
      own(2),
      tx({ kind: "session.end", title: "The harness reported the work as finished", completion: "done", at: T(9) }),
      event({ kind: "step.marker", title: "Step test", blockId: "test", channel: "claude-code:hook", at: T(11) }),
    ]);
    expect(view.blocks.test).toMatchObject({ state: "done", passes: 1 });
  });

  it("does not take the hook for starting a subagent, arriving before the transcript, for work elsewhere", () => {
    // Measured (ANT-56CA4FED): the PreToolUse hook for A's Agent call was read
    // five seconds before the transcript wrote the call.
    const hook = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
      event({ source: "hook", channel: "claude-code:hook", ...partial });
    const view = foldLiveSession(workflow, run(), [
      ...printed("implement", "p1", 1),
      ...printed("fix", "p2", 2),
      hook({ kind: "tool.start", title: "Agent", toolName: "Agent", toolUseId: "call-a", at: T(7) }),
    ]);
    expect(view.blocks.implement.state).toBe("running");
    expect(view.detours).toEqual([]);
  });

  it("does not take a subagent's own calls, read before its start was, for the session's work", () => {
    const view = foldLiveSession(workflow, run(), [
      ...printed("implement", "p1", 1),
      ...printed("fix", "p2", 2),
      tx({ kind: "tool.start", title: "Edit", toolUseId: "sub-1", parentToolUseId: "call-a", at: T(8) }),
    ]);
    expect(view.blocks.implement.state).toBe("running");
    expect(view.detours).toEqual([]);
  });

  it("does not call moving between the branches of a parallel fork a detour (ANT-166)", () => {
    const parallel: Workflow = {
      ...workflow,
      nodes: [
        workflow.nodes[0],
        { ...workflow.nodes[1], id: "svc-a", name: "Service A" },
        { ...workflow.nodes[1], id: "svc-b", name: "Service B" },
        workflow.nodes[4],
      ],
      edges: [
        { id: "e1", source: "start", target: "svc-a" },
        { id: "e2", source: "start", target: "svc-b" },
        { id: "e3", source: "svc-a", target: "end" },
        { id: "e4", source: "svc-b", target: "end" },
      ],
    };
    // The session doing both branches itself, one after the other.
    const view = foldLiveSession(parallel, run(), [...printed("svc-a", "p1", 1), own(2), ...printed("svc-b", "p2", 5), own(6)]);
    expect(view.blocks["svc-a"].state).toBe("done");
    expect(view.detours).toEqual([]);
  });

  it("goes on with the same pass when the session comes back to a step it announced in a batch", () => {
    const view = foldLiveSession(workflow, run(), [
      ...printed("implement", "p1", 1),
      ...printed("fix", "p2", 1),
      tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(2) }),
      own(3),
    ]);
    expect(view.blocks.implement).toMatchObject({ state: "running", passes: 1 });
    expect(view.spans.filter((s) => s.blockId === "implement")).toHaveLength(1);
  });

  it("closes a step that had work in it as soon as it is left, as before", () => {
    const view = foldLiveSession(workflow, run(), [...printed("implement", "p1", 1), own(1.5), ...printed("test", "p2", 2)]);
    expect(view.blocks.implement.state).toBe("done");
  });
});

/*
  ANT-184. Claude Code starts a step's subagent in the same message as the
  command that prints the step's line, and the line is recorded only when that
  command returns — after the subagent has already opened the step. The line
  then read as the step being entered a second time: "pass 2" on the first
  visit, and a step still working counted among the finished.
*/
describe("a step line recorded after its subagent was started", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-27T19:39:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  /** One step as the recorded W3 run did it: command, dispatch, then the line, then the subagent's work. */
  const visit = (blockId: string, n: number, s: number) => [
    tx({ kind: "tool.start", title: "Bash", toolUseId: `p${n}`, at: T(s) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: `a${n}`, stepTag: blockId, at: T(s + 1.7) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: `p${n}`, at: T(s + 3.1) }),
    tx({ kind: "step.marker", title: `Step ${blockId}`, blockId, printedBy: `p${n}`, at: T(s + 3.1) }),
    tx({ kind: "tool.start", title: "Read", toolUseId: `r${n}`, parentToolUseId: `a${n}`, at: T(s + 4) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: `a${n}`, at: T(s + 5) }),
  ];

  it("is the first pass, not the second", () => {
    const view = foldLiveSession(workflow, run(), [...visit("implement", 1, 1), ...visit("test", 2, 7)]);
    expect(view.blocks.implement).toMatchObject({ state: "done", passes: 1 });
    expect(view.blocks.test).toMatchObject({ state: "running", passes: 1 });
    expect(view.spans.map((span) => [span.blockId, span.pass])).toEqual([
      ["implement", 1],
      ["test", 1],
    ]);
  });

  it("does not count the step still working as finished", () => {
    const journal = [...visit("implement", 1, 1), ...visit("test", 2, 7)];
    // Right after the second step's line: only the first is finished.
    const view = foldLiveSession(workflow, run(), journal.slice(0, 6 + 4));
    expect(view.blocks.test.state).toBe("running");
    expect(finishedSteps(view)).toBe(1);
  });

  it("still counts a real return to a step, done the same way, as its second pass", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      ...visit("implement", 1, 1),
      ...visit("test", 2, 7),
      ...visit("fix", 3, 13),
      ...visit("test", 4, 19),
    ]);
    expect(view.blocks.implement.passes).toBe(1);
    expect(view.blocks.fix.passes).toBe(1);
    expect(view.blocks.test.passes).toBe(2);
    // The second pass began when its subagent was started, and the first
    // was not stretched over the fix in between.
    const tests = view.spans.filter((span) => span.blockId === "test");
    expect(tests.map((span) => span.pass)).toEqual([1, 2]);
    expect(tests[0].endedAt).toBe(T(16.1));
    expect(tests[1].startedAt).toBe(T(20.7));
  });

  it("is no detour and moves the session onto the step", () => {
    const view = foldLiveSession(workflow, run(), [...visit("implement", 1, 1), ...visit("test", 2, 7)]);
    expect(view.detours).toEqual([]);
    expect(view.activeBlockId).toBe("test");
  });
});

/*
  ANT-179. Codex announced three parallel checks, spawned a checker for
  each, and when the results came back announced each check again to report
  it — as the prompt asks, "each time you come back to it". Two of the three
  were drawn as pass 2, though no connection can lead back into them.
*/
describe("a parallel branch announced again to report its result", () => {
  const fork: Workflow = {
    id: "workflow-fork",
    name: "Checks in parallel",
    version: "1",
    target: "codex",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "prep", type: "agent", name: "Prepare checks", config: { actionKind: "agent-step", task: "Prepare", agentId: "agent-dev" } },
      { id: "chk-a", type: "agent", name: "Check: import", config: { actionKind: "verify", task: "a", agentId: "agent-qa" } },
      { id: "chk-b", type: "agent", name: "Check: values", config: { actionKind: "verify", task: "b", agentId: "agent-qa" } },
      { id: "chk-c", type: "agent", name: "Check: files", config: { actionKind: "verify", task: "c", agentId: "agent-qa" } },
      { id: "sum", type: "agent", name: "Summarize", config: { actionKind: "agent-step", task: "Sum up", agentId: "agent-dev" } },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "prep" },
      { id: "e2", source: "prep", target: "chk-a" },
      { id: "e3", source: "prep", target: "chk-b" },
      { id: "e4", source: "prep", target: "chk-c" },
      { id: "e5", source: "chk-a", target: "sum" },
      { id: "e6", source: "chk-b", target: "sum" },
      { id: "e7", source: "chk-c", target: "sum" },
      { id: "e8", source: "sum", target: "end" },
    ],
    metadata: {
      workflow: { formatVersion: 4, agents: [{ id: "agent-dev", name: "Developer" }, { id: "agent-qa", name: "Checker" }] },
    },
  };

  /*
    ANT-203: Codex announced the three checks together, then spawned their
    subagents one after another. Its spawn_agent hands the task over
    encrypted, so no spawn names a step; each subagent's own messages do.
  */
  describe("spawned by Codex, whose spawns name no step", () => {
    const T = (s: number) => new Date(Date.parse("2026-09-29T03:48:40.000Z") + s * 1000).toISOString();
    const rollout = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
      event({ cli: "codex", source: "rollout", channel: "codex:rollout", ...partial });
    const spawn = (call: string, at: number) => [
      rollout({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: call, background: true, at: T(at) }),
      rollout({ kind: "tool.end", title: "Tool finished", toolUseId: call, background: true, at: T(at + 0.1) }),
    ];
    const says = (call: string, tag: string, at: number) =>
      rollout({ kind: "message", title: "Message", detail: "Checking.", stepTag: tag, parentToolUseId: call, author: { kind: "subagent", name: call }, at: T(at) });
    const ends = (call: string, at: number) =>
      rollout({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: call, author: { kind: "subagent", name: call }, at: T(at) });
    const journal = [
      rollout({ kind: "step.marker", title: "Step prep", blockId: "prep", at: T(0) }),
      rollout({ kind: "tool.start", title: "exec_command", toolUseId: "own", at: T(1) }),
      rollout({ kind: "step.marker", title: "Step chk-a", blockId: "chk-a", at: T(8) }),
      rollout({ kind: "step.marker", title: "Step chk-b", blockId: "chk-b", at: T(8) }),
      rollout({ kind: "step.marker", title: "Step chk-c", blockId: "chk-c", at: T(8) }),
      ...spawn("call-a", 10),
      says("call-a", "chk-a", 11),
      ...spawn("call-b", 12),
      says("call-b", "chk-b", 13),
      ...spawn("call-c", 14),
      says("call-c", "chk-c", 15),
      ends("call-a", 17),
      ends("call-b", 20),
      ends("call-c", 33),
    ];

    it("gives each check its own subagent, not the last one announced", () => {
      const view = foldLiveSession(fork, run(), journal);
      expect(view.blocks["chk-a"].state).toBe("done");
      expect(view.blocks["chk-b"].state).toBe("done");
      // Each ran for as long as its own subagent did.
      expect(view.blocks["chk-a"].spentMs).toBe(9_000);
      expect(view.blocks["chk-b"].spentMs).toBe(12_000);
    });

    it("draws a check working while its subagent is out", () => {
      const view = foldLiveSession(fork, run(), journal.slice(0, 12));
      expect(view.blocks["chk-a"].state).toBe("running");
      expect(view.blocks["chk-b"].state).toBe("running");
    });

    it("puts a subagent's work on the step it names", () => {
      const view = foldLiveSession(fork, run(), [
        ...journal.slice(0, 7),
        rollout({ kind: "tool.start", title: "exec_command", toolUseId: "a-own", parentToolUseId: "call-a", at: T(10.5) }),
        ...journal.slice(7),
      ]);
      const work = view.events.find((item) => item.toolUseId === "a-own");
      expect(work?.mapping.blockId).toBe("chk-a");
    });
  });

  it("is the same pass, not a second", () => {
    const view = foldLiveSession(fork, run(), [
      step("prep"), worked(),
      step("chk-a"), worked(),
      step("chk-b"), worked(),
      step("chk-c"), worked(),
      step("chk-b"), worked(),
      step("chk-c"), worked(),
      step("sum"), worked(),
    ]);
    for (const id of ["chk-a", "chk-b", "chk-c"]) expect(view.blocks[id].passes).toBe(1);
    expect(view.detours).toEqual([]);
  });

  it("still counts a return from a later step as a second pass", () => {
    const view = foldLiveSession(fork, run(), [
      step("prep"), worked(),
      step("chk-a"), worked(),
      step("sum"), worked(),
      step("chk-a"), worked(),
    ]);
    expect(view.blocks["chk-a"].passes).toBe(2);
  });
});

/*
  ANT-176. The agent reached the Decide gate, asked its question and ended its
  turn; `claude -p` exited, the hooks wrote Stop and SessionEnd and no
  Notification. The gate was drawn Done, and the report read as approved,
  though nobody had answered.
*/
describe("a session that stopped at an Approval Gate", () => {
  const gated: Workflow = {
    ...workflow,
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "implement", type: "agent", name: "Research", config: { actionKind: "agent-step", task: "Look", agentId: "agent-dev" } },
      { id: "decide", type: "approval", name: "Decide", config: { prompt: "Which way?" } },
      { id: "test", type: "agent", name: "Present", config: { actionKind: "agent-step", task: "Present", agentId: "agent-dev" } },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "implement" },
      { id: "e2", source: "implement", target: "decide" },
      { id: "e3", source: "decide", target: "test", label: "Approved" },
      { id: "e4", source: "decide", target: "end", label: "Rejected", kind: "stop" },
      { id: "e5", source: "test", target: "end" },
    ],
  };
  const hookTurnEnd = () => event({ kind: "turn.end", title: "The agent finished its turn" });

  it("stays waiting on you when the turn and the session end there", () => {
    const view = foldLiveSession(gated, run({ state: "completed" }), [
      step("implement"), worked(),
      step("decide"),
      hookTurnEnd(),
      event({ kind: "session.end", title: "Session ended" }),
    ]);
    expect(view.blocks.decide.state).toBe("needsYou");
    expect(view.blocks.decide.note).toContain("nobody answered");
    expect(view.blocks.implement.state).toBe("done");
  });

  it("is passed once the next step is announced", () => {
    const view = foldLiveSession(gated, run({ state: "completed" }), [
      step("implement"), worked(),
      step("decide"),
      hookTurnEnd(),
      step("test"), worked(),
      hookTurnEnd(),
    ]);
    expect(view.blocks.decide.state).toBe("done");
  });

  it("is settled by the session's own word that the work is done", () => {
    const view = foldLiveSession(gated, run({ state: "completed" }), [
      step("implement"), worked(),
      step("decide"),
      event({ kind: "session.end", title: "The harness reported the work as finished", completion: "done", source: "transcript", channel: "claude-code:transcript" }),
    ]);
    expect(view.blocks.decide.state).toBe("done");
  });
});

/*
  ANT-190. Two parallel Developer subagents were sent off on their own and
  stopped by hand from Claude Code's Background tasks panel before either
  handed back. Their transcripts end "[Request interrupted by user]"; the
  steps must not end as done.
*/
describe("a subagent stopped by hand", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-27T23:25:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });

  it("ends its step failed, not done, even once the run completes", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
      tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-a", stepTag: "implement", background: true, at: T(1) }),
      tx({ kind: "tool.end", title: "Tool finished", toolUseId: "call-a", background: true, at: T(1.2) }),
      tx({ kind: "step.marker", title: "Step test", blockId: "test", at: T(2) }),
      tx({ kind: "tool.start", title: "Edit", toolUseId: "own", at: T(3) }),
      tx({ kind: "notification", title: "Stopped by hand", parentToolUseId: "call-a", at: T(40) }),
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(45) }),
    ]);
    expect(view.blocks.implement.state).toBe("failed");
    expect(view.blocks.implement.note).toContain("stopped by hand");
    // A stopped step is not a finished one.
    expect(finishedSteps(view)).toBe(0);
  });

  it("leaves a subagent that finished its turn done", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
      tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-a", stepTag: "implement", background: true, at: T(1) }),
      tx({ kind: "tool.end", title: "Tool finished", toolUseId: "call-a", background: true, at: T(1.2) }),
      tx({ kind: "step.marker", title: "Step test", blockId: "test", at: T(2) }),
      tx({ kind: "tool.start", title: "Edit", toolUseId: "own", at: T(3) }),
      tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "call-a", author: { kind: "subagent" }, at: T(40) }),
    ]);
    expect(view.blocks.implement.state).toBe("done");
  });
});

/*
  W9 in the 0.8.3 QA: the session sent two subagents off on their own, ended
  its turn waiting for them, and was killed. Neither handed back, and both
  steps were drawn green and counted as finished.
*/
/*
  W15 in the 0.8.3 QA: two checkers sent off on their own. Claude Code wrote
  the Quantity Checker's last message with no stop reason, so its transcript
  never recorded the end of its turn — only the SubagentStop hook said it was
  over, naming no subagent. Its step stayed "Working" for a minute after the
  session had both verdicts and moved on.
*/
describe("a subagent whose end only the SubagentStop hook records", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-28T03:59:45.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const hook = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "hook", channel: "claude-code:hook", ...partial });
  const sub = { kind: "subagent" as const };

  const dispatch = [
    tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
    tx({ kind: "step.marker", title: "Step test", blockId: "test", at: T(0.1) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "qty", stepTag: "implement", background: true, at: T(4) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "qty", background: true, at: T(4.1) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "name", stepTag: "test", background: true, at: T(6) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "name", background: true, at: T(6.1) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", at: T(8) }),
  ];

  it("is over when the hook says a subagent stopped, right after it last spoke", () => {
    const view = foldLiveSession(workflow, run({ state: "detected_live" }), [
      ...dispatch,
      tx({ kind: "tool.start", title: "Read", toolUseId: "n1", parentToolUseId: "name", author: sub, at: T(9) }),
      tx({ kind: "message", title: "Message", detail: "Qty column verdict: PASS", parentToolUseId: "qty", author: sub, at: T(11) }),
      hook({ kind: "subagent.end", title: "A subagent finished", at: T(11.4) }),
    ]);
    expect(view.blocks.implement.state).toBe("done");
    // The other one is still at work.
    expect(view.blocks.test.state).toBe("running");
  });

  it("leaves a running subagent alone when the stop was owed to one whose end was recorded", () => {
    const view = foldLiveSession(workflow, run({ state: "detected_live" }), [
      ...dispatch,
      tx({ kind: "tool.start", title: "Read", toolUseId: "q1", parentToolUseId: "qty", author: sub, at: T(12) }),
      tx({ kind: "message", title: "Message", detail: "Name check complete", parentToolUseId: "name", author: sub, at: T(13) }),
      tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "name", author: sub, at: T(13) }),
      hook({ kind: "subagent.end", title: "A subagent finished", at: T(13.8) }),
    ]);
    // Its stop was the Name Checker's, whose end was already recorded; the
    // Quantity Checker, heard from a second earlier, is still at work.
    expect(view.blocks.implement.state).toBe("running");
  });
});

describe("a session that ends with its subagents still out", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-28T03:33:40.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const hook = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "hook", channel: "claude-code:hook", ...partial });

  const killed = [
    tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-a", stepTag: "implement", background: true, at: T(7) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "call-a", background: true, at: T(8) }),
    tx({ kind: "message", title: "Message", detail: "The Developer is running.", author: { kind: "main" }, at: T(14) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", at: T(14) }),
    hook({ kind: "session.end", title: "Session ended", at: T(16) }),
  ];

  it("does not call the step done: nothing came back from it", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), killed);
    expect(view.blocks.implement.state).toBe("unknown");
    expect(view.blocks.implement.note).toContain("never handed back");
    expect(finishedSteps(view)).toBe(0);
  });

  it("still calls it done once the subagent has finished its turn", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      ...killed.slice(0, 3),
      tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "call-a", author: { kind: "subagent" }, at: T(12) }),
      ...killed.slice(3),
    ]);
    expect(view.blocks.implement.state).toBe("done");
  });
});

/*
  ANT-204, W9 in the 0.8.4 QA: two parallel steps both sent off to subagents,
  then the session itself interrupted by hand while its subagents worked. The
  main session's "Stopped by hand" was read as a question to a person, and the
  last step announced was left "Waiting on you" after the run ended.
*/
describe("a session stopped by hand", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-29T04:10:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });

  const delegatedBoth = [
    tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
    tx({ kind: "step.marker", title: "Step test", blockId: "test", at: T(0.1) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-a", stepTag: "implement", background: true, at: T(3) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "call-a", background: true, at: T(3.1) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-b", stepTag: "test", background: true, at: T(4) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "call-b", background: true, at: T(4.1) }),
    tx({ kind: "tool.start", title: "Read", toolUseId: "own", at: T(5) }),
  ];
  const stopped = tx({ kind: "notification", title: "Stopped by hand", at: T(6) });

  it("leaves no step waiting on you once the run ends", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [...delegatedBoth, stopped]);
    expect(view.blocks.implement.state).toBe("unknown");
    expect(view.blocks.test.state).toBe("unknown");
    expect(view.blocks.test.note).toContain("never handed back");
  });

  it("is not presented as a question while the session is still open", () => {
    const view = foldLiveSession(workflow, run(), [...delegatedBoth, stopped]);
    expect(view.blocks.test.state).toBe("needsYou");
    expect(view.blocks.test.waitReason).not.toBe("asked");
    expect(view.blocks.test.note).toContain("stopped by hand");
  });

  it("ends a step the session itself was working on as stopped, not done", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
      tx({ kind: "tool.start", title: "Edit", toolUseId: "own", at: T(1) }),
      stopped,
    ]);
    expect(view.blocks.implement.state).toBe("failed");
    expect(view.blocks.implement.note).toContain("stopped by hand");
  });

  // ANT-208: a stop closes the run as observation_lost, and that is not the
  // same as Anthill losing sight of it.
  it("reads as stopped, not lost, once the stop closes the run", () => {
    const lost = run({ state: "observation_lost" });
    const own = foldLiveSession(workflow, lost, [
      tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
      tx({ kind: "tool.start", title: "Edit", toolUseId: "own", at: T(1) }),
      stopped,
    ]);
    expect(own.blocks.implement.state).toBe("failed");
    expect(own.blocks.implement.note).toContain("stopped by hand");

    const delegated = foldLiveSession(workflow, lost, [...delegatedBoth, stopped]);
    expect(delegated.blocks.implement.state).toBe("unknown");
    expect(delegated.blocks.test.state).toBe("unknown");
    expect(delegated.blocks.test.note).toContain("never handed back");
  });

  it("still reads as lost when nobody stopped it", () => {
    const view = foldLiveSession(workflow, run({ state: "observation_lost" }), [
      tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
      tx({ kind: "tool.start", title: "Edit", toolUseId: "own", at: T(1) }),
    ]);
    expect(view.blocks.implement.state).toBe("unknown");
    expect(view.blocks.implement.note).toContain("stopped being able to read");
  });

  it("goes back to working when the person sets it going again", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
      tx({ kind: "tool.start", title: "Edit", toolUseId: "own", at: T(1) }),
      stopped,
      tx({ kind: "tool.start", title: "Edit", toolUseId: "own-2", at: T(20) }),
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(30) }),
      event({ kind: "session.end", title: "The harness reported the work as finished", completion: "done", source: "transcript", channel: "claude-code:transcript", at: T(31) }),
    ]);
    expect(view.blocks.implement.state).toBe("done");
  });
});
