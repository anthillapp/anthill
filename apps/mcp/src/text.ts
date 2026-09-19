/**
 * What each tool has to say, and how it says it to each of its two readers.
 *
 * Every tool result goes to two audiences at once. The harness reads
 * `structuredContent` and acts on fields; the model reads `content` and talks to
 * the user. The SDK will happily let a tool populate one and leave the other
 * empty, and a result with only `structuredContent` arrives in the conversation
 * looking like nothing happened — so both are always written, and both are
 * written from the same answer object. Two renderings of one answer cannot drift;
 * two answers would.
 *
 * The answer types below are therefore the tool's whole result: they are handed
 * to `structuredContent` unchanged, and the renderers in this file turn each of
 * them into the paragraph the model reads out.
 *
 * The prose is aimed at the model, and through it at the user. Where a state has
 * words already — `describeState` is where the app and this server agree on what
 * to call a draft under each handover mode — those words are used rather than
 * new ones, because the user will see both surfaces and being told two things
 * about one state leaves them with no way to settle which is true. What this file
 * adds on top is the part the app has no reason to say: which tool to call next.
 */

import {
  EXCHANGE_STORE_PROBLEM_CODES,
  type Binding,
  type EligibilityRefusal,
  type RevisionAuthor,
} from "@anthill/exchange-store";
import {
  describeState,
  type ExchangeProblem,
  type ExchangeSource,
  type HandoverMode,
  type RevisionState,
} from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";

/** A step as the reporting commands name it. */
export type RunStep = { id: string; name: string };

export type DraftAnswer = {
  outcome: "created" | "already_exists" | "incomplete" | "invalid";
  /** Absent only when the submission was too malformed to say which workflow it was about. */
  workflowId?: string;
  url?: string;
  revision?: number;
  mode?: HandoverMode;
  /** True only after desktop acknowledgement, not when a request is queued. */
  displayed?: boolean;
  displayRequested?: boolean;
  problems?: ExchangeProblem[];
  /** The `ask` of every problem that has one, in the order they came back. */
  questions?: string[];
};

export type WorkflowAnswer = {
  outcome: "found" | "not_found";
  workflowId: string;
  url: string;
  mode?: HandoverMode;
  source?: ExchangeSource;
  createdAt?: string;
  head?: { revision: number; digest: string; createdAt: string; by: RevisionAuthor };
  /** Every revision on disk, readable or not. */
  revisions?: number[];
  ready?: { revision: number; at?: string };
  bindings?: Binding[];
  eligible?: boolean;
  /** The revision eligibility is about: the one to work from, or the one refused. */
  revision?: number;
  state?: RevisionState;
  reason?: EligibilityRefusal;
  /** Records that could not be read, and why the eligible revision is not one. */
  problems?: ExchangeProblem[];
};

export type ReadyAnswer = {
  outcome: "ready" | "not_ready";
  workflowId: string;
  url: string;
  mode?: HandoverMode;
  revision?: number;
  digest?: string;
  state?: RevisionState;
  /**
   * The content to work from.
   *
   * Returned rather than assumed, because the user may have edited the workflow
   * since it was handed over. The revision that is eligible is the one they
   * approved, not the one the harness remembers submitting.
   */
  workflow?: Workflow;
  steps?: RunStep[];
  reason?: EligibilityRefusal;
  problems?: ExchangeProblem[];
  questions?: string[];
};

export type BindAnswer = {
  outcome: "bound" | "already_bound" | "not_ready" | "no_such_workflow" | "conflict" | "invalid";
  workflowId: string;
  url: string;
  mode?: HandoverMode;
  revision?: number;
  digest?: string;
  runId?: string;
  nonce?: string;
  sessionId?: string;
  /** True only after desktop acknowledgement, not when a request is queued. */
  registered?: boolean;
  registrationRequested?: boolean;
  /** The commands the harness runs to report progress, ready to be followed. */
  reportingCommands?: string;
  steps?: RunStep[];
  reason?: EligibilityRefusal;
  problems?: ExchangeProblem[];
  questions?: string[];
};

