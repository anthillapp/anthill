import { describe, expect, it } from "vitest";

import type { AgentResult, RuntimeAdapterPort, WorkflowRun } from "./contracts.js";
import {
  NotImplementedError,
  WorkflowEngine,
  WorkflowValidationError,
  getRunFailureReason,
} from "./engine.js";
import {
  FakeApprovalGate,
  FakeRunStore,
  FakeRuntimeAdapter,
  MinimalRunStore,
  ThrowingRuntimeAdapter,
  agentNode,
  agentResult,
  edge,
  fakeClock,
  fakeIds,
  node,
  workflow,
} from "./test-helpers.js";

type Harness = {
  engine: WorkflowEngine;
  store: FakeRunStore;
  adapter: FakeRuntimeAdapter;
  approvals: FakeApprovalGate;
  clock: ReturnType<typeof fakeClock>;
};

function harness(
  options: {
    script?: ConstructorParameters<typeof FakeRuntimeAdapter>[1];
    decisions?: ConstructorParameters<typeof FakeApprovalGate>[0];
    onApprovalRequest?: (nodeId: string) => void;
    limits?: ConstructorParameters<typeof WorkflowEngine>[0]["limits"];
    adapters?: Map<string, RuntimeAdapterPort>;
  } = {},
): Harness {
  const store = new FakeRunStore();
  const adapter = new FakeRuntimeAdapter("fake", options.script ?? {});
  const approvals = new FakeApprovalGate(options.decisions ?? "approved", options.onApprovalRequest);
  const clock = fakeClock();
  const engine = new WorkflowEngine({
    adapters: options.adapters ?? new Map([["fake", adapter]]),
    runStore: store,
    approvals,
    limits: options.limits,
    now: clock.now,
    newId: fakeIds("run"),
  });
  return { engine, store, adapter, approvals, clock };
}

function nodeRunSummary(run: WorkflowRun): string[] {
  return run.nodeRuns.map((nodeRun) => `${nodeRun.nodeId}#${nodeRun.attempt}:${nodeRun.status}`);
}

/* ------------------------------------------------------------------ */
/* (a) linear workflow                                                 */
/* ------------------------------------------------------------------ */

const linearWorkflow = workflow(
  "linear",
  [
    node("start", "start"),
    agentNode("architect"),
    agentNode("developer"),
    agentNode("reviewer"),
    node("finish", "end"),
  ],
  [
    edge("start", "architect"),
    edge("architect", "developer"),
    edge("developer", "reviewer"),
    edge("reviewer", "finish"),
  ],
);

describe("linear workflow", () => {
  it("walks start -> agent -> agent -> agent -> end and records every node run", async () => {
    const { engine, store, adapter } = harness({
      script: {
        architect: agentResult({ summary: "workflow written" }),
        developer: agentResult({ summary: "code written" }),
        reviewer: agentResult({ summary: "reviewed", decision: "approved" }),
      },
    });

    const run = await engine.run(linearWorkflow, { inputs: { repo: "/tmp/demo" } });

    expect(run.status).toBe("success");
    expect(run.workflowId).toBe("linear");
    expect(run.workflowVersion).toBe("1.0.0");
    expect(run.finishedAt).toBeDefined();
    expect(adapter.callOrder()).toEqual(["architect", "developer", "reviewer"]);
    expect(nodeRunSummary(run)).toEqual([
      "start#1:success",
      "architect#1:success",
      "developer#1:success",
      "reviewer#1:success",
      "finish#1:success",
    ]);
    expect(getRunFailureReason(run)).toBeUndefined();
  });

  it("passes workflow context, run inputs, and prior results to the adapter", async () => {
    const { engine, adapter } = harness({
      script: { architect: agentResult({ summary: "workflow written" }) },
    });

    await engine.run(linearWorkflow, { inputs: { repo: "/tmp/demo" } });

    const developerCall = adapter.calls.find((call) => call.nodeId === "developer")!;
    expect(developerCall.attempt).toBe(1);
    expect(developerCall.inputs).toEqual({ repo: "/tmp/demo" });
    expect(developerCall.instructions).toBe("do developer");
    expect(developerCall.workflow.id).toBe("linear");
    expect(developerCall.node.type).toBe("agent");
    expect(developerCall.priorResults["architect"]?.summary).toBe("workflow written");
    // Only completed nodes are visible; the current node is not.
    expect(developerCall.priorResults["developer"]).toBeUndefined();
  });

  it("streams progress to the run store so a caller can observe it mid-run", async () => {
    const { engine, store } = harness();

    const run = await engine.run(linearWorkflow);

    expect(store.events[0]?.kind).toBe("createRun");
    expect(store.runStatuses()).toEqual(["running", "success"]);
    // Each node is written twice: once as `running`, once with its outcome.
    const events = store.nodeRunEvents();
    expect(events.map((event) => `${event.nodeId}:${event.status}`)).toEqual([
      "start:running",
      "start:success",
      "architect:running",
      "architect:success",
      "developer:running",
      "developer:success",
      "reviewer:running",
      "reviewer:success",
      "finish:running",
      "finish:success",
    ]);
    await expect(store.getRun(run.id)).resolves.toEqual(run);
  });

  it("works with a run store that implements only the required port methods", async () => {
    const store = new MinimalRunStore();
    const engine = new WorkflowEngine({
      adapters: new Map([["fake", new FakeRuntimeAdapter("fake")]]),
      runStore: store,
      approvals: new FakeApprovalGate(),
    });

    const run = await engine.run(linearWorkflow);

    expect(run.status).toBe("success");
    expect(store.nodeRuns.length).toBe(10);
  });
});

