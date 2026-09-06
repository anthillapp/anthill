import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRunStore, RunNotFoundError } from "./sqlite-run-store.js";
import type {
  AgentResult,
  NodeRun,
  RunStore,
  WorkflowRun,
  WorkflowSnapshot,
} from "./contracts.js";

const tempRoots: string[] = [];
const openStores: RunStore[] = [];

async function makeRootDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "anthill-run-store-"));
  tempRoots.push(dir);
  return dir;
}

async function openStore(rootDir: string): Promise<RunStore> {
  const store = await createRunStore({ rootDir });
  openStores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close?.()));
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const snapshot: WorkflowSnapshot = {
  id: "wf-review",
  version: "3.1.0",
  nodes: [
    { id: "workflow", type: "agent", prompt: "Plan the change" },
    { id: "review", type: "agent", prompt: "Review the diff" },
  ],
  edges: [{ from: "workflow", to: "review" }],
};

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "wf-review",
    workflowVersion: "3.1.0",
    status: "running",
    startedAt: "2026-08-25T10:00:00.000Z",
    nodeRuns: [
      { id: "nr-workflow-1", nodeId: "workflow", attempt: 1, status: "queued" },
      { id: "nr-review-1", nodeId: "review", attempt: 1, status: "queued" },
    ],
    ...overrides,
  };
}

const failedResult: AgentResult = {
  status: "failed",
  summary: "Reviewer found blocking issues",
  artifacts: [],
  issues: [
    { severity: "critical", title: "SQL injection", file: "src/db.ts" },
    { severity: "low", title: "Typo in comment" },
  ],
  metadata: { model: "opus-5" },
};

const successResult: AgentResult = {
  status: "success",
  summary: "Second attempt passed",
  decision: "approve",
  artifacts: [],
  issues: [],
  metrics: { durationMs: 4210, tokens: 18_432 },
  metadata: { model: "opus-5", retryOf: "nr-review-1" },
};

describe("createRunStore", () => {
  it("creates a run and reads it back with its snapshot intact", async () => {
    const store = await openStore(await makeRootDir());
    await store.createRun(makeRun(), snapshot);

    const stored = await store.getRun("run-1");
    expect(stored).toBeDefined();
    expect(stored?.workflowId).toBe("wf-review");
    expect(stored?.workflowVersion).toBe("3.1.0");
    expect(stored?.status).toBe("running");
    expect(stored?.startedAt).toBe("2026-08-25T10:00:00.000Z");
    expect(stored?.finishedAt).toBeUndefined();
    expect(stored?.nodeRuns).toHaveLength(2);
    expect(stored?.snapshot).toEqual(snapshot);
  });

  it("returns undefined for an unknown run", async () => {
    const store = await openStore(await makeRootDir());
    expect(await store.getRun("nope")).toBeUndefined();
  });

  it("keeps the snapshot verbatim even after the run is updated", async () => {
    const store = await openStore(await makeRootDir());
    await store.createRun(makeRun(), snapshot);
    await store.updateRunStatus("run-1", "success", "2026-08-25T10:30:00.000Z");

    const stored = await store.getRun("run-1");
    expect(stored?.snapshot).toEqual(snapshot);
    // Mutating the returned copy must not affect what is stored.
    (stored?.snapshot as Record<string, unknown>).nodes = [];
    expect((await store.getRun("run-1"))?.snapshot).toEqual(snapshot);
  });
});

