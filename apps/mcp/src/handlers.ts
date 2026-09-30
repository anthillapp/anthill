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
 * asked, rather than a laxer one of its own.
 *
 * What is judged here is the call rather than the handover: a size ceiling,
 * which is the server's own because the transport is, and whether the
 * arguments a tool was handed are values Anthill can use at all. Both belong
 * to this file for the same reason the rule below gives — they are refusals
 * that have to be answered rather than thrown, and the tool's input schema
 * cannot answer anything.
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
  type EligibilityRefusal,
  type ExchangeWorkflow,
} from "@anthill/exchange-store";
import { MARKER_VERSION, cliInstruction, newNonce, newRunId, workflowSteps, type CliInvocation } from "@anthill/live";
import {
  EXCHANGE_PROBLEM_CODES,
  EXCHANGE_VERSION,
  checkCompleteness,
  checkSessionId,
  isSessionId,
  readSubmission,
  readWorkflowDocument,
  type ExchangeProblem,
} from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

import {
  bindText,
  callText,
  draftText,
  openText,
  questionsFrom,
  readyText,
  reviseText,
  workflowText,
  type BindAnswer,
  type CallAnswer,
  type DraftAnswer,
  type ReadyAnswer,
  type ReviseAnswer,
  type WorkflowAnswer,
} from "./text.js";
import { openUrl, type LaunchReport, type Launcher } from "./launch.js";
import { currentEnvironment, type ResolvedTarget, type TargetRequest, type TargetSession } from "./target.js";
import { invocationDeps, reportingInvocation } from "./report-command.js";
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
 * The longest binding key this server will take.
 *
 * The sender's own string, written onto a binding that is never rewritten and
 * compared against on every retry. It lived on the tool's input schema until
 * that schema had to stop judging what is in these fields; the limit is a
 * judgement about content, so it moved here with the rest of them.
 */
export const MAX_BIND_KEY_LENGTH = 256;

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
  /**
   * The Anthill a chat's handovers reach, resolved at the first handover and
   * pinned (see `target.ts`). The server always passes one.
   */
  targets?: TargetSession;
  /**
   * A fixed exchange instead, for a test that has nothing to resolve: every
   * call uses it, with `launch` below.
   */
  store?: ExchangeStore;
  /** Injected so a test can pin the ids a bind mints; defaults to `@anthill/live`'s. */
  mintRunId?: () => string;
  mintNonce?: () => string;
  /**
   * How Anthill is brought up. Injected so a test opens nothing at all — the
   * default runs a real opener against the real machine, which a unit test
   * must never do.
   */
  launch?: Launcher;
  /**
   * How the harness runs the reporting commands for a target (ANT-232):
   * `anthill`, or this node on the checkout's CLI when `anthill` is not on the
   * PATH. Injected so a test fixes the PATH; defaults to the real machine.
   */
  invocation?: (resolved: ResolvedTarget) => CliInvocation;
};

/**
 * What `create_workflow_draft` is given: the six fields, none of them judged.
 *
 * `unknown` rather than the types they are supposed to have, and optional
 * rather than required, and both are the point rather than an oversight. The
 * SDK validates a tool's declared input schema *inside* the try block that
 * turns every failure into `isError: true`, so anything the schema refuses
 * comes back looking like a crash, with a zod message and no question for the
 * user. The design asks instead for an `invalid` outcome carrying every problem
 * with its dotted path and its `ask` — and `readSubmission` is written to
 * produce exactly that, for every one of these fields.
 *
 * Absence is one of the things it answers for. `fieldProblem` tells "this
 * handover does not carry `mode`" apart from "`mode` has to be one of these
 * three" in so many words, and reporting every field at once is the whole
 * reason a sender gets one list rather than one zod sentence. A schema that
 * marked these required would take the first of those answers back and leave
 * the harness with the shape a refusal must never have.
 */
export type CreateDraftInput = {
  idempotencyKey?: unknown;
  mode?: unknown;
  source?: unknown;
  workflow?: unknown;
  workflowId?: unknown;
  exchangeVersion?: unknown;
  /**
   * `false` stores the handover without opening Anthill, so something can be
   * asked first; `open_workflow` opens it after (ANT-138). Anything else —
   * including leaving it out — opens it at once, as before.
   */
  open?: unknown;
  /** `"dev"` for the development build, on the chat's first handover (ANT-223). */
  build?: unknown;
};

