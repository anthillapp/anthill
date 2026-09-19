/**
 * The wire shape a coding harness hands a workflow over in.
 *
 * Everything here crosses a process boundary that Anthill does not control. A
 * harness — Claude Code, Codex, pi — composes a workflow somewhere else and
 * submits it; Anthill validates it, stores it and shows it. Nothing on the far
 * side of that boundary is trusted, so every field below is described by what
 * it means rather than by what the sender promises, and `readSubmission` is the
 * only door into these types.
 *
 * Versioned by number so an Anthill that does not understand a submission can
 * say so without opening it, the way `checkWorkflowCompatibility` refuses a
 * workflow from the future.
 */

import { HARNESS_TARGETS, type HarnessTarget, type Workflow } from "@anthill/workflow-schema";

/**
 * The version of the shapes in this file.
 *
 * Bumped when the wire shape changes in a way an older Anthill would read
 * wrongly — a field gaining a meaning, not a field being added. A submission
 * numbered higher than this is refused unopened.
 */
export const EXCHANGE_VERSION = 1;

/**
 * The harness on the other end of the handover.
 *
 * Deliberately the same three as `HarnessTarget` and as `MarkerCli`, and
 * written as an alias rather than as its own union so it cannot drift from
 * them: `checkCompleteness` compares a submission's harness against
 * `workflow.target` directly, and two unions that merely happen to agree today
 * would make that comparison a lie the day one of them gains a fourth member.
 */
export type SourceHarness = HarnessTarget;

/**
 * Who handed this over, and what they were asked to do.
 *
 * The session id is the harness's own and opaque here — Anthill neither mints
 * it nor parses it. It is kept because a run bound to this workflow needs a
 * session to be recoverable after it goes quiet, and the report channel alone
 * never supplies one.
 */
export type ExchangeSource = {
  harness: SourceHarness;
  /** The harness's own identifier for the conversation. Opaque. */
  sessionId: string;
  /**
   * What the user asked for, in the user's words.
   *
   * Never the model's reasoning about what the user asked for. This is the text
   * a person reads back to check that Anthill understood the same job they did,
   * and a summary would quietly replace their sentence with the model's.
   */
  taskText: string;
};

/**
 * What the harness may do once the workflow is in Anthill.
 *
 * `show-and-go` — the workflow is shown and the harness may start on it
 * straight away. The user can still edit, and an edit becomes a new revision,
 * but nothing waits for them.
 *
 * `approval-gate` — nothing may start until the user marks a revision ready,
 * and only that exact revision. There is no falling back to `show-and-go`: the
 * mode is recorded at the handover and a bind that ignores it is refused.
 */
export type HandoverMode = "show-and-go" | "approval-gate";

export const HANDOVER_MODES = [
  "show-and-go",
  "approval-gate",
] as const satisfies readonly HandoverMode[];

/**
 * One handover, as it exists once it has been read.
 *
 * The wire carries `workflow` as arbitrary JSON; this type only ever holds one
 * that `WorkflowSchema` has accepted, which is why nothing downstream needs to
 * re-check its shape. Build one with `readSubmission` and nowhere else.
 */
export type DraftSubmission = {
  /** The sender's `EXCHANGE_VERSION`, already checked against this build's. */
  exchangeVersion: number;
  /**
   * The sender's own key for this handover, repeated verbatim on a retry.
   *
   * A harness that submits, loses the answer and submits again must land on the
   * same workflow rather than a second one. The key is what makes the second
   * call recognisable as the same call; the store compares it and answers
   * `already_exists` rather than creating anything.
   */
  idempotencyKey: string;
  source: ExchangeSource;
  mode: HandoverMode;
  /**
   * The workflow this submission is addressed to, when it is addressed to one.
   *
   * Absent on a first submission, and never an id Anthill handed out. Identity
   * is the document's own `workflow.id`, which the harness brings with it and
   * the store files the handover under — it has to be, because that id is how
   * a run is tied to the document the user has open. Nothing requires it to be
   * unique or hard to guess, and `createEmptyWorkflow` calls every blank
   * document `workflow`, so an id that is already taken is refused rather than
   * merged into what is there.
   *
   * This field says only which workflow the sender believes it is revising, so
   * that a submission whose address and document disagree can be refused
   * instead of quietly filed under one of the two.
   */
  workflowId?: string;
  workflow: Workflow;
};

