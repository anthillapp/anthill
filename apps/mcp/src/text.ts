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

import type { LaunchReport } from "./launch.js";

/** A step as the reporting commands name it. */
export type RunStep = { id: string; name: string };

export type DraftAnswer = {
  outcome: "created" | "already_exists" | "incomplete" | "invalid";
  /** Absent only when the submission was too malformed to say which workflow it was about. */
  workflowId?: string;
  /**
   * The link that opens this workflow, when there is one to open.
   *
   * Absent from every refusal, and that is the rule every answer in this file
   * follows: a link is offered only where the thing it addresses is stored.
   * Handing the user an `anthill://` URL that opens nothing — or, after an id
   * clash, that opens somebody else's workflow — is worse than saying nothing,
   * because it looks like the one part of the answer they can act on.
   */
  url?: string;
  revision?: number;
  mode?: HandoverMode;
  /** True only after desktop acknowledgement, not when a request is queued. */
  displayed?: boolean;
  displayRequested?: boolean;
  /** Stored with `open: false`: nothing was asked of the app yet (ANT-138). */
  openDeferred?: boolean;
  /**
   * What became of bringing Anthill up for this.
   *
   * Separate from `displayRequested`, which is about the request left in the
   * exchange, and from `displayed`, which is the app's own acknowledgement.
   * This is about the app existing at all: on every outcome but `opened` it
   * carries the sentence to pass on, because the user is about to wait for a
   * window that is not coming (ANT-123).
   */
  app?: LaunchReport;
  /**
   * The Anthill this chat is pinned to, when nothing was brought up to say so
   * (`open: false`): the first result of a chat names it either way (ANT-236).
   */
  target?: LaunchReport["target"];

  problems?: ExchangeProblem[];
  /** The `ask` of every problem that has one, in the order they came back. */
  questions?: string[];
};

export type WorkflowAnswer = {
  outcome: "found" | "not_found";
  workflowId: string;
  /** Absent on `not_found`: there is nothing of that id here for a link to open. */
  url?: string;
  mode?: HandoverMode;
  source?: ExchangeSource;
  createdAt?: string;
  head?: { revision: number; digest: string; createdAt: string; by: RevisionAuthor };
  /** Every revision on disk, readable or not. */
  revisions?: number[];
  bindings?: Binding[];
  eligible?: boolean;
  /** The revision eligibility is about: the one to work from, or the one refused. */
  revision?: number;
  state?: RevisionState;
  reason?: EligibilityRefusal;
  /** Records that could not be read, and why the eligible revision is not one. */
  problems?: ExchangeProblem[];
};

/**
 * What became of a revision offered to a workflow that already exists.
 *
 * `unchanged` is a success and has to read as one. The store recognises the
 * content it already holds, so a retry after a lost reply, or a change the user
 * had already made themselves, lands on the revision that is there rather than
 * stacking a duplicate beside it — and a caller told "unchanged" has nothing to
 * fix and nothing to do again.
 */
export type ReviseAnswer = {
  outcome: "revised" | "unchanged" | "no_such_workflow" | "incomplete" | "invalid" | "conflict";
  workflowId?: string;
  /** Absent from every refusal, for the reason `DraftAnswer.url` gives. */
  url?: string;
  revision?: number;
  digest?: string;
  /** The revision a run is working from, when one is, and it is not this one. */
  boundRevision?: number;
  displayRequested?: boolean;
  /**
   * What became of bringing Anthill up for this.
   *
   * Separate from `displayRequested`, which is about the request left in the
   * exchange, and from `displayed`, which is the app's own acknowledgement.
   * This is about the app existing at all: on every outcome but `opened` it
   * carries the sentence to pass on, because the user is about to wait for a
   * window that is not coming (ANT-123).
   */
  app?: LaunchReport;

  problems?: ExchangeProblem[];
  questions?: string[];
};