/* ------------------------------------------------------------------ */
/* (b) review loop (MVP success criteria)                              */
/* ------------------------------------------------------------------ */

function reviewLoopWorkflow(developerMaxAttempts: number, reviewerMaxAttempts: number) {
  return workflow(
    "review-loop",
    [
      node("start", "start"),
      agentNode("architect"),
      agentNode("developer", { retryPolicy: { maxAttempts: developerMaxAttempts } }),
      agentNode("reviewer", { retryPolicy: { maxAttempts: reviewerMaxAttempts } }),
      node("finish", "end"),
    ],
    [
      edge("start", "architect"),
      edge("architect", "developer"),
      edge("developer", "reviewer"),
      edge("reviewer", "developer", {
        condition: 'reviewer.decision == "changes_requested"',
        label: "changes",
      }),
      edge("reviewer", "finish", { condition: 'reviewer.decision == "approved"' }),
    ],
  );
}

const changesRequested = agentResult({
  summary: "Error handling is missing.",
  decision: "changes_requested",
  issues: [{ severity: "medium", title: "Missing failure path test", file: "src/client.ts" }],
});

const approved = agentResult({ summary: "Looks good.", decision: "approved" });

describe("review loop", () => {
  it("loops back to the developer on changes_requested and finishes when approved", async () => {
    const { engine, adapter } = harness({
      script: {
        architect: agentResult({ summary: "workflow" }),
        developer: [agentResult({ summary: "v1" }), agentResult({ summary: "v2" })],
        reviewer: [changesRequested, approved],
      },
    });

    const run = await engine.run(reviewLoopWorkflow(3, 3));

    expect(run.status).toBe("success");
    expect(adapter.callOrder()).toEqual([
      "architect",
      "developer",
      "reviewer",
      "developer",
      "reviewer",
    ]);
    expect(nodeRunSummary(run)).toEqual([
      "start#1:success",
      "architect#1:success",
      "developer#1:success",
      "reviewer#1:success",
      "developer#2:success",
      "reviewer#2:success",
      "finish#1:success",
    ]);
  });

  it("hands the review context to the developer's second attempt", async () => {
    const { engine, adapter } = harness({
      script: {
        developer: [agentResult({ summary: "v1" }), agentResult({ summary: "v2" })],
        reviewer: [changesRequested, approved],
      },
    });

    await engine.run(reviewLoopWorkflow(3, 3));

    const secondDeveloperCall = adapter.calls.filter((call) => call.nodeId === "developer")[1]!;
    expect(secondDeveloperCall.attempt).toBe(2);
    expect(secondDeveloperCall.priorResults["reviewer"]?.decision).toBe("changes_requested");
    expect(secondDeveloperCall.priorResults["reviewer"]?.issues[0]?.title).toBe(
      "Missing failure path test",
    );
  });

  it("records the final artifacts of the approved run", async () => {
    const { engine } = harness({
      script: {
        developer: agentResult({
          summary: "v1",
          artifacts: [{ id: "patch-1", type: "patch", title: "feature.patch" }],
        }),
        reviewer: approved,
      },
    });

    const run = await engine.run(reviewLoopWorkflow(3, 3));
    const developerRun = run.nodeRuns.find((nodeRun) => nodeRun.nodeId === "developer")!;

    expect(run.status).toBe("success");
    expect(developerRun.result?.artifacts).toEqual([
      { id: "patch-1", type: "patch", title: "feature.patch" },
    ]);
  });

  it("fails with a clear error when no outgoing edge matches", async () => {
    const { engine } = harness({
      script: { reviewer: agentResult({ decision: "needs_discussion" }) },
    });

    const run = await engine.run(reviewLoopWorkflow(3, 3));
    const failure = getRunFailureReason(run);

    expect(run.status).toBe("failed");
    expect(failure?.code).toBe("NO_MATCHING_EDGE");
    expect(failure?.nodeId).toBe("reviewer");
    expect(failure?.message).toContain('No outgoing edge of node "reviewer"');
    expect(failure?.message).toContain('reviewer.decision == "approved"');
  });
});

