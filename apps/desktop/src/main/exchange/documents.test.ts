import { ExchangeStore } from "@anthill/exchange-store";
import { WORKFLOW_FORMAT_VERSION, type HandoverMode } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import { createPendingRun } from "@anthill/live";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { boundWorkflow, exchangeDestination, readExchangeView, readyExchangeRevision, revokeExchangeRevision, saveExchangeCopy } from "./documents.js";
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

it("gates only the reviewed saved revision, never the next edit", async () => {
  const { store, path, workflow } = await fixture();
  const view = (await readExchangeView(store, path, workflow.id))!;
  expect(view.state).toBe("draft");
  expect(await store.eligibleRevision(workflow.id)).toMatchObject({ eligible: false, reason: "awaiting_approval" });
  expect(await readyExchangeRevision(store, { path, ...view })).toEqual({ ok: true });
  expect((await readExchangeView(store, path, workflow.id))?.state).toBe("ready_for_agent");
  await saveExchangeCopy(store, path, { ...workflow, name: "Edited" });
  expect(await readyExchangeRevision(store, { path, ...view })).toMatchObject({ ok: false });
  expect((await readExchangeView(store, path, workflow.id))?.state).toBe("draft");
  expect((await store.readRevision(workflow.id, 1))?.workflow.name).toBe("Fix the crash");
});

/*
 * Readiness never carries to the next revision, which is right — and leaves an
 * approval standing on the revision it was made for. The head is then a draft
 * and the approved revision is still what a brand-new bind is handed, so a
 * view that reported only the head's state said nothing was authorised while
 * something was.
 */
it("reports the approval an edit left behind, which is still what a bind takes", async () => {
  const { store, path, workflow } = await fixture();
  const view = (await readExchangeView(store, path, workflow.id))!;
  expect(view.approved).toBeUndefined();
  expect(await readyExchangeRevision(store, { path, ...view })).toEqual({ ok: true });
  expect((await readExchangeView(store, path, workflow.id))?.approved).toMatchObject({ revision: 1 });

  await saveExchangeCopy(store, path, { ...workflow, name: "Edited" });
  expect(await readExchangeView(store, path, workflow.id)).toMatchObject({
    revision: 2, state: "draft", approved: { revision: 1 },
  });
  expect(await store.eligibleRevision(workflow.id)).toMatchObject({ eligible: true, revision: { revision: 1 } });
});

/*
 * The other half of the gate. Showing the standing approval told the user
 * revision 1 was still what an agent would be given; it left them no way to
 * say otherwise short of approving something newer.
 */
it("withdraws a standing approval without disturbing the run that holds it", async () => {
  const { store, path, workflow } = await fixture();
  const first = (await readExchangeView(store, path, workflow.id))!;
  await readyExchangeRevision(store, { path, ...first });
  await store.bind(workflow.id, 1, { runId: "ANT-EARLY", nonce: "abc", digest: first.digest });
  await saveExchangeCopy(store, path, { ...workflow, name: "Edited" });
  expect(await readExchangeView(store, path, workflow.id)).toMatchObject({
    approved: { revision: 1, withdrawable: true },
  });

  expect(await revokeExchangeRevision(store, { path, workflowId: workflow.id, revision: 1 })).toEqual({ ok: true });

  expect((await readExchangeView(store, path, workflow.id))?.approved).toBeUndefined();
  expect(await store.eligibleRevision(workflow.id)).toMatchObject({ eligible: false, reason: "awaiting_approval" });
  // The decision is about what a new run may take. The one already bound to
  // revision 1 is still bound to it and still reporting against it.
  expect((await store.readBinding(workflow.id, "ANT-EARLY"))?.revision).toBe(1);
});

/*
 * The whole of it reached through what the panel offers and nothing else:
 * approve, edit, approve, edit, withdraw. The panel promised that withdrawing
 * left the handover with nothing approved; here it hands the gate to revision
 * 1, which the user has edited past twice, the moment they act to stop exactly
 * that. The store is right — revision 1 was approved and never withdrawn — so
 * what the view has to carry is the revision underneath, and the panel says
 * that instead of guessing.
 */
it("names the approval a withdrawal would fall back to, and offers that one too", async () => {
  const { store, path, workflow } = await fixture();
  const approve = async () => {
    const view = (await readExchangeView(store, path, workflow.id))!;
    // Exactly the panel's gate: the button is offered only on a draft head.
    expect(view.state).toBe("draft");
    return readyExchangeRevision(store, { path, ...view });
  };

  expect(await approve()).toEqual({ ok: true });
  await saveExchangeCopy(store, path, { ...workflow, name: "Second thoughts" });
  expect(await approve()).toEqual({ ok: true });
  await saveExchangeCopy(store, path, { ...workflow, name: "Third thoughts" });

  expect(await readExchangeView(store, path, workflow.id)).toMatchObject({
    revision: 3, approved: { revision: 2, withdrawable: true, below: 1 },
  });

  expect(await revokeExchangeRevision(store, { path, workflowId: workflow.id, revision: 2 })).toEqual({ ok: true });

  // What the sentence said would happen, and what a new bind is now given.
  const after = (await readExchangeView(store, path, workflow.id))!;
  expect(after.approved).toMatchObject({ revision: 1, withdrawable: true });
  expect(after.approved?.below).toBeUndefined();
  expect(await store.eligibleRevision(workflow.id)).toMatchObject({ eligible: true, revision: { revision: 1 } });

  // Re-reading is all the panel does after recording a decision, and it is
  // enough to offer the older approval in its turn.
  expect(await revokeExchangeRevision(store, { path, workflowId: workflow.id, revision: 1 })).toEqual({ ok: true });
  expect((await readExchangeView(store, path, workflow.id))?.approved).toBeUndefined();
  expect(await store.eligibleRevision(workflow.id)).toMatchObject({ eligible: false, reason: "awaiting_approval" });
});

it("refuses to withdraw an approval the panel has not seen", async () => {
  const { store, path, workflow } = await fixture();
  const view = (await readExchangeView(store, path, workflow.id))!;
  await readyExchangeRevision(store, { path, ...view });

  // A panel that last read the exchange before the approval moved would
  // otherwise withdraw one the user never looked at.
  expect(await revokeExchangeRevision(store, { path, workflowId: workflow.id, revision: 2 })).toMatchObject({ ok: false });
  expect(await store.readyRevision(workflow.id)).toBe(1);
});

it("refuses approval when the disk copy was edited outside Anthill", async () => {
  const { store, path, workflow } = await fixture();
  const view = (await readExchangeView(store, path, workflow.id))!;
  await writeFile(path, JSON.stringify({ ...workflow, name: "Unrecorded edit" }));
  expect(await readyExchangeRevision(store, { path, ...view })).toMatchObject({ ok: false });
  expect((await store.readWorkflow(workflow.id))?.ready).toBeUndefined();
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