/** The id the two read-only tools address, unjudged until `readWorkflowId`. */
export type WorkflowInput = { workflowId?: unknown };

/** What `open_workflow` and the two reads are given: the id, and the build a `--dev` command asks for. */
export type OpenInput = WorkflowInput & { build?: unknown };

/**
 * What `revise_workflow` is given: which workflow, and what it should say now.
 *
 * No idempotency key, unlike a handover. A revision is identified by its
 * content — the store recognises what it already holds and answers
 * `unchanged` — so a retry after a lost reply needs no promise from the
 * sender to be safe, and a key would only be a second way to say the same
 * thing and a second way to get it wrong.
 */
export type ReviseInput = { workflowId?: unknown; workflow?: unknown };

/**
 * What `bind_run` is given, judged here for the same reason a draft is.
 *
 * These carried their types on the schema until a reviewer drove the tool over
 * stdio: five of six malformed binds came back as `isError: true` with a zod
 * sentence and no `outcome`, which is the one shape the comment at the top of
 * this file says a refusal must never take. The precondition refusal below had
 * been written and could not be reached. So the schema now names the keys and
 * asks for none of them, and the answering is done where an answer can carry a
 * sentence the model can act on.
 */
export type BindRunInput = {
  workflowId?: unknown;
  revision?: unknown;
  digest?: unknown;
  idempotencyKey?: unknown;
  /** The harness's own session, checked for shape here rather than downstream. */
  sessionId?: unknown;
  /** `"dev"` for the development build, on the chat's first handover (ANT-223). */
  build?: unknown;
};

export type Handlers = {
  createWorkflowDraft(input: CreateDraftInput): Promise<CallToolResult>;
  reviseWorkflow(input: ReviseInput): Promise<CallToolResult>;
  getWorkflow(input: OpenInput): Promise<CallToolResult>;
  openWorkflow(input: OpenInput): Promise<CallToolResult>;
  getReadyRevision(input: OpenInput): Promise<CallToolResult>;
  bindRun(input: BindRunInput): Promise<CallToolResult>;
};