describe("updateNodeRun", () => {
  it("records multiple attempts of the same node side by side", async () => {
    const store = await openStore(await makeRootDir());
    await store.createRun(makeRun(), snapshot);

    const attempt1: NodeRun = {
      id: "nr-review-1",
      nodeId: "review",
      attempt: 1,
      status: "failed",
      startedAt: "2026-08-25T10:05:00.000Z",
      finishedAt: "2026-08-25T10:06:00.000Z",
      result: failedResult,
    };
    const attempt2: NodeRun = {
      id: "nr-review-2",
      nodeId: "review",
      attempt: 2,
      status: "success",
      startedAt: "2026-08-25T10:07:00.000Z",
      finishedAt: "2026-08-25T10:09:00.000Z",
      result: successResult,
    };

    await store.updateNodeRun("run-1", attempt1);
    await store.updateNodeRun("run-1", attempt2);

    const stored = await store.getRun("run-1");
    const reviewAttempts = stored?.nodeRuns.filter((nr) => nr.nodeId === "review") ?? [];
    expect(reviewAttempts).toHaveLength(2);
    expect(reviewAttempts.map((nr) => nr.attempt)).toEqual([1, 2]);
    expect(reviewAttempts[0]?.status).toBe("failed");
    expect(reviewAttempts[0]?.result).toEqual(failedResult);
    expect(reviewAttempts[1]?.status).toBe("success");
    expect(reviewAttempts[1]?.result).toEqual(successResult);
    // The untouched node is still there.
    expect(stored?.nodeRuns.filter((nr) => nr.nodeId === "workflow")).toHaveLength(1);
  });

  it("updates an existing attempt in place instead of duplicating it", async () => {
    const store = await openStore(await makeRootDir());
    await store.createRun(makeRun(), snapshot);

    await store.updateNodeRun("run-1", {
      id: "nr-workflow-1",
      nodeId: "workflow",
      attempt: 1,
      status: "running",
      startedAt: "2026-08-25T10:01:00.000Z",
    });
    await store.updateNodeRun("run-1", {
      id: "nr-workflow-1",
      nodeId: "workflow",
      attempt: 1,
      status: "success",
      startedAt: "2026-08-25T10:01:00.000Z",
      finishedAt: "2026-08-25T10:04:00.000Z",
      result: { ...successResult, summary: "Planned" },
    });

    const stored = await store.getRun("run-1");
    const workflowAttempts = stored?.nodeRuns.filter((nr) => nr.nodeId === "workflow") ?? [];
    expect(workflowAttempts).toHaveLength(1);
    expect(workflowAttempts[0]?.status).toBe("success");
    expect(workflowAttempts[0]?.finishedAt).toBe("2026-08-25T10:04:00.000Z");
    expect(workflowAttempts[0]?.result?.summary).toBe("Planned");
  });

  it("throws for an unknown run", async () => {
    const store = await openStore(await makeRootDir());
    await expect(
      store.updateNodeRun("ghost", {
        id: "nr-x",
        nodeId: "x",
        attempt: 1,
        status: "queued",
      }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

describe("updateRunStatus", () => {
  it("updates status and finishedAt", async () => {
    const store = await openStore(await makeRootDir());
    await store.createRun(makeRun(), snapshot);

    await store.updateRunStatus("run-1", "paused");
    expect((await store.getRun("run-1"))?.status).toBe("paused");
    expect((await store.getRun("run-1"))?.finishedAt).toBeUndefined();

    await store.updateRunStatus("run-1", "failed", "2026-08-25T11:00:00.000Z");
    const stored = await store.getRun("run-1");
    expect(stored?.status).toBe("failed");
    expect(stored?.finishedAt).toBe("2026-08-25T11:00:00.000Z");
  });

  it("throws for an unknown run", async () => {
    const store = await openStore(await makeRootDir());
    await expect(store.updateRunStatus("ghost", "success")).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });
});

describe("listRuns", () => {
  async function seed(store: RunStore): Promise<void> {
    await store.createRun(
      makeRun({
        id: "run-a",
        workflowId: "wf-review",
        status: "success",
        startedAt: "2026-08-25T09:00:00.000Z",
      }),
      snapshot,
    );
    await store.createRun(
      makeRun({
        id: "run-b",
        workflowId: "wf-review",
        status: "failed",
        startedAt: "2026-08-25T10:00:00.000Z",
      }),
      snapshot,
    );
    await store.createRun(
      makeRun({
        id: "run-c",
        workflowId: "wf-deploy",
        status: "success",
        startedAt: "2026-08-25T11:00:00.000Z",
      }),
      snapshot,
    );
  }

  it("lists every run newest first", async () => {
    const store = await openStore(await makeRootDir());
    await seed(store);

    const runs = await store.listRuns();
    expect(runs.map((r) => r.id)).toEqual(["run-c", "run-b", "run-a"]);
    expect(runs[0]?.nodeRuns).toHaveLength(2);
  });

  it("filters by workflowId", async () => {
    const store = await openStore(await makeRootDir());
    await seed(store);

    const runs = await store.listRuns({ workflowId: "wf-review" });
    expect(runs.map((r) => r.id)).toEqual(["run-b", "run-a"]);
  });

  it("filters by status", async () => {
    const store = await openStore(await makeRootDir());
    await seed(store);

    const runs = await store.listRuns({ status: "success" });
    expect(runs.map((r) => r.id)).toEqual(["run-c", "run-a"]);
  });

  it("filters by workflowId and status together", async () => {
    const store = await openStore(await makeRootDir());
    await seed(store);

    const runs = await store.listRuns({ workflowId: "wf-review", status: "success" });
    expect(runs.map((r) => r.id)).toEqual(["run-a"]);
    expect(await store.listRuns({ workflowId: "wf-deploy", status: "failed" })).toEqual([]);
  });
});

describe("saveArtifact", () => {
  it("writes the content to disk and returns the artifact with a path", async () => {
    const rootDir = await makeRootDir();
    const store = await openStore(rootDir);
    await store.createRun(makeRun(), snapshot);

    const content = "# Review notes\n\nLooks good apart from `src/db.ts`.\n";
    const saved = await store.saveArtifact(
      "run-1",
      "review",
      { id: "notes", type: "markdown", title: "Review notes", metadata: { lines: 3 } },
      content,
    );

    expect(saved.path).toBeDefined();
    expect(saved.id).toBe("notes");
    expect(saved.title).toBe("Review notes");
    expect(saved.metadata).toEqual({ lines: 3 });
    expect(saved.path).toBe(path.join(rootDir, "artifacts", "run-1", "review", "notes.md"));
    await expect(stat(saved.path as string)).resolves.toBeDefined();
    expect(await readFile(saved.path as string, "utf8")).toBe(content);
  });

  it("keeps artifacts of different nodes and runs apart", async () => {
    const rootDir = await makeRootDir();
    const store = await openStore(rootDir);
    await store.createRun(makeRun(), snapshot);

    const a = await store.saveArtifact(
      "run-1",
      "workflow",
      { id: "out", type: "json", title: "Workflow" },
      '{"steps":1}',
    );
    const b = await store.saveArtifact(
      "run-1",
      "review",
      { id: "out", type: "json", title: "Review" },
      '{"steps":2}',
    );

    expect(a.path).not.toBe(b.path);
    expect(await readFile(a.path as string, "utf8")).toBe('{"steps":1}');
    expect(await readFile(b.path as string, "utf8")).toBe('{"steps":2}');
  });

  it("survives ids that are unsafe as path segments", async () => {
    const rootDir = await makeRootDir();
    const store = await openStore(rootDir);
    await store.createRun(makeRun(), snapshot);

    const saved = await store.saveArtifact(
      "run-1",
      "../../escape",
      { id: "../../evil", type: "text", title: "Nope" },
      "contained",
    );

    expect(saved.path?.startsWith(path.join(rootDir, "artifacts"))).toBe(true);
    expect(saved.path).not.toContain("..");
    expect(await readFile(saved.path as string, "utf8")).toBe("contained");
  });
});

describe("appendLog", () => {
  it("appends to one file per (run, node, kind) and is retrievable from the run", async () => {
    const rootDir = await makeRootDir();
    const store = await openStore(rootDir);
    await store.createRun(makeRun(), snapshot);

    const first = await store.appendLog("run-1", "review", "stdout", "starting review\n");
    const second = await store.appendLog("run-1", "review", "stdout", "done\n");
    const stderr = await store.appendLog("run-1", "review", "stderr", "warning\n");

    expect(second.id).toBe(first.id);
    expect(second.path).toBe(first.path);
    expect(first.kind).toBe("stdout");
    expect(first.path).toBe(path.join(rootDir, "logs", "run-1", "review", "stdout.log"));
    expect(await readFile(first.path, "utf8")).toBe("starting review\ndone\n");
    expect(await readFile(stderr.path, "utf8")).toBe("warning\n");

    const stored = await store.getRun("run-1");
    const review = stored?.nodeRuns.find((nr) => nr.nodeId === "review");
    expect(review?.logs?.map((l) => l.id).sort()).toEqual(
      [first.id, stderr.id].sort(),
    );
    expect(review?.logs?.find((l) => l.kind === "stdout")?.path).toBe(first.path);
    // Logs belong to the node, not to some other node.
    expect(stored?.nodeRuns.find((nr) => nr.nodeId === "workflow")?.logs).toBeUndefined();
  });

  it("attaches logs to the latest attempt of the node", async () => {
    const store = await openStore(await makeRootDir());
    await store.createRun(makeRun(), snapshot);
    await store.updateNodeRun("run-1", {
      id: "nr-review-2",
      nodeId: "review",
      attempt: 2,
      status: "running",
    });
    await store.appendLog("run-1", "review", "stdout", "retrying\n");

    const stored = await store.getRun("run-1");
    const attempts = stored?.nodeRuns.filter((nr) => nr.nodeId === "review") ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts.find((nr) => nr.attempt === 1)?.logs).toBeUndefined();
    expect(attempts.find((nr) => nr.attempt === 2)?.logs).toHaveLength(1);
  });

  it("preserves log refs explicitly recorded on a node attempt", async () => {
    const store = await openStore(await makeRootDir());
    await store.createRun(makeRun(), snapshot);
    await store.updateNodeRun("run-1", {
      id: "nr-review-1",
      nodeId: "review",
      attempt: 1,
      status: "running",
      logs: [{ id: "external-log", path: "/elsewhere/agent.log", kind: "agent" }],
    });
    const appended = await store.appendLog("run-1", "review", "stdout", "hello\n");

    const stored = await store.getRun("run-1");
    const review = stored?.nodeRuns.find((nr) => nr.nodeId === "review");
    expect(review?.logs?.map((l) => l.id)).toEqual(["external-log", appended.id]);
  });
});

describe("persistence across restarts", () => {
  it("sees runs, artifacts and logs written by a previous store instance", async () => {
    const rootDir = await makeRootDir();

    const first = await openStore(rootDir);
    await first.createRun(makeRun(), snapshot);
    await first.updateNodeRun("run-1", {
      id: "nr-review-1",
      nodeId: "review",
      attempt: 1,
      status: "failed",
      startedAt: "2026-08-25T10:05:00.000Z",
      finishedAt: "2026-08-25T10:06:00.000Z",
      result: failedResult,
    });
    const savedArtifact = await first.saveArtifact(
      "run-1",
      "review",
      { id: "diff", type: "diff", title: "Proposed diff" },
      "--- a\n+++ b\n",
    );
    const savedLog = await first.appendLog("run-1", "review", "stdout", "line one\n");
    await first.updateRunStatus("run-1", "failed", "2026-08-25T10:10:00.000Z");
    await first.close?.();
    openStores.splice(openStores.indexOf(first), 1);

    // Fresh handle on the same rootDir — simulates an app restart.
    const second = await openStore(rootDir);

    const stored = await second.getRun("run-1");
    expect(stored?.status).toBe("failed");
    expect(stored?.finishedAt).toBe("2026-08-25T10:10:00.000Z");
    expect(stored?.snapshot).toEqual(snapshot);

    const review = stored?.nodeRuns.find((nr) => nr.nodeId === "review");
    expect(review?.status).toBe("failed");
    expect(review?.result).toEqual(failedResult);
    expect(review?.logs).toEqual([
      { id: savedLog.id, path: savedLog.path, kind: "stdout" },
    ]);

    expect(await readFile(savedArtifact.path as string, "utf8")).toBe("--- a\n+++ b\n");
    expect(await readFile(savedLog.path, "utf8")).toBe("line one\n");

    // Listing and further writes keep working on the reopened store.
    expect((await second.listRuns({ workflowId: "wf-review" })).map((r) => r.id)).toEqual([
      "run-1",
    ]);
    const appendedAgain = await second.appendLog("run-1", "review", "stdout", "line two\n");
    expect(appendedAgain.path).toBe(savedLog.path);
    expect(await readFile(savedLog.path, "utf8")).toBe("line one\nline two\n");

    await second.createRun(
      makeRun({ id: "run-2", status: "queued", startedAt: "2026-08-25T12:00:00.000Z" }),
      snapshot,
    );
    expect((await second.listRuns()).map((r) => r.id)).toEqual(["run-2", "run-1"]);
  });
});
