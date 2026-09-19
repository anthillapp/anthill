/**
 * Reading a handover that arrived from somewhere else.
 *
 * Everything this module is given came over MCP from a process Anthill did not
 * start and cannot vouch for, so it is read the way a file from a stranger is
 * read: nothing is assumed to exist, nothing is assumed to be the type it looks
 * like, and no cast stands in for a check. The reward for that care is that a
 * `DraftSubmission` can be believed everywhere else.
 *
 * Two rules shape the whole file.
 *
 * The version is checked first and alone. A submission numbered higher than
 * this build understands is refused *unopened* — reporting that its `mode` is
 * unrecognised would be Anthill guessing at the meaning of a shape it has just
 * admitted it does not know, and the sender would go and fix the wrong thing.
 *
 * Everything else is reported at once. The existing defensive parse in
 * `edit-proposal.ts` shows only the first zod issue, and a sender that has to
 * discover its mistakes one round trip at a time is a sender that puts four
 * questions to the user where one would have done. Every problem this module
 * can see, it says.
 */

import { HARNESS_TARGETS, WorkflowSchema, type Workflow } from "@anthill/workflow-schema";

import {
  EXCHANGE_PROBLEM_CODES,
  EXCHANGE_VERSION,
  HANDOVER_MODES,
  SESSION_ID_MAX_LENGTH,
  isHandoverMode,
  isSessionId,
  isSourceHarness,
  type DraftSubmission,
  type ExchangeProblem,
  type ExchangeSource,
} from "./contracts.js";

export type ReadSubmissionResult =
  | { ok: true; submission: DraftSubmission }
  | { ok: false; problems: ExchangeProblem[] };

/**
 * Whether this build can read a submission at that version number.
 *
 * By number, without looking inside, so the answer does not depend on the very
 * fields whose meaning is in question — the same posture as
 * `checkWorkflowCompatibility` refusing a workflow from the future. There is no
 * `ask` on the problem it returns: the user cannot answer a version mismatch,
 * and putting the question to them would waste the one thing `ask` is for.
 */
export function checkExchangeVersion(submitted: number): ExchangeProblem | undefined {
  if (!Number.isInteger(submitted) || submitted < 1) {
    return {
      code: EXCHANGE_PROBLEM_CODES.EXCHANGE_VERSION_UNSUPPORTED,
      message: `${JSON.stringify(submitted)} is not an exchange version. This build speaks version ${EXCHANGE_VERSION}.`,
      field: "exchangeVersion",
    };
  }

  if (submitted > EXCHANGE_VERSION) {
    return {
      code: EXCHANGE_PROBLEM_CODES.EXCHANGE_VERSION_UNSUPPORTED,
      message: `This handover uses exchange version ${submitted}; this build of Anthill understands ${EXCHANGE_VERSION}. Update Anthill to accept it — reading it here would silently drop whatever this build does not know about.`,
      field: "exchangeVersion",
    };
  }

  return undefined;
}

/**
 * Whether a session id is one Anthill can carry without changing it.
 *
 * Exported because two doors let one in and they have to shut on the same
 * things: a handover carries the session that composed the workflow, and a
 * bind may name a different session to do the work. Anthill still does not
 * parse either — what a session id means is the harness's business — but it
 * writes one onto a binding, registers it as a run's session, compares it
 * against the ids in the harness's own session files and shows it to the user.
 * An id carrying a separator or a newline survives none of that intact, and
 * the failure it causes is a run that never matches its session rather than
 * anything anyone would recognise as a bad session id. So it is refused here,
 * where the refusal can still reach the only party able to send another one.
 */
export function checkSessionId(value: unknown, field: string): ExchangeProblem | undefined {
  if (isSessionId(value)) return undefined;

  if (typeof value !== "string" || value.trim().length === 0) {
    return fieldProblem(
      value,
      field,
      "a string",
      "It is the harness's own id for this session. A run bound to this workflow needs one to be picked up again after it goes quiet, and the progress channel never supplies it.",
    );
  }

  return {
    code: EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_INVALID,
    message: `${field} has to be letters, digits, hyphens and underscores, and at most ${SESSION_ID_MAX_LENGTH} of them. Anthill does not read a session id, but it writes one down, compares it against the ids in the harness's own session files and shows it to the user, and one carrying anything else comes back out of a file name as a different string.`,
    field,
  };
}

/**
 * Turn arbitrary JSON into a submission, or into every reason it is not one.
 *
 * The only door into `DraftSubmission`. The workflow inside goes through
 * `WorkflowSchema.safeParse` rather than `parseWorkflow`, which throws: a
 * malformed document is an answer to give the sender, not an exception for
 * somebody further up to catch.
 *
 * Surviving this says only that the handover has the right *shape*. Whether the
 * workflow inside is one a person could be asked to approve is a separate
 * question, and `checkCompleteness` is where it is asked.
 */
