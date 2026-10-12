/**
 * A subagent's own todo list, per step (ANT-310): only what its tool
 * confirmed, attached to the step its subagent works for, and never a reason
 * for a step to change state.
 */

import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";

import { foldLiveSession } from "./live-session.js";
import type { ObservationEvent, TodoChange } from "./observation-event.js";
import { createPendingRun, type PendingRun } from "./pending-run.js";
import { todoProgress } from "./todos.js";

const workflow: Workflow = {
  id: "workflow-1",
  name: "Implement, test, fix",
  version: "1",
  target: "claude-code",
  nodes: [
    { id: "start", type: "start", name: "Start", config: {} },
    { id: "implement", type: "agent", name: "Make the change", config: { actionKind: "agent-step", task: "Write it", agentId: "agent-dev" } },
    { id: "test", type: "agent", name: "Run tests", config: { actionKind: "verify", task: "Run them", agentId: "agent-qa" } },
    { id: "end", type: "end", name: "Done", config: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "implement" },
    { id: "e2", source: "implement", target: "test" },
    { id: "e3", source: "test", target: "end" },
  ],
  metadata: { workflow: { formatVersion: 4, agents: [{ id: "agent-dev", name: "Developer" }, { id: "agent-qa", name: "Tester" }] } },
};

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
      now: "2026-10-10T10:00:00.000Z",
    }),
    state: "detected_live",
    detectedSessionId: "sess-1",
    ...partial,
  };
}

const T = (s: number) => new Date(Date.parse("2026-10-10T10:00:00.000Z") + s * 1000).toISOString();
let seq = 0;
const tx = (partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title">): ObservationEvent => {
  seq += 1;
  return {
    runId: "ANT-1A2B3C4D",
    seq,
    at: T(seq),
    recordedAt: T(seq),
    cli: "claude-code",
    source: "transcript",
    channel: "claude-code:transcript",
    sessionId: "sess-1",
    ...partial,
  };
};
const mark = (blockId: string, s: number) => tx({ kind: "step.marker", title: `Step ${blockId}`, blockId, at: T(s) });
const dispatch = (id: string, s: number) =>
  tx({ kind: "subagent.start", title: "Delegated to a subagent", toolUseId: id, background: true, at: T(s) });
const todo = (call: string, s: number, change: TodoChange, name = "Tester") =>
  tx({ kind: "todo", title: "Todo list changed", toolUseId: `todo-${s}`, parentToolUseId: call, author: { kind: "subagent", name }, todo: change, at: T(s) });

describe("a subagent's todo list", () => {
  it("is shown on the step its subagent was started for, as the agent kept it", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("implement", 1),
      mark("test", 2),
      dispatch("call-qa", 3),
      todo("call-qa", 4, { op: "upsert", id: "1", title: "Run the suite", status: "pending" }),
      todo("call-qa", 5, { op: "upsert", id: "2", title: "Write the summary", status: "pending" }),
      todo("call-qa", 6, { op: "upsert", id: "1", status: "in_progress" }),
      todo("call-qa", 7, { op: "upsert", id: "1", status: "completed" }),
    ]);
    expect(view.todos.implement).toBeUndefined();
    expect(view.todos.test).toHaveLength(1);
    const list = view.todos.test?.[0];
    expect(list?.owner).toBe("call-qa");
    expect(list?.ownerName).toBe("Tester");
    expect(list?.items).toEqual([
      { id: "1", title: "Run the suite", status: "completed" },
      { id: "2", title: "Write the summary", status: "pending" },
    ]);
    expect(list?.updatedAt).toBe(T(7));
    expect(todoProgress(list?.items ?? [])).toEqual({ done: 1, total: 2 });
  });

  it("takes a deleted task off the list rather than counting it done", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("test", 1),
      dispatch("call-qa", 2),
      todo("call-qa", 3, { op: "replace", items: [{ title: "One", status: "pending" }, { title: "Two", status: "pending" }] }),
      todo("call-qa", 4, { op: "upsert", id: "9", title: "Three", status: "pending" }),
      todo("call-qa", 5, { op: "upsert", id: "9", status: "deleted" }),
    ]);
    expect(view.todos.test?.[0]?.items.map((item) => item.title)).toEqual(["One", "Two"]);
    expect(todoProgress(view.todos.test?.[0]?.items ?? [])).toEqual({ done: 0, total: 2 });
  });

  it("ignores an update for a task the list never had", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("test", 1),
      dispatch("call-qa", 2),
      todo("call-qa", 3, { op: "upsert", id: "1", title: "Run the suite", status: "pending" }),
      todo("call-qa", 4, { op: "upsert", id: "7", status: "completed" }),
    ]);
    expect(view.todos.test?.[0]?.items).toEqual([{ id: "1", title: "Run the suite", status: "pending" }]);
  });

  it("keeps one list per subagent when two work for the same step", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("test", 1),
      dispatch("call-a", 2),
      dispatch("call-b", 3),
      todo("call-a", 4, { op: "replace", items: [{ title: "Unit tests", status: "in_progress" }] }, "Unit runner"),
      todo("call-b", 5, { op: "replace", items: [{ title: "E2E tests", status: "pending" }] }, "E2E runner"),
    ]);
    expect(view.todos.test?.map((list) => [list.owner, list.items[0]?.title])).toEqual([
      ["call-a", "Unit tests"],
      ["call-b", "E2E tests"],
    ]);
  });

  it("leaves out the session's own list, which is no one step's", () => {
    const view = foldLiveSession(workflow, run(), [
      mark("test", 1),
      tx({ kind: "todo", title: "Todo list changed", toolUseId: "t1", todo: { op: "replace", items: [{ title: "Plan", status: "pending" }] }, at: T(2) }),
    ]);
    expect(view.todos).toEqual({});
  });

  it("never moves a step", () => {
    const base = [mark("implement", 1), dispatch("call-dev", 2)];
    const changes = [
      todo("call-dev", 3, { op: "replace", items: [{ title: "Edit", status: "completed" }, { title: "Test", status: "completed" }] }, "Developer"),
      todo("call-dev", 40, { op: "replace", items: [{ title: "Edit", status: "completed" }] }, "Developer"),
    ];
    const without = foldLiveSession(workflow, run({ state: "completed" }), base);
    const withTodos = foldLiveSession(workflow, run({ state: "completed" }), [...base, ...changes]);
    expect(withTodos.blocks).toEqual(without.blocks);
    expect(withTodos.spans).toEqual(without.spans);
    expect(withTodos.lastSeenAt).toBe(without.lastSeenAt);
    expect(withTodos.unmappedCount).toBe(without.unmappedCount);
  });
});
