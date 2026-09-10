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
import { foldLiveSession, hasStepEvidence } from "./live-session.js";
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
      how: "test-runner — mapped by agent name",
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

    it("is not declared finished by a run that went quiet", () => {
      // `completed` is read from a terminal stop reason plus a long silence,
      // which is this exact session: the silence is the person not having
      // answered yet. The step's own record outranks that inference.
      const view = foldLiveSession(workflow, run({ state: "completed" }), [
        step("implement"),
        turnEnd(),
      ]);
      expect(view.blocks.implement.state).toBe("needsYou");
    });

    it("still finishes a step the agent left running", () => {
      const view = foldLiveSession(workflow, run({ state: "completed" }), [step("implement")]);
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

  it("leaves the total alone when the clocks cannot support it", () => {
    // Stamps can arrive out of order across channels; a departure that reads
    // as earlier than the arrival is not a negative duration, it is no
    // measurement at all.
    const view = foldLiveSession(workflow, run(), [
      marker("implement", 300_000),
      marker("test", 60_000),
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
