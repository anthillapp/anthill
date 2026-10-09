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

import { attribute, buildWorkflowIndex, stepForAgent } from "./attribution.js";
import { finishedSteps, foldLiveSession, hasStepEvidence, helperStops, subagentStops } from "./live-session.js";
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

  it("does not count a step the agent is back in until that pass finishes (ANT-243)", () => {
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
    // "implement" is working on its second pass: the count is of what is
    // finished now, so it waits for that pass — as the step's own badge does.
    expect(again.blocks.implement).toMatchObject({ state: "running", passes: 2 });
    expect(finishedSteps(again)).toBe(2);
    const after = foldLiveSession(workflow, run(), [
      step("implement"),
      worked(),
      step("test"),
      worked(),
      step("fix"),
      worked(),
      step("implement"),
      worked(),
      step("test"),
    ]);
    // Its second pass over, "implement" counts again; "test" is now the step
    // reopened, and waits in its turn.
    expect(after.blocks.implement).toMatchObject({ state: "done", passes: 2 });
    expect(after.blocks.test).toMatchObject({ state: "running", passes: 2 });
    expect(finishedSteps(after)).toBe(2);
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
   * ANT-308. The session sent a long evaluation to run in the background,
   * said so and ended its turn. The step was put down as waiting on the person
   * while the command was still at work, and nothing ever moved it on.
   */
  describe("a turn that ends with a background command still running", () => {
    const turnEnd = () => event({ kind: "turn.end", title: "The agent finished its turn" });
    const sentOff = () =>
      event({
        kind: "tool.start",
        title: "Bash",
        toolName: "Bash",
        toolUseId: "toolu_bg",
        background: true,
        source: "transcript",
        channel: "claude-code:transcript",
      });
    const ended = () =>
      event({
        kind: "task.end",
        title: "Background task finished",
        toolUseId: "toolu_bg",
        ok: true,
        source: "transcript",
        channel: "claude-code:transcript",
      });

    it("keeps the step working while the command runs", () => {
      const view = foldLiveSession(workflow, run(), [step("implement"), sentOff(), turnEnd()]);
      expect(view.blocks.implement.state).toBe("running");
    });

    it("hands the step over once the command has ended and the turn ends again", () => {
      const view = foldLiveSession(workflow, run(), [step("implement"), sentOff(), turnEnd(), ended(), turnEnd()]);
      expect(view.blocks.implement.state).toBe("needsYou");
    });
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

      /*
        ANT-255. A VS Code chat is found by the nonce in commands it runs after
        binding, so Anthill's note that it found it can land after the done
        line. That note is Anthill's own bookkeeping, not the session asking
        anybody anything, and it left the last step "Waiting on you".
      */
      it("does not take Anthill's own note as the session asking for a person", () => {
        const note = () =>
          event({
            kind: "notification",
            title: "VS Code chat found",
            source: "anthill",
            channel: "exchange:session-resolution",
          });
        const done = () =>
          event({
            kind: "session.end",
            title: "The harness reported the work as finished",
            source: "anthill",
            channel: "anthill:report",
            completion: "done",
          });
        const after = foldLiveSession(workflow, run({ state: "completed" }), [
          step("implement"),
          step("test"),
          worked(),
          done(),
          note(),
          hookTurnEnd(),
        ]);
        expect(after.blocks.test.state).toBe("done");
        expect(after.unmappedCount).toBe(0);

        const during = foldLiveSession(workflow, run(), [step("implement"), worked(), note()]);
        expect(during.blocks.implement.state).toBe("running");
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

    it("does not call checks the workflow forks into an overlap", () => {
      expect(foldLiveSession(fork, run(), journal).overlaps).toEqual([]);
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
  ANT-245, M5 of the 0.8.8-next QA. Claude Code's subagents hand back with a
  SubagentHandback call. Two specialists sent off on their own each ended a
  turn to wait on a background command, with nothing handed back; one was then
  stopped by hand. Both steps were drawn Done — the stopped one beside a card
  saying it was stopped.
*/
describe("a subagent that ends a turn before it hands back", () => {
  const T = (s: number) => new Date(Date.parse("2026-10-03T21:09:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const hook = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "hook", channel: "claude-code:hook", ...partial });
  const sub = { kind: "subagent" as const };
  const of = (call: string) => ({ parentToolUseId: call, agentId: `agent-${call}`, author: sub });

  /** A coordinator that handed back, then two specialists sent off together. */
  const dispatched = [
    tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "coord", stepTag: "implement", at: T(1) }),
    tx({ kind: "tool.start", title: "SubagentHandback", toolName: "SubagentHandback", toolUseId: "hb-coord", ...of("coord"), at: T(4) }),
    hook({ kind: "subagent.end", title: "A subagent finished", agentId: "agent-coord", at: T(4.5) }),
    tx({ kind: "tool.end", title: "Agent", toolUseId: "coord", at: T(4.6) }),
    tx({ kind: "step.marker", title: "Step fix", blockId: "fix", at: T(5) }),
    tx({ kind: "step.marker", title: "Step test", blockId: "test", at: T(5.05) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "a", stepTag: "test", background: true, at: T(6) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "a", background: true, at: T(6.1) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "b", stepTag: "fix", background: true, at: T(7) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "b", background: true, at: T(7.1) }),
    // Each starts a command in the background and ends its turn to wait on it.
    tx({ kind: "tool.start", title: "Bash", toolUseId: "a-sleep", ...of("a"), at: T(8) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "a-sleep", ...of("a"), at: T(8.5) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", ...of("a"), at: T(20) }),
    hook({ kind: "subagent.end", title: "A subagent finished", agentId: "agent-a", at: T(20.2) }),
    tx({ kind: "tool.start", title: "Monitor", toolUseId: "b-wait", ...of("b"), at: T(9) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "b-wait", ...of("b"), at: T(9.5) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", ...of("b"), at: T(25) }),
    hook({ kind: "subagent.end", title: "A subagent finished", agentId: "agent-b", at: T(25.2) }),
  ];

  it("keeps the step working while its subagent waits on its own command", () => {
    const view = foldLiveSession(workflow, run(), dispatched);
    expect(view.blocks.test.state).toBe("running");
    expect(view.blocks.fix.state).toBe("running");
    expect(finishedSteps(view)).toBe(1);
  });

  it("ends a step whose subagent was stopped by hand failed, not done", () => {
    const view = foldLiveSession(workflow, run(), [
      ...dispatched,
      tx({ kind: "notification", title: "Stopped by hand", ...of("b"), at: T(29) }),
    ]);
    expect(view.blocks.fix.state).toBe("failed");
    expect(view.blocks.fix.note).toContain("stopped by hand");
    expect(view.blocks.test.state).toBe("running");
  });

  it("finishes the step when the subagent hands back", () => {
    const view = foldLiveSession(workflow, run(), [
      ...dispatched,
      // Woken by its command, it checks the result and hands back.
      tx({ kind: "tool.start", title: "Bash", toolUseId: "b-check", ...of("b"), at: T(40) }),
      tx({ kind: "tool.end", title: "Tool finished", toolUseId: "b-check", ...of("b"), at: T(41) }),
      tx({ kind: "tool.start", title: "SubagentHandback", toolName: "SubagentHandback", toolUseId: "hb-b", ...of("b"), at: T(45) }),
      hook({ kind: "subagent.end", title: "A subagent finished", agentId: "agent-b", at: T(45.5) }),
    ]);
    expect(view.blocks.fix.state).toBe("done");
    expect(view.blocks.test.state).toBe("running");
  });

  it("leaves a step whose subagent never handed back unknown when the session is stopped", () => {
    const view = foldLiveSession(workflow, run({ state: "observation_lost" }), [
      ...dispatched,
      tx({ kind: "notification", title: "Stopped by hand", at: T(36) }),
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(37) }),
    ]);
    expect(view.blocks.test.state).not.toBe("done");
    expect(view.blocks.fix.state).not.toBe("done");
    expect(finishedSteps(view)).toBe(1);
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

/*
  ANT-215. A plugin-bound run reported itself done through \`anthill done\`,
  then read its workflow back with the plugin's get_workflow. That call put
  the last step back to Working, and the run to Live.
*/
describe("a run read back through Anthill's own tools after it said it was done", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-30T06:00:28.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });

  it("stays done", () => {
    const view = foldLiveSession(workflow, run(), [
      event({ kind: "step.marker", title: "Step announced implement", blockId: "implement", source: "anthill", channel: "anthill:report", at: T(0) }),
      tx({ kind: "tool.start", title: "Write", toolName: "Write", toolUseId: "w", at: T(5) }),
      event({ kind: "step.marker", title: "Step announced test", blockId: "test", source: "anthill", channel: "anthill:report", at: T(20) }),
      tx({ kind: "tool.start", title: "Read", toolName: "Read", toolUseId: "r", at: T(25) }),
      event({ kind: "session.end", title: "The harness reported the work as finished", completion: "done", source: "anthill", channel: "anthill:report", at: T(40) }),
      tx({ kind: "tool.start", title: "mcp__plugin_anthill_exchange__get_workflow", toolName: "mcp__plugin_anthill_exchange__get_workflow", toolUseId: "g", at: T(41) }),
      tx({ kind: "tool.end", title: "Tool finished", toolName: "mcp__plugin_anthill_exchange__get_workflow", toolUseId: "g", at: T(43) }),
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(50) }),
    ]);
    expect(view.blocks.test.state).toBe("done");
    expect(view.activeBlockIds).toEqual([]);
  });
});

/*
  ANT-218, W5/W18 in the 0.8.5 QA. Claude Code reused the Developer and the
  Tester through SendMessage for the Fix stage and the second check. The
  Developer's Fix work carried the id of the call that first started it for
  Implement, and was filed there. After the done line, Claude Code's own
  helper fired one hook-only Bash call, which put the last step back to
  Working.
*/
describe("subagents reused for a later step", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-30T07:03:40.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const sub = { kind: "subagent" as const };
  const journal = [
    step("implement"),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "dev", stepTag: "implement", at: T(1) }),
    tx({ kind: "tool.start", title: "Write", toolUseId: "w1", parentToolUseId: "dev", author: sub, at: T(6) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "dev", author: sub, at: T(14) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "dev", at: T(14.5) }),
    step("test"),
    tx({ kind: "tool.start", title: "Read", toolUseId: "r1", at: T(25) }),
    step("fix"),
    tx({ kind: "tool.start", title: "SendMessage", toolName: "SendMessage", toolUseId: "send", at: T(40) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "send", at: T(42) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", at: T(45) }),
    tx({ kind: "tool.start", title: "Edit", toolUseId: "e1", parentToolUseId: "dev", author: sub, at: T(46) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "dev", author: sub, at: T(54) }),
  ];

  it("files the reused agent's work under the step it was reused for", () => {
    const view = foldLiveSession(workflow, run(), journal);
    const edit = view.events.find((item) => item.toolUseId === "e1");
    expect(edit?.mapping.blockId).toBe("fix");
    const write = view.events.find((item) => item.toolUseId === "w1");
    expect(write?.mapping.blockId).toBe("implement");
  });

  it("holds that step open while the reused agent works", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), journal.slice(0, 12));
    expect(view.blocks.fix.state).toBe("unknown");
    expect(view.blocks.fix.note).toContain("never handed back");
  });

  it("is not put back to work by a hook-only call after the done line", () => {
    const view = foldLiveSession(workflow, run(), [
      ...journal,
      event({ kind: "session.end", title: "The harness reported the work as finished", completion: "done", source: "transcript", channel: "claude-code:transcript", at: T(60) }),
      event({ kind: "tool.start", title: "Bash", toolName: "Bash", toolUseId: "helper", source: "hook", channel: "claude-code:hook", at: T(64) }),
    ]);
    expect(view.blocks.fix.state).toBe("done");
    expect(view.activeBlockIds).toEqual([]);
  });
});

/*
  ANT-217, a plugin watch run in the 0.8.5 QA. Two parallel writers announced
  together; the session then wrote the agent files itself, and dispatched both
  writers in the background with no step tag — only the agent's name as the
  description. The Caption step was closed "Done · took 287ms" by the session's
  own setup work, both dispatches went to the Theme step, and the Stop left
  Captions green with its writer still running.
*/
describe("parallel writers dispatched with no step tag", () => {
  const writers: Workflow = {
    ...workflow,
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "captions", type: "agent", name: "Write captions", config: { actionKind: "agent-step", task: "a", agentId: "agent-caption" } },
      { id: "themes", type: "agent", name: "Write themes", config: { actionKind: "agent-step", task: "b", agentId: "agent-theme" } },
      { id: "review", type: "agent", name: "Review", config: { actionKind: "verify", task: "c", agentId: "agent-review" } },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "captions" },
      { id: "e2", source: "start", target: "themes" },
      { id: "e3", source: "captions", target: "review" },
      { id: "e4", source: "themes", target: "review" },
      { id: "e5", source: "review", target: "end" },
    ],
    metadata: {
      workflow: {
        formatVersion: 4,
        agents: [
          { id: "agent-caption", name: "Caption Writer" },
          { id: "agent-theme", name: "Theme Writer" },
          { id: "agent-review", name: "Reviewer" },
        ],
      },
    },
  };
  const T = (s: number) => new Date(Date.parse("2026-09-30T06:48:40.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const report = (blockId: string, s: number) =>
    event({ kind: "step.marker", title: `Step announced ${blockId}`, blockId, source: "anthill", channel: "anthill:report", at: T(s) });
  const dispatched = [
    report("captions", 0),
    report("themes", 0.3),
    tx({ kind: "tool.start", title: "Bash", toolName: "Bash", toolUseId: "setup", at: T(27) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "setup", at: T(28) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "cap", agentName: "general-purpose", detail: "Caption Writer", background: true, at: T(34) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "thm", agentName: "general-purpose", detail: "Theme Writer", background: true, at: T(38) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "thm", background: true, at: T(39) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "cap", background: true, at: T(39) }),
    tx({ kind: "tool.start", title: "Read", toolName: "Read", toolUseId: "cap-read", parentToolUseId: "cap", author: { kind: "subagent" }, at: T(41) }),
  ];
  const stopped = tx({ kind: "notification", title: "Stopped by hand", at: T(50) });

  it("sends each writer to the step its agent belongs to", () => {
    const view = foldLiveSession(writers, run(), dispatched);
    const cards = view.events.filter((item) => item.kind === "subagent.start");
    expect(cards.map((card) => card.mapping.blockId)).toEqual(["captions", "themes"]);
    expect(view.events.find((item) => item.toolUseId === "cap-read")?.mapping.blockId).toBe("captions");
  });

  it("keeps a writer's step open while the writer works, as the same pass", () => {
    const view = foldLiveSession(writers, run(), dispatched);
    expect(view.blocks.captions.state).toBe("running");
    expect(view.blocks.captions.passes).toBe(1);
    expect(view.blocks.themes.state).toBe("running");
  });

  it("claims no finish for either writer when the session is stopped", () => {
    const view = foldLiveSession(writers, run({ state: "observation_lost" }), [...dispatched, stopped]);
    expect(view.blocks.captions.state).toBe("unknown");
    expect(view.blocks.themes.state).toBe("unknown");
    expect(finishedSteps(view)).toBe(0);
  });
});

/*
  ANT-220, W13 through the Claude plugin in the 0.8.5 QA. The Writer's Write
  of SUMMARY.md was refused by Claude Code; the file was never written, the
  session was stopped and said the run was not completed, and never reported
  done. The run went quiet and the Writer step was settled Done.
*/
describe("a step whose work failed and the run went quiet", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-30T07:12:54.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const sub = { kind: "subagent" as const };
  const refused = [
    step("implement"),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "writer", stepTag: "implement", at: T(5) }),
    tx({ kind: "tool.start", title: "Write", toolName: "Write", toolUseId: "w1", parentToolUseId: "writer", author: sub, at: T(12) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "w1", ok: false, parentToolUseId: "writer", author: sub, at: T(12.1) }),
    tx({ kind: "tool.start", title: "SubagentHandback", toolName: "SubagentHandback", toolUseId: "h1", parentToolUseId: "writer", author: sub, at: T(22) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "h1", ok: true, parentToolUseId: "writer", author: sub, at: T(23) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "writer", author: sub, at: T(25) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "writer", ok: true, at: T(30) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", at: T(60) }),
    // The hooks carried this run: the Stop hook says only that the turn ended.
    event({ kind: "turn.end", title: "The agent finished its turn", source: "hook", channel: "claude-code:hook", at: T(60.5) }),
  ];

  it("is not called done", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), refused);
    expect(view.blocks.implement.state).toBe("unknown");
    expect(view.blocks.implement.note).toContain("Write call in this step failed");
    expect(finishedSteps(view)).toBe(0);
  });

  it("is done once the same tool was made to work", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      ...refused.slice(0, 4),
      tx({ kind: "tool.start", title: "Write", toolName: "Write", toolUseId: "w2", parentToolUseId: "writer", author: sub, at: T(14) }),
      tx({ kind: "tool.end", title: "Tool finished", toolUseId: "w2", ok: true, parentToolUseId: "writer", author: sub, at: T(14.1) }),
      ...refused.slice(4),
    ]);
    expect(view.blocks.implement.state).toBe("done");
  });

  it("is done when the session said the work was done", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      ...refused,
      event({ kind: "session.end", title: "The harness reported the work as finished", completion: "done", source: "transcript", channel: "claude-code:transcript", at: T(61) }),
    ]);
    expect(view.blocks.implement.state).toBe("done");
  });

  // The Writer was then reused through SendMessage. Started in the
  // foreground, its call had already returned, and would never again.
  it("settles a reused foreground agent when its turn ends", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [
      ...refused.slice(0, 8),
      tx({ kind: "tool.start", title: "SubagentHandback", toolName: "SubagentHandback", toolUseId: "h2", parentToolUseId: "writer", author: sub, at: T(48) }),
      tx({ kind: "tool.end", title: "Tool finished", toolUseId: "h2", ok: true, parentToolUseId: "writer", author: sub, at: T(49) }),
      tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "writer", author: sub, at: T(51) }),
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(60) }),
    ]);
    expect(view.blocks.implement.note).not.toContain("never handed back");
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

  /*
    ANT-241. Codex writes turn_aborted into each subagent's own file as well
    as the session's, so one press of Stop reads as the session stopped and
    every subagent stopped by hand too. That is the session's stop reaching
    them, not somebody stopping a subagent (ANT-190): their steps were drawn
    Failed, when what they got through is simply not in the record.
  */
  describe("with its subagents stopped along with it", () => {
    const theirs = (call: string, s: number) =>
      tx({ kind: "notification", title: "Stopped by hand", parentToolUseId: call, author: { kind: "subagent", name: "Tester" }, at: T(s) });

    it("leaves their steps unknown, never failed, whichever is read first", () => {
      for (const stops of [
        [stopped, theirs("call-a", 6.3), theirs("call-b", 6.6)],
        [theirs("call-a", 5.7), stopped, theirs("call-b", 6.4)],
        [theirs("call-a", 5.7), theirs("call-b", 5.9), stopped],
      ]) {
        for (const state of ["observation_lost", "completed"] as const) {
          const view = foldLiveSession(workflow, run({ state }), [...delegatedBoth, ...stops]);
          expect(view.blocks.implement.state).toBe("unknown");
          expect(view.blocks.test.state).toBe("unknown");
          expect(view.blocks.implement.note).toContain("never handed back");
          expect(view.blocks.test.note).toContain("never handed back");
        }
      }
    });

    it("is not presented as a question while the session is still open", () => {
      const view = foldLiveSession(workflow, run(), [...delegatedBoth, stopped, theirs("call-a", 6.3), theirs("call-b", 6.6)]);
      expect(view.blocks.test.state).toBe("needsYou");
      expect(view.blocks.test.waitReason).not.toBe("asked");
      expect(view.blocks.implement.state).toBe("unknown");
    });

    it("still fails a step whose subagent was stopped on its own, long before", () => {
      const view = foldLiveSession(workflow, run({ state: "observation_lost" }), [...delegatedBoth.slice(0, -1), theirs("call-a", 4.5), tx({ kind: "tool.start", title: "Read", toolUseId: "own", at: T(20) }), tx({ kind: "notification", title: "Stopped by hand", at: T(30) })]);
      expect(view.blocks.implement.state).toBe("failed");
      expect(view.blocks.test.state).toBe("unknown");
    });
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

/*
  ANT-243, the DEV retest of ANT-218: "Implement, test, fix" run from a copied
  prompt in Claude Code. The Tester failed the first check, the Developer
  fixed it, and the agent went back to "Run tests" for a second pass. While
  that pass was still working the header read "3 of 3 steps finished". The
  journal below is that run's, in its recorded order, with the token-usage
  records and the duplicate hook copies of tool calls left out.
*/
describe("a rework step back for another pass, as the ANT-218 retest recorded it", () => {
  const T = (s: number) => new Date(Date.parse("2026-10-01T01:11:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const hook = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "hook", channel: "claude-code:hook", ...partial });
  const main = { kind: "main" as const };
  const developer = { kind: "subagent" as const, name: "Implement two-bullet safety card" };
  const tester = { kind: "subagent" as const, name: "Manually check safety card bullets" };
  /** The Bash call that prints a step's line, and the line, recorded when it returns. */
  const marker = (blockId: string, id: string, s: number, back: number) => [
    tx({ kind: "tool.start", title: "Bash", toolName: "Bash", toolUseId: id, at: T(s - back) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: id, at: T(s) }),
    tx({ kind: "step.marker", title: "Step announced", detail: blockId, blockId, printedBy: id, at: T(s) }),
  ];

  const journal = [
    tx({ kind: "prompt.submit", title: "The workflow was pasted in", at: T(4.258) }),
    hook({ kind: "session.start", title: "Session started", at: T(3.699) }),
    hook({ kind: "prompt.submit", title: "A prompt was submitted", at: T(4.379) }),
    // Implement: the Developer, sent off as a subagent.
    ...marker("implement", "m1", 23.903, 1.7),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolName: "Agent", toolUseId: "dev", agentName: "developer", stepTag: "implement", at: T(28.028) }),
    tx({ kind: "tool.start", title: "Write", toolName: "Write", toolUseId: "w1", parentToolUseId: "dev", at: T(33.601) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: "w1", parentToolUseId: "dev", at: T(33.912) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: "dev", at: T(38.449) }),
    tx({ kind: "message", title: "Message", detail: "Done.", parentToolUseId: "dev", author: developer, at: T(38.151) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "dev", author: developer, at: T(38.151) }),
    hook({ kind: "subagent.end", title: "A subagent finished", at: T(38.264) }),
    hook({ kind: "prompt.submit", title: "A prompt was submitted", at: T(38.569) }),
    tx({ kind: "message", title: "Message", detail: "The Implement step is done.", author: main, stepTag: "implement", at: T(40.717) }),
    // Run tests, pass 1: the Tester finds two bullets where three are wanted.
    ...marker("test", "m2", 42.824, 1.5),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolName: "Agent", toolUseId: "qa", agentName: "tester", stepTag: "test", at: T(47.001) }),
    tx({ kind: "tool.start", title: "Read", toolName: "Read", toolUseId: "r1", parentToolUseId: "qa", at: T(50.204) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: "r1", parentToolUseId: "qa", at: T(50.563) }),
    tx({ kind: "message", title: "Message", detail: "The first-pass check failed.", parentToolUseId: "qa", author: tester, at: T(55.579) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "qa", author: tester, at: T(55.579) }),
    hook({ kind: "subagent.end", title: "A subagent finished", at: T(55.704) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: "qa", at: T(55.891) }),
    hook({ kind: "prompt.submit", title: "A prompt was submitted", at: T(56.015) }),
    // Fix failures: the same Developer, resumed with SendMessage.
    ...marker("fix", "m3", 61.104, 1.1),
    tx({ kind: "tool.start", title: "SendMessage", toolName: "SendMessage", toolUseId: "s1", at: T(64.828) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: "s1", at: T(65.673) }),
    tx({ kind: "message", title: "Message", detail: "The Developer is adding the third bullet.", author: main, stepTag: "fix", at: T(67.329) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", at: T(67.329) }),
    tx({ kind: "tool.start", title: "Edit", toolName: "Edit", toolUseId: "e1", parentToolUseId: "dev", at: T(68.76) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: "e1", parentToolUseId: "dev", at: T(69.189) }),
    hook({ kind: "turn.end", title: "The agent finished its turn", at: T(68.41) }),
    hook({ kind: "subagent.end", title: "A subagent finished", at: T(71.629) }),
    tx({ kind: "message", title: "Message", detail: "I added a third bullet.", parentToolUseId: "dev", author: developer, stepTag: "fix", at: T(73.859) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "dev", author: developer, at: T(73.859) }),
    hook({ kind: "prompt.submit", title: "A prompt was submitted", at: T(72.22) }),
    hook({ kind: "subagent.end", title: "A subagent finished", at: T(73.989) }),
    tx({ kind: "message", title: "Message", detail: "Fix failures is done.", author: main, stepTag: "test", at: T(74.916) }),
    // Run tests, pass 2: the Tester, resumed, re-reads the file.
    ...marker("test", "m4", 76.555, 1.5),
    hook({ kind: "prompt.submit", title: "A prompt was submitted", at: T(76.693) }),
    tx({ kind: "tool.start", title: "SendMessage", toolName: "SendMessage", toolUseId: "s2", at: T(80.749) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: "s2", at: T(81.652) }),
    tx({ kind: "message", title: "Message", detail: "The Tester is re-reading the file.", author: main, stepTag: "test", at: T(83.015) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", at: T(83.015) }),
    tx({ kind: "tool.start", title: "Read", toolName: "Read", toolUseId: "r2", parentToolUseId: "qa", at: T(82.873) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: "r2", parentToolUseId: "qa", at: T(83.232) }),
    hook({ kind: "turn.end", title: "The agent finished its turn", at: T(83.954) }),
    // 18:12:25 PDT: the moment the header claimed all three steps finished.
    tx({ kind: "tool.start", title: "SubagentHandback", toolName: "SubagentHandback", toolUseId: "h2", parentToolUseId: "qa", at: T(85.279) }),
  ];
  const ending = [
    hook({ kind: "subagent.end", title: "A subagent finished", at: T(85.921) }),
    tx({ kind: "tool.end", title: "Tool finished", ok: true, toolUseId: "h2", parentToolUseId: "qa", at: T(86.542) }),
    hook({ kind: "prompt.submit", title: "A prompt was submitted", at: T(86.47) }),
    tx({ kind: "message", title: "Message", detail: "The pass 2 re-check passed.", parentToolUseId: "qa", author: tester, stepTag: "test", at: T(88.275) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "qa", author: tester, at: T(88.275) }),
    hook({ kind: "subagent.end", title: "A subagent finished", at: T(88.408) }),
    tx({ kind: "turn.end", title: "The agent finished its turn", at: T(98.384) }),
    tx({ kind: "session.end", title: "The harness reported the work as finished", author: main, completion: "done", at: T(98.392) }),
    tx({ kind: "message", title: "Message", detail: "The workflow is done.", author: main, stepTag: "test", at: T(98.392) }),
    hook({ kind: "session.end", title: "The harness reported the work as finished", completion: "done", at: T(99.937) }),
  ];

  it("does not count Run tests while its second pass is working", () => {
    const view = foldLiveSession(workflow, run(), journal);
    expect(view.blocks.implement).toMatchObject({ state: "done", passes: 1 });
    expect(view.blocks.fix).toMatchObject({ state: "done", passes: 1 });
    expect(view.blocks.test).toMatchObject({ state: "running", passes: 2 });
    expect(finishedSteps(view)).toBe(2);
  });

  it("counts it once the run reports the work done", () => {
    const view = foldLiveSession(workflow, run({ state: "completed" }), [...journal, ...ending]);
    expect(view.blocks.test).toMatchObject({ state: "done", passes: 2 });
    expect(finishedSteps(view)).toBe(3);
  });
});

/*
  ANT-242, a plugin watch run (ANT-ARRVQBQU) in Claude Code desktop. Two
  writers sent off in the background, each step reported through `anthill
  step`. The Theme step's report was made by a command issued before the
  Theme Writer's Agent call but recorded 0.7 s after it, so the dispatch went
  to the Caption step and the THEMES.md Write was "Confirmed · Write
  CAPTIONS.md". The session then ended its turn while both wrote, was prompted
  twice and stopped; each time Claude Code's own helper fired SubagentStop a
  moment later, and each was drawn "Theme Writer — Completed". After the Stop
  the steps read Unknown and Failed. Timings are the journal's.
*/
describe("background writers in a plugin-bound run, through turn endings and a Stop", () => {
  const writers: Workflow = {
    ...workflow,
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "caption-writer", type: "agent", name: "Write CAPTIONS.md", config: { actionKind: "agent-step", task: "a", agentId: "agent-caption" } },
      { id: "theme-writer", type: "agent", name: "Write THEMES.md", config: { actionKind: "agent-step", task: "b", agentId: "agent-theme" } },
      { id: "reviewer", type: "agent", name: "Review both files", config: { actionKind: "verify", task: "c", agentId: "agent-reviewer" } },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "caption-writer" },
      { id: "e2", source: "start", target: "theme-writer" },
      { id: "e3", source: "caption-writer", target: "reviewer" },
      { id: "e4", source: "theme-writer", target: "reviewer" },
      { id: "e5", source: "reviewer", target: "end" },
    ],
    metadata: {
      workflow: {
        formatVersion: 5,
        agents: [
          { id: "agent-caption", name: "Caption Writer" },
          { id: "agent-theme", name: "Theme Writer" },
          { id: "agent-reviewer", name: "Reviewer" },
        ],
      },
    },
  };
  const T = (s: number) => new Date(Date.parse("2026-10-01T01:08:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const hook = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "hook", channel: "claude-code:hook", ...partial });
  const report = (blockId: string, s: number) =>
    event({ kind: "step.marker", title: "Step announced", detail: blockId, blockId, source: "anthill", channel: "anthill:report", at: T(s) });
  const turnEnd = (s: number) => [
    tx({ kind: "turn.end", title: "The agent finished its turn", toolUseId: `msg-${s}`, at: T(s) }),
    hook({ kind: "turn.end", title: "The agent finished its turn", at: T(s + 0.14) }),
  ];
  /** Claude Code's own helper, ending after the session's turn. */
  const helper = (s: number) => hook({ kind: "subagent.end", title: "A subagent finished", at: T(s) });
  const byTheme = { parentToolUseId: "thm", author: { kind: "subagent" as const, name: "Theme Writer: THEMES.md" } };

  const journal = (themeDescription = "Theme Writer: THEMES.md") => [
    tx({ kind: "tool.start", title: "Bash", toolName: "Bash", toolUseId: "report-cap", detail: "Report run start and caption step", at: T(20.616) }),
    report("caption-writer", 21.828),
    hook({ kind: "tool.end", title: "Bash", toolName: "Bash", toolUseId: "report-cap", ok: true, at: T(21.953) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolName: "Agent", toolUseId: "cap", agentName: "general-purpose", detail: "Caption Writer: CAPTIONS.md", background: true, at: T(27.546) }),
    hook({ kind: "tool.end", title: "Agent", toolName: "Agent", toolUseId: "cap", ok: true, at: T(28.707) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "cap", ok: true, background: true, at: T(28.758) }),
    tx({ kind: "tool.start", title: "Bash", toolName: "Bash", toolUseId: "report-thm", detail: "Report theme writer step", at: T(30.523) }),
    tx({ kind: "usage", title: "Token usage recorded", parentToolUseId: "cap", tokens: { in: 49516, out: 8 }, at: T(32.08) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolName: "Agent", toolUseId: "thm", agentName: "general-purpose", detail: themeDescription, background: true, at: T(33.857) }),
    report("theme-writer", 34.555),
    hook({ kind: "tool.end", title: "Bash", toolName: "Bash", toolUseId: "report-thm", ok: true, at: T(34.69) }),
    hook({ kind: "tool.start", title: "Agent", toolName: "Agent", toolUseId: "thm", at: T(34.828) }),
    hook({ kind: "tool.end", title: "Agent", toolName: "Agent", toolUseId: "thm", ok: true, at: T(34.995) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "thm", ok: true, background: true, at: T(35.038) }),
    ...turnEnd(36.58),
    helper(38.419),
    tx({ kind: "usage", title: "Token usage recorded", ...byTheme, tokens: { in: 49498, out: 8 }, at: T(38.795) }),
    hook({ kind: "prompt.submit", title: "A prompt was submitted", at: T(56.073) }),
    ...turnEnd(63.469),
    helper(65.972),
    tx({ kind: "tool.start", title: "Write", toolName: "Write", toolUseId: "thm-write", detail: "THEMES.md", ...byTheme, at: T(77.756) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "thm-write", ok: true, ...byTheme, at: T(78.083) }),
    hook({ kind: "prompt.submit", title: "A prompt was submitted", at: T(84.342) }),
  ];
  const stop = [tx({ kind: "notification", title: "Stopped by hand", at: T(93.466) }), helper(95.022)];

  it("sends each writer's dispatch, and its work, to its own step", () => {
    const view = foldLiveSession(writers, run(), journal());
    const cards = view.events.filter((item) => item.kind === "subagent.start");
    expect(cards.map((card) => card.mapping.blockId)).toEqual(["caption-writer", "theme-writer"]);
    expect(view.events.find((item) => item.toolUseId === "thm-write")?.mapping).toMatchObject({
      blockId: "theme-writer",
    });
    expect(view.blocks["theme-writer"].passes).toBe(1);
  });

  it("goes by the step the session reported as it dispatched, when the description names no agent", () => {
    const view = foldLiveSession(writers, run(), journal("Write the themes file"));
    const card = view.events.find((item) => item.kind === "subagent.start" && item.toolUseId === "thm");
    expect(card?.mapping).toMatchObject({ blockId: "theme-writer", confidence: "likely" });
    expect(view.events.find((item) => item.toolUseId === "thm-write")?.mapping.blockId).toBe("theme-writer");
    expect(view.blocks["theme-writer"].passes).toBe(1);
  });

  it("does not take a step reported by a command issued after the dispatch", () => {
    const later = journal("Write the themes file").map((item) =>
      item.toolUseId === "report-thm" && item.kind === "tool.start" ? { ...item, at: T(34) } : item,
    );
    const view = foldLiveSession(writers, run(), later);
    const card = view.events.find((item) => item.kind === "subagent.start" && item.toolUseId === "thm");
    expect(card?.mapping.blockId).toBe("caption-writer");
  });

  it("finishes no writer when the session's own turn ends and Claude Code's helper stops", () => {
    const view = foldLiveSession(writers, run(), journal());
    expect(view.blocks["caption-writer"].state).toBe("running");
    expect(view.blocks["theme-writer"].state).toBe("running");
    expect(finishedSteps(view)).toBe(0);
  });

  it("reads both writers Unknown when the session is stopped before either hands back", () => {
    const view = foldLiveSession(writers, run({ state: "observation_lost" }), [...journal(), ...stop]);
    expect(view.blocks["caption-writer"].state).toBe("unknown");
    expect(view.blocks["theme-writer"].state).toBe("unknown");
    expect(finishedSteps(view)).toBe(0);
  });

  it("tells the helper's stop from a subagent's own", () => {
    const events = [...journal(), ...stop];
    const isHelper = helperStops(events);
    expect(events.filter((item) => item.kind === "subagent.end").map(isHelper)).toEqual([true, true, true]);
    // A writer's own stop, a moment after it last wrote, is its own however
    // recently the session's turn ended.
    const own = [
      ...turnEnd(10),
      tx({ kind: "turn.end", title: "The agent finished its turn", ...byTheme, at: T(10.5) }),
      helper(10.6),
    ];
    expect(helperStops(own)(own[3])).toBe(false);
  });
});

describe("the agent a dispatch's description names", () => {
  const named: Workflow = {
    ...workflow,
    metadata: {
      workflow: {
        formatVersion: 4,
        agents: [
          { id: "agent-dev", name: "Developer" },
          { id: "agent-qa", name: "Test Runner" },
        ],
      },
    },
    nodes: workflow.nodes.filter((node) => node.id !== "fix"),
  };
  const byName = buildWorkflowIndex(named);

  it("is the agent it opens with", () => {
    expect(stepForAgent(byName, "Test Runner: run the suite", true)).toBe("test");
    expect(stepForAgent(byName, "Test Runner", true)).toBe("test");
  });

  it("is not an agent whose name only starts a longer word or comes later", () => {
    expect(stepForAgent(byName, "Test Runners", true)).toBeUndefined();
    expect(stepForAgent(byName, "Ask the Test Runner", true)).toBeUndefined();
  });

  it("is never read into an agent type", () => {
    expect(stepForAgent(byName, "test-runner-general")).toBeUndefined();
  });
});

/*
  ANT-245. Two real journals from the 0.8.5 QA on the ANT-242 build, replayed
  as recorded (usage records' token counts and long details cut down, call ids
  shortened). Claude Code's SubagentStop named no subagent then — Anthill's
  hook dropped the agent id — and its helper's stop came a moment after a
  background writer had made a call, so the timing rule took it for that
  writer finishing.
*/
describe("helper stops after a subagent's call, replayed from real journals", () => {
  /** A journal row: its seq, the channel it came through, its kind and its time of day. */
  const replay = (day: string, runId: string) =>
    (seq: number, via: "tx" | "hook" | "report", kind: ObservationEvent["kind"], time: string, rest: Partial<ObservationEvent> & { title: string }): ObservationEvent => ({
      runId,
      seq,
      at: `${day}T${time}Z`,
      recordedAt: `${day}T${time}Z`,
      cli: "claude-code",
      ...(via === "tx"
        ? { source: "transcript" as const, channel: "claude-code:transcript" }
        : via === "hook"
          ? { source: "hook" as const, channel: "claude-code:hook" }
          : { source: "anthill" as const, channel: "anthill:report" }),
      sessionId: "sess-1",
      kind,
      ...rest,
    });

  /*
    ANT-217's scenario, run ANT-7QB269JF: a Caption Writer and a Theme Writer
    sent off in the background, through two short turns and a longer one, then
    the session stopped with both still writing. At 02:36:44.853 the helper's
    stop came 0.5 s after the Theme Writer's THEMES.md Write and was drawn
    "Theme Writer — Completed"; after the Stop the themes step read Failed and
    the captions step Unknown.
  */
  describe("two writers, three turn endings and a Stop (ANT-7QB269JF)", () => {
    const museum: Workflow = {
      ...workflow,
      nodes: [
        { id: "start", type: "start", name: "Start", config: {} },
        { id: "write-captions", type: "agent", name: "Write CAPTIONS.md", config: { actionKind: "agent-step", task: "a", agentId: "caption-writer" } },
        { id: "write-themes", type: "agent", name: "Write THEMES.md", config: { actionKind: "agent-step", task: "b", agentId: "theme-writer" } },
        { id: "review", type: "agent", name: "Review both files", config: { actionKind: "verify", task: "c", agentId: "reviewer" } },
        { id: "finalize", type: "agent", name: "Write SUMMARY.md", config: { actionKind: "agent-step", task: "d", agentId: "finalizer" } },
        { id: "end", type: "end", name: "Done", config: {} },
      ],
      edges: [
        { id: "e1", source: "start", target: "write-captions" },
        { id: "e2", source: "start", target: "write-themes" },
        { id: "e3", source: "write-captions", target: "review" },
        { id: "e4", source: "write-themes", target: "review" },
        { id: "e5", source: "review", target: "finalize" },
        { id: "e6", source: "finalize", target: "end" },
      ],
      metadata: {
        workflow: {
          formatVersion: 5,
          agents: [
            { id: "caption-writer", name: "Caption Writer" },
            { id: "theme-writer", name: "Theme Writer" },
            { id: "reviewer", name: "Reviewer" },
            { id: "finalizer", name: "Finalizer" },
          ],
        },
      },
    };
    const r = replay("2026-10-01", "ANT-7QB269JF");
    const journal = [
      r(1, "tx", "tool.end", "02:35:16.853", {"title": "Tool finished", "toolUseId": "iqdret", "ok": true}),
      r(2, "hook", "tool.end", "02:35:16.831", {"title": "mcp__plugin_anthill_exchange__bind_run", "toolName": "mcp__plugin_anthill_exchange__bind_run", "toolUseId": "iqdret", "ok": true}),
      r(3, "hook", "tool.start", "02:35:19.101", {"title": "Bash", "toolName": "Bash", "toolUseId": "LC2nSN", "detail": "Report run start and both writer steps t"}),
      r(4, "tx", "usage", "02:35:17.981", {"title": "Token usage recorded"}),
      r(5, "tx", "tool.start", "02:35:18.985", {"title": "Bash", "toolName": "Bash", "toolUseId": "LC2nSN", "detail": "Report run start and both writer steps t"}),
      r(6, "tx", "subagent.start", "02:35:23.034", {"title": "Delegated to a subagent", "toolName": "Agent", "toolUseId": "cqzGHo", "agentName": "general-purpose", "detail": "Caption Writer: CAPTIONS.md", "background": true}),
      r(7, "tx", "subagent.start", "02:35:25.965", {"title": "Delegated to a subagent", "toolName": "Agent", "toolUseId": "o7Dmfr", "agentName": "general-purpose", "detail": "Theme Writer: THEMES.md", "background": true}),
      r(8, "tx", "tool.end", "02:35:29.066", {"title": "Tool finished", "toolUseId": "LC2nSN", "ok": true}),
      r(9, "hook", "tool.end", "02:35:29.045", {"title": "Bash", "toolName": "Bash", "toolUseId": "LC2nSN", "detail": "Report run start and both writer steps t", "ok": true}),
      r(10, "report", "step.marker", "02:35:28.604", {"title": "Step announced", "detail": "write-captions", "blockId": "write-captions"}),
      r(11, "report", "step.marker", "02:35:28.930", {"title": "Step announced", "detail": "write-themes", "blockId": "write-themes"}),
      r(12, "tx", "tool.end", "02:35:29.502", {"title": "Tool finished", "toolUseId": "cqzGHo", "background": true, "ok": true}),
      r(13, "tx", "tool.end", "02:35:29.504", {"title": "Tool finished", "toolUseId": "o7Dmfr", "background": true, "ok": true}),
      r(14, "hook", "tool.start", "02:35:29.177", {"title": "Agent", "toolName": "Agent", "toolUseId": "cqzGHo", "detail": "Caption Writer: CAPTIONS.md"}),
      r(15, "hook", "tool.start", "02:35:29.178", {"title": "Agent", "toolName": "Agent", "toolUseId": "o7Dmfr", "detail": "Theme Writer: THEMES.md"}),
      r(16, "hook", "tool.end", "02:35:29.410", {"title": "Agent", "toolName": "Agent", "toolUseId": "cqzGHo", "detail": "Caption Writer: CAPTIONS.md", "ok": true}),
      r(17, "hook", "tool.end", "02:35:29.427", {"title": "Agent", "toolName": "Agent", "toolUseId": "o7Dmfr", "detail": "Theme Writer: THEMES.md", "ok": true}),
      r(18, "tx", "usage", "02:35:31.953", {"title": "Token usage recorded"}),
      r(19, "tx", "turn.end", "02:35:31.953", {"title": "The agent finished its turn", "toolUseId": "msg_011Cfajjrx9ojQQXvN4ja1bH"}),
      r(20, "tx", "message", "02:35:31.956", {"title": "Message", "detail": "The Caption Writer and Theme Writer are ", "author": {"kind": "main"}}),
      r(21, "tx", "turn.end", "02:35:31.956", {"title": "The agent finished its turn", "toolUseId": "msg_011Cfajjrx9ojQQXvN4ja1bH"}),
      r(22, "tx", "usage", "02:35:31.077", {"title": "Token usage recorded", "parentToolUseId": "cqzGHo"}),
      r(23, "hook", "turn.end", "02:35:33.048", {"title": "The agent finished its turn"}),
      r(24, "hook", "subagent.end", "02:35:34.666", {"title": "A subagent finished"}),
      r(25, "hook", "prompt.submit", "02:36:07.510", {"title": "A prompt was submitted"}),
      r(26, "tx", "usage", "02:36:11.197", {"title": "Token usage recorded", "parentToolUseId": "o7Dmfr"}),
      r(27, "tx", "usage", "02:36:10.759", {"title": "Token usage recorded"}),
      r(28, "tx", "turn.end", "02:36:10.759", {"title": "The agent finished its turn", "toolUseId": "msg_011CfajngonaG7h7XuQNMzP5"}),
      r(29, "tx", "message", "02:36:15.266", {"title": "Message", "detail": "The review starts only after both writer", "author": {"kind": "main"}}),
      r(30, "tx", "turn.end", "02:36:15.266", {"title": "The agent finished its turn", "toolUseId": "msg_011CfajngonaG7h7XuQNMzP5"}),
      r(31, "hook", "turn.end", "02:36:16.557", {"title": "The agent finished its turn"}),
      r(32, "hook", "subagent.end", "02:36:18.274", {"title": "A subagent finished"}),
      r(33, "hook", "prompt.submit", "02:36:39.840", {"title": "A prompt was submitted"}),
      r(34, "tx", "usage", "02:36:41.101", {"title": "Token usage recorded"}),
      r(35, "tx", "turn.end", "02:36:41.101", {"title": "The agent finished its turn", "toolUseId": "msg_011Cfajq4b2vxpuW5zMNo3XM"}),
      r(36, "tx", "message", "02:36:42.279", {"title": "Message", "detail": "I'll wait. Both writers are still runnin", "author": {"kind": "main"}}),
      r(37, "tx", "turn.end", "02:36:42.279", {"title": "The agent finished its turn", "toolUseId": "msg_011Cfajq4b2vxpuW5zMNo3XM"}),
      r(38, "tx", "tool.start", "02:36:44.098", {"title": "Write", "toolName": "Write", "toolUseId": "3TM2RW", "parentToolUseId": "o7Dmfr", "detail": "anthill-qa-cc3-217/THEMES.md"}),
      r(39, "tx", "tool.end", "02:36:44.383", {"title": "Tool finished", "toolUseId": "3TM2RW", "parentToolUseId": "o7Dmfr", "ok": true}),
      r(40, "hook", "turn.end", "02:36:43.292", {"title": "The agent finished its turn"}),
      r(41, "hook", "tool.start", "02:36:44.208", {"title": "Write", "toolName": "Write", "toolUseId": "3TM2RW", "detail": "anthill-qa-cc3-217/THEMES.md"}),
      r(42, "hook", "tool.end", "02:36:44.350", {"title": "Write", "toolName": "Write", "toolUseId": "3TM2RW", "detail": "anthill-qa-cc3-217/THEMES.md", "ok": true}),
      r(43, "hook", "subagent.end", "02:36:44.853", {"title": "A subagent finished"}),
      r(44, "tx", "tool.start", "02:36:55.496", {"title": "Write", "toolName": "Write", "toolUseId": "zuyzpR", "parentToolUseId": "cqzGHo", "detail": "anthill-qa-cc3-217/CAPTIONS.md"}),
      r(45, "tx", "tool.end", "02:36:55.767", {"title": "Tool finished", "toolUseId": "zuyzpR", "parentToolUseId": "cqzGHo", "ok": true}),
      r(46, "hook", "tool.start", "02:36:55.601", {"title": "Write", "toolName": "Write", "toolUseId": "zuyzpR", "detail": "anthill-qa-cc3-217/CAPTIONS.md"}),
      r(47, "hook", "tool.end", "02:36:55.736", {"title": "Write", "toolName": "Write", "toolUseId": "zuyzpR", "detail": "anthill-qa-cc3-217/CAPTIONS.md", "ok": true}),
      r(48, "hook", "prompt.submit", "02:37:02.719", {"title": "A prompt was submitted"}),
      r(49, "tx", "notification", "02:37:09.086", {"title": "Stopped by hand"}),
      r(50, "hook", "subagent.end", "02:37:10.678", {"title": "A subagent finished"}),
    ];
    const before = (seq: number) => journal.filter((item) => item.seq < seq);

    it("reads every SubagentStop as Claude Code's helper", () => {
      const isHelper = helperStops(journal);
      expect(journal.filter((item) => item.kind === "subagent.end").map((item) => [item.seq, isHelper(item)])).toEqual([
        [24, true],
        [32, true],
        [43, true],
        [50, true],
      ]);
    });

    it("keeps both writers running until the Stop", () => {
      const view = foldLiveSession(museum, run(), before(49));
      expect(view.blocks["write-captions"].state).toBe("running");
      expect(view.blocks["write-themes"].state).toBe("running");
      expect(finishedSteps(view)).toBe(0);
    });

    it("reads both writers Unknown once the Stop cut them off", () => {
      const view = foldLiveSession(museum, run({ state: "observation_lost" }), journal);
      expect(view.blocks["write-captions"]).toMatchObject({ state: "unknown" });
      expect(view.blocks["write-themes"]).toMatchObject({ state: "unknown" });
      expect(view.blocks["write-themes"].note).toBe(view.blocks["write-captions"].note);
      expect(finishedSteps(view)).toBe(0);
    });
  });

  /*
    ANT-190's scenario, run ANT-A5B8869B: two Developers sent off in the
    background. At 02:44:22.547 the helper's stop came while both were between
    a call and its reply, and was drawn "Developer (mod3–mod5) — Completed"
    a quarter of a minute before either handed back.
  */
  describe("two developers, before either hands back (ANT-A5B8869B)", () => {
    const mods: Workflow = {
      ...workflow,
      nodes: [
        { id: "start", type: "start", name: "Start", config: {} },
        { id: "n1", type: "agent", name: "Hand out module assignments", config: { actionKind: "agent-step", task: "a", agentId: "agent-3" } },
        { id: "n2", type: "agent", name: "Document and test mod1–mod2", config: { actionKind: "agent-step", task: "b", agentId: "agent-1" } },
        { id: "n3", type: "agent", name: "Document and test mod3–mod5", config: { actionKind: "agent-step", task: "c", agentId: "agent-2" } },
        { id: "n4", type: "agent", name: "Run unittest discover", config: { actionKind: "verify", task: "d", agentId: "agent-3" } },
        { id: "n5", type: "agent", name: "Write the closing summary", config: { actionKind: "agent-step", task: "e", agentId: "agent-3" } },
        { id: "end", type: "end", name: "Done", config: {} },
      ],
      edges: [
        { id: "e1", source: "start", target: "n1" },
        { id: "e2", source: "n1", target: "n2" },
        { id: "e3", source: "n1", target: "n3" },
        { id: "e4", source: "n2", target: "n4" },
        { id: "e5", source: "n3", target: "n4" },
        { id: "e6", source: "n4", target: "n5" },
        { id: "e7", source: "n5", target: "end" },
      ],
      metadata: {
        workflow: {
          formatVersion: 5,
          agents: [
            { id: "agent-1", name: "Developer (mod1–mod2)" },
            { id: "agent-2", name: "Developer (mod3–mod5)" },
            { id: "agent-3", name: "Tester" },
          ],
        },
      },
    };
    const r = replay("2026-10-01", "ANT-A5B8869B");
    const journal = [
      r(1, "tx", "prompt.submit", "02:43:19.515", {"title": "The workflow was pasted in"}),
      r(2, "hook", "session.start", "02:43:18.911", {"title": "Session started"}),
      r(3, "hook", "prompt.submit", "02:43:19.614", {"title": "A prompt was submitted"}),
      r(4, "hook", "tool.start", "02:43:29.608", {"title": "Bash", "toolName": "Bash", "toolUseId": "B7AF7K", "detail": "List project folder and show module and "}),
      r(5, "tx", "usage", "02:43:27.916", {"title": "Token usage recorded"}),
      r(6, "tx", "message", "02:43:28.466", {"title": "Message", "detail": "I'll treat the pasted workflow as your r", "author": {"kind": "main"}, "stepTag": "n1"}),
      r(7, "tx", "tool.start", "02:43:29.493", {"title": "Bash", "toolName": "Bash", "toolUseId": "B7AF7K", "detail": "List project folder and show module and "}),
      r(8, "tx", "tool.end", "02:43:30.927", {"title": "Tool finished", "toolUseId": "B7AF7K", "ok": true}),
      r(9, "hook", "tool.end", "02:43:30.875", {"title": "Bash", "toolName": "Bash", "toolUseId": "B7AF7K", "detail": "List project folder and show module and ", "ok": true}),
      r(10, "tx", "usage", "02:43:32.945", {"title": "Token usage recorded"}),
      r(11, "tx", "message", "02:43:32.947", {"title": "Message", "detail": "Agent files already exist from an earlie", "author": {"kind": "main"}}),
      r(12, "tx", "tool.start", "02:43:49.117", {"title": "Bash", "toolName": "Bash", "toolUseId": "8WnPhw", "detail": "Write the three agent definition files a"}),
      r(13, "hook", "tool.start", "02:43:49.233", {"title": "Bash", "toolName": "Bash", "toolUseId": "8WnPhw", "detail": "Write the three agent definition files a"}),
      r(14, "hook", "tool.end", "02:43:49.627", {"title": "Bash", "toolName": "Bash", "toolUseId": "8WnPhw", "detail": "Write the three agent definition files a", "ok": true}),
      r(15, "tx", "tool.end", "02:43:49.654", {"title": "Tool finished", "toolUseId": "8WnPhw", "ok": true}),
      r(16, "tx", "step.marker", "02:43:49.654", {"title": "Step announced", "detail": "n1", "blockId": "n1"}),
      r(17, "hook", "tool.start", "02:43:53.229", {"title": "Agent", "toolName": "Agent", "toolUseId": "YXKTYm", "detail": "Hand out module assignments"}),
      r(18, "tx", "usage", "02:43:53.119", {"title": "Token usage recorded"}),
      r(19, "tx", "subagent.start", "02:43:53.119", {"title": "Delegated to a subagent", "toolName": "Agent", "toolUseId": "YXKTYm", "agentName": "tester", "detail": "Hand out module assignments", "stepTag": "n1"}),
      r(20, "tx", "usage", "02:43:55.185", {"title": "Token usage recorded", "parentToolUseId": "YXKTYm"}),
      r(21, "tx", "tool.start", "02:43:55.185", {"title": "Bash", "toolName": "Bash", "toolUseId": "H6fBxT", "parentToolUseId": "YXKTYm", "detail": "List folder contents"}),
      r(22, "hook", "tool.start", "02:43:55.334", {"title": "Bash", "toolName": "Bash", "toolUseId": "H6fBxT", "detail": "List folder contents"}),
      r(23, "tx", "tool.end", "02:43:56.247", {"title": "Tool finished", "toolUseId": "H6fBxT", "parentToolUseId": "YXKTYm", "ok": true}),
      r(24, "hook", "tool.end", "02:43:56.217", {"title": "Bash", "toolName": "Bash", "toolUseId": "H6fBxT", "detail": "List folder contents", "ok": true}),
      r(25, "tx", "usage", "02:44:00.475", {"title": "Token usage recorded", "parentToolUseId": "YXKTYm"}),
      r(26, "tx", "tool.start", "02:44:00.475", {"title": "SubagentHandback", "toolName": "SubagentHandback", "toolUseId": "L1S4Hh", "parentToolUseId": "YXKTYm"}),
      r(27, "tx", "tool.end", "02:44:01.082", {"title": "Tool finished", "toolUseId": "L1S4Hh", "parentToolUseId": "YXKTYm", "ok": true}),
      r(28, "hook", "tool.start", "02:44:00.583", {"title": "SubagentHandback", "toolName": "SubagentHandback", "toolUseId": "L1S4Hh"}),
      r(29, "hook", "tool.end", "02:44:01.054", {"title": "SubagentHandback", "toolName": "SubagentHandback", "toolUseId": "L1S4Hh", "ok": true}),
      r(30, "tx", "tool.end", "02:44:02.020", {"title": "Tool finished", "toolUseId": "YXKTYm", "ok": true}),
      r(31, "tx", "usage", "02:44:01.725", {"title": "Token usage recorded", "parentToolUseId": "YXKTYm"}),
      r(32, "tx", "message", "02:44:01.725", {"title": "Message", "parentToolUseId": "YXKTYm", "detail": "I delivered the report to my caller.", "author": {"kind": "subagent", "name": "Hand out module assignments"}}),
      r(33, "tx", "turn.end", "02:44:01.725", {"title": "The agent finished its turn", "toolUseId": "msg_011CfakPZppS6zAwMgwn8AyR", "parentToolUseId": "YXKTYm", "author": {"kind": "subagent", "name": "Hand out module assignments"}}),
      r(34, "hook", "subagent.end", "02:44:01.864", {"title": "A subagent finished"}),
      r(35, "hook", "tool.end", "02:44:02.000", {"title": "Agent", "toolName": "Agent", "toolUseId": "YXKTYm", "detail": "Hand out module assignments", "ok": true}),
      r(36, "hook", "prompt.submit", "02:44:02.121", {"title": "A prompt was submitted"}),
      r(37, "tx", "usage", "02:44:04.696", {"title": "Token usage recorded"}),
      r(38, "tx", "message", "02:44:04.697", {"title": "Message", "detail": "Step n1 succeeded: all five modules are ", "author": {"kind": "main"}}),
      r(39, "tx", "tool.start", "02:44:05.664", {"title": "Bash", "toolName": "Bash", "toolUseId": "VossBi", "detail": "Mark the start of steps n2 and n3"}),
      r(40, "tx", "tool.end", "02:44:06.212", {"title": "Tool finished", "toolUseId": "VossBi", "ok": true}),
      r(41, "tx", "step.marker", "02:44:06.212", {"title": "Step announced", "detail": "n2", "blockId": "n2"}),
      r(42, "tx", "step.marker", "02:44:06.212", {"title": "Step announced", "detail": "n3", "blockId": "n3"}),
      r(43, "hook", "tool.start", "02:44:05.776", {"title": "Bash", "toolName": "Bash", "toolUseId": "VossBi", "detail": "Mark the start of steps n2 and n3"}),
      r(44, "hook", "tool.end", "02:44:06.174", {"title": "Bash", "toolName": "Bash", "toolUseId": "VossBi", "detail": "Mark the start of steps n2 and n3", "ok": true}),
      r(45, "hook", "tool.start", "02:44:12.085", {"title": "Agent", "toolName": "Agent", "toolUseId": "J47Djf", "detail": "Document and test mod1–mod2"}),
      r(46, "tx", "usage", "02:44:11.977", {"title": "Token usage recorded"}),
      r(47, "tx", "subagent.start", "02:44:11.977", {"title": "Delegated to a subagent", "toolName": "Agent", "toolUseId": "J47Djf", "agentName": "developer-mod1-mod2", "detail": "Document and test mod1–mod2", "background": true, "stepTag": "n2"}),
      r(48, "tx", "subagent.start", "02:44:15.918", {"title": "Delegated to a subagent", "toolName": "Agent", "toolUseId": "hACRY9", "agentName": "developer-mod3-mod5", "detail": "Document and test mod3–mod5", "background": true, "stepTag": "n3"}),
      r(49, "tx", "tool.end", "02:44:16.549", {"title": "Tool finished", "toolUseId": "hACRY9", "background": true, "ok": true}),
      r(50, "tx", "tool.end", "02:44:16.551", {"title": "Tool finished", "toolUseId": "J47Djf", "background": true, "ok": true}),
      r(51, "tx", "usage", "02:44:17.560", {"title": "Token usage recorded", "parentToolUseId": "hACRY9"}),
      r(52, "hook", "tool.start", "02:44:16.019", {"title": "Agent", "toolName": "Agent", "toolUseId": "hACRY9", "detail": "Document and test mod3–mod5"}),
      r(53, "hook", "tool.end", "02:44:16.459", {"title": "Agent", "toolName": "Agent", "toolUseId": "J47Djf", "detail": "Document and test mod1–mod2", "ok": true}),
      r(54, "hook", "tool.end", "02:44:16.470", {"title": "Agent", "toolName": "Agent", "toolUseId": "hACRY9", "detail": "Document and test mod3–mod5", "ok": true}),
      r(55, "tx", "usage", "02:44:18.881", {"title": "Token usage recorded"}),
      r(56, "tx", "message", "02:44:18.881", {"title": "Message", "detail": "Both developers are now running in the b", "author": {"kind": "main"}, "stepTag": "n2"}),
      r(57, "tx", "turn.end", "02:44:18.881", {"title": "The agent finished its turn", "toolUseId": "msg_011CfakQiwn351RuRCo89FjC"}),
      r(58, "tx", "message", "02:44:18.017", {"title": "Message", "parentToolUseId": "hACRY9", "detail": "Starting with the required wait.", "author": {"kind": "subagent", "name": "Document and test mod3–mod5"}, "stepTag": "n3"}),
      r(59, "tx", "tool.start", "02:44:18.138", {"title": "Bash", "toolName": "Bash", "toolUseId": "htbqB9", "parentToolUseId": "hACRY9", "detail": "Wait 120 seconds before starting"}),
      r(60, "tx", "tool.end", "02:44:18.140", {"title": "Tool finished", "toolUseId": "htbqB9", "parentToolUseId": "hACRY9", "ok": false}),
      r(61, "tx", "usage", "02:44:17.878", {"title": "Token usage recorded", "parentToolUseId": "J47Djf"}),
      r(62, "tx", "tool.start", "02:44:17.878", {"title": "Bash", "toolName": "Bash", "toolUseId": "tJxu6e", "parentToolUseId": "J47Djf", "detail": "Wait 120 seconds as instructed"}),
      r(63, "tx", "tool.end", "02:44:17.880", {"title": "Tool finished", "toolUseId": "tJxu6e", "parentToolUseId": "J47Djf", "ok": false}),
      r(64, "tx", "usage", "02:44:20.868", {"title": "Token usage recorded", "parentToolUseId": "hACRY9"}),
      r(65, "tx", "message", "02:44:20.868", {"title": "Message", "parentToolUseId": "hACRY9", "detail": "The standalone sleep was blocked, so I'l", "author": {"kind": "subagent", "name": "Document and test mod3–mod5"}}),
      r(66, "tx", "tool.start", "02:44:21.388", {"title": "Bash", "toolName": "Bash", "toolUseId": "vPc3KQ", "parentToolUseId": "hACRY9", "detail": "Wait 120 seconds in background"}),
      r(67, "tx", "usage", "02:44:20.160", {"title": "Token usage recorded", "parentToolUseId": "J47Djf"}),
      r(68, "tx", "tool.start", "02:44:20.711", {"title": "Bash", "toolName": "Bash", "toolUseId": "Uyt7R2", "parentToolUseId": "J47Djf", "detail": "Wait 120 seconds in background"}),
      r(69, "tx", "tool.end", "02:44:21.247", {"title": "Tool finished", "toolUseId": "Uyt7R2", "parentToolUseId": "J47Djf", "ok": true}),
      r(70, "hook", "turn.end", "02:44:19.963", {"title": "The agent finished its turn"}),
      r(71, "hook", "tool.start", "02:44:20.826", {"title": "Bash", "toolName": "Bash", "toolUseId": "Uyt7R2", "detail": "Wait 120 seconds in background"}),
      r(72, "hook", "tool.end", "02:44:21.212", {"title": "Bash", "toolName": "Bash", "toolUseId": "Uyt7R2", "detail": "Wait 120 seconds in background", "ok": true}),
      r(73, "hook", "tool.start", "02:44:21.507", {"title": "Bash", "toolName": "Bash", "toolUseId": "vPc3KQ", "detail": "Wait 120 seconds in background"}),
      r(74, "tx", "tool.end", "02:44:21.878", {"title": "Tool finished", "toolUseId": "vPc3KQ", "parentToolUseId": "hACRY9", "ok": true}),
      r(75, "tx", "usage", "02:44:22.969", {"title": "Token usage recorded", "parentToolUseId": "hACRY9"}),
      r(76, "tx", "message", "02:44:22.969", {"title": "Message", "parentToolUseId": "hACRY9", "detail": "The 120-second wait is running in the ba", "author": {"kind": "subagent", "name": "Document and test mod3–mod5"}}),
      r(77, "tx", "tool.start", "02:44:23.278", {"title": "Monitor", "toolName": "Monitor", "toolUseId": "Eqehw9", "parentToolUseId": "hACRY9", "detail": "select:Monitor"}),
      r(78, "tx", "tool.end", "02:44:23.280", {"title": "Tool finished", "toolUseId": "Eqehw9", "parentToolUseId": "hACRY9", "ok": false}),
      r(79, "tx", "usage", "02:44:22.585", {"title": "Token usage recorded", "parentToolUseId": "J47Djf"}),
      r(80, "hook", "tool.end", "02:44:21.842", {"title": "Bash", "toolName": "Bash", "toolUseId": "vPc3KQ", "detail": "Wait 120 seconds in background", "ok": true}),
      r(81, "hook", "subagent.end", "02:44:22.547", {"title": "A subagent finished"}),
      r(82, "tx", "usage", "02:44:25.101", {"title": "Token usage recorded", "parentToolUseId": "hACRY9"}),
      r(83, "tx", "tool.start", "02:44:25.344", {"title": "ToolSearch", "toolName": "ToolSearch", "toolUseId": "kGcZF5", "parentToolUseId": "hACRY9", "detail": "select:Monitor"}),
      r(84, "tx", "tool.end", "02:44:25.614", {"title": "Tool finished", "toolUseId": "kGcZF5", "parentToolUseId": "hACRY9", "ok": true}),
      r(85, "tx", "tool.start", "02:44:23.688", {"title": "Monitor", "toolName": "Monitor", "toolUseId": "2JU4Au", "parentToolUseId": "J47Djf", "detail": "Wait for 120s sleep to finish"}),
      r(86, "tx", "tool.end", "02:44:24.426", {"title": "Tool finished", "toolUseId": "2JU4Au", "parentToolUseId": "J47Djf", "ok": true}),
      r(87, "hook", "tool.start", "02:44:23.814", {"title": "Monitor", "toolName": "Monitor", "toolUseId": "2JU4Au", "detail": "Wait for 120s sleep to finish"}),
      r(88, "hook", "tool.end", "02:44:24.391", {"title": "Monitor", "toolName": "Monitor", "toolUseId": "2JU4Au", "detail": "Wait for 120s sleep to finish", "ok": true}),
      r(89, "hook", "tool.start", "02:44:25.455", {"title": "ToolSearch", "toolName": "ToolSearch", "toolUseId": "kGcZF5", "detail": "select:Monitor"}),
      r(90, "hook", "tool.end", "02:44:25.586", {"title": "ToolSearch", "toolName": "ToolSearch", "toolUseId": "kGcZF5", "detail": "select:Monitor", "ok": true}),
      r(91, "tx", "usage", "02:44:25.807", {"title": "Token usage recorded", "parentToolUseId": "J47Djf"}),
      r(92, "tx", "tool.start", "02:44:25.807", {"title": "Bash", "toolName": "Bash", "toolUseId": "wQCx6z", "parentToolUseId": "J47Djf", "detail": "Look at folder and modules"}),
      r(93, "tx", "tool.end", "02:44:26.356", {"title": "Tool finished", "toolUseId": "wQCx6z", "parentToolUseId": "J47Djf", "ok": true}),
      r(94, "tx", "usage", "02:44:27.468", {"title": "Token usage recorded", "parentToolUseId": "J47Djf"}),
      r(95, "tx", "tool.start", "02:44:27.468", {"title": "Bash", "toolName": "Bash", "toolUseId": "9fcdfo", "parentToolUseId": "J47Djf", "detail": "Read existing tests"}),
      r(96, "hook", "tool.start", "02:44:25.914", {"title": "Bash", "toolName": "Bash", "toolUseId": "wQCx6z", "detail": "Look at folder and modules"}),
      r(97, "hook", "tool.end", "02:44:26.319", {"title": "Bash", "toolName": "Bash", "toolUseId": "wQCx6z", "detail": "Look at folder and modules", "ok": true}),
      r(98, "hook", "tool.start", "02:44:27.585", {"title": "Bash", "toolName": "Bash", "toolUseId": "9fcdfo", "detail": "Read existing tests"}),
      r(99, "tx", "usage", "02:44:27.679", {"title": "Token usage recorded", "parentToolUseId": "hACRY9"}),
      r(100, "tx", "tool.start", "02:44:27.679", {"title": "Monitor", "toolName": "Monitor", "toolUseId": "y6P8Wk", "parentToolUseId": "hACRY9", "detail": "wait for 120s sleep to finish"}),
      r(101, "tx", "tool.end", "02:44:28.494", {"title": "Tool finished", "toolUseId": "y6P8Wk", "parentToolUseId": "hACRY9", "ok": true}),
      r(102, "tx", "tool.end", "02:44:28.527", {"title": "Tool finished", "toolUseId": "9fcdfo", "parentToolUseId": "J47Djf", "ok": true}),
      r(103, "hook", "tool.start", "02:44:27.786", {"title": "Monitor", "toolName": "Monitor", "toolUseId": "y6P8Wk", "detail": "wait for 120s sleep to finish"}),
      r(104, "hook", "tool.end", "02:44:28.368", {"title": "Monitor", "toolName": "Monitor", "toolUseId": "y6P8Wk", "detail": "wait for 120s sleep to finish", "ok": true}),
      r(105, "hook", "tool.end", "02:44:28.420", {"title": "Bash", "toolName": "Bash", "toolUseId": "9fcdfo", "detail": "Read existing tests", "ok": true}),
      r(106, "tx", "usage", "02:44:30.071", {"title": "Token usage recorded", "parentToolUseId": "hACRY9"}),
      r(107, "tx", "tool.start", "02:44:30.071", {"title": "Bash", "toolName": "Bash", "toolUseId": "r6ynSJ", "parentToolUseId": "hACRY9", "detail": "Inspect folder and module sources"}),
      r(108, "tx", "tool.end", "02:44:30.659", {"title": "Tool finished", "toolUseId": "r6ynSJ", "parentToolUseId": "hACRY9", "ok": true}),
      r(109, "tx", "usage", "02:44:29.938", {"title": "Token usage recorded", "parentToolUseId": "J47Djf"}),
      r(110, "tx", "tool.start", "02:44:30.401", {"title": "Bash", "toolName": "Bash", "toolUseId": "Zrfp42", "parentToolUseId": "J47Djf", "detail": "Run mod1 and mod2 tests"}),
      r(111, "tx", "tool.end", "02:44:31.063", {"title": "Tool finished", "toolUseId": "Zrfp42", "parentToolUseId": "J47Djf", "ok": true}),
      r(112, "hook", "tool.start", "02:44:30.175", {"title": "Bash", "toolName": "Bash", "toolUseId": "r6ynSJ", "detail": "Inspect folder and module sources"}),
      r(113, "hook", "tool.start", "02:44:30.508", {"title": "Bash", "toolName": "Bash", "toolUseId": "Zrfp42", "detail": "Run mod1 and mod2 tests"}),
      r(114, "hook", "tool.end", "02:44:30.630", {"title": "Bash", "toolName": "Bash", "toolUseId": "r6ynSJ", "detail": "Inspect folder and module sources", "ok": true}),
      r(115, "hook", "tool.end", "02:44:31.022", {"title": "Bash", "toolName": "Bash", "toolUseId": "Zrfp42", "detail": "Run mod1 and mod2 tests", "ok": true}),
      r(116, "tx", "usage", "02:44:31.980", {"title": "Token usage recorded", "parentToolUseId": "hACRY9"}),
      r(117, "tx", "tool.start", "02:44:31.980", {"title": "Bash", "toolName": "Bash", "toolUseId": "a7sUAg", "parentToolUseId": "hACRY9", "detail": "Read existing tests"}),
      r(118, "tx", "tool.end", "02:44:32.567", {"title": "Tool finished", "toolUseId": "a7sUAg", "parentToolUseId": "hACRY9", "ok": true}),
      r(119, "hook", "tool.start", "02:44:32.086", {"title": "Bash", "toolName": "Bash", "toolUseId": "a7sUAg", "detail": "Read existing tests"}),
      r(120, "hook", "tool.end", "02:44:32.534", {"title": "Bash", "toolName": "Bash", "toolUseId": "a7sUAg", "detail": "Read existing tests", "ok": true}),
      r(121, "tx", "usage", "02:44:34.069", {"title": "Token usage recorded", "parentToolUseId": "hACRY9"}),
      r(122, "tx", "tool.start", "02:44:34.379", {"title": "Bash", "toolName": "Bash", "toolUseId": "MKLqtx", "parentToolUseId": "hACRY9", "detail": "Run the three test files"}),
      r(123, "tx", "tool.end", "02:44:34.986", {"title": "Tool finished", "toolUseId": "MKLqtx", "parentToolUseId": "hACRY9", "ok": true}),
      r(124, "tx", "usage", "02:44:34.709", {"title": "Token usage recorded", "parentToolUseId": "J47Djf"}),
      r(125, "tx", "tool.start", "02:44:34.709", {"title": "SubagentHandback", "toolName": "SubagentHandback", "toolUseId": "bxhfeL", "parentToolUseId": "J47Djf"}),
      r(126, "tx", "tool.end", "02:44:35.308", {"title": "Tool finished", "toolUseId": "bxhfeL", "parentToolUseId": "J47Djf", "ok": true}),
      r(127, "hook", "tool.start", "02:44:34.501", {"title": "Bash", "toolName": "Bash", "toolUseId": "MKLqtx", "detail": "Run the three test files"}),
      r(128, "hook", "tool.start", "02:44:34.826", {"title": "SubagentHandback", "toolName": "SubagentHandback", "toolUseId": "bxhfeL"}),
      r(129, "hook", "tool.end", "02:44:34.952", {"title": "Bash", "toolName": "Bash", "toolUseId": "MKLqtx", "detail": "Run the three test files", "ok": true}),
      r(130, "hook", "tool.end", "02:44:35.246", {"title": "SubagentHandback", "toolName": "SubagentHandback", "toolUseId": "bxhfeL", "ok": true}),
      r(131, "hook", "prompt.submit", "02:44:35.328", {"title": "A prompt was submitted"}),
    ];

    it("reads the stop between their calls as Claude Code's helper, and the Tester's own as its", () => {
      const isHelper = helperStops(journal);
      expect(journal.filter((item) => item.kind === "subagent.end").map((item) => [item.seq, isHelper(item)])).toEqual([
        [34, false],
        [81, true],
      ]);
    });

    it("keeps both developers running until they hand back", () => {
      const view = foldLiveSession(mods, run(), journal.filter((item) => item.seq < 125));
      expect(view.blocks.n1.state).toBe("done");
      expect(view.blocks.n2.state).toBe("running");
      expect(view.blocks.n3.state).toBe("running");
    });

    it("finishes a developer's step on its handback (ANT-245)", () => {
      const view = foldLiveSession(mods, run(), journal);
      expect(view.blocks.n2.state).toBe("done");
      expect(view.blocks.n3.state).toBe("running");
    });
  });
});

/*
  ANT-245. Claude Code's SubagentStop names the agent that stopped, by the id
  its transcript's rows carry. A stop is the subagent it names, or — naming
  none the session's transcripts were read for — Claude Code's own helper.
*/
describe("a SubagentStop that names its subagent", () => {
  const T = (s: number) => new Date(Date.parse("2026-10-01T03:00:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const hook = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "hook", channel: "claude-code:hook", ...partial });
  const byA = { parentToolUseId: "call-a", agentId: "agent-a", author: { kind: "subagent" as const } };
  const byB = { parentToolUseId: "call-b", agentId: "agent-b", author: { kind: "subagent" as const } };
  const stopOf = (agentId: string | undefined, s: number) =>
    hook({ kind: "subagent.end", title: "A subagent finished", ...(agentId ? { agentId } : {}), at: T(s) });

  const dispatch = [
    tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
    tx({ kind: "step.marker", title: "Step test", blockId: "test", at: T(0.1) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-a", stepTag: "implement", background: true, at: T(1) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "call-a", background: true, at: T(1.1) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-b", stepTag: "test", background: true, at: T(2) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "call-b", background: true, at: T(2.1) }),
    tx({ kind: "message", title: "Message", detail: "Starting.", ...byA, at: T(3) }),
    tx({ kind: "message", title: "Message", detail: "Starting.", ...byB, at: T(3.5) }),
    // The session goes on to a step of its own while both work.
    tx({ kind: "step.marker", title: "Step fix", blockId: "fix", at: T(4) }),
    tx({ kind: "tool.start", title: "Read", toolName: "Read", toolUseId: "own", at: T(5) }),
  ];

  it("settles the subagent it names, however recently another spoke", () => {
    const events = [
      ...dispatch,
      tx({ kind: "message", title: "Message", detail: "Done.", ...byA, at: T(20) }),
      tx({ kind: "message", title: "Message", detail: "Still going.", ...byB, at: T(20.3) }),
      stopOf("agent-a", 20.4),
    ];
    expect(subagentStops(events)(events[events.length - 1])).toEqual({ call: "call-a" });
    const view = foldLiveSession(workflow, run(), events);
    expect(view.blocks.implement.state).toBe("done");
    expect(view.blocks.test.state).toBe("running");
  });

  it("settles nothing when it names an agent no subagent's transcript is from", () => {
    // A subagent that just said something, a moment after the session's turn
    // ended, used to be enough for timing to give it the helper's stop.
    const events = [
      ...dispatch,
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(20) }),
      tx({ kind: "message", title: "Message", detail: "Done.", ...byA, at: T(21) }),
      stopOf("helper-1", 21.2),
    ];
    expect(subagentStops(events)(events[events.length - 1])).toBe("helper");
    expect(helperStops(events)(events[events.length - 1])).toBe(true);
    const view = foldLiveSession(workflow, run(), events);
    expect(view.blocks.implement.state).toBe("running");
    expect(view.blocks.test.state).toBe("running");
  });

  it("is absorbed by a subagent whose end its transcript already recorded, and leaves the next unnamed stop to pair", () => {
    const events = [
      ...dispatch,
      tx({ kind: "turn.end", title: "The agent finished its turn", ...byA, at: T(20) }),
      stopOf("agent-a", 20.1),
      tx({ kind: "message", title: "Message", detail: "Verdict: PASS", ...byB, at: T(40) }),
      stopOf(undefined, 40.2),
    ];
    const view = foldLiveSession(workflow, run(), events);
    expect(view.blocks.implement.state).toBe("done");
    // The unnamed stop after is B's, not one owed to A's recorded end.
    expect(view.blocks.test.state).toBe("done");
  });

  it("falls back to timing when no subagent's transcript gave an id", () => {
    const anonymous = dispatch.map(({ agentId: _id, ...rest }) => rest);
    const events = [
      ...anonymous,
      tx({ kind: "message", title: "Message", detail: "Done.", parentToolUseId: "call-a", author: { kind: "subagent" }, at: T(20) }),
      stopOf("agent-a", 20.3),
    ];
    expect(subagentStops(events)(events[events.length - 1])).toBe("unidentified");
    expect(foldLiveSession(workflow, run(), events).blocks.implement.state).toBe("done");
  });
});

/* ANT-245: the timing fallback, for stops that name no subagent. */
describe("an unnamed SubagentStop just after a subagent's call", () => {
  const T = (s: number) => new Date(Date.parse("2026-10-01T04:00:00.000Z") + s * 1000).toISOString();
  const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "transcript", channel: "claude-code:transcript", ...partial });
  const hook = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ source: "hook", channel: "claude-code:hook", ...partial });
  const byA = { parentToolUseId: "call-a", author: { kind: "subagent" as const } };
  const dispatch = [
    tx({ kind: "step.marker", title: "Step implement", blockId: "implement", at: T(0) }),
    tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "call-a", stepTag: "implement", background: true, at: T(1) }),
    tx({ kind: "tool.end", title: "Tool finished", toolUseId: "call-a", background: true, at: T(1.1) }),
    tx({ kind: "step.marker", title: "Step test", blockId: "test", at: T(2) }),
    tx({ kind: "tool.start", title: "Read", toolName: "Read", toolUseId: "own", at: T(3) }),
  ];

  it("is the helper's after the session's turn ends: the subagent's reply to its call comes first", () => {
    const events = [
      ...dispatch,
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(10) }),
      tx({ kind: "tool.start", title: "Write", toolName: "Write", toolUseId: "w", ...byA, at: T(11.1) }),
      tx({ kind: "tool.end", title: "Tool finished", toolUseId: "w", ...byA, at: T(11.4) }),
      hook({ kind: "subagent.end", title: "A subagent finished", at: T(11.9) }),
    ];
    expect(helperStops(events)(events[events.length - 1])).toBe(true);
    expect(foldLiveSession(workflow, run(), events).blocks.implement.state).toBe("running");
  });

  it("is not paired with a subagent last heard making a call, away from any turn ending", () => {
    const events = [
      ...dispatch,
      tx({ kind: "tool.start", title: "Write", toolName: "Write", toolUseId: "w", ...byA, at: T(30.1) }),
      tx({ kind: "tool.end", title: "Tool finished", toolUseId: "w", ...byA, at: T(30.4) }),
      hook({ kind: "subagent.end", title: "A subagent finished", at: T(30.9) }),
    ];
    expect(foldLiveSession(workflow, run(), events).blocks.implement.state).toBe("running");
  });

  it("is still the subagent's when its reply came after its call", () => {
    const events = [
      ...dispatch,
      tx({ kind: "turn.end", title: "The agent finished its turn", at: T(10) }),
      tx({ kind: "tool.end", title: "Tool finished", toolUseId: "w", ...byA, at: T(11) }),
      tx({ kind: "message", title: "Message", detail: "Written.", ...byA, at: T(12.5) }),
      hook({ kind: "subagent.end", title: "A subagent finished", at: T(12.7) }),
    ];
    expect(helperStops(events)(events[events.length - 1])).toBe(false);
    expect(foldLiveSession(workflow, run(), events).blocks.implement.state).toBe("done");
  });
});

