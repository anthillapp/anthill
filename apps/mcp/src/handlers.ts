/**
 * What the four tools actually do.
 *
 * Deliberately a thin shell. Every rule this server appears to enforce belongs
 * to somebody else: `readSubmission` decides whether a handover can be read,
 * `checkSessionId` decides whether a session id can be carried at all,
 * `checkCompleteness` decides whether it can be shown to a person, and
 * `ExchangeStore.eligibleRevision` decides whether it can be worked on. A second
 * copy of any of those living here would be a second answer the app could
 * disagree with, in front of the same user, about the same workflow — which is
 * also why `bind_run` asks `checkSessionId` the same question a handover is
 * asked, rather than a laxer one of its own. The only judgement made in this
 * file is a size ceiling, which is the server's own because the transport is.
 *
 * The one rule that shapes every function below comes from the SDK rather than
 * from the domain: a handler that throws is turned into
 * `{content, isError: true}`, which is exactly what the SDK produces for a
 * genuine crash. A refusal signalled that way would be indistinguishable from a
 * bug, and the model would have no way to tell "ask the user three questions"
 * from "the server fell over". So nothing here throws to say no. Every refusal
 * is an ordinary result carrying an explicit `outcome`, and `isError` is left to
 * the faults the SDK catches on its own.
 *
 * Handlers are built here rather than inside the tool registrations so a test
 * can construct them against a temporary data directory and call them directly.
 * What that leaves untested is the wiring, which is what the end-to-end test
 * over a real stdio transport is for.
 */

import {
  ExchangeStore,
  type Eligibility,
  type ExchangeWorkflow,
} from "@anthill/exchange-store";
import { MARKER_VERSION, cliInstruction, newNonce, newRunId, workflowSteps } from "@anthill/live";
import {
  EXCHANGE_VERSION,
  checkSessionId,
  readSubmission,
  type ExchangeProblem,
} from "@anthill/workflow-exchange";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

import {
  bindText,
  draftText,
  questionsFrom,
  readyText,
  workflowText,
  type BindAnswer,
  type DraftAnswer,
  type ReadyAnswer,
  type WorkflowAnswer,
} from "./text.js";
import { workflowUrl } from "./url.js";

/**
 * The largest handover this server will take, in bytes of JSON.
 *
 * The ceiling exists because the one above it is fatal: `StdioServerTransport`
 * reads into a 10 MB buffer and, on a message larger than that, emits an error
 * and closes — the connection dies instead of answering, and the harness is left
 * without even a refusal to read. Anything caught here is answered properly, so
 * the limit is set an order of magnitude below the one that kills the session
 * rather than just under it.
 *
 * A megabyte of JSON is a workflow nobody is going to read through and approve,
 * which is the only thing a handover is for. Above 10 MB nothing in this process
 * ever runs; that message is lost in the transport before a handler sees it.
 */
export const MAX_SUBMISSION_BYTES = 1_000_000;

/**
 * The server's own problem code.
 *
 * One, and it is about the transport rather than about workflows — which is why
 * it is here and not in `@anthill/workflow-exchange`, whose vocabulary describes
 * what a handover is allowed to say rather than how much of it fits down a pipe.
 */
export const MCP_PROBLEM_CODES = {
  SUBMISSION_TOO_LARGE: "SUBMISSION_TOO_LARGE",
} as const;

export type HandlerDependencies = {
  store: ExchangeStore;
  /** Injected so a test can pin the ids a bind mints; defaults to `@anthill/live`'s. */
  mintRunId?: () => string;
  mintNonce?: () => string;
};

/**
 * What `create_workflow_draft` is given: the six fields, none of them judged.
 *
 * `unknown` rather than the types they are supposed to have, and the looseness
 * is the point rather than an oversight. The SDK validates a tool's declared
 * input schema *inside* the try block that turns every failure into
 * `isError: true`, so anything the schema refuses comes back looking like a
 * crash, with a zod message and no question for the user. The design asks
 * instead for an `invalid` outcome carrying every problem with its dotted path
 * and its `ask` — and `readSubmission` is written to produce exactly that, for
 * every one of these fields. A schema that declared their types would refuse
 * them first and leave that work unreachable.
 *
 * What the schema still decides is which keys have to be there at all, because
 * zod has no way to say "required, and I will judge it myself": a missing
 * required field is the one mistake the SDK answers on its own. The schema is
 * where that requirement is advertised, so the answer at least names the field
 * the caller left out.
 */
export type CreateDraftInput = {
  idempotencyKey: unknown;
  mode: unknown;
  source: unknown;
  workflow: unknown;
  workflowId?: unknown;
  exchangeVersion?: unknown;
};

export type WorkflowInput = { workflowId: string };