/**
 * Where a revision stands.
 *
 * A revision, not a workflow: readiness belongs to one numbered revision and
 * cannot carry to the next, and a run binds to the revision it started with
 * rather than to whatever the workflow later became.
 */
export type RevisionState =
  /** Submitted and stored. Nobody has approved it and no run holds it. */
  | "draft"
  /** The user marked this exact revision ready, or the mode needs no approval. */
  | "ready_for_agent"
  /** A run is bound to it, so its content can no longer change. */
  | "bound";

/**
 * Something wrong with a submission, phrased for whoever has to fix it.
 *
 * One type for two vocabularies: the workflow validator's codes travel through
 * unchanged, and the handover's own rules add a few of their own. A consumer
 * that does not recognise a code still has `message` to show and `ask` to put
 * to the user, which is the point — the list is meant to survive a validator
 * gaining a rule.
 */
export type ExchangeProblem = {
  /** A `WORKFLOWNER_VALIDATION_CODES` code, an advisory code, or one from `EXCHANGE_PROBLEM_CODES`. */
  code: string;
  /** What a person reads. Absent from no problem. */
  message: string;
  /** The step this is about, when it is about one. */
  nodeId?: string;
  /**
   * The connection this is about, when it is about one.
   *
   * Three of the validator's rules — a dangling connection, a condition that
   * does not parse, and one that reads a result from an agent the workflow does
   * not have — locate themselves by edge and by nothing else. Dropping it would
   * leave those three with no locator at all, and the only way to act on them
   * would be to read every connection in the diagram.
   */
  edgeId?: string;
  /** Dotted path into the submission, e.g. `workflow.nodes.0.id`, when the problem has one. */
  field?: string;
  /**
   * The question to put to the user, in their language rather than the
   * validator's.
   *
   * This is the whole mechanism by which a harness knows what to ask before it
   * may hand anything over: `message` says what is wrong, `ask` says what to
   * say out loud. Absent only where there is genuinely nothing to ask — a
   * version mismatch is answered by updating Anthill, not by the user.
   */
  ask?: string;
};

/**
 * Codes the exchange raises itself, as opposed to the validator's.
 *
 * Prefixed so a reader can tell at a glance which vocabulary a code came from:
 * `SUBMISSION_*` is the envelope, `WORKFLOW_MALFORMED` is the document inside
 * it, `HANDOVER_*` is a rule that exists only because this is a handover.
 */
export const EXCHANGE_PROBLEM_CODES = {
  /** The version number is from a newer Anthill, or is not a version at all. */
  EXCHANGE_VERSION_UNSUPPORTED: "EXCHANGE_VERSION_UNSUPPORTED",
  /** The submission is not a JSON object. */
  SUBMISSION_NOT_AN_OBJECT: "SUBMISSION_NOT_AN_OBJECT",
  /** A required envelope field is absent. */
  SUBMISSION_FIELD_MISSING: "SUBMISSION_FIELD_MISSING",
  /** An envelope field is present but is not the kind of thing it has to be. */
  SUBMISSION_FIELD_INVALID: "SUBMISSION_FIELD_INVALID",
  /** The workflow document did not survive `WorkflowSchema`. */
  WORKFLOW_MALFORMED: "WORKFLOW_MALFORMED",
  /** The brief does not say when the work is finished. */
  HANDOVER_NO_DONE_CRITERIA: "HANDOVER_NO_DONE_CRITERIA",
  /** The submission does not carry what the user actually asked for. */
  HANDOVER_NO_TASK_TEXT: "HANDOVER_NO_TASK_TEXT",
  /** The workflow targets one tool and a different tool submitted it. */
  HANDOVER_TARGET_MISMATCH: "HANDOVER_TARGET_MISMATCH",
} as const;

export type ExchangeProblemCode =
  (typeof EXCHANGE_PROBLEM_CODES)[keyof typeof EXCHANGE_PROBLEM_CODES];

/**
 * Whether a value that arrived as `unknown` names a harness.
 *
 * Asked of `HARNESS_TARGETS` rather than of a list repeated here, so a fourth
 * tool becomes submittable by being added in one place.
 */
export function isSourceHarness(value: unknown): value is SourceHarness {
  return HARNESS_TARGETS.includes(value as HarnessTarget);
}

export function isHandoverMode(value: unknown): value is HandoverMode {
  return HANDOVER_MODES.includes(value as HandoverMode);
}