/* -------------------------------------------------------------------------- */
/* The four results                                                           */
/* -------------------------------------------------------------------------- */

export function draftText(answer: DraftAnswer): string {
  if (answer.outcome === "invalid") return refusedDraftText(answer);
  if (answer.outcome === "incomplete") return join([
    "This handover was not stored or displayed. No work may start from it.",
    ...detail(answer.questions, answer.problems),
    "Clarify these requirements with the user, correct the workflow, and submit it again using the same intended workflow id and request key.",
  ]);

  const where = answer.workflowId ?? "the workflow";
  const stored =
    answer.outcome === "already_exists"
      ? `This handover has been submitted before. It is already stored as revision ${answer.revision} of ${where}`
      : `Stored as revision ${answer.revision} of ${where}`;
  const shown = answer.displayRequested
    ? ". A display request is queued; the desktop has not acknowledged opening it."
    : ". No display request was queued. Desktop display is not confirmed.";

  const parts = [`${stored}${shown}`];

  if (answer.mode) {
    parts.push(
      stateText(answer.mode === "approval-gate" ? "draft" : "ready_for_agent", answer.mode),
      answer.mode === "approval-gate"
        ? "Tell the user that, then call get_ready_revision when they say they have approved it. It answers straight away and never waits."
        : "Call get_ready_revision, then bind_run, before you start work.",
    );
  }

  if (answer.problems && answer.problems.length > 0) {
    parts.push("Also worth knowing:", numbered(answer.problems.map(sentence)));
  }

  if (answer.url) parts.push(answer.url);
  return join(parts);
}

export function workflowText(answer: WorkflowAnswer): string {
  if (answer.outcome === "not_found") {
    return join([unknownWorkflowText(answer.workflowId)]);
  }

  const parts: string[] = [headline(answer)];

  const facts: string[] = [];
  if (answer.source?.taskText) facts.push(`Asked for: ${quote(answer.source.taskText)}`);
  if (answer.head) {
    facts.push(
      `Head: revision ${answer.head.revision}, digest ${answer.head.digest}, written by the ${answer.head.by === "user" ? "user editing it" : "harness that handed it over"} at ${answer.head.createdAt}`,
    );
  }
  if (answer.revisions && answer.revisions.length > 0) {
    facts.push(`Revisions on disk: ${answer.revisions.join(", ")}`);
  }
  facts.push(
    answer.ready
      ? `Approved: revision ${answer.ready.revision}${answer.ready.at ? ` at ${answer.ready.at}` : ""}`
      : "Approved: nothing yet",
  );
  facts.push(
    answer.bindings && answer.bindings.length > 0
      ? `Runs: ${answer.bindings.map((binding) => `${binding.runId} on revision ${binding.revision}`).join(", ")}`
      : "Runs: none bound",
  );
  parts.push(bulleted(facts));

  if (answer.eligible && answer.state && answer.mode) {
    parts.push(
      `Revision ${answer.revision} is the one to work from.`,
      stateText(answer.state, answer.mode),
    );
  } else if (answer.reason) {
    parts.push(refusalText(answer.reason, answer.workflowId, answer.revision));
  }

  if (answer.problems && answer.problems.length > 0) {
    parts.push("Problems:", numbered(answer.problems.map(sentence)));
  }

  parts.push(answer.url);
  return join(parts);
}