/*
  ANT-300, from run ANT-OM3MK6RK. The workflow drew three drafts as one chain;
  Codex announced the first, sent its subagent off in the background, and
  announced the next while it was still at work — three blocks of one chain
  drawn Working at once, with nothing saying the run had left the plan.
*/
describe("steps the workflow chains, started side by side", () => {
  const chain: Workflow = {
    ...workflow,
    target: "codex",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "context", type: "agent", name: "Freeze questions", config: { actionKind: "agent-step", task: "c", agentId: "agent-dev" } },
      { id: "aster-draft", type: "agent", name: "aster independent proposal", config: { actionKind: "design", task: "a", agentId: "agent-dev" } },
      { id: "mira-draft", type: "agent", name: "mira independent proposal", config: { actionKind: "design", task: "m", agentId: "agent-dev" } },
      { id: "cairn-draft", type: "agent", name: "cairn independent proposal", config: { actionKind: "design", task: "k", agentId: "agent-dev" } },
      { id: "review", type: "agent", name: "Mira critiques Aster", config: { actionKind: "verify", task: "r", agentId: "agent-qa" } },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "context" },
      { id: "e2", source: "context", target: "aster-draft" },
      { id: "e3", source: "aster-draft", target: "mira-draft" },
      { id: "e4", source: "mira-draft", target: "cairn-draft" },
      { id: "e5", source: "cairn-draft", target: "review" },
      { id: "e6", source: "review", target: "end" },
    ],
  };
  const T = (s: number) => new Date(Date.parse("2026-10-08T04:35:16.000Z") + s * 1000).toISOString();
  const rollout = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ cli: "codex", source: "rollout", channel: "codex:rollout", ...partial });
  const report = (blockId: string, s: number) =>
    event({ cli: "codex", kind: "step.marker", title: "Step announced", blockId, source: "anthill", channel: "anthill:report", at: T(s) });
  const spawn = (call: string, s: number) => [
    rollout({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: call, background: true, at: T(s) }),
    rollout({ kind: "tool.end", title: "Tool finished", toolUseId: call, background: true, at: T(s + 0.3) }),
  ];
  const works = (call: string, name: string, s: number) =>
    rollout({ kind: "tool.start", title: "exec", toolUseId: `${call}-x${s}`, parentToolUseId: call, author: { kind: "subagent", name }, at: T(s) });
  const ends = (call: string, name: string, s: number) =>
    rollout({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: call, author: { kind: "subagent", name }, at: T(s) });

  const journal = [
    report("context", 0),
    rollout({ kind: "tool.start", title: "exec", toolUseId: "own", at: T(5) }),
    rollout({ kind: "tool.end", title: "Tool finished", toolUseId: "own", at: T(6) }),
    report("aster-draft", 38),
    ...spawn("call-aster", 46),
    works("call-aster", "aster", 51),
    report("mira-draft", 48),
    ...spawn("call-mira", 56),
    works("call-mira", "mira", 61),
    report("cairn-draft", 58),
    ...spawn("call-cairn", 66),
    works("call-cairn", "cairn", 70),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  it("marks each draft started while the one drawn before it was still at work", () => {
    const view = foldLiveSession(chain, run({ selectedCli: "codex" }), journal);
    for (const id of ["aster-draft", "mira-draft", "cairn-draft"]) expect(view.blocks[id].state).toBe("running");
    expect(view.overlaps).toEqual([
      { step: "mira-draft", alongside: "aster-draft", at: T(48), pass: 1 },
      { step: "cairn-draft", alongside: "aster-draft", at: T(58), pass: 1 },
      { step: "cairn-draft", alongside: "mira-draft", at: T(58), pass: 1 },
    ]);
    // Moves along the chain's own connections are no detour.
    expect(view.detours).toEqual([]);
  });

  it("marks nothing when each draft's subagent is back before the next is announced", () => {
    const view = foldLiveSession(chain, run({ selectedCli: "codex" }), [
      report("context", 0),
      rollout({ kind: "tool.start", title: "exec", toolUseId: "own", at: T(5) }),
      rollout({ kind: "tool.end", title: "Tool finished", toolUseId: "own", at: T(6) }),
      report("aster-draft", 10),
      ...spawn("call-aster", 11),
      works("call-aster", "aster", 12),
      ends("call-aster", "aster", 20),
      report("mira-draft", 21),
      ...spawn("call-mira", 22),
      works("call-mira", "mira", 23),
      ends("call-mira", "mira", 30),
    ]);
    expect(view.overlaps).toEqual([]);
  });

  it("marks steps announced together once their subagents run them at once", () => {
    const view = foldLiveSession(chain, run({ selectedCli: "codex" }), [
      report("context", 0),
      rollout({ kind: "tool.start", title: "exec", toolUseId: "own", at: T(5) }),
      rollout({ kind: "tool.end", title: "Tool finished", toolUseId: "own", at: T(6) }),
      report("aster-draft", 10),
      report("mira-draft", 10.05),
      ...spawn("call-aster", 12),
      rollout({ kind: "message", title: "Message", detail: "Drafting.", stepTag: "aster-draft", parentToolUseId: "call-aster", author: { kind: "subagent", name: "aster" }, at: T(13) }),
      ...spawn("call-mira", 14),
      rollout({ kind: "message", title: "Message", detail: "Drafting.", stepTag: "mira-draft", parentToolUseId: "call-mira", author: { kind: "subagent", name: "mira" }, at: T(15) }),
    ]);
    expect(view.blocks["aster-draft"].state).toBe("running");
    expect(view.blocks["mira-draft"].state).toBe("running");
    expect(view.overlaps).toEqual([expect.objectContaining({ step: "mira-draft", alongside: "aster-draft" })]);
  });
});

