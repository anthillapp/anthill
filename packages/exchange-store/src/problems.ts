/**
 * What the store says when it will not do something.
 *
 * The exchange already has a type for "something is wrong, phrased for whoever
 * has to fix it", and a consumer that can show a completeness problem can show
 * one of these unchanged. So this is a vocabulary rather than a type: the codes
 * the store raises, prefixed `STORE_` so a reader can tell at a glance that the
 * answer came from the disk rather than from the validator.
 *
 * Almost none of them carries an `ask`. That field exists to make clarifying
 * questions a requirement of the system rather than a hope about the model, and
 * a user asked what to do about two processes disagreeing over revision 4 has
 * been handed somebody else's problem. Where the store is passing a
 * completeness problem through, the question comes with it and is not
 * rewritten.
 *
 * The exception is a workflow id that is already taken, which is the one refusal
 * here a person can actually answer: the id is the document's own, the harness
 * took it from whatever it was editing, and naming the work differently is a
 * decision only the user can make.
 */

import type { ExchangeProblem } from "@anthill/workflow-exchange";

export const EXCHANGE_STORE_PROBLEM_CODES = {
  /** No workflow of that id has ever been stored here. */
  STORE_WORKFLOW_UNKNOWN: "STORE_WORKFLOW_UNKNOWN",
  /** The workflow exists; that revision of it does not. */
  STORE_REVISION_UNKNOWN: "STORE_REVISION_UNKNOWN",
  /** A record is on disk and this build cannot make sense of it. */
  STORE_RECORD_UNREADABLE: "STORE_RECORD_UNREADABLE",
  /** A record was written by a newer Anthill and is not opened. */
  STORE_RECORD_TOO_NEW: "STORE_RECORD_TOO_NEW",
  /** Two handovers claim the same workflow id and disagree about it. */
  STORE_IDENTITY_CONFLICT: "STORE_IDENTITY_CONFLICT",
  /** Another workflow already holds this id, or the directory name it becomes. */
  STORE_WORKFLOW_ID_TAKEN: "STORE_WORKFLOW_ID_TAKEN",
  /** A revision number is taken, by content that is not the content offered. */
  STORE_REVISION_CONFLICT: "STORE_REVISION_CONFLICT",
  /** That run id is already bound, to something else. */
  STORE_BINDING_CONFLICT: "STORE_BINDING_CONFLICT",
  /** That inbox key is taken, by a request that is not this one. */
  STORE_INBOX_CONFLICT: "STORE_INBOX_CONFLICT",
  /** The submission addresses one workflow id and carries a document with another. */
  STORE_WORKFLOW_ID_MISMATCH: "STORE_WORKFLOW_ID_MISMATCH",
  /** The handover waits on the user, and the user has not said yes yet. */
  /** There is no approval of that revision to withdraw. */
  STORE_REVISION_NOT_APPROVED: "STORE_REVISION_NOT_APPROVED",
  /** The user withdrew their approval of that revision, and it cannot be given again. */
  STORE_REVISION_REVOKED: "STORE_REVISION_REVOKED",
  /** The revision asked for is not the one the mode makes eligible. */
  STORE_REVISION_NOT_ELIGIBLE: "STORE_REVISION_NOT_ELIGIBLE",
} as const;

export type ExchangeStoreProblemCode =
  (typeof EXCHANGE_STORE_PROBLEM_CODES)[keyof typeof EXCHANGE_STORE_PROBLEM_CODES];

/** One of the store's own problems, with a question only where there is one. */
export function storeProblem(
  code: ExchangeStoreProblemCode,
  message: string,
  extra: { field?: string; ask?: string } = {},
): ExchangeProblem {
  return { code, message, ...extra };
}