export type BindRunInput = {
  workflowId: string;
  revision?: number;
  digest?: string;
  idempotencyKey?: string;
  /** The harness's own session, checked for shape here rather than downstream. */
  sessionId?: string;
};

export type Handlers = {
  createWorkflowDraft(input: CreateDraftInput): Promise<CallToolResult>;
  getWorkflow(input: WorkflowInput): Promise<CallToolResult>;
  getReadyRevision(input: WorkflowInput): Promise<CallToolResult>;
  bindRun(input: BindRunInput): Promise<CallToolResult>;
};

export function createHandlers(dependencies: HandlerDependencies): Handlers {
  const { store } = dependencies;
  const mintRunId = dependencies.mintRunId ?? (() => newRunId());
  const mintNonce = dependencies.mintNonce ?? (() => newNonce());

  return {
    async createWorkflowDraft(input): Promise<CallToolResult> {
      const submitted = {
        // A sender that says nothing about versions is speaking this one. The
        // field is accepted at all so that a plugin built against a later
        // exchange is refused by number with something to read, rather than
        // having its extra meaning silently dropped by this build.
        exchangeVersion: input.exchangeVersion ?? EXCHANGE_VERSION,
        idempotencyKey: input.idempotencyKey,
        mode: input.mode,
        source: input.source,
        ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
        workflow: input.workflow,
      };

      const oversize = checkSize(submitted);
      if (oversize) return result(draftText, invalidDraft([oversize]));

      const read = readSubmission(submitted);
      if (!read.ok) return result(draftText, invalidDraft(read.problems));

      const submission = read.submission;
      const created = await store.createWorkflow(submission);
      const problems = created.problems ?? [];

      // `id_taken`, `refused` and `conflict` all mean the same thing to a
      // caller: nothing it can work with was stored. They are folded into the
      // one outcome the design names for that, and the store's own code and
      // message travel through untouched so the difference is still legible.
      //
      // No link on any of them. Under `refused` there is nothing of this id to
      // open, and under `id_taken` the link opens the *other* workflow that
      // holds the name — which is the confusion the refusal exists to report.
      if (created.outcome !== "created" && created.outcome !== "already_exists") {
        return result(draftText, {
          ...invalidDraft(problems),
          outcome: created.outcome === "refused" ? "incomplete" : "invalid",
          workflowId: created.workflowId,
        });
      }

      const url = workflowUrl(created.workflowId);

      const revision = created.revision;
      if (revision === undefined) {
        // The store returns the revision on both of the outcomes that got this
        // far. Reaching here would mean it stopped doing so, and a display
        // request naming a guessed revision would point the app at content
        // nobody submitted — a fault, and reported as one.
        throw new Error(`${created.workflowId} was stored but no revision came back.`);
      }

      const stored = await store.readWorkflow(created.workflowId);

      // Asking the app to open it is a separate write from storing it, and a
      // draft the user never sees is a draft nobody can answer the questions
      // about. The key is derived rather than minted, so a retried handover
      // does not make the app open the same workflow twice.
      const drop = await store.dropInbox({
        kind: "display",
        key: displayKey(created.workflowId, submission.idempotencyKey),
        workflowId: created.workflowId,
        revision,
      });

      const all = [...problems, ...(drop.problems ?? [])];
      return result(draftText, {
        outcome: problems.length > 0 ? "incomplete" : created.outcome,
        workflowId: created.workflowId,
        url,
        revision,
        ...(stored?.identity ? { mode: stored.identity.mode } : {}),
        displayed: false,
        displayRequested: drop.outcome !== "conflict",
        ...(all.length > 0 ? { problems: all, questions: questionsFrom(all) } : {}),
      });
    },

    async getWorkflow({ workflowId }): Promise<CallToolResult> {
      const stored = await store.readWorkflow(workflowId);
      if (!stored) return result(workflowText, { outcome: "not_found", workflowId });

      const url = workflowUrl(workflowId);

      // Whether a revision may be worked on is asked of the store rather than
      // assembled here out of readiness and bindings. It is the same question
      // `get_ready_revision` answers, and two derivations of it would eventually
      // tell the user two different things about one workflow.
      const eligibility = await store.eligibleRevision(workflowId);

      const problems = [...stored.problems];
      if (!eligibility.eligible && eligibility.reason === "incomplete") {
        problems.push(...eligibility.problems);
      }

      return result(workflowText, {
        outcome: "found",
        workflowId,
        url,
        ...identityFields(stored),
        ...(stored.head
          ? {
              head: {
                revision: stored.head.revision,
                digest: stored.head.digest,
                createdAt: stored.head.createdAt,
                by: stored.head.by,
              },
            }
          : {}),
        revisions: stored.revisions,
        ...(stored.ready ? { ready: stored.ready } : {}),
        bindings: stored.bindings,
        ...eligibilityFields(eligibility),
        ...(problems.length > 0 ? { problems } : {}),
      });
    },

    async getReadyRevision({ workflowId }): Promise<CallToolResult> {
      const eligibility = await store.eligibleRevision(workflowId);

      if (!eligibility.eligible) {
        // An id nothing was stored under is not a workflow that is not ready
        // yet. Relaying it as one tells the caller to wait for a user who has
        // nothing in front of them to approve, and no amount of waiting turns
        // an id this machine has never seen into a revision.
        if (eligibility.reason === "no_such_workflow") {
          return result(readyText, {
            outcome: "no_such_workflow",
            workflowId,
            ...notReadyFields(eligibility),
          });
        }

        return result(readyText, {
          outcome: "not_ready",
          workflowId,
          url: workflowUrl(workflowId),
          ...notReadyFields(eligibility),
        });
      }

      const url = workflowUrl(workflowId);
      const workflow = eligibility.revision.workflow;
      return result(readyText, {
        outcome: "ready",
        workflowId,
        url,
        mode: eligibility.mode,
        revision: eligibility.revision.revision,
        digest: eligibility.revision.digest,
        state: eligibility.state,
        workflow,
        steps: workflowSteps(workflow),
      });
    },

    async bindRun({ workflowId, revision, digest, idempotencyKey, sessionId }): Promise<CallToolResult> {
      // Before anything is read or written: the one id in this call that
      // Anthill did not mint. It is copied onto the binding and registered as
      // the run's session, where it is compared against the ids in the
      // harness's own files — so an id that cannot survive being written down
      // is refused here, with something to read, rather than quietly failing
      // to match anything a layer or two further on.
      const badSession =
        sessionId === undefined ? undefined : checkSessionId(sessionId, "sessionId");
      if (badSession) {
        // No link: this is refused before Anthill has looked at the workflow,
        // so nothing here knows whether there is one to open.
        return result(bindText, {
          outcome: "invalid",
          workflowId,
          ...problemFields([badSession]),
        });
      }

      if (!Number.isSafeInteger(revision) || revision! < 1 || !digest?.trim() || !idempotencyKey?.trim()) {
        return result(bindText, {
          outcome: "invalid", workflowId,
          problems: [{ code: "BIND_PRECONDITION_REQUIRED", message:
            "Provide the revision and digest returned by get_ready_revision and a stable idempotencyKey. Retry with the same key and payload; use a new key only for an intentional new run." }],
        });
      }
      const url = workflowUrl(workflowId);
      const bound = await store.bindRequest(workflowId, revision!, digest!, idempotencyKey!, sessionId,
        () => ({ runId: mintRunId(), nonce: mintNonce() }));

      if (bound.outcome !== "bound" && bound.outcome !== "already_bound") {
        return result(bindText, {
          outcome:
            bound.outcome === "no_such_workflow"
              ? "no_such_workflow"
              : bound.outcome === "not_eligible"
                ? "not_ready"
                : "conflict",
          workflowId,
          ...(bound.outcome !== "no_such_workflow" ? { url } : {}),
          revision,
          ...(bound.reason ? { reason: bound.reason } : {}),
          ...problemFields(bound.problems),
        });
      }

      const binding = bound.binding;
      if (!binding) {
        // The store returns the binding on both successful outcomes. Reaching
        // here would mean it stopped doing so, which is a fault rather than an
        // answer, and it is reported as one.
        throw new Error(`A run was bound to ${workflowId} but no binding came back.`);
      }

      // The app registers the run from this drop; nothing else tells it a run
      // exists. A binding the app never hears about is a run that never appears
      // on the Live Session page, so the failure is reported rather than
      // swallowed — the reporting commands below would otherwise arrive for a
      // run nothing is watching.
      const drop = await store.dropInbox({
        kind: "bind",
        key: bindKey(binding.runId),
        workflowId,
        revision: binding.revision,
        runId: binding.runId,
      });

      const stored = await store.readWorkflow(workflowId);
      const snapshot = await store.readRevision(workflowId, binding.revision);
      if (!snapshot || !stored?.identity || snapshot.digest !== binding.digest) {
        throw new Error("The bound snapshot cannot be verified. No running state is implied.");
      }
      const steps = workflowSteps(snapshot.workflow);
      const reportingCommands = cliInstruction(
        {
          runId: binding.runId,
          nonce: binding.nonce,
          workflowId: binding.workflowId,
          cli: stored?.identity?.source.harness ?? "claude-code",
          promptVersion: MARKER_VERSION,
          issuedAt: binding.at,
        },
        steps,
      );

      return result(bindText, {
        outcome: bound.outcome,
        workflowId,
        url,
        mode: stored.identity.mode,
        revision: binding.revision,
        digest: snapshot.digest,
        runId: binding.runId,
        nonce: binding.nonce,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
        registered: false,
        registrationRequested: drop.outcome !== "conflict",
        reportingCommands,
        steps,
        ...problemFields(drop.problems),
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The pieces the four share                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One answer, rendered for both of its readers.
 *
 * `structuredContent` is the answer itself and `content` is the same answer in
 * prose. Hosts differ in whether they expose structured output to the model,
 * so the text path must also include the complete authoritative instructions.
 */
function result<Answer extends Record<string, unknown>>(
  render: (answer: Answer) => string,
  answer: Answer,
): CallToolResult {
  return {
    content: [{ type: "text", text: render(answer) }],
    structuredContent: answer,
  };
}

function invalidDraft(problems: readonly ExchangeProblem[]): DraftAnswer {
  return {
    outcome: "invalid",
    problems: [...problems],
    questions: questionsFrom(problems),
  };
}

function identityFields(stored: ExchangeWorkflow): Partial<WorkflowAnswer> {
  if (!stored.identity) return {};
  return {
    mode: stored.identity.mode,
    source: stored.identity.source,
    createdAt: stored.identity.createdAt,
  };
}

function eligibilityFields(eligibility: Eligibility): Partial<WorkflowAnswer> {
  if (eligibility.eligible) {
    return {
      eligible: true,
      revision: eligibility.revision.revision,
      state: eligibility.state,
    };
  }
  return {
    eligible: false,
    reason: eligibility.reason,
    ...(eligibility.revision !== undefined ? { revision: eligibility.revision } : {}),
  };
}

/** The refusing half of an eligibility answer, for the two tools that relay one. */
function notReadyFields(
  eligibility: Extract<Eligibility, { eligible: false }>,
): Partial<ReadyAnswer & BindAnswer> {
  return {
    reason: eligibility.reason,
    ...(eligibility.mode ? { mode: eligibility.mode } : {}),
    ...(eligibility.revision !== undefined ? { revision: eligibility.revision } : {}),
    ...problemFields(eligibility.problems),
  };
}

function problemFields(problems: readonly ExchangeProblem[] | undefined): {
  problems?: ExchangeProblem[];
  questions?: string[];
} {
  if (!problems || problems.length === 0) return {};
  return { problems: [...problems], questions: questionsFrom(problems) };
}

/**
 * Whether the handover is small enough to answer about.
 *
 * Measured on the assembled submission rather than on the workflow alone,
 * because the whole of it is what gets stored and the whole of it is what came
 * down the pipe.
 */
function checkSize(submitted: unknown): ExchangeProblem | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(submitted), "utf8");
  if (bytes <= MAX_SUBMISSION_BYTES) return undefined;
  return {
    code: MCP_PROBLEM_CODES.SUBMISSION_TOO_LARGE,
    message: `This handover is ${bytes} bytes; Anthill accepts up to ${MAX_SUBMISSION_BYTES}. Nothing was stored.`,
    field: "workflow",
    ask: "This workflow is too large to hand over. Which parts of it are the work you actually want done?",
  };
}

/**
 * The inbox keys the app sees.
 *
 * Both are derived from something the sender already owns rather than minted
 * here, which is what makes a repeat recognisable: dropping a display request
 * twice for one workflow under one idempotency key does not open it twice, and
 * a run id belongs to exactly one bind.
 *
 * The display key is about the workflow as well as the key, because the key
 * alone does not say which document this is. Nothing refuses a sender that
 * reuses one key under a second `workflow.id` — a submission is filed under
 * the id its document carries, and the key is only compared once two of them
 * land on one id — so a drop keyed on the key alone collided with the first
 * handover's in the inbox. That collision is not a repeat, so it is refused as
 * a conflict, and the workflow it would have opened never opens.
 *
 * Hashed rather than spelled out, because a key becomes a file name through
 * `safeSegment`, which rewrites everything outside its alphabet and then cuts
 * the result to 120 characters. Two pairs that differ only in punctuation, or
 * only past that length, would be one file again — and a file the app has
 * already consumed is worse than a collision, because `dropInbox` reads the
 * copy in `done/` as this request having been carried out and answers
 * `already_dropped` for a workflow nobody has seen. Hashing the entire JSON
 * tuple keeps the key within the filename limit without ambiguous separators.
 */
function displayKey(workflowId: string, idempotencyKey: string): string {
  return `display-${createHash("sha256").update(JSON.stringify([workflowId, idempotencyKey])).digest("hex")}`;
}

function bindKey(runId: string): string {
  return `bind-${runId}`;
}
