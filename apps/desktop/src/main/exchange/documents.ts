import type { ExchangeStore } from "@anthill/exchange-store";
import { checkCompleteness, revisionDigest } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExchangeView, BoundWorkflowResult } from "../../shared/ipc.js";
import type { PendingRun } from "@anthill/live";
import { captureSavedRevision } from "./working-copy.js";

function inExchange(store: ExchangeStore, path: string): boolean {
  const part = relative(store.root, resolve(path));
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** Only the editable working copy is a save destination inside the exchange. */
export async function exchangeDestination(store: ExchangeStore, path: string, workflowId: string): Promise<boolean> {
  if (!inExchange(store, path)) return false;
  if (resolve(path) !== resolve(store.workingCopyPath(workflowId)) ||
      !(await store.readWorkflow(workflowId))?.identity) {
    throw new Error("This path is reserved for exchange records or another workflow. Choose a location outside the exchange.");
  }
  return true;
}

export async function saveExchangeCopy(store: ExchangeStore, path: string, workflow: Workflow): Promise<void> {
  await exchangeDestination(store, path, workflow.id);
  // Record first. A failed file replacement leaves a recoverable revision;
  // the opposite order could leave a successful-looking save without history.
  const captured = await captureSavedRevision(store, path, workflow);
  if (!captured || !["added", "unchanged"].includes(captured.outcome)) {
    throw new Error(captured?.problems?.map((item) => item.message).join(" ") || "The workflow revision could not be recorded. Save again.");
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(workflow, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function readExchangeView(store: ExchangeStore, path: string, workflowId: string): Promise<ExchangeView | undefined> {
  if (!inExchange(store, path)) return undefined;
  await exchangeDestination(store, path, workflowId);
  const stored = await store.readWorkflow(workflowId);
  if (!stored?.identity || !stored.head) throw new Error("The exchange revision cannot be read.");
  const { identity, head } = stored;
  const problems = [...stored.problems, ...checkCompleteness(head.workflow, identity.source)];
  const bound = stored.bindings.some((binding) => binding.revision === head.revision);
  return {
    workflowId, source: identity.source,
    revision: head.revision, digest: head.digest,
    // Three states, and none of them is about permission. `draft` now means
    // one thing only — the graph does not compile into a prompt yet — where it
    // used to also mean the user had not pressed a button.
    state: bound ? "bound" : problems.length === 0 ? "ready_for_agent" : "draft",
    problems, bindings: stored.bindings.map(({ runId, revision }) => ({ runId, revision })),
  };
}

export async function boundWorkflow(store: ExchangeStore, run: PendingRun | undefined): Promise<BoundWorkflowResult> {
  if (!run?.exchange || !run.workflowId) return { ok: false, error: "No bound revision is registered for this run." };
  const binding = await store.readBinding(run.workflowId, run.anthillRunId);
  const revision = await store.readRevision(run.workflowId, run.exchange.revision);
  if (!binding || !revision || binding.nonce !== run.correlationNonce ||
      binding.revision !== revision.revision || revision.digest !== run.exchange.digest ||
      (binding.digest && binding.digest !== revision.digest)) {
    return { ok: false, error: "The bound revision is missing or does not match this run. The edited graph will not be used instead." };
  }
  return { ok: true, workflow: revision.workflow, revision: revision.revision, digest: revision.digest };
}