/*
  ANT-303, from run ANT-OM3MK6RK. Codex ran `anthill done` on the last step,
  wrote its final record, ended its turn, and the person gave the same session
  another job — with subagents of its own. Each of those reopened the last
  step: Live on "Verify" for good, and "Unknown" once the run settled.
*/
describe("work in the session after the harness said it was done", () => {
  const T = (s: number) => new Date(Date.parse("2026-10-08T04:50:43.000Z") + s * 1000).toISOString();
  const rollout = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ cli: "codex", source: "rollout", channel: "codex:rollout", ...partial });
  const report = (blockId: string, s: number) =>
    event({ cli: "codex", kind: "step.marker", title: "Step announced", blockId, source: "anthill", channel: "anthill:report", at: T(s) });
  const done = (s: number) =>
    event({ cli: "codex", kind: "session.end", title: "The harness reported the work as finished", completion: "done", source: "anthill", channel: "anthill:report", at: T(s) });
  const call = (id: string, s: number) => [
    rollout({ kind: "tool.start", title: "exec", toolUseId: id, at: T(s) }),
    rollout({ kind: "tool.end", title: "Tool finished", toolUseId: id, at: T(s + 0.4) }),
  ];
  const journal = [
    report("implement", 0),
    ...call("a", 8),
    report("test", 20),
    ...call("b", 30),
    done(36),
    ...call("c", 52),
    rollout({ kind: "turn.end", title: "Codex finished the turn", at: T(59) }),
    event({ cli: "codex", kind: "prompt.submit", title: "A prompt was submitted", source: "hook", channel: "codex:hook", at: T(192) }),
    ...call("d", 197),
    rollout({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: "spawn", background: true, at: T(210) }),
    rollout({ kind: "tool.end", title: "Tool finished", toolUseId: "spawn", background: true, at: T(210.3) }),
  ];

  it("keeps the last step done, live or settled", () => {
    for (const state of ["detected_live", "completed"] as const) {
      const view = foldLiveSession(workflow, run({ state }), journal);
      expect(view.blocks.test.state).toBe("done");
      expect(view.activeBlockIds).toEqual([]);
      expect(view.endedAt).toBe(T(59));
    }
  });

  it("reopens a step the harness reports again", () => {
    const view = foldLiveSession(workflow, run(), [...journal, report("test", 240), ...call("e", 245)]);
    expect(view.blocks.test.state).toBe("running");
    expect(view.blocks.test.passes).toBe(2);
  });
});