export type ReadyAnswer = {
  /**
   * `no_such_workflow` is its own outcome rather than a flavour of `not_ready`.
   * The difference is the whole answer a caller acts on: one is a workflow
   * waiting for its user, the other is an id this machine has never seen, and a
   * caller told to wait for the second waits for ever.
   */
  outcome: "ready" | "not_ready" | "no_such_workflow";
  workflowId: string;
  /** Absent on `no_such_workflow`, for the reason `DraftAnswer.url` gives. */
  url?: string;
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

/**
 * The call itself being wrong, before any workflow was consulted.
 *
 * Its own member of the union because it is the one outcome that can arrive
 * with no workflow to name: the id is one of the five values a bind carries and
 * is judged with the other four, so a call that did not send a usable one
 * leaves nothing to address and nothing to link to. Everything else about it is
 * the ordinary bind answer — one shape, one set of words, every value that has
 * to change named at once, whichever of them it is.
 */
export type InvalidBindAnswer = {
  outcome: "invalid";
  workflowId?: string;
  problems?: ExchangeProblem[];
};

export type BindAnswer = InvalidBindAnswer | {
  outcome:
    | "bound"
    | "already_bound"
    | "not_ready"
    | "no_such_workflow"
    | "conflict";
  workflowId: string;
  /** Absent on `no_such_workflow`, for the reason `DraftAnswer.url` gives. */
  url?: string;
  mode?: HandoverMode;
  revision?: number;
  digest?: string;
  runId?: string;
  nonce?: string;
  sessionId?: string;
  /** True only after desktop acknowledgement, not when a request is queued. */
  registered?: boolean;
  registrationRequested?: boolean;
  /**
   * What became of bringing Anthill up for this.
   *
   * Separate from `displayRequested`, which is about the request left in the
   * exchange, and from `displayed`, which is the app's own acknowledgement.
   * This is about the app existing at all: on every outcome but `opened` it
   * carries the sentence to pass on, because the user is about to wait for a
   * window that is not coming (ANT-123).
   */
  app?: LaunchReport;

  /** The commands the harness runs to report progress, ready to be followed. */
  reportingCommands?: string;
  steps?: RunStep[];
  reason?: EligibilityRefusal;
  problems?: ExchangeProblem[];
  questions?: string[];
};

/**
 * What the two read-only tools say when no workflow was named.
 *
 * Shared between them because the mistake is one mistake either way, and it is
 * the whole of what those two calls can get wrong: the id is what each of them
 * is *for*, and there is nothing else in either call to judge. `bind_run`
 * carries four more values and answers for the id among them, in `bindText`,
 * so that a call wrong in two places is corrected once.
 *
 * It carries neither a workflowId nor a link, and it cannot — a call that could
 * not say which workflow it meant leaves nothing to name and nothing to open.
 */
export type CallAnswer = {
  outcome: "invalid";
  problems: ExchangeProblem[];
};

/* -------------------------------------------------------------------------- */
/* The four results                                                           */
/* -------------------------------------------------------------------------- */

export type OpenAnswer = {
  outcome: "open_requested" | "not_found";
  workflowId: string;
  url?: string;
  revision?: number;
  /** True only after desktop acknowledgement, not when a request is queued. */
  displayed?: boolean;
  displayRequested?: boolean;
  app?: LaunchReport;
  problems?: ExchangeProblem[];
};

/** What `open_workflow` says: the second half of a draft stored with `open: false`. */
export function openText(answer: OpenAnswer): string {
  if (answer.outcome === "not_found") return join([unknownWorkflowText(answer.workflowId)]);
  const parts = [
    answer.displayRequested
      ? `Anthill was asked to open revision ${answer.revision} of ${answer.workflowId}. Anthill has not acknowledged showing it.`
      : `No new display request was queued for revision ${answer.revision} of ${answer.workflowId}; one is already waiting.`,
    ...appText(answer.app),
  ];
  if (answer.problems && answer.problems.length > 0) parts.push("Also worth knowing:", numbered(answer.problems.map(sentence)));
  if (answer.url) parts.push(answer.url);
  return join(parts);
}

/**
 * The one sentence a result says about Anthill itself.
 *
 * Nothing when the link was taken, because "Anthill was opened" is noise in an
 * answer whose next line is the workflow's URL — and because it would be a
 * claim about a window this server has not seen. Something on every other
 * outcome, because then the user is waiting for an app that is not coming and
 * the model is the only one in a position to tell them.
 */
function appText(report: LaunchReport | undefined): string[] {
  if (!report) return [];
  // Which Anthill, always: a chat pinned to the wrong build is seen here, at
  // the first handover, rather than when nothing appears.
  const named = targetText(report.target);
  if (report.outcome === "opened") return named;
  return [...named, ...(report.message ? [report.message] : [])];
}

/** Which Anthill the chat's handovers go to, where a result knows it. */
function targetText(target: LaunchReport["target"]): string[] {
  return target ? [`This chat's handovers go to ${target.label}.`] : [];
}

export function draftText(answer: DraftAnswer): string {
  if (answer.outcome === "invalid") return refusedDraftText(answer);
  if (answer.outcome === "incomplete") return join([
    "This handover was not stored or displayed. No work may start from it.",
    ...detail(answer.questions, answer.problems),
    "Clarify these requirements with the user, correct the workflow, and submit it again using the same intended workflow id and request key.",
    ...targetText(answer.target),
  ]);

  const where = answer.workflowId ?? "the workflow";
  const stored =
    answer.outcome === "already_exists"
      ? `This handover has been submitted before. It is already stored as revision ${answer.revision} of ${where}`
      : `Stored as revision ${answer.revision} of ${where}`;
  const shown = answer.openDeferred
    ? ". It has not been opened: call open_workflow with this workflow id when it is time to show it."
    : answer.displayRequested
      ? ". A display request is queued; Anthill has not acknowledged opening it."
      : ". No display request was queued. Desktop display is not confirmed.";

  const parts = [`${stored}${shown}`];

  // A stored revision is a complete one — an incomplete submission is refused
  // without being stored — so there is one thing to say about it and one
  // sequence to follow. What decides whether work starts is the user's answer,
  // not anything this server holds.
  parts.push(
    stateText("ready_for_agent"),
    "Ask the user whether to start. When they say so, call get_ready_revision, then bind_run.",
  );

  parts.push(...(answer.app ? appText(answer.app) : targetText(answer.target)));

  if (answer.problems && answer.problems.length > 0) {
    parts.push("Also worth knowing:", numbered(answer.problems.map(sentence)));
  }

  if (answer.url) parts.push(answer.url);
  return join(parts);
}

export function reviseText(answer: ReviseAnswer): string {
  const where = answer.workflowId ?? "that workflow";

  if (answer.outcome === "no_such_workflow") return join([
    `Nothing of the id ${where} has been handed over to this Anthill, so there was nothing to revise. Check the id against the one create_workflow_draft returned; waiting will not change it.`,
  ]);

  if (answer.outcome === "incomplete") return join([
    `Revision of ${where} was refused, and nothing was written. The workflow it would have stored is missing something a person has to answer for.`,
    ...detail(answer.questions, answer.problems),
    "Put these to the user, correct the workflow, and send it again.",
  ]);

  if (answer.outcome === "invalid" || answer.outcome === "conflict") return join([
    `Nothing was written to ${where}.`,
    ...(answer.problems && answer.problems.length > 0 ? [numbered(answer.problems.map(sentence))] : []),
  ]);

  const stored =
    answer.outcome === "unchanged"
      ? `${where} already held this content, as revision ${answer.revision}. Nothing was added, and nothing needed to be.`
      : `Stored as revision ${answer.revision} of ${where}.`;

  const parts = [stored];

  parts.push(
    answer.displayRequested
      ? "A display request is queued; Anthill has not acknowledged opening it. The user will be asked before it replaces anything they have not saved."
      : "No display request was queued, so the user is still looking at whatever they had open.",
  );

  // The one thing a caller is most likely to get wrong about revising while a
  // run is going: that it did something to the run. It did not, and saying so
  // is cheaper than the answer to "why is the agent ignoring my change".
  if (answer.boundRevision !== undefined) {
    parts.push(
      `A run is bound to revision ${answer.boundRevision} and stays on it. This revision does not reach that run; nothing about the work already under way has changed.`,
    );
  }

  parts.push(
    "The user decides what is worked on. Tell them what you changed and ask, rather than binding this revision because you wrote it.",
  );

  parts.push(...appText(answer.app));

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
    answer.bindings && answer.bindings.length > 0
      ? // The nonce beside the run id, because the two together are what the
        // reporting commands take: this is where a harness that lost them —
        // one that restarted, and cannot bind again because its key is spent
        // — comes to find them.
        `Runs: ${answer.bindings.map((binding) => `${binding.runId} (nonce ${binding.nonce}) on revision ${binding.revision}`).join(", ")}`
      : "Runs: none bound",
  );
  parts.push(bulleted(facts));

  if (answer.eligible && answer.state) {
    parts.push(
      `Revision ${answer.revision} is the one to work from.`,
      stateText(answer.state),
    );
  } else if (answer.reason) {
    parts.push(refusalText(answer.reason, answer.workflowId, answer.revision));
  }

  if (answer.problems && answer.problems.length > 0) {
    parts.push("Problems:", numbered(answer.problems.map(sentence)));
  }

  parts.push(answer.url ?? "");
  return join(parts);
}