export function readyText(answer: ReadyAnswer): string {
  if (answer.outcome === "not_ready") {
    return join([
      answer.reason
        ? refusalText(answer.reason, answer.workflowId, answer.revision)
        : `There is no revision of ${answer.workflowId} to work from.`,
      ...detail(answer.questions, answer.problems),
      // The anti-requirement, said to the one reader who can honour it. A tool
      // that returned "not ready" and was then called in a tight loop, or waited
      // on inside the user's turn, would burn a session on somebody else's
      // reading speed.
      "This call does not wait, and neither should you. Tell the user what Anthill is waiting for, finish your turn, and call get_ready_revision again when they say they are done.",
      answer.url,
    ]);
  }

  const parts = [
    `Revision ${answer.revision} of ${answer.workflowId} is the one to work from. Digest ${answer.digest}.`,
  ];
  if (answer.state && answer.mode) parts.push(stateText(answer.state, answer.mode));
  if (answer.workflow) parts.push(workflowSummary(answer.workflow, answer.steps ?? []),
    "Authoritative workflow JSON for this exact revision:\n" + JSON.stringify(answer.workflow));
  parts.push(
    "Call bind_run with this revision, digest and a stable idempotencyKey before you start. Repeat that same key and payload after a lost reply, not a new request.",
    answer.url,
  );
  return join(parts);
}

export function bindText(answer: BindAnswer): string {
  if (answer.outcome === "invalid") return join(["Nothing was bound. Correct the request:", ...detail(answer.questions, answer.problems)]);
  if (answer.outcome === "no_such_workflow") {
    return join([unknownWorkflowText(answer.workflowId), answer.url]);
  }

  if (answer.outcome === "not_ready") {
    return join([
      answer.reason
        ? refusalText(answer.reason, answer.workflowId, answer.revision)
        : `Revision ${answer.revision} of ${answer.workflowId} cannot be worked on.`,
      ...detail(answer.questions, answer.problems),
      "Nothing was bound and no run was created.",
      answer.url,
    ]);
  }

  if (answer.outcome === "conflict") {
    return join([
      `Nothing was bound to ${answer.workflowId}.`,
      ...detail(answer.questions, answer.problems),
      answer.url,
    ]);
  }

  const registered = answer.registrationRequested
    ? "Observation registration is queued, not acknowledged. This does not mean the session is running or visible in Anthill."
    : "Observation registration was not queued. This does not start, stop or control the external session.";

  return join([
    `Run ${answer.runId} is bound to revision ${answer.revision} of ${answer.workflowId}. ${registered}`,
    bulleted([`Run id: ${answer.runId}`, `Nonce: ${answer.nonce}`]),
    // Why the commands are not optional decoration: Anthill is not driving this
    // session and has no other way to learn which step the work is on.
    "Run these as you work. They are the only thing that tells Anthill which step you are on, and they change nothing about the work itself — if one cannot be run, carry on without it.",
    answer.reportingCommands ?? "",
    answer.url,
  ]);
}

/* -------------------------------------------------------------------------- */
/* The pieces they share                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What to say under a refusal, beyond the sentence that named it.
 *
 * Questions when there are any, because those are what the user has to be
 * asked. Otherwise the problems themselves — minus the two the store raises
 * that say, in its words, exactly what the reason sentence has just said.
 * Printing those twice reads as though two separate things were wrong.
 */
function detail(
  questions: readonly string[] | undefined,
  problems: readonly ExchangeProblem[] | undefined,
): string[] {
  if (questions && questions.length > 0) {
    return ["Put these to the user, in their own words:", numbered(questions)];
  }

  const echoes: readonly string[] = [
    EXCHANGE_STORE_PROBLEM_CODES.STORE_AWAITING_APPROVAL,
    EXCHANGE_STORE_PROBLEM_CODES.STORE_WORKFLOW_UNKNOWN,
  ];
  const rest = (problems ?? []).filter((problem) => !echoes.includes(problem.code));
  return rest.length > 0 ? [numbered(rest.map(sentence))] : [];
}

/** Every question a list of problems carries, in order and without repeats. */
export function questionsFrom(problems: readonly ExchangeProblem[]): string[] {
  const asked = new Set<string>();
  const questions: string[] = [];
  for (const problem of problems) {
    if (!problem.ask || asked.has(problem.ask)) continue;
    asked.add(problem.ask);
    questions.push(problem.ask);
  }
  return questions;
}