export function createHandlers(dependencies: HandlerDependencies): Handlers {
  const targets = targetAccess(dependencies);
  const mintRunId = dependencies.mintRunId ?? (() => newRunId());
  const mintNonce = dependencies.mintNonce ?? (() => newNonce());
  const invocation = dependencies.invocation ??
    ((resolved: ResolvedTarget) => reportingInvocation(resolved, invocationDeps(dependencies.targets?.environment ?? currentEnvironment())));

  /**
   * Ask the machine to bring Anthill up for a workflow this call just acted on.
   *
   * Called from exactly the three places that leave something in the exchange
   * inbox, and that is the whole rule: a drop is this server asking the app to
   * do something, and an app that is not running cannot. Everything else these
   * handlers answer — reading a workflow, asking whether a revision is ready —
   * is the model informing itself, and opening a window for it would put
   * Anthill in front of somebody who was working on something else. The same
   * reasoning is why nothing launches from the server's own startup or from
   * `tools/list`: a harness starts this process long before the user asks for
   * anything, and often in sessions that never will (ANT-123).
   *
   * Never allowed to fail the call. What is stored is stored, and the report
   * travels in the answer.
   */
  async function bringUp(reach: Reached, workflowId: string): Promise<LaunchReport> {
    // Every result names the Anthill it reached, so a chat on the wrong build
    // is seen at the first handover rather than discovered later.
    const target = reach.resolved ? { target: { id: reach.resolved.target, label: reach.resolved.label } } : {};
    try {
      return { ...(await reach.launch(workflowUrl(workflowId))), ...target };
    } catch (error) {
      // A launcher that throws is still only a launcher. The message says what
      // happened and the link in the result still works by hand.
      return {
        outcome: "failed",
        message: `Anthill could not be opened: ${error instanceof Error ? error.message : String(error)}. The handover is stored${opensIt(reach.link(workflowId))}.`,
        ...target,
      };
    }
  }

  /**
   * The revision an `incomplete` refusal is about, where there is one.
   *
   * Read only for that one reason, and only to put a block's name in front of
   * each question: a refusal names the revision by number, and the names the
   * user needs to hear are in the snapshot. Every other refusal is about the
   * workflow rather than about anything inside it.
   */
  async function incompleteRevision(
    store: ExchangeStore,
    workflowId: string,
    reason: EligibilityRefusal | undefined,
    revision: number | undefined,
  ): Promise<Workflow | undefined> {
    if (reason !== "incomplete" || revision === undefined) return undefined;
    return (await store.readRevision(workflowId, revision))?.workflow;
  }

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

      const build = readBuild(input.build);
      const read = readSubmission(submitted);
      if (!read.ok || "problem" in build) {
        return result(draftText, invalidDraft([...(read.ok ? [] : read.problems), ...("problem" in build ? [build.problem] : [])]));
      }

      const submission = read.submission;
      // Resolved before anything is written: a build the chat cannot have is
      // refused with nothing stored, never stored in the wrong exchange.
      const reach = targets.handover(build.request);
      if ("problem" in reach) return result(draftText, invalidDraft([reach.problem], submission.workflow));
      const { store } = reach;
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
          ...invalidDraft(problems, submission.workflow),
          outcome: created.outcome === "refused" ? "incomplete" : "invalid",
          workflowId: created.workflowId,
        });
      }

      const url = reach.link(created.workflowId);

      const revision = created.revision;
      if (revision === undefined) {
        // The store returns the revision on both of the outcomes that got this
        // far. Reaching here would mean it stopped doing so, and a display
        // request naming a guessed revision would point the app at content
        // nobody submitted — a fault, and reported as one.
        throw new Error(`${created.workflowId} was stored but no revision came back.`);
      }

      const stored = await store.readWorkflow(created.workflowId);

      // Stored, and not opened: the caller has something to ask first — whether
      // to connect Codex's hooks, say — and a window appearing mid-question
      // would put Anthill in front of the answer (ANT-138). `open_workflow`
      // does the rest when it is time.
      if (input.open === false) {
        return result(draftText, {
          outcome: problems.length > 0 ? "incomplete" : created.outcome,
          workflowId: created.workflowId,
          url,
          revision,
          ...(stored?.identity ? { mode: stored.identity.mode } : {}),
          displayed: false,
          displayRequested: false,
          openDeferred: true,
          ...(reach.resolved ? { target: { id: reach.resolved.target, label: reach.resolved.label } } : {}),
          ...(problems.length > 0 ? { problems, questions: questionsFrom(problems, submission.workflow) } : {}),
        });
      }

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
      // After the drop, so a queued request is waiting by the time the app
      // starts reading, and on a conflicting drop too: a conflict means this
      // same request is already queued, and the app still has to be running to
      // take it.
      const app = await bringUp(reach, created.workflowId);
      return result(draftText, {
        outcome: problems.length > 0 ? "incomplete" : created.outcome,
        workflowId: created.workflowId,
        // Read again: a web shell this handover started has a port by now.
        url: app.link ?? reach.link(created.workflowId),
        revision,
        ...(stored?.identity ? { mode: stored.identity.mode } : {}),
        displayed: false,
        displayRequested: drop.outcome !== "conflict",
        app,
        ...(all.length > 0 ? { problems: all, questions: questionsFrom(all, submission.workflow) } : {}),
      });
    },

    /**
     * A later say about a workflow that already exists.
     *
     * Kept apart from `create_workflow_draft` rather than folded into it.
     * Creating and revising differ in what they need and in what they refuse:
     * one claims a name and needs a key promising a retry is a retry, the
     * other addresses a name already claimed and is identified by content.
     * The one field they would have shared is `idempotencyKey`, which would
     * then mean two things depending on whether the id was taken — and its
     * whole job is to mean one.
     *
     * A revision is not a decision. Anything the store hands back says so: the
     * user is the one who chooses what is worked on, and a harness that writes
     * a revision and binds it has approved its own work.
     */
    async reviseWorkflow(input): Promise<CallToolResult> {
      const oversize = checkSize(input);
      if (oversize) return result(reviseText, { outcome: "invalid", problems: [oversize] });

      const addressed = readWorkflowId(input.workflowId);
      if ("problem" in addressed) {
        return result(reviseText, { outcome: "invalid", problems: [addressed.problem] });
      }
      const { workflowId } = addressed;
      const reach = targets.handover({});
      if ("problem" in reach) return result(reviseText, { outcome: "invalid", workflowId, problems: [reach.problem] });
      const { store } = reach;

      // Read before writing, for two reasons that both matter: a workflow this
      // Anthill has never been given is a different answer from one that
      // refuses the content, and completeness is judged against the source
      // recorded at the handover, which only the stored identity carries.
      const stored = await store.readWorkflow(workflowId);
      if (!stored?.identity) {
        return result(reviseText, { outcome: "no_such_workflow", workflowId });
      }

      const read = readWorkflowDocument(input.workflow);
      if (!read.ok) {
        return result(reviseText, { outcome: "invalid", workflowId, problems: read.problems });
      }
      if (read.workflow.id !== workflowId) {
        return result(reviseText, {
          outcome: "invalid",
          workflowId,
          problems: [
            callProblem(
              read.workflow.id,
              "workflow.id",
              `the id of the workflow being revised, ${workflowId}`,
              "A revision replaces nothing and renames nothing: it is a later say about one workflow, and the document has to be that workflow.",
            ),
          ],
        });
      }

      const problems = checkCompleteness(read.workflow, stored.identity.source);
      if (problems.length > 0) {
        return result(reviseText, {
          outcome: "incomplete",
          workflowId,
          problems,
          questions: questionsFrom(problems, read.workflow),
        });
      }

      const added = await store.addRevision(workflowId, read.workflow, "harness");
      if (added.outcome !== "added" && added.outcome !== "unchanged") {
        return result(reviseText, {
          outcome: added.outcome === "no_such_workflow" ? "no_such_workflow" : "conflict",
          workflowId,
          ...(added.problems ? { problems: added.problems } : {}),
        });
      }

      const revision = added.revision;
      if (revision === undefined) {
        throw new Error(`${workflowId} took a revision but no number came back.`);
      }

      /*
        Ask the app to show it.

        A revision on its own is a record the user cannot see: the document
        they have open is the working copy, which this server does not touch,
        so without this they would be reading the old graph while the store
        held a newer one — and the next thing they were asked to approve would
        not be what was in front of them. The drop is keyed on the content, so
        a retry asks once rather than reopening the workflow each time, and the
        app puts the unsaved-changes question before replacing anything.
      */
      const drop = await store.dropInbox({
        kind: "display",
        key: displayKey(workflowId, added.digest ?? String(revision)),
        workflowId,
        revision,
      });

      const bound = stored.bindings.at(-1)?.revision;
      const app = await bringUp(reach, workflowId);
      return result(reviseText, {
        outcome: added.outcome === "added" ? "revised" : "unchanged",
        workflowId,
        url: app.link ?? reach.link(workflowId),
        revision,
        app,
        ...(added.digest ? { digest: added.digest } : {}),
        ...(bound !== undefined && bound !== revision ? { boundRevision: bound } : {}),
        displayRequested: drop.outcome !== "conflict",
        ...(drop.problems ? { problems: drop.problems } : {}),
      });
    },

    /**
     * Open a stored handover in Anthill: the second half of a
     * `create_workflow_draft` called with `open: false` (ANT-138).
     *
     * Opens the head revision — what the user will see and edit — and is keyed
     * on it, so asking twice for the same revision does not open it twice.
     */
    async openWorkflow(input): Promise<CallToolResult> {
      const addressed = readWorkflowId(input.workflowId);
      if ("problem" in addressed) return result(callText, invalidCall([addressed.problem]));
      const workflowId = addressed.workflowId;
      const build = readBuild(input.build);
      if ("problem" in build) return result(callText, invalidCall([build.problem]));
      const reach = targets.handover(build.request);
      if ("problem" in reach) return result(callText, invalidCall([reach.problem]));
      const { store } = reach;

      const stored = await store.readWorkflow(workflowId);
      const revision = stored?.head?.revision;
      if (!stored || revision === undefined) return result(openText, { outcome: "not_found", workflowId });

      const drop = await store.dropInbox({
        kind: "display",
        key: displayKey(workflowId, `open-revision-${revision}`),
        workflowId,
        revision,
      });
      const app = await bringUp(reach, workflowId);
      return result(openText, {
        outcome: "open_requested",
        workflowId,
        url: app.link ?? reach.link(workflowId),
        revision,
        displayed: false,
        displayRequested: drop.outcome !== "conflict",
        app,
        ...(drop.problems ? { problems: drop.problems } : {}),
      });
    },

    async getWorkflow(input): Promise<CallToolResult> {
      const addressed = readWorkflowId(input.workflowId);
      if ("problem" in addressed) return result(callText, invalidCall([addressed.problem]));
      const workflowId = addressed.workflowId;
      const build = readBuild(input.build);
      if ("problem" in build) return result(callText, invalidCall([build.problem]));
      const reach = targets.read(build.request);
      if ("problem" in reach) return result(callText, invalidCall([reach.problem]));
      const { store } = reach;

      const stored = await store.readWorkflow(workflowId);
      if (!stored) return result(workflowText, { outcome: "not_found", workflowId });

      const url = reach.link(workflowId);

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
        bindings: stored.bindings,
        ...eligibilityFields(eligibility),
        ...(problems.length > 0 ? { problems } : {}),
      });
    },

    async getReadyRevision(input): Promise<CallToolResult> {
      const addressed = readWorkflowId(input.workflowId);
      if ("problem" in addressed) return result(callText, invalidCall([addressed.problem]));
      const workflowId = addressed.workflowId;
      const build = readBuild(input.build);
      if ("problem" in build) return result(callText, invalidCall([build.problem]));
      const reach = targets.read(build.request);
      if ("problem" in reach) return result(callText, invalidCall([reach.problem]));
      const { store } = reach;

      const eligibility = await store.eligibleRevision(workflowId);

      if (!eligibility.eligible) {
        const refused = await incompleteRevision(store, workflowId, eligibility.reason, eligibility.revision);
        // An id nothing was stored under is not a workflow that is not ready
        // yet. Relaying it as one tells the caller to wait for a user who has
        // nothing in front of them to approve, and no amount of waiting turns
        // an id this machine has never seen into a revision.
        if (eligibility.reason === "no_such_workflow") {
          return result(readyText, {
            outcome: "no_such_workflow",
            workflowId,
            ...notReadyFields(eligibility, refused),
          });
        }

        return result(readyText, {
          outcome: "not_ready",
          workflowId,
          url: reach.link(workflowId),
          ...notReadyFields(eligibility, refused),
        });
      }

      const url = reach.link(workflowId);
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

    async bindRun(input): Promise<CallToolResult> {
      const { revision, digest, idempotencyKey, sessionId } = input;

      // Every argument is judged before anything is read or written, and every
      // one that fails is named. Two of them are copied from
      // `get_ready_revision` and three are the caller's own, so a refusal that
      // said only that one of the five was wrong left it guessing which — and
      // the four it had sent correctly were as likely to be rewritten as the
      // one it had not.
      //
      // The workflow id is judged here with the rest rather than answered first
      // and separately, which is what it used to be: a call wrong in the id and
      // in the digest was refused for the id, corrected, sent again and refused
      // for the digest — two round trips, in two different shapes of prose, for
      // one wrong call. It is the same sentence either way, because the two
      // read-only tools have nothing beside the id to judge and answer for it
      // on their own.
      const problems: ExchangeProblem[] = [];

      const addressed = readWorkflowId(input.workflowId);
      const workflowId = "problem" in addressed ? undefined : addressed.workflowId;
      if ("problem" in addressed) problems.push(addressed.problem);

      // The one id in this call that Anthill did not mint. It is copied onto
      // the binding and registered as the run's session, where it is compared
      // against the ids in the harness's own files — so an id that cannot
      // survive being written down is refused here, with something to read,
      // rather than quietly failing to match anything a layer or two on.
      //
      // An explicit `null` counts as not sending one, the way `readSubmission`
      // reads a null `workflowId`: senders do write it, and reading it as an
      // unusable session id would refuse a call that asked for the default.
      const given = sessionId === undefined || sessionId === null ? undefined : sessionId;
      const badSession = given === undefined ? undefined : checkSessionId(given, "sessionId");
      if (badSession) problems.push(badSession);

      // Asked again rather than cast: passing `checkSessionId` is exactly
      // `isSessionId` holding, and a cast would say so without checking.
      const session = isSessionId(given) ? given : undefined;

      const build = readBuild(input.build);
      if ("problem" in build) problems.push(build.problem);

      const exactRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1
        ? revision : undefined;
      if (exactRevision === undefined) {
        problems.push(callProblem(revision, "revision", "the revision number get_ready_revision returned",
          "A whole number of 1 or more, and that exact one: a run is bound to the content the user approved rather than to whatever is newest."));
      }

      const exactDigest = typeof digest === "string" && digest.trim() ? digest : undefined;
      if (exactDigest === undefined) {
        problems.push(callProblem(digest, "digest", "the digest get_ready_revision returned beside that revision",
          "It is what says the revision being bound is still the content that was read."));
      }

      // The length is judged here too, now that the schema no longer does it:
      // a key of any size would otherwise be written into a binding that is
      // never rewritten.
      const bindingKey = typeof idempotencyKey === "string" && idempotencyKey.trim() &&
        idempotencyKey.length <= MAX_BIND_KEY_LENGTH ? idempotencyKey : undefined;
      if (bindingKey === undefined) {
        problems.push(callProblem(idempotencyKey, "idempotencyKey",
          `a key of your own: a string of at most ${MAX_BIND_KEY_LENGTH} characters, and not a blank one`,
          "Repeat the same key and payload after a lost reply; use a new key only for an intentional new run."));
      }

      // Each value again by name rather than `problems.length`, because these
      // are what the calls below are given and a count does not narrow them.
      if (workflowId === undefined || badSession || exactRevision === undefined ||
        exactDigest === undefined || bindingKey === undefined || "problem" in build) {
        return result(bindText, {
          outcome: "invalid",
          // Named when there is one, because a caller correcting four values
          // should be able to see which handover they were correcting them
          // for. Absent when the id is what was wrong, which is the only way
          // a bind answer can carry no workflow at all.
          ...(workflowId === undefined ? {} : { workflowId }),
          ...problemFields(problems),
        });
      }
      const reach = targets.handover(build.request);
      if ("problem" in reach) {
        return result(bindText, { outcome: "invalid", workflowId, ...problemFields([reach.problem]) });
      }
      const url = reach.link(workflowId);
      const { store } = reach;
      const bound = await store.bindRequest(workflowId, exactRevision, exactDigest, bindingKey, session,
        () => ({ runId: mintRunId(), nonce: mintNonce() }));

      if (bound.outcome !== "bound" && bound.outcome !== "already_bound") {
        const refused = await incompleteRevision(store, workflowId, bound.reason, bound.revision);
        return result(bindText, {
          outcome:
            bound.outcome === "no_such_workflow"
              ? "no_such_workflow"
              : bound.outcome === "not_eligible"
                ? "not_ready"
                : "conflict",
          workflowId,
          ...(bound.outcome !== "no_such_workflow" ? { url } : {}),
          revision: exactRevision,
          ...(bound.reason ? { reason: bound.reason } : {}),
          ...problemFields(bound.problems, refused),
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
        reach.resolved ? invocation(reach.resolved) : {},
      );

      // The one place the app being up is not a convenience: nothing but a
      // running Anthill registers the run, and the reporting commands below
      // are about to start arriving for it.
      const app = await bringUp(reach, workflowId);
      return result(bindText, {
        outcome: bound.outcome,
        workflowId,
        url: app.link ?? reach.link(workflowId),
        mode: stored.identity.mode,
        revision: binding.revision,
        digest: snapshot.digest,
        runId: binding.runId,
        nonce: binding.nonce,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
        registered: false,
        registrationRequested: drop.outcome !== "conflict",
        app,
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

/** The exchange and launcher a call works with, and the target they belong to. */
type Reached = {
  store: ExchangeStore;
  launch: Launcher;
  resolved?: ResolvedTarget;
  /** The link a result gives for a workflow (see `Reach.link`): the web shell's `http://` link, `anthill://`, or none. */
  link: (workflowId: string) => string | undefined;
};

/**
 * How a call reaches its Anthill: through the chat's pinned target, or through
 * the one fixed exchange a test gave.
 *
 * A handover without a build request cannot be refused by the rule, so a
 * refusal here would be a fault; the build request that can be refused is
 * answered where it is read.
 */
function targetAccess(dependencies: HandlerDependencies): {
  handover(request: TargetRequest): Reached | { problem: ExchangeProblem };
  read(request?: TargetRequest): Reached | { problem: ExchangeProblem };
} {
  const { targets, store } = dependencies;
  const answered = (reach: ReturnType<TargetSession["handover"]>): Reached | { problem: ExchangeProblem } =>
    "refused" in reach
      ? { problem: { code: EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_INVALID, message: reach.refused, field: "build" } }
      : reach;
  if (targets) {
    return {
      handover: (request) => answered(targets.handover(request)),
      read: (request = {}) => answered(targets.read(request)),
    };
  }
  if (!store) throw new Error("createHandlers needs either targets or a store.");
  const fixed: Reached = { store, launch: dependencies.launch ?? openUrl, link: workflowUrl };
  return { handover: () => fixed, read: () => fixed };
}

/**
 * The build a handover asks for: `"dev"`, or nothing.
 *
 * Judged here for the reason every argument is: a schema that refused it
 * would answer with `isError` and a zod sentence.
 */
function readBuild(value: unknown): { request: TargetRequest } | { problem: ExchangeProblem } {
  if (value === undefined || value === null) return { request: {} };
  if (value === "dev") return { request: { build: "dev" } };
  return {
    problem: callProblem(
      value,
      "build",
      '"dev", or left out',
      "It says the user asked for the development build (--dev); leave it out for the installed Anthill.",
    ),
  };
}

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

/**
 * The workflow this call is about, or the reason it named none.
 *
 * Asked before anything is read or written, by all three tools that take an
 * id, because none of them has anything to do without one. It is judged here
 * rather than declared on the input schema for the reason the rest of this
 * file gives: a call that left the id out, or sent a number, would otherwise
 * be answered by the SDK with `isError` and a zod sentence — the one shape a
 * model cannot tell apart from the server having fallen over.
 *
 * Blank is refused along with absent. A whitespace id is not a workflow this
 * machine has never seen; it is a caller that has lost track of what it was
 * addressing, and looking it up would answer `no_such_workflow` and send it
 * away to check an id it never sent.
 *
 * The same problem, reported in two places: it is the whole of what the two
 * read-only calls can get wrong, so they answer with it alone, while `bind_run`
 * collects it with the four values beside it and refuses once.
 */
function readWorkflowId(
  value: unknown,
): { workflowId: string } | { problem: ExchangeProblem } {
  if (typeof value === "string" && value.trim().length > 0) return { workflowId: value };
  return {
    problem: callProblem(
      value,
      "workflowId",
      "a string, and not a blank one",
      "It is the workflow's own id: the `id` field of the document that was handed over, which create_workflow_draft and get_workflow both return.",
    ),
  };
}

function invalidCall(problems: readonly ExchangeProblem[]): CallAnswer {
  return { outcome: "invalid", problems: [...problems] };
}

/**
 * One argument that did not arrive, or did not arrive as the kind of thing it
 * has to be.
 *
 * Told apart the way `readSubmission` tells a missing envelope field apart
 * from a malformed one, and said in the same vocabulary: `checkSessionId`
 * already answers for one of `bind_run`'s arguments with a `SUBMISSION_FIELD_*`
 * code, and a second set of codes for the arguments beside it would make one
 * kind of mistake look like two depending on which door it came through.
 *
 * No `ask` on any of these. That field carries a question for the user, and
 * the user did not write this call.
 */
function callProblem(
  value: unknown,
  field: string,
  expected: string,
  why: string,
): ExchangeProblem {
  const absent = value === undefined || value === null;
  const head = absent
    ? `This call does not carry ${field}, which has to be ${expected}.`
    : `${field} has to be ${expected}.`;
  return {
    code: absent
      ? EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_MISSING
      : EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_INVALID,
    message: `${head} ${why}`,
    field,
  };
}

function invalidDraft(problems: readonly ExchangeProblem[], workflow?: Workflow): DraftAnswer {
  return {
    outcome: "invalid",
    problems: [...problems],
    questions: questionsFrom(problems, workflow),
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
  workflow?: Workflow,
): Partial<ReadyAnswer & BindAnswer> {
  return {
    reason: eligibility.reason,
    ...(eligibility.mode ? { mode: eligibility.mode } : {}),
    ...(eligibility.revision !== undefined ? { revision: eligibility.revision } : {}),
    ...problemFields(eligibility.problems, workflow),
  };
}

/**
 * The problems and the questions they carry.
 *
 * The workflow is passed wherever there is one, because a question about a
 * step is unanswerable without the step's name — see `questionsFrom`.
 */
function problemFields(problems: readonly ExchangeProblem[] | undefined, workflow?: Workflow): {
  problems?: ExchangeProblem[];
  questions?: string[];
} {
  if (!problems || problems.length === 0) return {};
  return { problems: [...problems], questions: questionsFrom(problems, workflow) };
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

/** "; <link> opens it" where there is a link to give, and nothing where there is none. */
function opensIt(link: string | undefined): string {
  return link ? `; ${link} opens it` : "";
}