export function readyText(answer: ReadyAnswer): string {
  if (answer.outcome === "no_such_workflow") {
    return join([unknownWorkflowText(answer.workflowId)]);
  }

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
      //
      // Said only where the user is the one who can change the answer. Under
      // the rest — a damaged record, a workflow with no revision — waiting for
      // them is waiting for somebody who cannot help.
      answer.reason && userCanClear(answer.reason)
        ? "This call does not wait, and neither should you. Tell the user what Anthill is waiting for, finish your turn, and call get_ready_revision again when they say they are done."
        : "",
      answer.url ?? "",
    ]);
  }

  const parts = [
    `Revision ${answer.revision} of ${answer.workflowId} is the one to work from. Digest ${answer.digest}.`,
  ];
  if (answer.state) parts.push(stateText(answer.state));
  if (answer.workflow) parts.push(workflowSummary(answer.workflow, answer.steps ?? []),
    "Authoritative workflow JSON for this exact revision:\n" + JSON.stringify(answer.workflow));
  parts.push(
    "Call bind_run with this revision, digest and a stable idempotencyKey before you start. Repeat that same key and payload after a lost reply, not a new request.",
    answer.url ?? "",
  );
  return join(parts);
}

export function bindText(answer: BindAnswer): string {
  if (answer.outcome === "no_such_workflow") {
    return join([unknownWorkflowText(answer.workflowId)]);
  }

  // The caller's own mistake, so it is the caller that is addressed. Nothing
  // here is a question for the user, and telling the model to go and ask one
  // would send it to somebody who cannot answer. No link either: this is
  // refused before Anthill has looked at the workflow, so nothing here knows
  // whether there is one to open.
  if (answer.outcome === "invalid") {
    return join([
      "Nothing was bound and no run was created. This call cannot be accepted:",
      numbered((answer.problems ?? []).map(sentence)),
      "Correct the call and bind again.",
    ]);
  }

  if (answer.outcome === "not_ready") {
    return join([
      answer.reason
        ? refusalText(answer.reason, answer.workflowId, answer.revision)
        : `Revision ${answer.revision} of ${answer.workflowId} cannot be worked on.`,
      ...detail(answer.questions, answer.problems),
      "Nothing was bound and no run was created.",
      answer.url ?? "",
    ]);
  }

  if (answer.outcome === "conflict") {
    return join([
      `Nothing was bound to ${answer.workflowId}.`,
      ...detail(answer.questions, answer.problems),
      // Both ways on, because the common cause of this is a harness that
      // restarted: it repeats the binding key it was told to repeat, from a
      // session with a new id, and the run it is trying to rejoin is already
      // on disk. Without this the model is told no and left with nowhere to
      // go, and the run id and nonce it needs are in neither this answer nor
      // anything it has been told to read.
      "Use a new idempotencyKey for a deliberate new run, or call get_workflow to recover the run id and nonce of the existing binding.",
      answer.url ?? "",
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
    "Run these as you work. They are the only thing that tells Anthill which step you are on, and they change nothing about the work itself – if one cannot be run, carry on without it.",
    answer.reportingCommands ?? "",
    ...appText(answer.app),
    answer.url ?? "",
  ]);
}

export function callText(answer: CallAnswer): string {
  // Only a missing or blank workflowId means the call names no workflow. A
  // refused build names one, and saying otherwise sends the agent looking for
  // another id instead of dropping --dev (ANT-237).
  const unnamed = answer.problems.every((problem) => problem.field === "workflowId");
  return join([
    `${unnamed ? "This call names no workflow to act on." : "This call was refused."} Nothing was looked up and nothing was written:`,
    numbered(answer.problems.map(sentence)),
    "Correct the call and try again. Nothing here is a question for the user.",
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
    EXCHANGE_STORE_PROBLEM_CODES.STORE_WORKFLOW_UNKNOWN,
  ];
  const rest = (problems ?? []).filter((problem) => !echoes.includes(problem.code));
  return rest.length > 0 ? [numbered(rest.map(sentence))] : [];
}

/**
 * Whether the user is the one who can change this answer.
 *
 * One of the four refusals is theirs: questions they have not answered. The
 * other three — an id nothing was ever stored under, a record this build
 * cannot read, a workflow with no revision at all — are not things a person
 * can settle by reading and coming back, and asking them to would leave them
 * waiting for a change that is never going to arrive.
 *
 * There used to be a second: an approval they had not given. It went with the
 * gate, and nothing replaced it, because a complete graph is now workable the
 * moment it is stored.
 */
function userCanClear(reason: EligibilityRefusal): boolean {
  return reason === "incomplete";
}

/**
 * Every question a list of problems carries, in order, each said once.
 *
 * "Once" used to mean once per sentence, which quietly turned a workflow with
 * five unfinished steps into a single "What exactly should this step do?" —
 * and the tool description tells the model to read the questions out, so the
 * user was asked one question about five things and had no way to answer it.
 * The problems knew which block each was about all along; only this function
 * threw it away. So a repeat is now a repeat of the same question about the
 * same block, and a question that belongs to a block is prefixed with the
 * block's name, which the revision carries.
 *
 * The collapse is kept for problems with no block, because those genuinely are
 * one question: a brief with no goal is not five problems however many steps
 * read from it.
 */
export function questionsFrom(
  problems: readonly ExchangeProblem[],
  workflow?: Workflow,
): string[] {
  const names = new Map((workflow?.nodes ?? []).map((node) => [node.id, node.name.trim()]));
  const asked = new Set<string>();
  const questions: string[] = [];
  for (const problem of problems) {
    if (!problem.ask) continue;
    const key = `${problem.nodeId ?? ""}\u0000${problem.ask}`;
    if (asked.has(key)) continue;
    asked.add(key);
    // The id where the name is unknown or blank: it is worse to read out than
    // a name, and it is still the one thing that tells two of these apart.
    const named = problem.nodeId ? names.get(problem.nodeId) || problem.nodeId : undefined;
    questions.push(named ? `${named}: ${problem.ask}` : problem.ask);
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

  parts.push(...targetText(answer.target));
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
  const which = revision === undefined ? workflowId : `Revision ${revision} of ${workflowId}`;
  return `${which} is not finished enough to hand to anybody yet.`;
}

function unknownWorkflowText(workflowId: string): string {
  return `No workflow with id ${workflowId} has been handed over to Anthill on this machine. Check the id, or hand the workflow over with create_workflow_draft.`;
}

/** The shared words for a state, laid out as a short paragraph. */
function stateText(state: RevisionState): string {
  const described = describeState(state);
  return [`${described.label} – ${described.detail}`, described.next].filter(Boolean).join(" ");
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