/*
  ANT-306, shaped like run ANT-LES4RGQD. Codex's subagents live the whole run
  as one turn: each reports to the session (send_message to root), waits
  (wait_agent), and is given its next task with followup_task. Its turn never
  ended between tasks, so the drafts stayed Working for as long as the
  subagents lived, beside the join and reviews already under way.
*/
describe("Codex's long-lived subagents", () => {
  const council: Workflow = {
    ...workflow,
    target: "codex",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "context", type: "agent", name: "Freeze context", config: { actionKind: "agent-step", task: "c", agentId: "agent-dev" } },
      { id: "a-draft", type: "agent", name: "Corin draft", config: { actionKind: "design", task: "a", agentId: "agent-dev" } },
      { id: "b-draft", type: "agent", name: "Sable draft", config: { actionKind: "design", task: "b", agentId: "agent-dev" } },
      { id: "join", type: "agent", name: "Accept drafts", config: { actionKind: "verify", task: "j", agentId: "agent-qa" } },
      { id: "a-review", type: "agent", name: "Corin critiques Sable", config: { actionKind: "verify", task: "ar", agentId: "agent-qa" } },
      { id: "b-review", type: "agent", name: "Sable critiques Corin", config: { actionKind: "verify", task: "br", agentId: "agent-qa" } },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "context" },
      { id: "e2", source: "context", target: "a-draft" },
      { id: "e3", source: "context", target: "b-draft" },
      { id: "e4", source: "a-draft", target: "join" },
      { id: "e5", source: "b-draft", target: "join" },
      { id: "e6", source: "join", target: "a-review" },
      { id: "e7", source: "join", target: "b-review" },
      { id: "e8", source: "a-review", target: "end" },
      { id: "e9", source: "b-review", target: "end" },
    ],
  };
  const T = (s: number) => new Date(Date.parse("2026-10-08T05:46:49.000Z") + s * 1000).toISOString();
  const rollout = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ cli: "codex", source: "rollout", channel: "codex:rollout", ...partial });
  const report = (blockId: string, s: number) =>
    event({ cli: "codex", kind: "step.marker", title: "Step announced", blockId, source: "anthill", channel: "anthill:report", at: T(s) });
  const own = (id: string, s: number) => [
    rollout({ kind: "tool.start", title: "exec", toolName: "exec", toolUseId: id, at: T(s) }),
    rollout({ kind: "tool.end", title: "Tool finished", toolUseId: id, at: T(s + 0.3) }),
  ];
  const spawn = (call: string, name: string, s: number) => [
    rollout({ kind: "subagent.start", title: "Delegated to a subagent", toolName: "spawn_agent", toolUseId: call, agentName: name, background: true, at: T(s) }),
    rollout({ kind: "tool.end", title: "Tool finished", toolUseId: call, background: true, at: T(s + 0.2) }),
  ];
  const sub = (call: string, name: string, toolName: string, s: number, to?: string) =>
    rollout({ kind: "tool.start", title: toolName, toolName, toolUseId: `${call}-${toolName}-${s}`, parentToolUseId: call, author: { kind: "subagent", name }, ...(to ? { to } : {}), at: T(s) });
  const followup = (to: string, s: number) =>
    rollout({ kind: "tool.start", title: "followup_task", toolName: "followup_task", toolUseId: `fu-${to}-${s}`, to, at: T(s) });

  const drafts = [
    report("context", 0),
    ...own("ctx", 2),
    report("a-draft", 10),
    ...spawn("call-a", "corin", 12),
    report("b-draft", 14),
    ...spawn("call-b", "sable", 16),
    sub("call-a", "corin", "exec", 20),
    sub("call-b", "sable", "exec", 22),
    sub("call-a", "corin", "send_message", 200, "root"),
    sub("call-a", "corin", "wait_agent", 203),
    sub("call-b", "sable", "send_message", 260, "root"),
    sub("call-b", "sable", "wait_agent", 262),
  ];
  const reviews = [
    report("join", 300),
    ...own("join-check", 302),
    report("a-review", 310),
    followup("corin", 312),
    report("b-review", 320),
    followup("sable", 322),
    sub("call-a", "corin", "exec", 330),
    sub("call-b", "sable", "exec", 332),
  ];

  it("ends a draft when its subagent has reported and waits", () => {
    const view = foldLiveSession(council, run({ selectedCli: "codex" }), drafts);
    expect(view.blocks["a-draft"].state).toBe("done");
    expect(view.spans.find((span) => span.blockId === "a-draft")?.endedAt).toBe(T(203));
    // The step the session itself is on waits for the session to move on.
    expect(view.blocks["b-draft"].state).toBe("running");
    expect(view.activeBlockIds).toEqual(["b-draft"]);
  });

  it("does not take a report alone, with no wait after it, for the task handed back", () => {
    const view = foldLiveSession(council, run({ selectedCli: "codex" }), drafts.slice(0, 9));
    expect(view.blocks["a-draft"].state).toBe("running");
  });

  it("gives a follow-up's subagent to the step the session is on, and the join was not early", () => {
    const view = foldLiveSession(council, run({ selectedCli: "codex" }), [...drafts, ...reviews]);
    expect(view.blocks.join.state).toBe("done");
    expect(view.blocks["a-review"].state).toBe("running");
    expect(view.blocks["b-review"].state).toBe("running");
    expect(view.overlaps).toEqual([]);
    const work = view.events.find((item) => item.toolUseId === "call-a-exec-330");
    expect(work?.mapping.blockId).toBe("a-review");
  });

  it("takes a step back when its subagent works again after waiting, and ends it at the next wait", () => {
    const more = [...drafts, sub("call-a", "corin", "exec", 230)];
    expect(foldLiveSession(council, run({ selectedCli: "codex" }), more).blocks["a-draft"].state).toBe("running");
    const again = foldLiveSession(council, run({ selectedCli: "codex" }), [...more, sub("call-a", "corin", "wait_agent", 240)]);
    expect(again.blocks["a-draft"].state).toBe("done");
    expect(again.blocks["a-draft"].passes).toBe(1);
  });

  it("ends a step a follow-up moves its subagent away from, even before it reported", () => {
    const view = foldLiveSession(council, run({ selectedCli: "codex" }), [
      ...drafts.slice(0, 8),
      report("join", 300),
      ...own("join-check", 302),
      report("a-review", 310),
      followup("corin", 312),
    ]);
    expect(view.blocks["a-draft"].state).toBe("done");
    expect(view.blocks["a-review"].state).toBe("running");
  });
});

