/**
 * The working copy: written so the editor can open it, read back so an edit
 * becomes a revision.
 *
 * Against a real store in a real temporary directory, because what is being
 * checked is where a file lands and what the store makes of it afterwards —
 * both of which a stub would be free to agree with this code about.
 */

import { ExchangeStore } from "@anthill/exchange-store";
import { WORKFLOW_FORMAT_VERSION, type DraftSubmission } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureSavedRevision, writeWorkingCopy } from "./working-copy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function openStore(): Promise<ExchangeStore> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-working-copy-"));
  roots.push(dir);
  return new ExchangeStore(dir);
}

/** A workflow with nothing left to ask about, so completeness is never the reason. */
function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow-1",
    name: "Ship the fix",
    version: "0.1.0",
    target: "claude-code",
    brief: {
      goal: "The startup crash is fixed and covered by a test.",
      doneCriteria: ["The test suite passes."],
    },
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      {
        id: "step-1",
        type: "agent",
        name: "Fix it",
        config: {
          actionKind: "implement",
          task: "Find the cause of the startup crash and fix it.",
          agentId: "agent-1",
          expectedOutput: "A patch, and a test that fails without it.",
          successCriteria: ["The new test fails on the old code."],
        },
      },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "edge-1", source: "start", target: "step-1" },
      { id: "edge-2", source: "step-1", target: "end" },
    ],
    metadata: {
      workflow: {
        formatVersion: WORKFLOW_FORMAT_VERSION,
        agents: [{ id: "agent-1", name: "Developer", models: { "claude-code": { id: "sonnet" } } }],
      },
    },
    ...overrides,
  };
}

function submission(): DraftSubmission {
  return {
    exchangeVersion: 1,
    idempotencyKey: "handover-7",
    source: {
      harness: "claude-code",
      sessionId: "session-abc",
      taskText: "Fix the crash on startup.",
    },
    mode: "show-and-go",
    workflow: workflow(),
  };
}

describe("writeWorkingCopy", () => {
  it("accepts a supported older working copy without rewriting the user's bytes", async () => {
    const store = await openStore();
    const path = store.workingCopyPath("workflow-1");
    await writeWorkingCopy(path, workflow());
    const older = workflow({ metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION - 1 } } });
    const bytes = JSON.stringify(older);
    await writeFile(path, bytes);
    await writeWorkingCopy(path, workflow());
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it.each([
    ["future format", () => workflow({ metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION + 1 } } })],
    ["wrong identity", () => workflow({ id: "someone-else" })],
    ["invalid document", () => ({ id: "workflow-1", nodes: "broken" })],
  ] as const)("refuses an existing %s without replacing it", async (_label, make) => {
    const store = await openStore();
    const path = store.workingCopyPath("workflow-1");
    await writeWorkingCopy(path, workflow());
    const bytes = JSON.stringify(make());
    await writeFile(path, bytes);
    await expect(writeWorkingCopy(path, workflow())).rejects.toThrow("unreadable or belongs to another workflow");
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("writes a workflow the editor can open, in the shape a save leaves", async () => {
    const store = await openStore();
    const path = store.workingCopyPath("workflow-1");

    await writeWorkingCopy(path, workflow());

    const written = await readFile(path, "utf8");
    expect(written).toBe(`${JSON.stringify(workflow(), null, 2)}\n`);
  });

  it("creates the directory a first handover has not made yet", async () => {
    const store = await openStore();

    await writeWorkingCopy(store.workingCopyPath("never-stored"), workflow());

    expect((await readFile(store.workingCopyPath("never-stored"), "utf8")).length).toBeGreaterThan(0);
  });
});

describe("captureSavedRevision", () => {
  it("records an edit of a handed-over workflow as the next revision", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const edited = workflow({ name: "Ship the fix, properly" });
    const captured = await captureSavedRevision(
      store,
      store.workingCopyPath("workflow-1"),
      edited,
    );

    expect(captured?.outcome).toBe("added");
    expect(captured?.revision).toBe(2);

    const stored = await store.readWorkflow("workflow-1");
    expect(stored?.head?.by).toBe("user");
    expect(stored?.head?.workflow.name).toBe("Ship the fix, properly");
  });

  /* Revision N is never modified: the one the harness submitted is still there. */
  it("leaves the revision that was handed over exactly as it was", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    await captureSavedRevision(
      store,
      store.workingCopyPath("workflow-1"),
      workflow({ name: "Ship the fix, properly" }),
    );

    const first = await store.readRevision("workflow-1", 1);
    expect(first?.by).toBe("harness");
    expect(first?.workflow.name).toBe("Ship the fix");
  });

  it("writes nothing when the save changed nothing", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const captured = await captureSavedRevision(
      store,
      store.workingCopyPath("workflow-1"),
      workflow(),
    );

    expect(captured?.outcome).toBe("unchanged");
    expect((await store.readWorkflow("workflow-1"))?.revisions).toEqual([1]);
  });

  /*
   * Almost every save in the app is this one, and it must cost nothing and
   * decide nothing.
   */
  it("says nothing about a save somewhere else entirely", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const captured = await captureSavedRevision(
      store,
      join(tmpdir(), "somebody-elses.workflow.json"),
      workflow(),
    );

    expect(captured).toBeUndefined();
  });

  /*
   * A Save As that lands inside the exchange is not an edit of what lives
   * there. The test is the path this document's id would be filed under, not
   * "somewhere under the exchange".
   */
  it("says nothing about a save into another workflow's directory", async () => {
    const store = await openStore();
    await store.createWorkflow(submission());

    const captured = await captureSavedRevision(
      store,
      store.workingCopyPath("workflow-1"),
      workflow({ id: "a-different-workflow" }),
    );

    expect(captured).toBeUndefined();
    expect((await store.readWorkflow("workflow-1"))?.revisions).toEqual([1]);
  });

  it("has nothing to record for a workflow nobody handed over", async () => {
    const store = await openStore();

    const captured = await captureSavedRevision(
      store,
      store.workingCopyPath("workflow-1"),
      workflow(),
    );

    expect(captured?.outcome).toBe("no_such_workflow");
  });
});