/* ------------------------------------------------------------------ */
/* (c) loop safety                                                     */
/* ------------------------------------------------------------------ */

describe("loop safety", () => {
  it("fails the run when a looping node exceeds its attempt limit", async () => {
    const { engine, adapter } = harness({
      script: { reviewer: changesRequested },
    });

    const run = await engine.run(reviewLoopWorkflow(2, 5));
    const failure = getRunFailureReason(run);

    expect(run.status).toBe("failed");
    expect(failure?.code).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(failure?.nodeId).toBe("developer");
    expect(failure?.message).toContain("attempt limit of 2");
    expect(adapter.callOrder()).toEqual([
      "architect",
      "developer",
      "reviewer",
      "developer",
      "reviewer",
    ]);
    expect(run.nodeRuns.at(-1)?.status).toBe("failed");
  });

  it("defaults to a single attempt per node when no retry policy is configured", async () => {
    const { engine } = harness({ script: { reviewer: changesRequested } });
    const looping = workflow(
      "no-policy",
      [node("start", "start"), agentNode("reviewer"), node("finish", "end")],
      [
        edge("start", "reviewer"),
        edge("reviewer", "reviewer", { condition: 'reviewer.decision == "changes_requested"' }),
        edge("reviewer", "finish", { condition: 'reviewer.decision == "approved"' }),
      ],
    );

    const run = await engine.run(looping);

    expect(run.status).toBe("failed");
    expect(getRunFailureReason(run)?.code).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(getRunFailureReason(run)?.message).toContain("attempt limit of 1");
  });

  it("enforces the global cap on total node executions", async () => {
    const { engine } = harness({
      script: { reviewer: changesRequested },
      limits: { maxTotalNodeExecutions: 4 },
    });

    const run = await engine.run(reviewLoopWorkflow(50, 50));
    const failure = getRunFailureReason(run);

    expect(run.status).toBe("failed");
    expect(failure?.code).toBe("MAX_NODE_EXECUTIONS_EXCEEDED");
    expect(failure?.message).toContain("maximum of 4 total node executions");
  });

  it("enforces the global wall-clock limit", async () => {
    const store = new FakeRunStore();
    const clock = fakeClock();
    const adapter = new FakeRuntimeAdapter("fake", {
      architect: () => {
        clock.advance(120_000);
        return agentResult({ summary: "slow workflow" });
      },
    });
    const engine = new WorkflowEngine({
      adapters: new Map([["fake", adapter]]),
      runStore: store,
      approvals: new FakeApprovalGate(),
      limits: { maxDurationMs: 1_000 },
      now: clock.now,
      newId: fakeIds("run"),
    });

    const run = await engine.run(linearWorkflow);
    const failure = getRunFailureReason(run);

    expect(run.status).toBe("failed");
    expect(failure?.code).toBe("MAX_DURATION_EXCEEDED");
    expect(failure?.message).toContain("maximum duration of 1000ms");
    expect(adapter.callOrder()).toEqual(["architect"]);
  });
});

/* ------------------------------------------------------------------ */
/* (d) approval node                                                   */
/* ------------------------------------------------------------------ */

