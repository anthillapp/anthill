/**
 * What the exchange writes down, and how it reads it back.
 *
 * Five kinds of record, each in its own file and each carrying a `{version, …}`
 * envelope with the constant below. They are read one at a time and judged one
 * at a time: a revision this build cannot make sense of costs that revision, not
 * the workflow it belongs to. Settings and assistant threads throw the whole
 * file away when anything in it looks wrong, which is the right answer for a
 * cache of preferences and the wrong one here — the history of what a person
 * approved is not something to discard because the entry after it is damaged.
 * The model is the workflow-status store, which skips the entry and keeps
 * going.
 *
 * A record from a newer Anthill is refused rather than opened, the way
 * `checkWorkflowCompatibility` refuses a workflow from the future. There is no
 * migration chain because there is nothing yet to migrate from; version 1 with
 * an honest refusal is a smaller lie than an upgrade path nobody has exercised.
 *
 * One thing these parsers deliberately do not do is migrate the workflow inside
 * a revision. A revision is the document exactly as it was submitted, on the
 * pre-migration side, and `migrateWorkflow` runs where the document is opened —
 * in the editor, on the working copy. Mixing the two has already cost this
 * repository one regression, so the side each reader is on is worth saying out
 * loud: this one is on the raw side.
 */

import type { ExchangeProblem, ExchangeSource, HandoverMode } from "@anthill/workflow-exchange";
import { isHandoverMode, isSourceHarness } from "@anthill/workflow-exchange";
import { WorkflowSchema, type Workflow } from "@anthill/workflow-schema";

import { EXCHANGE_STORE_PROBLEM_CODES, storeProblem } from "./problems.js";

/**
 * Bumped when the shape of a file in this store changes.
 *
 * Separate from `EXCHANGE_VERSION`, and they are not to be conflated: that one
 * describes what crosses the wire between a harness and Anthill, this one
 * describes what is on this machine's disk. A store that gains a field has not
 * changed what a harness may send.
 */
export const EXCHANGE_STORE_VERSION = 1;

/** Who wrote a revision: the harness that submitted it, or the user editing it. */
export type RevisionAuthor = "harness" | "user";

const REVISION_AUTHORS: readonly RevisionAuthor[] = ["harness", "user"];

/** What an inbox drop is asking the app to do. */
export type InboxKind = "display" | "bind";

const INBOX_KINDS: readonly InboxKind[] = ["display", "bind"];

/**
 * A workflow's identity: created once, never rewritten.
 *
 * Everything here is a fact about the handover rather than about the workflow's
 * current content, which is why none of it changes when the workflow is edited.
 * The mode in particular is recorded at the handover and read back at every
 * bind, so a harness cannot decide later that it would rather not wait.
 */
export type StoredIdentity = {
  /** The id as it was submitted, before it became a directory name. */
  workflowId: string;
  createdAt: string;
  /** The sender's key for the handover, which is what makes a retry recognisable. */
  idempotencyKey: string;
  mode: HandoverMode;
  /**
   * The wire version the handover arrived on.
   *
   * Kept so a revision can be read back knowing which contract minted it. The
   * store's own version says how this file is shaped; it says nothing about
   * what the sender was speaking.
   */
  exchangeVersion: number;
  source: ExchangeSource;
};

/**
 * One immutable snapshot of a workflow's content.
 *
 * The digest is stored rather than recomputed on read because it is what
 * decides whether two writes are the same revision, and a stored answer cannot
 * start disagreeing with a canonicalisation rule that changed underneath it.
 */
export type StoredRevision = {
  revision: number;
  createdAt: string;
  by: RevisionAuthor;
  digest: string;
  workflow: Workflow;
};

/**
 * The user's approval of one exact revision.
 *
 * The marker's *name* is the approval; its contents are only the date. So `at`
 * is absent where the marker exists and its record could not be read: the user
 * still said yes to that revision, and the only thing lost is when.
 */
export type StoredReadiness = {
  revision: number;
  at?: string;
};

/**
 * A run holding a revision.
 *
 * `sessionId` is the harness's own, copied from the identity at the moment of
 * binding. A run whose only evidence is the report channel never learns one,
 * and a run with no session id can never be picked back up after it goes quiet
 * — so it is written down here, where there is still something that knows it.
 */
export type Binding = {
  runId: string;
  workflowId: string;
  revision: number;
  nonce: string;
  sessionId?: string;
  at: string;
};

/**
 * One request from the server for the app to do something.
 *
 * The inbox is a transport, not a record: everything a drop refers to is
 * already stored, and the drop says only which workflow and which revision the
 * app should go and look at. A drop that carried a copy of the thing it points
 * at would be a second source of truth for it.
 */
export type InboxDrop = {
  kind: InboxKind;
  key: string;
  workflowId: string;
  revision: number;
  at: string;
  /** The run this drop is about, on a `bind`. Absent on a `display`. */
  runId?: string;
};

export type RecordRead<T> = { ok: true; record: T } | { ok: false; problem: ExchangeProblem };

/** Serialise a record with its envelope, ready to be written exactly once. */
export function encodeRecord(record: object): string {
  return `${JSON.stringify({ version: EXCHANGE_STORE_VERSION, ...record }, null, 2)}\n`;
}