export function readSubmission(value: unknown): ReadSubmissionResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      problems: [
        {
          code: EXCHANGE_PROBLEM_CODES.SUBMISSION_NOT_AN_OBJECT,
          message: "A handover has to be a JSON object.",
        },
      ],
    };
  }

  if (typeof value.exchangeVersion !== "number") {
    return {
      ok: false,
      problems: [
        fieldProblem(
          value.exchangeVersion,
          "exchangeVersion",
          "a version number",
          `This build speaks version ${EXCHANGE_VERSION}.`,
        ),
      ],
    };
  }

  const unsupported = checkExchangeVersion(value.exchangeVersion);
  if (unsupported) return { ok: false, problems: [unsupported] };

  const problems: ExchangeProblem[] = [];

  const idempotencyKey = readNonBlankString(value.idempotencyKey);
  if (idempotencyKey === undefined) {
    problems.push(
      fieldProblem(
        value.idempotencyKey,
        "idempotencyKey",
        "a string",
        "It is the sender's own key for this handover, repeated verbatim if the handover is retried. A submission lands on the id the document carries, and the key is what says a second one under that id is the same call rather than different work.",
      ),
    );
  }

  const mode = isHandoverMode(value.mode) ? value.mode : undefined;
  if (mode === undefined) {
    problems.push(
      fieldProblem(
        value.mode,
        "mode",
        anyOf(HANDOVER_MODES),
        "Show-and-go lets the work begin as soon as the workflow validates; approval-gate waits until the user has marked a revision ready.",
      ),
    );
  }

  const source = readSource(value.source, problems);

  let workflowId: string | undefined;
  if (value.workflowId !== undefined && value.workflowId !== null) {
    // Absent — or an explicit null, which senders do write — means "this is a
    // new workflow" and Anthill assigns the identity. Present but blank is a
    // different claim: the sender believes it is revising something and has
    // lost track of what, and reading that as the first would quietly create a
    // second workflow behind its back.
    workflowId = readNonBlankString(value.workflowId);
    if (workflowId === undefined) {
      problems.push(
        fieldProblem(
          value.workflowId,
          "workflowId",
          "a string",
          "Leave it out altogether for a new workflow. A blank one says this revises something without saying what.",
        ),
      );
    }
  }

  const workflow = readWorkflow(value.workflow, problems);

  // `problems` is checked as well as the four values, not instead of them: a
  // blank `workflowId` leaves every named value defined and is still a refusal.
  if (
    problems.length > 0 ||
    idempotencyKey === undefined ||
    mode === undefined ||
    source === undefined ||
    workflow === undefined
  ) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    submission: {
      exchangeVersion: value.exchangeVersion,
      idempotencyKey,
      source,
      mode,
      ...(workflowId ? { workflowId } : {}),
      workflow,
    },
  };
}

function readSource(value: unknown, problems: ExchangeProblem[]): ExchangeSource | undefined {
  if (!isRecord(value)) {
    problems.push(
      fieldProblem(
        value,
        "source",
        "an object",
        "It says who handed this over: which tool, which session of it, and what the user asked for.",
      ),
    );
    return undefined;
  }

  const harness = isSourceHarness(value.harness) ? value.harness : undefined;
  if (harness === undefined) {
    problems.push(fieldProblem(value.harness, "source.harness", anyOf(HARNESS_TARGETS)));
  }

  // Shape as well as presence, which no other envelope field asks for. This is
  // the one id in here that leaves Anthill's own vocabulary and is matched
  // against strings a harness wrote somewhere else.
  const badSession = checkSessionId(value.sessionId, "source.sessionId");
  if (badSession) problems.push(badSession);
  const sessionId = isSessionId(value.sessionId) ? value.sessionId : undefined;

  // Present-but-blank is deliberately not a problem here. It is a completeness
  // problem, and `checkCompleteness` puts the question to the user; a sender
  // that carried no field at all has a bug no question to the user would fix.
  const taskText = typeof value.taskText === "string" ? value.taskText : undefined;
  if (taskText === undefined) {
    problems.push(
      fieldProblem(
        value.taskText,
        "source.taskText",
        "a string",
        "It is what the user asked for, in the user's own words — not a summary of it.",
      ),
    );
  }

  if (harness === undefined || sessionId === undefined || taskText === undefined) return undefined;
  return { harness, sessionId, taskText };
}

function readWorkflow(value: unknown, problems: ExchangeProblem[]): Workflow | undefined {
  const parsed = WorkflowSchema.safeParse(value);
  if (parsed.success) return parsed.data as Workflow;

  for (const issue of parsed.error.issues) {
    // Paths are prefixed so `field` locates the problem in the *submission*,
    // which is what the sender has in front of it. `nodes.0.id` on its own
    // stops being unambiguous the moment the envelope grows a list of its own.
    const path = issue.path.map((segment) => String(segment)).join(".");
    problems.push({
      code: EXCHANGE_PROBLEM_CODES.WORKFLOW_MALFORMED,
      message: path ? `${path}: ${issue.message}` : issue.message,
      field: path ? `workflow.${path}` : "workflow",
    });
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The values a field may take, as a person reads them: `"a", "b" or "c"`.
 *
 * Taken from the list the check itself uses rather than written out beside it.
 * The two were a literal and `isSourceHarness`, which agreed only for as long
 * as nobody added a fourth tool — and the sentence a sender reads to find out
 * what it sent wrong is the copy that would have gone stale.
 */
function anyOf(values: readonly string[]): string {
  const quoted = values.map((value) => JSON.stringify(value));
  if (quoted.length < 2) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`;
}

/**
 * One envelope field's problem, told apart by whether anything was sent at all.
 *
 * "You did not send this" and "what you sent is the wrong kind of thing" send
 * the sender to different places, and one message covering both makes a typo
 * look like an omission.
 */
function fieldProblem(
  value: unknown,
  field: string,
  expected: string,
  why?: string,
): ExchangeProblem {
  const absent = value === undefined || value === null;
  const head = absent
    ? `This handover does not carry ${field}, which has to be ${expected}.`
    : `${field} has to be ${expected}.`;
  return {
    code: absent
      ? EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_MISSING
      : EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_INVALID,
    message: why ? `${head} ${why}` : head,
    field,
  };
}