const approvalWorkflow = workflow(
  "approval",
  [
    node("start", "start"),
    agentNode("developer"),
    node("gate", "approval", { prompt: "Ship it?" }),
    node("shipped", "end"),
    node("abandoned", "end", { status: "failed", summary: "Change was rejected." }),
  ],
  [
    edge("start", "developer"),
    edge("developer", "gate"),
    edge("gate", "shipped", { label: "Approved" }),
    edge("gate", "abandoned", { label: "REJECTED" }),
  ],
);

describe("approval node", () => {
  it("pauses the run, then continues down the approved edge", async () => {
    const pausedSnapshots: string[][] = [];
    const { engine, store, approvals } = harness({
      decisions: "approved",
      onApprovalRequest: () => pausedSnapshots.push(store.runStatuses()),
    });

    const run = await engine.run(approvalWorkflow, { inputs: { branch: "feat/x" } });

    expect(run.status).toBe("success");
    // The store observed `paused` before the decision resolved.
    expect(pausedSnapshots[0]).toEqual(["running", "paused"]);
    expect(store.runStatuses()).toEqual(["running", "paused", "running", "success"]);
    expect(nodeRunSummary(run)).toEqual([
      "start#1:success",
      "developer#1:success",
      "gate#1:success",
      "shipped#1:success",
    ]);
    expect(
      store.nodeRunEvents().filter((event) => event.nodeId === "gate" && event.status === "paused"),
    ).toHaveLength(1);
    expect(run.nodeRuns.find((nodeRun) => nodeRun.nodeId === "gate")?.result?.decision).toBe(
      "approved",
    );

    const request = approvals.requests[0]!;
    expect(request.nodeId).toBe("gate");
    expect(request.runId).toBe(run.id);
    expect(request.context["inputs"]).toEqual({ branch: "feat/x" });
    expect(request.context["config"]).toEqual({ prompt: "Ship it?" });
    expect((request.context["priorResults"] as Record<string, AgentResult>)["developer"]).toBeDefined();
  });

  it("continues down the rejected edge and honours a failure end node", async () => {
    const { engine, store } = harness({ decisions: "rejected" });

    const run = await engine.run(approvalWorkflow);

    expect(run.status).toBe("failed");
    expect(nodeRunSummary(run)).toEqual([
      "start#1:success",
      "developer#1:success",
      "gate#1:success",
      "abandoned#1:failed",
    ]);
    expect(getRunFailureReason(run)?.code).toBe("END_NODE_FAILURE");
    expect(getRunFailureReason(run)?.message).toBe("Change was rejected.");
    expect(store.runStatuses().at(-1)).toBe("failed");
  });

  it("matches approval edge labels case-insensitively", async () => {
    const { engine } = harness({ decisions: "rejected" });
    const run = await engine.run(approvalWorkflow);
    expect(run.nodeRuns.at(-1)?.nodeId).toBe("abandoned");
  });

  it("supports conditions on approval edges as well as labels", async () => {
    const { engine } = harness({ decisions: "approved" });
    const conditional = workflow(
      "approval-conditional",
      [node("start", "start"), node("gate", "approval"), node("finish", "end")],
      [
        edge("start", "gate"),
        edge("gate", "finish", { condition: 'gate.decision == "approved"' }),
      ],
    );

    const run = await engine.run(conditional);

    expect(run.status).toBe("success");
  });

  it("fails when no edge matches the decision", async () => {
    const { engine } = harness({ decisions: "rejected" });
    const oneWay = workflow(
      "approval-one-way",
      [node("start", "start"), node("gate", "approval"), node("finish", "end")],
      [edge("start", "gate"), edge("gate", "finish", { label: "approved" })],
    );

    const run = await engine.run(oneWay);
    const failure = getRunFailureReason(run);

    expect(run.status).toBe("failed");
    expect(failure?.code).toBe("NO_MATCHING_EDGE");
    expect(failure?.message).toContain('for decision "rejected"');
  });

  it("fails the run when the approval gate throws", async () => {
    const store = new FakeRunStore();
    const engine = new WorkflowEngine({
      adapters: new Map([["fake", new FakeRuntimeAdapter("fake")]]),
      runStore: store,
      approvals: {
        async requestApproval() {
          throw new Error("ui disconnected");
        },
      },
    });

    const run = await engine.run(approvalWorkflow);

    expect(run.status).toBe("failed");
    expect(getRunFailureReason(run)?.code).toBe("APPROVAL_FAILED");
    expect(getRunFailureReason(run)?.message).toContain("ui disconnected");
  });
});