export function parseIdentity(text: string, where: string): RecordRead<StoredIdentity> {
  const opened = openEnvelope(text, where);
  if (!opened.ok) return opened;
  const value = opened.record;

  const workflowId = str(value.workflowId);
  const createdAt = when(value.createdAt);
  const idempotencyKey = str(value.idempotencyKey);
  const mode = isHandoverMode(value.mode) ? value.mode : undefined;
  const exchangeVersion =
    typeof value.exchangeVersion === "number" && Number.isInteger(value.exchangeVersion)
      ? value.exchangeVersion
      : undefined;
  const source = readSource(value.source);

  if (!workflowId || !createdAt || !idempotencyKey || !mode || !exchangeVersion || !source) {
    return unreadable(where, "it does not carry the identity of a handover");
  }

  return {
    ok: true,
    record: { workflowId, createdAt, idempotencyKey, mode, exchangeVersion, source },
  };
}

export function parseRevision(text: string, where: string): RecordRead<StoredRevision> {
  const opened = openEnvelope(text, where);
  if (!opened.ok) return opened;
  const value = opened.record;

  const revision = count(value.revision);
  const createdAt = when(value.createdAt);
  const by = REVISION_AUTHORS.includes(value.by as RevisionAuthor)
    ? (value.by as RevisionAuthor)
    : undefined;
  const digest = str(value.digest);
  // By shape, not by completeness. A revision was judged complete on the way
  // in; asking again on the way out would mean a validator that gained a rule
  // could make yesterday's approved revision unreadable.
  const workflow = WorkflowSchema.safeParse(value.workflow);

  if (!revision || !createdAt || !by || !digest || !workflow.success) {
    return unreadable(where, "it is not a revision this build can read");
  }

  return {
    ok: true,
    record: { revision, createdAt, by, digest, workflow: workflow.data as Workflow },
  };
}

export function parseReadiness(text: string, where: string): RecordRead<StoredReadiness> {
  const opened = openEnvelope(text, where);
  if (!opened.ok) return opened;

  const revision = count(opened.record.revision);
  const at = when(opened.record.at);
  if (!revision || !at) return unreadable(where, "it does not say which revision was approved, or when");

  return { ok: true, record: { revision, at } };
}

export function parseBinding(text: string, where: string): RecordRead<Binding> {
  const opened = openEnvelope(text, where);
  if (!opened.ok) return opened;
  const value = opened.record;

  const runId = str(value.runId);
  const workflowId = str(value.workflowId);
  const revision = count(value.revision);
  const nonce = str(value.nonce);
  const at = when(value.at);
  const sessionId = str(value.sessionId);

  if (!runId || !workflowId || !revision || !nonce || !at) {
    return unreadable(where, "it does not describe a run holding a revision");
  }

  return {
    ok: true,
    record: { runId, workflowId, revision, nonce, at, ...(sessionId ? { sessionId } : {}) },
  };
}

export function parseInboxDrop(text: string, where: string): RecordRead<InboxDrop> {
  const opened = openEnvelope(text, where);
  if (!opened.ok) return opened;
  const value = opened.record;

  const kind = INBOX_KINDS.includes(value.kind as InboxKind) ? (value.kind as InboxKind) : undefined;
  const key = str(value.key);
  const workflowId = str(value.workflowId);
  const revision = count(value.revision);
  const at = when(value.at);
  const runId = str(value.runId);

  if (!kind || !key || !workflowId || !revision || !at) {
    return unreadable(where, "it is not a request this build understands");
  }
  // A bind drop with no run in it would send the app looking for a binding that
  // could be any of them. Better to say the drop is wrong than to guess.
  if (kind === "bind" && !runId) {
    return unreadable(where, "it asks for a run to be registered without saying which run");
  }

  return { ok: true, record: { kind, key, workflowId, revision, at, ...(runId ? { runId } : {}) } };
}

/**
 * Parse the JSON and check the version, which every record shares.
 *
 * The future is refused by number and by name, because the alternative is this
 * build reading a record it half understands and then writing its half back.
 */
function openEnvelope(text: string, where: string): RecordRead<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return unreadable(where, "it is not JSON");
  }

  if (!isRecord(value)) return unreadable(where, "it is not a JSON object");

  if (typeof value.version !== "number" || !Number.isInteger(value.version)) {
    return unreadable(where, "it does not say what version it is");
  }

  if (value.version > EXCHANGE_STORE_VERSION) {
    return {
      ok: false,
      problem: storeProblem(
        EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_TOO_NEW,
        `${where} was written by a newer Anthill (store version ${value.version}; this build reads ${EXCHANGE_STORE_VERSION}). It is left alone rather than opened — reading it here would drop whatever this build does not know about, and writing it back would make the loss permanent.`,
        { field: where },
      ),
    };
  }

  if (value.version !== EXCHANGE_STORE_VERSION) {
    return unreadable(where, `it is store version ${value.version} and this build reads ${EXCHANGE_STORE_VERSION}`);
  }

  return { ok: true, record: value };
}

function unreadable(where: string, why: string): { ok: false; problem: ExchangeProblem } {
  return {
    ok: false,
    problem: storeProblem(
      EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE,
      `${where} cannot be read: ${why}. Nothing was changed, and the rest of the workflow is unaffected.`,
      { field: where },
    ),
  };
}

function readSource(value: unknown): ExchangeSource | undefined {
  if (!isRecord(value)) return undefined;
  const harness = isSourceHarness(value.harness) ? value.harness : undefined;
  const sessionId = str(value.sessionId);
  // Blank is allowed back out because blank is what may have gone in: an empty
  // task text is a completeness question, not a malformed record, and a stored
  // handover that was incomplete is still a handover.
  const taskText = typeof value.taskText === "string" ? value.taskText : undefined;
  if (!harness || !sessionId || taskText === undefined) return undefined;
  return { harness, sessionId, taskText };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A timestamp that is a timestamp — the app parses these and would throw on a lie. */
function when(value: unknown): string | undefined {
  const text = str(value);
  if (!text || Number.isNaN(Date.parse(text))) return undefined;
  return text;
}
