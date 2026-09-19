/**
 * The working copy: written so the editor can open it.
 *
 * Against a real store in a real temporary directory, because what is being
 * checked is where a file lands — which a stub would be free to agree with
 * this code about.
 */

import { ExchangeStore } from "@anthill/exchange-store";
import { WORKFLOW_FORMAT_VERSION } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeWorkingCopy } from "./working-copy.js";

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

describe("writeWorkingCopy", () => {
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