/* ------------------------------------------------------------------ */
/* Agent failure / retry semantics                                     */
/* ------------------------------------------------------------------ */

describe("agent node failures", () => {
  const retryWorkflow = (maxAttempts: number) =>
    workflow(
      "retry",
      [
        node("start", "start"),
        agentNode("developer", { retryPolicy: { maxAttempts } }),
        node("finish", "end"),
      ],
      [edge("start", "developer"), edge("developer", "finish")],
    );

  it("retries a failed agent node as a new attempt of the same node", async () => {
    const { engine, adapter } = harness({
      script: {
        developer: [
          agentResult({ status: "failed", summary: "compile error" }),
          agentResult({ status: "failed", summary: "test failure" }),
          agentResult({ summary: "green" }),
        ],
      },
    });

    const run = await engine.run(retryWorkflow(3));

    expect(run.status).toBe("success");
    expect(adapter.callOrder()).toEqual(["developer", "developer", "developer"]);
    expect(nodeRunSummary(run)).toEqual([
      "start#1:success",
      "developer#1:failed",
      "developer#2:failed",
      "developer#3:success",
      "finish#1:success",
    ]);
  });

  it("fails the run once the attempts are exhausted", async () => {
    const { engine } = harness({
      script: { developer: agentResult({ status: "failed", summary: "compile error" }) },
    });

    const run = await engine.run(retryWorkflow(2));
    const failure = getRunFailureReason(run);

    expect(run.status).toBe("failed");
    expect(failure?.code).toBe("NODE_FAILED");
    expect(failure?.message).toContain("failed after 2 attempt(s)");
    expect(failure?.message).toContain("compile error");
  });

  it("turns an adapter exception into a failed agent result", async () => {
    const engineHarness = harness({
      adapters: new Map([["fake", new ThrowingRuntimeAdapter("fake", "codex not installed")]]),
    });

    const run = await engineHarness.engine.run(retryWorkflow(1));

    expect(run.status).toBe("failed");
    expect(getRunFailureReason(run)?.message).toContain("codex not installed");
    expect(run.nodeRuns.at(-1)?.result?.metadata["threw"]).toBe(true);
  });

  it("cancels the run when an agent reports cancelled", async () => {
    const { engine } = harness({
      script: { developer: agentResult({ status: "cancelled", summary: "user aborted" }) },
    });

    const run = await engine.run(retryWorkflow(3));

    expect(run.status).toBe("cancelled");
    expect(getRunFailureReason(run)?.code).toBe("NODE_CANCELLED");
  });

  it("fails when the node's runtime is not registered", async () => {
    const { engine } = harness();
    const unknown = workflow(
      "unknown-runtime",
      [
        node("start", "start"),
        node("developer", "agent", { runtime: "gemini-cli" }),
        node("finish", "end"),
      ],
      [edge("start", "developer"), edge("developer", "finish")],
    );

    const run = await engine.run(unknown);
    const failure = getRunFailureReason(run);

    expect(run.status).toBe("failed");
    expect(failure?.code).toBe("UNKNOWN_RUNTIME");
    expect(failure?.message).toContain('"gemini-cli"');
  });
});

/* ------------------------------------------------------------------ */
/* Condition nodes, fan-out, command nodes, validation                 */
/* ------------------------------------------------------------------ */