/*
  ANT-307, shaped like run ANT-4P5R899J. Codex spawned three authors while
  the session was still on `context`, and reported their steps only after, in
  one command. Every spawn went to `context`: it stayed Working, the authors
  read as started early, and two of them as done in 0.4 s.
*/
describe("subagents Codex starts before it reports their steps", () => {
  const council: Workflow = {
    ...workflow,
    target: "codex",
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      { id: "context", type: "agent", name: "Freeze evidence", config: { actionKind: "agent-step", task: "c", agentId: "editor" } },
      { id: "author-a", type: "agent", name: "Quill design", config: { actionKind: "design", task: "a", agentId: "quill" } },
      { id: "author-b", type: "agent", name: "Rowan design", config: { actionKind: "design", task: "b", agentId: "rowan" } },
      { id: "join", type: "agent", name: "Freeze drafts", config: { actionKind: "verify", task: "j", agentId: "editor" } },
      { id: "quill-review", type: "agent", name: "Quill critiques Rowan", config: { actionKind: "verify", task: "qr", agentId: "quill" } },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "context" },
      { id: "e2", source: "context", target: "author-a" },
      { id: "e3", source: "context", target: "author-b" },
      { id: "e4", source: "author-a", target: "join" },
      { id: "e5", source: "author-b", target: "join" },
      { id: "e6", source: "join", target: "quill-review" },
      { id: "e7", source: "quill-review", target: "end" },
    ],
    metadata: {
      workflow: {
        formatVersion: 4,
        agents: [
          { id: "editor", name: "Vale Council Editor" },
          { id: "quill", name: "Quill Pooled-Score Objective Architect" },
          { id: "rowan", name: "Rowan Reliability Gate Architect" },
        ],
      },
    },
  };
  const T = (s: number) => new Date(Date.parse("2026-10-08T06:41:08.000Z") + s * 1000).toISOString();
  const rollout = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">) =>
    event({ cli: "codex", source: "rollout", channel: "codex:rollout", ...partial });
  const report = (blockId: string, s: number) =>
    event({ cli: "codex", kind: "step.marker", title: "Step announced", blockId, source: "anthill", channel: "anthill:report", at: T(s) });
  const spawn = (call: string, name: string, s: number) => [
    rollout({ kind: "subagent.start", title: "Delegated to a subagent", toolName: "spawn_agent", toolUseId: call, agentName: name, background: true, at: T(s) }),
    rollout({ kind: "tool.end", title: "Tool finished", toolUseId: call, background: true, at: T(s + 0.2) }),
  ];
  const journal = [
    report("context", 0),
    rollout({ kind: "tool.start", title: "exec", toolName: "exec", toolUseId: "ctx", at: T(5) }),
    rollout({ kind: "tool.end", title: "Tool finished", toolUseId: "ctx", at: T(6) }),
    ...spawn("call-q", "quill_wp1", 29),
    ...spawn("call-r", "rowan_gate1", 33),
    report("author-a", 42.4),
    report("author-b", 42.8),
    rollout({ kind: "tool.start", title: "exec", toolName: "exec", toolUseId: "q-1", parentToolUseId: "call-q", author: { kind: "subagent", name: "quill_wp1" }, at: T(50) }),
  ];

  it("gives each spawn to its agent's nearest step, not the step the session was on", () => {
    const view = foldLiveSession(council, run({ selectedCli: "codex" }), journal);
    expect(view.blocks.context.state).toBe("done");
    expect(view.blocks["author-a"].state).toBe("running");
    expect(view.blocks["author-b"].state).toBe("running");
    expect(view.blocks["quill-review"].state).toBe("queued");
    expect(view.overlaps).toEqual([]);
    expect(view.events.find((item) => item.toolUseId === "q-1")?.mapping.blockId).toBe("author-a");
  });

  it("still gives a spawn named after no agent to the step the session is on", () => {
    const view = foldLiveSession(council, run({ selectedCli: "codex" }), [
      report("context", 0),
      ...spawn("call-x", "helper_1", 10),
    ]);
    expect(view.events.find((item) => item.kind === "subagent.start")?.mapping.blockId).toBe("context");
  });
});