function refusedDraftText(answer: DraftAnswer): string {
  const problems = answer.problems ?? [];
  const parts = [
    "Nothing was stored. This handover cannot be accepted:",
    numbered(problems.map(sentence)),
  ];

  // Two audiences, and which one this refusal belongs to depends on what came
  // back. A malformed envelope is the caller's to fix and the user cannot help;
  // a workflow id that is already taken is a decision only the user can make.
  const questions = answer.questions ?? [];
  if (questions.length > 0) {
    parts.push("Put these to the user, in their own words:", numbered(questions));
  } else {
    parts.push("Correct the call and submit again.");
  }

  if (answer.url) parts.push(answer.url);
  return join(parts);
}

function headline(answer: WorkflowAnswer): string {
  const harness = answer.source ? harnessName(answer.source.harness) : "a coding harness";
  const when = answer.createdAt ? ` at ${answer.createdAt}` : "";
  const mode = answer.mode ? `, under ${answer.mode}` : "";
  return `${answer.workflowId} was handed over by ${harness}${when}${mode}.`;
}

function refusalText(
  reason: EligibilityRefusal,
  workflowId: string,
  revision?: number,
): string {
  if (reason === "no_such_workflow") return unknownWorkflowText(workflowId);
  if (reason === "unreadable") {
    return `Something is stored under ${workflowId} that this build of Anthill cannot read, so it cannot say what may be worked on.`;
  }
  if (reason === "no_revision") return `${workflowId} has no revision to work from.`;
  if (reason === "awaiting_approval") {
    return `${workflowId} waits for the user to approve a revision, and they have not approved one yet.`;
  }
  const which = revision === undefined ? workflowId : `Revision ${revision} of ${workflowId}`;
  return `${which} is not finished enough to hand to anybody yet.`;
}

function unknownWorkflowText(workflowId: string): string {
  return `No workflow with id ${workflowId} has been handed over to Anthill on this machine. Check the id, or hand the workflow over with create_workflow_draft.`;
}

/** The shared words for a state, laid out as a short paragraph. */
function stateText(state: RevisionState, mode: HandoverMode): string {
  const described = describeState(state, mode);
  return [`${described.label} — ${described.detail}`, described.next].filter(Boolean).join(" ");
}

function workflowSummary(workflow: Workflow, steps: readonly RunStep[]): string {
  const lines: string[] = [];
  if (workflow.brief?.goal) lines.push(`Goal: ${workflow.brief.goal}`);

  const doneCriteria = workflow.brief?.doneCriteria?.filter((item) => item.trim()) ?? [];
  if (doneCriteria.length > 0) lines.push(`Done when: ${doneCriteria.join("; ")}`);

  if (steps.length > 0) {
    lines.push(`Steps: ${steps.map((step) => `${step.id} (${step.name})`).join(", ")}`);
  }

  const heading = `${workflow.name} (${workflow.id})`;
  return lines.length > 0 ? `${heading}\n${bulleted(lines)}` : heading;
}

function harnessName(harness: string): string {
  if (harness === "claude-code") return "Claude Code";
  if (harness === "codex") return "Codex";
  if (harness === "pi") return "pi";
  return harness;
}

/** A problem as one line: what is wrong, and where, when it says where. */
function sentence(problem: ExchangeProblem): string {
  const locator =
    problem.field ??
    (problem.nodeId ? `step ${problem.nodeId}` : undefined) ??
    (problem.edgeId ? `connection ${problem.edgeId}` : undefined);
  return locator ? `${problem.message} (${locator})` : problem.message;
}

function numbered(lines: readonly string[]): string {
  return lines.map((line, index) => `  ${index + 1}. ${line}`).join("\n");
}

function bulleted(lines: readonly string[]): string {
  return lines.map((line) => `  - ${line}`).join("\n");
}

function count(total: number, noun: string): string {
  return total === 1 ? `this ${noun}` : `these ${total} ${noun}s`;
}

function quote(text: string): string {
  return `"${text.trim()}"`;
}

/** Paragraphs, with the empty ones dropped so nothing renders a blank gap. */
function join(parts: readonly string[]): string {
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}