describe("condition nodes", () => {
  const conditionWorkflow = workflow(
    "condition",
    [
      node("start", "start"),
      agentNode("tester"),
      node("gate", "condition"),
      node("passed", "end"),
      node("failedEnd", "end", { status: "failed", summary: "tests are red" }),
    ],
    [
      edge("start", "tester"),
      edge("tester", "gate"),
      edge("gate", "passed", { condition: 'tester.decision == "green"' }),
      edge("gate", "failedEnd", { condition: 'tester.decision != "green"' }),
    ],
  );

  it("routes without calling any adapter", async () => {
    const { engine, adapter } = harness({ script: { tester: agentResult({ decision: "green" }) } });

    const run = await engine.run(conditionWorkflow);

    expect(run.status).toBe("success");
    expect(adapter.callOrder()).toEqual(["tester"]);
    expect(run.nodeRuns.map((nodeRun) => nodeRun.nodeId)).toEqual([
      "start",
      "tester",
      "gate",
      "passed",
    ]);
  });

  it("takes the != branch and ends in a failure end node", async () => {
    const { engine } = harness({ script: { tester: agentResult({ decision: "red" }) } });

    const run = await engine.run(conditionWorkflow);

    expect(run.status).toBe("failed");
    expect(getRunFailureReason(run)?.message).toBe("tests are red");
  });

  it("fails the run when an edge condition cannot be parsed", async () => {
    const { engine } = harness({ script: { tester: agentResult({ decision: "green" }) } });
    const broken = workflow(
      "broken-condition",
      [node("start", "start"), agentNode("tester"), node("finish", "end")],
      [edge("start", "tester"), edge("tester", "finish", { condition: "tester.decision ~= green" })],
    );

    const run = await engine.run(broken);
    const failure = getRunFailureReason(run);

    expect(run.status).toBe("failed");
    expect(failure?.code).toBe("INVALID_CONDITION");
    expect(failure?.message).toContain("unusable condition");
  });
});

describe("fan-out", () => {
  it("executes every matching outgoing edge", async () => {
    const { engine, adapter } = harness();
    const parallel = workflow(
      "fan-out",
      [
        node("start", "start"),
        agentNode("lint"),
        agentNode("test"),
        agentNode("collect"),
        node("finish", "end"),
      ],
      [
        edge("start", "lint"),
        edge("start", "test"),
        edge("lint", "collect"),
        edge("test", "collect", { id: "test->collect" }),
        edge("collect", "finish"),
      ],
    );

    const run = await engine.run(parallel, {});

    expect(run.status).toBe("success");
    expect(adapter.callOrder().slice(0, 2).sort()).toEqual(["lint", "test"]);
    expect(adapter.callOrder()).toContain("collect");
  });
});

describe("command nodes", () => {
  it("throws NotImplementedError and persists the failed run", async () => {
    const { engine, store } = harness();
    const withCommand = workflow(
      "command",
      [node("start", "start"), node("build", "command", { command: "npm test" }), node("finish", "end")],
      [edge("start", "build"), edge("build", "finish")],
    );

    await expect(engine.run(withCommand)).rejects.toBeInstanceOf(NotImplementedError);

    const persisted = await store.getRun("run_run1");
    expect(persisted?.status).toBe("failed");
    expect(getRunFailureReason(persisted!)?.code).toBe("NOT_IMPLEMENTED");
    expect(getRunFailureReason(persisted!)?.message).toContain("@anthill/runtimes");
  });
});

describe("workflow validation", () => {
  it("rejects a workflow without a start node", async () => {
    const { engine } = harness();
    const invalid = workflow("no-start", [node("finish", "end")], []);

    await expect(engine.run(invalid)).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it("rejects a workflow with more than one start node", async () => {
    const { engine } = harness();
    const invalid = workflow(
      "two-starts",
      [node("s1", "start"), node("s2", "start"), node("finish", "end")],
      [edge("s1", "finish"), edge("s2", "finish")],
    );

    await expect(engine.run(invalid)).rejects.toThrow(/exactly one "start" node/);
  });

  it("rejects edges pointing at unknown nodes", async () => {
    const { engine } = harness();
    const invalid = workflow(
      "dangling",
      [node("start", "start"), node("finish", "end")],
      [edge("start", "ghost")],
    );

    await expect(engine.run(invalid)).rejects.toThrow(/unknown target "ghost"/);
  });

  it("does not create a run for an invalid workflow", async () => {
    const { engine, store } = harness();
    const invalid = workflow("no-start", [node("finish", "end")], []);

    await expect(engine.run(invalid)).rejects.toThrow(WorkflowValidationError);
    expect(store.events).toHaveLength(0);
  });

  it("fails at runtime when a non-terminal node has no outgoing edges", async () => {
    const { engine } = harness();
    const dead = workflow("dead-end", [node("start", "start")], []);

    const run = await engine.run(dead);

    expect(run.status).toBe("failed");
    expect(getRunFailureReason(run)?.code).toBe("NO_MATCHING_EDGE");
    expect(getRunFailureReason(run)?.message).toContain("Outgoing edges: none");
  });
});
