import { ExchangeStore } from "@anthill/exchange-store";
import { WORKFLOW_FORMAT_VERSION, type HandoverMode } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import { createPendingRun } from "@anthill/live";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { boundWorkflow, exchangeDestination, readExchangeView, saveExchangeCopy } from "./documents.js";
import { writeWorkingCopy } from "./working-copy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(mode: HandoverMode = "approval-gate") {
  const root = await mkdtemp(join(tmpdir(), "anthill-exchange-document-"));
  roots.push(root);
  const store = new ExchangeStore(root);
  const workflow: Workflow = {
    id: "workflow-1", name: "Fix the crash", version: "1", target: "claude-code",
    brief: { goal: "Fix the crash", doneCriteria: ["Tests pass"] },
    nodes: [
      { id: "start", name: "Start", type: "start", config: {} },
      { id: "fix", name: "Fix", type: "agent", config: { actionKind: "implement", agentId: "dev", task: "Fix the crash", expectedOutput: "Patch", successCriteria: ["Tests pass"] } },
      { id: "end", name: "End", type: "end", config: {} },
    ],
    edges: [{ id: "a", source: "start", target: "fix" }, { id: "b", source: "fix", target: "end" }],
    metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION, agents: [{ id: "dev", name: "Developer", models: { "claude-code": { id: "sonnet" } } }] } },
  };
  expect((await store.createWorkflow({ workflow, mode, exchangeVersion: 1, idempotencyKey: "draft", source: { harness: "claude-code", sessionId: "source-1", taskText: "Fix the crash" } })).outcome).toBe("created");
  const path = store.workingCopyPath(workflow.id);
  await writeWorkingCopy(path, workflow);
  return { store, path, workflow };
}

/**
 * What a saved edit does to the view, now that saving is the whole act.
 *
 * There were six tests here about approving and withdrawing: which revision a
 * gate stood on, what an edit left behind, what a withdrawal fell back to.
 * The gate is gone, and what is left to check is that an edit becomes a
 * revision, that the view follows it, and that the revision before it is
 * untouched.
 */
it("makes a saved edit the head, and leaves the revision before it alone", async () => {
  const { store, path, workflow } = await fixture();
  expect((await readExchangeView(store, path, workflow.id))).toMatchObject({
    revision: 1, state: "ready_for_agent",
  });

  await saveExchangeCopy(store, path, { ...workflow, name: "Edited" });

  expect((await readExchangeView(store, path, workflow.id))).toMatchObject({
    revision: 2, state: "ready_for_agent",
  });
  expect((await store.readRevision(workflow.id, 1))?.workflow.name).toBe("Fix the crash");
  expect(await store.eligibleRevision(workflow.id)).toMatchObject({ eligible: true, revision: { revision: 2 } });
});

/**
 * A handover that arrived under the old gate.
 *
 * `approval-gate` is still stored — a harness may submit it and the records on
 * disk carry it — and it used to make this view a `draft` until the user
 * pressed a button. It decides nothing now, and the fixture submits under it
 * precisely so that this stays true.
 */
it("does not hold a stored approval-gate handover back", async () => {
  const { store, path, workflow } = await fixture("approval-gate");
  expect((await readExchangeView(store, path, workflow.id))?.state).toBe("ready_for_agent");
  expect(await store.eligibleRevision(workflow.id)).toMatchObject({ eligible: true });
});

/**
 * The mode reaches the renderer, which is the only thing it decides (ANT-118).
 *
 * It is read from the identity rather than from the document, so it says what
 * the user asked the harness for at the handover and not what the graph has
 * become since. The screen turns it into editor-or-live; this only has to get
 * it there unchanged, including for the two names that predate the pair.
 */
it("carries the handover's own mode through to the view", async () => {
  for (const mode of ["design", "watch", "show-and-go", "approval-gate"] as const) {
    const { store, path, workflow } = await fixture(mode);
    expect((await readExchangeView(store, path, workflow.id))?.mode).toBe(mode);
  }
});

it("preserves a saved working copy on an interrupted or repeated display", async () => {
  const { store, path, workflow } = await fixture();
  await saveExchangeCopy(store, path, { ...workflow, name: "Keep my work" });
  await writeWorkingCopy(path, workflow);
  expect(JSON.parse(await readFile(path, "utf8")).name).toBe("Keep my work");
});

it("refuses reserved destinations before any immutable record can be overwritten", async () => {
  const { store, path, workflow } = await fixture();
  await expect(exchangeDestination(store, path, "other-id")).rejects.toThrow("reserved");
  await expect(exchangeDestination(store, join(store.root, "workflows", "workflow-1", "revisions", "0001.json"), workflow.id)).rejects.toThrow("reserved");
  expect(await exchangeDestination(store, join(tmpdir(), "ordinary.workflow.json"), workflow.id)).toBe(false);
});

it("uses a frozen snapshot after save and restart, and fails closed on a damaged snapshot", async () => {
  const { store, path, workflow } = await fixture("show-and-go");
  const view = (await readExchangeView(store, path, workflow.id))!;
  expect(view.state).toBe("ready_for_agent");
  await store.bind(workflow.id, 1, { runId: "ANT-12345678", nonce: "abc123", digest: view.digest });
  const run = { ...createPendingRun({ anthillRunId: "ANT-12345678", correlationNonce: "abc123", workflowId: workflow.id, selectedCli: "claude-code", promptVersion: "1", bootstrapPromptHash: view.digest, now: new Date().toISOString() }), exchange: { revision: 1, digest: view.digest } };
  await saveExchangeCopy(store, path, { ...workflow, nodes: workflow.nodes.filter((node) => node.id !== "fix") });
  expect(await boundWorkflow(store, run)).toMatchObject({ ok: true, workflow });
  const reopened = new ExchangeStore(join(store.root, ".."));
  expect(await boundWorkflow(reopened, run)).toMatchObject({ ok: true, revision: 1 });
  await writeFile(join(store.root, "workflows", workflow.id, "revisions", "0001.json"), "{}");
  expect(await boundWorkflow(reopened, run)).toMatchObject({ ok: false });
});
