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
 *
 * Everything in here is written into the handover's identity, which is created
 * once and never rewritten. That is what makes it a record of the handover
 * rather than a description of the workflow's current content, and it is why
 * both fields are checked before they are stored rather than after.
 */
export type ExchangeSource = {
  harness: SourceHarness;
  /**
   * The harness's own identifier for the conversation.
   *
   * Opaque in meaning and checked in shape: Anthill does not parse it, but it
   * writes it onto a binding, registers it as a run's session, compares it
   * against the ids in the harness's own session files and shows it to the
   * user. `isSessionId` says what may travel; anything else is refused at the
   * door rather than mangled by whatever writes it down next.
   */
  sessionId: string;
  /**
   * What the user asked for, in the user's words.
   *
   * Never the model's reasoning about what the user asked for. This is the text
   * a person reads back to check that Anthill understood the same job they did,
   * and a summary would quietly replace their sentence with the model's.
   *
   * Frozen at the handover, deliberately. It lives in the identity, it is not
   * in the document the user edits, and no later submission may replace it —
   * so what a user reads back is what the harness said they asked for, at the
   * moment it said it. That is the whole value of the field: a text the sender
   * could correct after the fact would be evidence of nothing, and a user who
   * finds a summary here instead of their own sentence has learnt the one
   * thing this field exists to tell them. Their recourse is the workflow,
   * which is theirs to edit and is what the work is actually driven by.
   */
  taskText: string;
};

/**
 * Which of the two things the user asked for when they handed the workflow over.
 *
 * `design` — they want a workflow of their own. Anthill opens the editor, they
 * read it, change it and save it, and the session waits for them to say so.
 *
 * `watch` — they want to see the work happen. The harness composed the graph
 * itself and is already doing the work; there is nothing here for the user to
 * settle, so Anthill opens the Live Session instead of the canvas.
 *
 * **It decides a screen and nothing else.** It is not a gate and cannot be
 * one: nothing in this system has a hook on a harness, so an Anthill that
 * withheld a revision would withhold its own record of the run and not the
 * work. That was `approval-gate`, and it is gone. What decides whether work
 * starts is the user's answer to the session that asked them, which lives in
 * their conversation and only ever lived there.
 *
 * `show-and-go` and `approval-gate` stay in the union because they are written
 * into every handover already on disk, and a value that no longer parses would
 * make those records unreadable for no gain. Both read as `design`: an old
 * handover was one the user was meant to look at. Use `handoverOpens` rather
 * than comparing this field, so the legacy pair is folded in one place.
 */
export type HandoverMode = "design" | "watch" | "show-and-go" | "approval-gate";

export const HANDOVER_MODES = [
  "design",
  "watch",
  "show-and-go",
  "approval-gate",
] as const satisfies readonly HandoverMode[];

/** Which screen a handover in this mode belongs on. */
export type HandoverOpens = "editor" | "live";

/**
 * The screen a handover opens on, with the legacy modes folded in.
 *
 * Only `watch` goes to the Live Session. Everything else — including a
 * handover from before these two words existed — opens the editor, because
 * sending an old record somewhere new would change what a stored handover
 * means after the fact.
 */
export function handoverOpens(mode: HandoverMode): HandoverOpens {
  return mode === "watch" ? "live" : "editor";
}

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
   * Not an address. What a submission lands on is the document's own
   * `workflow.id`; the key is the sender's promise that a second submission
   * under that id is the same call rather than a different piece of work. The
   * store compares it against the one the identity recorded, answers
   * `already_exists` when they agree and refuses when they do not, and
   * overwrites nothing either way. So one key carrying two different documents
   * creates two workflows, and is not a way to revise the first.
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

/**
 * The longest session id Anthill will carry.
 *
 * The length `safeSegment` in `@anthill/exchange-store` cuts a file name down
 * to, so an id that fits here is an id no path can shorten. Generous for the
 * thing it describes: the three harnesses all mint a UUID.
 */
export const SESSION_ID_MAX_LENGTH = 120;

/** Letters, digits, hyphens and underscores — `safeSegment`'s alphabet. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Whether a value that arrived as `unknown` is a session id Anthill can carry
 * without changing it.
 *
 * The rule is `safeSegment`'s, restated rather than imported: that function
 * lives in the store, which depends on this package, and the dependency does
 * not run the other way. Restating it is the cost of the two sides agreeing
 * about what may travel, and the agreement is what matters — a session id
 * containing a separator or a newline is one that comes back out of a file
 * name as a different string, and the comparison that should have matched a
 * run to its session fails silently instead of loudly.
 */
export function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= SESSION_ID_MAX_LENGTH && SESSION_ID.test(value)
  );
}

/** What the app knows of one handed-over workflow: its identity, the head revision, and the runs bound to it. */
export type ExchangeView = {
  workflowId: string;
  source: ExchangeSource;
  /**
   * Which of the two things the user asked the harness for.
   *
   * Read from the handover's identity, which is written once, so it says what
   * they wanted at the moment they asked and not what the document has become
   * since. `handoverOpens` turns it into the screen this handover belongs on;
   * nothing here compares it to a literal, because the two legacy modes have
   * to fold into `design` in exactly one place.
   */
  mode: HandoverMode;
  /** What is true of the head revision — the one the editor has open. */
  state: RevisionState;
  revision: number;
  digest: string;
  problems: ExchangeProblem[];
  bindings: { runId: string; revision: number }[];
};
export type BoundWorkflowResult =
  | { ok: true; workflow: Workflow; revision: number; digest: string }
  | { ok: false; error: string };
