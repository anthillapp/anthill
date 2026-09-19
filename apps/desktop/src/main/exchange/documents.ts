import type { ExchangeStore } from "@anthill/exchange-store";
import { checkCompleteness, revisionDigest } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExchangeView, ExchangeReadyRequest, ExchangeRevokeRequest, ExchangeReadyResult, BoundWorkflowResult } from "../../shared/ipc.js";
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
  if (!stored?.identity || !stored.head) throw new Error("The exchange revision cannot be read. Nothing was approved.");
  const { identity, head } = stored;
  const problems = [...stored.problems, ...checkCompleteness(head.workflow, identity.source)];
  const bound = stored.bindings.some((binding) => binding.revision === head.revision);
  const ready = problems.length === 0 && (identity.mode === "show-and-go" || stored.ready?.revision === head.revision);
  return {
    workflowId, source: identity.source, mode: identity.mode,
    revision: head.revision, digest: head.digest,
    state: bound ? "bound" : ready ? "ready_for_agent" : "draft",
    // Reported whichever revision it names, including one the editor has moved
    // on from. Readiness deliberately does not carry to the next revision, so
    // an approval of revision 1 stands after an edit makes revision 2 — the
    // head is a draft and the approval is still what a new run would be given.
    // Reporting only the head's state left that standing approval invisible.
    ...(stored.ready ? { approved: {
      revision: stored.ready.revision,
      ...(stored.ready.at ? { at: stored.ready.at } : {}),
      // Only a gate makes an approval into permission, so only there is there
      // permission to take back.
      withdrawable: identity.mode === "approval-gate",
      // What withdrawing this one would actually leave behind, which is not
      // always nothing. The store walks its approvals highest-first and skips
      // the withdrawn ones, so an older approval that was never taken back is
      // what the gate falls to.
      ...(stored.readyBelow ? { below: stored.readyBelow.revision } : {}),
    } } : {}),
    problems, bindings: stored.bindings.map(({ runId, revision }) => ({ runId, revision })),
  };
}

export async function readyExchangeRevision(store: ExchangeStore, request: ExchangeReadyRequest): Promise<ExchangeReadyResult> {
  try {
    const view = await readExchangeView(store, request.path, request.workflowId);
    if (!view || view.revision !== request.revision || view.digest !== request.digest) {
      throw new Error("The saved revision changed. Review the latest revision before approving it.");
    }
    const copy: unknown = JSON.parse(await readFile(request.path, "utf8"));
    if (revisionDigest(copy as Workflow) !== request.digest) {
      throw new Error("The working copy differs from this revision. Save and review it before approving.");
    }
    const result = await store.markReady(request.workflowId, request.revision);
    if (result.outcome !== "ready" && result.outcome !== "already_ready") {
      throw new Error(result.problems?.map((item) => item.message).join(" ") || "This revision cannot be approved.");
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Take back the approval the panel was showing.
 *
 * Against the view rather than against the request: the revision named has to
 * be the one an approval currently stands on, so a panel that last read the
 * exchange before somebody else approved something cannot withdraw a decision
 * the user never saw. There is no digest to check because the withdrawn
 * revision is usually not the one the editor has open — that is the whole
 * reason this exists — and the working copy has nothing to say about it.
 */
export async function revokeExchangeRevision(store: ExchangeStore, request: ExchangeRevokeRequest): Promise<ExchangeReadyResult> {
  try {
    const view = await readExchangeView(store, request.path, request.workflowId);
    if (view?.approved?.revision !== request.revision || !view.approved.withdrawable) {
      throw new Error("The approval on this handover has changed. Review what is approved before withdrawing it.");
    }
    const result = await store.revokeReady(request.workflowId, request.revision);
    if (result.outcome !== "revoked" && result.outcome !== "already_revoked") {
      throw new Error(result.problems?.map((item) => item.message).join(" ") || "This approval cannot be withdrawn.");
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Never substitute the editor's graph when a bound snapshot is unavailable. */
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
