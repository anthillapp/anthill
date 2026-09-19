/**
 * The exchange's durable half: identity, revisions, readiness and bindings.
 *
 * A coding harness hands a workflow over; this is where it lands and stays. The
 * shape of the problem is unusual enough to be worth stating before the code.
 *
 * **Three writers, no shared lock.** The app writes here when the user approves
 * a revision or saves an edit; the MCP server writes here when a harness submits
 * a draft or binds a run. Electron's single-instance lock and the CLI's
 * `instance.lock` do not know about each other and the server is covered by
 * neither, so there is no moment at which this process can believe it is alone.
 * Every write is therefore an exclusive create, which the kernel makes atomic,
 * and `EEXIST` is the one form of contention there is. It is detected rather
 * than assumed: the file that got there first is read back, and whether it was
 * the same claim or a different one decides between a retry and a conflict.
 * Nothing is ever repaired by overwriting.
 *
 * **No index.** Head revision, readiness and bindings are all folds over a
 * directory listing. An index file would be the one thing two processes
 * genuinely had to fight over, and it would be wrong in exactly the moments —
 * two submissions at once, an app and a server both awake — that it existed to
 * describe.
 *
 * **Eligibility lives here.** Whether a revision may be worked on is decided
 * once, by this class, so the server and the app cannot answer it differently
 * in front of the same user. `show-and-go` makes the head revision eligible as
 * soon as it validates; `approval-gate` makes exactly the revision the user
 * marked ready eligible and nothing else, and there is no falling back from one
 * to the other in either direction.
 *
 * What it does not own: the working copy. `workflow.json` is an ordinary
 * workflow document that the editor opens and saves, living in this tree so a
 * deep link resolves to a path the editor already understands. The store names
 * it and never touches it.
 */

import { checkCompleteness, revisionDigest } from "@anthill/workflow-exchange";
import type {
  DraftSubmission,
  ExchangeProblem,
  HandoverMode,
  RevisionState,
} from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";

import { createExclusive, listDirectory, readTextIfPresent, removeFile } from "./disk.js";
import {
  encodeRecord,
  parseBinding,
  parseIdentity,
  parseInboxDrop,
  parseReadiness,
  parseRevision,
  type Binding,
  type InboxDrop,
  type InboxKind,
  type RevisionAuthor,
  type StoredIdentity,
  type StoredReadiness,
  type StoredRevision,
} from "./records.js";
import {
  bindingPath,
  bindingsDir,
  exchangeRoot,
  identityPath,
  inboxDoneDir,
  inboxDonePath,
  inboxDir,
  inboxPath,
  keyFromInboxFileName,
  readyPath,
  revisionFromFileName,
  revisionFromReadyFileName,
  revisionPath,
  revisionsDir,
  revisionStem,
  workingCopyPath,
} from "./paths.js";
import { EXCHANGE_STORE_PROBLEM_CODES, storeProblem } from "./problems.js";

/**
 * How many times to re-read the listing and try the next revision number.
 *
 * Each collision is one other writer getting there first, so the budget is a
 * bound on simultaneous writers rather than on retries of one write. Five is
 * far more than the two processes that exist; it is here so a pathological
 * thrash fails honestly instead of looping for ever.
 */
const MAX_REVISION_ATTEMPTS = 5;

export type CreateResult = {
  outcome:
    | "created"
    | "already_exists"
    /**
     * A different workflow already answers to this id.
     *
     * Its own outcome rather than a conflict because it is the one refusal
     * here a person can answer, and the problem carries the question: ids are
     * the document's own, a harness takes one from whatever it was editing,
     * and Anthill's own `createEmptyWorkflow` mints the constant `workflow`.
     * Two unrelated handovers arriving under that id is a naming collision
     * between two pieces of work, not a fault in either of them.
     */
    | "id_taken"
    /** Something the identity would carry for ever is not fit to be written. */
    | "refused"
    | "conflict";
  workflowId: string;
  /** The revision this submission's content is at, when it is at one. */
  revision?: number;
  /**
   * What is still missing before this may be handed to a user.
   *
   * An incomplete submission is stored rather than refused: the questions are
   * for the user, the user answers them by reading the workflow, and a draft
   * nobody can open is a draft nobody can fix. Eligibility is where
   * incompleteness stops something happening.
   *
   * The exception is anything the identity carries, which is written once and
   * is not in the document the user would edit. There the question has to be
   * answered before the workflow exists at all, and the outcome is `refused`.
   */
  problems?: ExchangeProblem[];
};

export type AddRevisionResult = {
  outcome: "added" | "unchanged" | "no_such_workflow" | "conflict";
  /** The revision now holding this content, on `added` and on `unchanged`. */
  revision?: number;
  digest?: string;
  problems?: ExchangeProblem[];
};

export type MarkReadyResult = {
  outcome: "ready" | "already_ready" | "no_such_revision" | "no_such_workflow";
  /** When the approval was recorded — the first time, on a repeat. */
  at?: string;
  problems?: ExchangeProblem[];
};

/** What a caller knows about a run at the moment it binds. */
export type BindRun = {
  runId: string;
  nonce: string;
  /**
   * The harness session the run belongs to.
   *
   * Defaults to the session that submitted the handover. It is written down
   * because a run whose only evidence is the report channel never learns one,
   * and a run with no session id can never be picked up again after it goes
   * quiet — every recovery path requires one.
   */
  sessionId?: string;
};

export type BindResult = {
  outcome: "bound" | "already_bound" | "not_eligible" | "no_such_workflow" | "conflict";
  /** The binding that holds the revision — the existing one, on a conflict. */
  binding?: Binding;
  problems?: ExchangeProblem[];
};

/**
 * Everything on disk about one workflow.
 *
 * Folded from a directory listing rather than read from an index, so it is true
 * as of the moment it was read and nothing pretends otherwise.
 */
export type ExchangeWorkflow = {
  /**
   * As asked for, and the same string the identity records.
   *
   * They cannot differ: a directory holding a workflow submitted under another
   * id that sanitises the same way is not this workflow, and nothing about it
   * is returned.
   */
  workflowId: string;
  /**
   * Who handed this over, and how.
   *
   * Absent only when `identity.json` is on disk and unreadable — the one thing
   * here that cannot be degraded around, because everything else is described
   * relative to the handover. `problems` says what happened.
   */
  identity?: StoredIdentity;
  /** The highest-numbered revision this build can read. */
  head?: StoredRevision;
  /** Every revision number present on disk, readable or not, in order. */
  revisions: number[];
  /** The highest revision the user has marked ready, if any. */
  ready?: StoredReadiness;
  bindings: Binding[];
  /** Records on disk that could not be read. One per record, and never fatal. */
  problems: ExchangeProblem[];
};

export type EligibilityRefusal =
  /** Nothing of that id has been stored here. */
  | "no_such_workflow"
  /** Something is on disk and this build cannot read it. */
  | "unreadable"
  /** The workflow exists and has no revision to work from. */
  | "no_revision"
  /** `approval-gate`, and the user has not approved anything yet. */
  | "awaiting_approval"
  /** There is a revision, and it is not something a person should be handed. */
  | "incomplete";

export type Eligibility =
  | {
      eligible: true;
      revision: StoredRevision;
      mode: HandoverMode;
      /** `bound` when a run already holds it, so the caller says the right words. */
      state: RevisionState;
    }
  | {
      eligible: false;
      reason: EligibilityRefusal;
      /** Why, in a vocabulary the caller already shows: store codes, or completeness questions. */
      problems: ExchangeProblem[];
      mode?: HandoverMode;
      /** The revision that was examined, when one was. */
      revision?: number;
    };

export type InboxDropInput = {
  kind: InboxKind;
  /** The sender's key for this request; what makes a repeat recognisable. */
  key: string;
  workflowId: string;
  revision: number;
  /** Required on a `bind`, meaningless on a `display`. */
  runId?: string;
};

export type DropInboxResult = {
  outcome: "dropped" | "already_dropped" | "conflict";
  drop?: InboxDrop;
  problems?: ExchangeProblem[];
};

export type ConsumeInboxResult = { outcome: "consumed" | "not_found" };

/**
 * Drops waiting for the app, and drops it will never be able to read.
 *
 * The damaged ones are listed rather than skipped, because skipping them means
 * re-reading the same broken file on every poll for ever. The app shows one as
 * a readable error and consumes it; nothing is repaired on its behalf.
 *
 * A drop is listed as damaged on the *second* look, never the first. Consuming
 * it is the one thing that cannot be undone — `dropInbox` answers
 * `already_dropped` for that key ever after, so the sender can never redeliver
 * the request — and a file that reads as damaged once and well the next time
 * has cost nothing but a poll.
 */
export type InboxListing = {
  drops: InboxDrop[];
  damaged: DamagedDrop[];
};

export type DamagedDrop = { key: string; problem: ExchangeProblem };

/** The refusing half of `Eligibility`, named so the two choosers can return one. */
type EligibilityRefused = Extract<Eligibility, { eligible: false }>;

export class ExchangeStore {
  /** The exchange's directory. The desktop needs it to tell a saved path from any other. */
  readonly root: string;

  /**
   * Inbox keys that failed to parse on the previous look.
   *
   * The only thing this class remembers between calls, and it is a memory
   * about *this* reader rather than about the store: a drop is reported as
   * damaged once it has failed twice, so a file caught mid-arrival is given
   * the next poll to finish rather than being handed to the app to destroy.
   * A store constructed afresh for every poll simply never reports one, which
   * is the safe direction to be wrong in — the drop stays where it is.
   */
  private damagedBefore = new Set<string>();

  /**
   * @param dataDir Anthill's user-data directory; the exchange is a directory inside it.
   * @param now The clock, injected so tests are deterministic and so a caller
   *   with a better idea of the time — one replaying a drop, say — can give it.
   */
  constructor(
    dataDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.root = exchangeRoot(dataDir);
  }

  /** Where the editor's copy of this workflow lives. The store never writes it. */
  workingCopyPath(workflowId: string): string {
    return workingCopyPath(this.root, workflowId);
  }

  /**
   * Store a handover that has not been stored before.
   *
   * Identity is claimed by creating `identity.json`, which one writer can do
   * and no writer can undo. Losing that race is not a failure: the submission
   * is compared against what is already there, and a handover that says the
   * same thing is the same handover arriving twice.
   *
   * A submission that says something *different* under a key that has already
   * been used is a conflict and stops here. The key is the sender's promise
   * that this is the same call it made before, and a store that quietly took
   * the newer content would make that promise unfalsifiable. A harness with a
   * corrected workflow is revising one that exists, which is `addRevision`.
   *
   * The id is the document's own and arrives from the harness; Anthill does not
   * mint it. So it may already be taken — `createEmptyWorkflow` calls every
   * blank document `workflow` — and that is an outcome of its own, with the
   * question to put to the user attached.
   */
  async createWorkflow(submission: DraftSubmission): Promise<CreateResult> {
    const workflowId = submission.workflow.id;

    const misaddressed = addressingProblem(submission.workflowId, workflowId);
    if (misaddressed) return { outcome: "conflict", workflowId, problems: [misaddressed] };

    const problems = checkCompleteness(submission.workflow, submission.source);

    // `taskText` goes into the identity, and the identity is written once. A
    // blank one stored here would make this workflow ineligible for as long as
    // it exists: completeness would refuse every revision of it for ever, and
    // the user could not fix it by editing, because the text they would have to
    // change is not in the document. Worse, the retry that carried the missing
    // text would be told `already_exists` with nothing wrong. It is the sender's
    // to correct, so it goes back with the question rather than onto the disk.
    if (!submission.source.taskText.trim()) {
      return { outcome: "refused", workflowId, problems };
    }

    const identity: StoredIdentity = {
      workflowId,
      createdAt: this.now(),
      idempotencyKey: submission.idempotencyKey,
      mode: submission.mode,
      exchangeVersion: submission.exchangeVersion,
      source: submission.source,
    };

    const claim = await createExclusive(identityPath(this.root, workflowId), encodeRecord(identity));
    if (claim.outcome === "existed") {
      return this.reconcileCreate(workflowId, submission, claim.text);
    }

    // The identity is ours, so revision 1 cannot be anybody else's: nothing
    // writes a revision without having claimed the identity first, and this
    // process has only just done so.
    const written = await this.writeRevision(workflowId, submission.workflow, "harness", 1);
    if (written.outcome === "retry") {
      return {
        outcome: "conflict",
        workflowId,
        problems: [
          storeProblem(
            EXCHANGE_STORE_PROBLEM_CODES.STORE_REVISION_CONFLICT,
            `Workflow ${workflowId} was created and revision 1 was already taken by other content. Nothing was overwritten.`,
          ),
        ],
      };
    }

    return {
      outcome: "created",
      workflowId,
      revision: written.revision,
      ...(problems.length > 0 ? { problems } : {}),
    };
  }

  /**
   * Add a snapshot of a workflow's content, unless it is the content already at
   * the head.
   *
   * Both halves of "editing after binding creates revision N+1" live here: a
   * save that changed nothing writes nothing, and a save that changed something
   * takes a new number rather than touching the old one. A bound revision is
   * safe for the same reason every other revision is — no path in this store
   * writes over a revision file that exists.
   *
   * Unlike `createWorkflow`, incompleteness does not stop this. The workflow
   * already exists, the revision is history, and refusing to record what
   * somebody actually saved would be losing their work to make a point about
   * validation. The completeness problems come back with the result, and
   * eligibility is where they bite.
   */
  async addRevision(
    workflowId: string,
    workflow: Workflow,
    by: RevisionAuthor,
  ): Promise<AddRevisionResult> {
    const misaddressed = addressingProblem(workflowId, workflow.id);
    if (misaddressed) return { outcome: "conflict", problems: [misaddressed] };

    const identity = await this.identityOf(workflowId);
    if (identity.outcome === "missing") return { outcome: "no_such_workflow" };
    if (identity.outcome === "elsewhere" || identity.outcome === "unreadable") {
      return { outcome: "conflict", problems: [identity.problem] };
    }

    const digest = revisionDigest(workflow);
    const problems = checkCompleteness(workflow, identity.record.source);
    const carry = problems.length > 0 ? { problems } : {};

    for (let attempt = 0; attempt < MAX_REVISION_ATTEMPTS; attempt += 1) {
      const history = await this.readRevisions(workflowId);
      if (history.head?.digest === digest) {
        return { outcome: "unchanged", revision: history.head.revision, digest, ...carry };
      }

      // The next number comes from every file present, not from the highest one
      // that parses. A damaged revision 3 still occupies the name, and choosing
      // 3 again because it could not be read would make the only copy of it the
      // one being written over.
      const next = (history.numbers.at(-1) ?? 0) + 1;
      const written = await this.writeRevision(workflowId, workflow, by, next, digest);
      if (written.outcome === "added" || written.outcome === "unchanged") {
        return { outcome: written.outcome, revision: written.revision, digest, ...carry };
      }
    }

    return {
      outcome: "conflict",
      digest,
      problems: [
        storeProblem(
          EXCHANGE_STORE_PROBLEM_CODES.STORE_REVISION_CONFLICT,
          `Another writer took every revision number this one tried for ${workflowId}. Nothing was overwritten; save again.`,
        ),
      ],
      ...carry,
    };
  }

  /**
   * Everything on disk about one workflow, or nothing when nothing of that id
   * is here.
   *
   * "Of that id" is the whole of it. A directory holding a workflow submitted
   * under a *different* id that sanitises to the same name is not this
   * workflow, and handing back its revisions, approvals and bindings would let
   * one handover read another's. Nothing is returned, because nothing of this
   * id was ever handed over; the callers that write — `bind`, `markReady`,
   * `addRevision`, `createWorkflow` — say which workflow is in the way.
   */
  async readWorkflow(workflowId: string): Promise<ExchangeWorkflow | undefined> {
    const identity = await this.identityOf(workflowId);
    if (identity.outcome === "missing" || identity.outcome === "elsewhere") return undefined;

    const problems: ExchangeProblem[] = [];
    if (identity.outcome === "unreadable") problems.push(identity.problem);

    const history = await this.readRevisions(workflowId);
    problems.push(...history.problems);

    const ready = await this.readReadiness(workflowId);
    problems.push(...ready.problems);

    const bindings = await this.readBindings(workflowId);
    problems.push(...bindings.problems);

    return {
      workflowId,
      ...(identity.outcome === "read" ? { identity: identity.record } : {}),
      ...(history.head ? { head: history.head } : {}),
      revisions: history.numbers,
      ...(ready.record ? { ready: ready.record } : {}),
      bindings: bindings.records,
      problems,
    };
  }

  /**
   * One revision, exactly as it was stored.
   *
   * The whole record rather than only the workflow inside it: the digest and
   * the author are already written down, and a caller that has to recompute a
   * digest to compare two revisions is a caller that will eventually compute it
   * differently.
   */
  async readRevision(workflowId: string, revision: number): Promise<StoredRevision | undefined> {
    const text = await readTextIfPresent(revisionPath(this.root, workflowId, revision));
    if (text === undefined) return undefined;
    const record = parseRevision(text, revisionName(workflowId, revision));
    return record.ok ? record.record : undefined;
  }

  /**
   * Record that the user approves this exact revision.
   *
   * Readiness is a file per revision rather than a field, so it cannot carry to
   * revision N+1 by being forgotten about: approving revision 1 and then
   * editing leaves revision 2 with no marker and nothing to argue with.
   *
   * The marker's existence is the claim and its contents are only the date, so
   * a second approval of the same revision is not a conflict. It is the same
   * answer given twice, and the first date is the one that is kept.
   */
  async markReady(workflowId: string, revision: number): Promise<MarkReadyResult> {
    // Presence, not readability: approving a revision is a decision about that
    // revision, and it does not need the handover's own record to be legible.
    // Whose revision it is, though, is not something to be lenient about — a
    // readable identity naming another id means this approval would land on
    // somebody else's workflow.
    const identity = await this.identityOf(workflowId);
    if (identity.outcome === "missing") return { outcome: "no_such_workflow" };
    if (identity.outcome === "elsewhere") {
      return { outcome: "no_such_workflow", problems: [identity.problem] };
    }

    const stored = await this.readRevision(workflowId, revision);
    if (!stored) return { outcome: "no_such_revision" };

    const at = this.now();
    const claim = await createExclusive(
      readyPath(this.root, workflowId, revision),
      encodeRecord({ revision, at }),
    );
    if (claim.outcome === "created") return { outcome: "ready", at };

    const held = parseReadiness(claim.text, readyName(workflowId, revision));
    return held.ok
      ? { outcome: "already_ready", ...(held.record.at ? { at: held.record.at } : {}) }
      : { outcome: "already_ready", problems: [held.problem] };
  }

  /** The highest revision the user has approved, if any. */
  async readyRevision(workflowId: string): Promise<number | undefined> {
    return (await this.readReadiness(workflowId)).record?.revision;
  }

  /**
   * The revision that may be worked on, under the mode this handover was
   * recorded with.
   *
   * The single place that question is answered, for both programs. The two
   * modes do not borrow from each other: `approval-gate` never falls back to
   * the head revision because the user has not got round to approving it, and
   * `show-and-go` never waits for an approval it was never going to be given.
   *
   * Completeness is checked under both. Readiness says a person approved the
   * content; it does not say the diagram can be compiled into a prompt, and
   * handing an agent one that cannot be is not something a user's approval can
   * authorise.
   */
  async eligibleRevision(workflowId: string): Promise<Eligibility> {
    const workflow = await this.readWorkflow(workflowId);
    if (!workflow) {
      return {
        eligible: false,
        reason: "no_such_workflow",
        problems: [unknownWorkflow(workflowId)],
      };
    }

    const identity = workflow.identity;
    if (!identity) return { eligible: false, reason: "unreadable", problems: workflow.problems };

    const mode = identity.mode;
    const chosen =
      mode === "approval-gate"
        ? await this.approvedRevision(workflowId, workflow)
        : this.headRevision(workflow, workflowId);
    if ("refusal" in chosen) return { ...chosen.refusal, mode };

    const problems = checkCompleteness(chosen.revision.workflow, identity.source);
    if (problems.length > 0) {
      return {
        eligible: false,
        reason: "incomplete",
        mode,
        revision: chosen.revision.revision,
        problems,
      };
    }

    const bound = workflow.bindings.some(
      (binding) => binding.revision === chosen.revision.revision,
    );
    return { eligible: true, revision: chosen.revision, mode, state: bound ? "bound" : "ready_for_agent" };
  }

  /**
   * Bind a run to a revision, exclusively.
   *
   * The gate is enforced here rather than trusted to the caller, because the
   * caller is the MCP server and the whole point of recording a mode is that a
   * harness cannot decide later that it would rather not wait. A bind naming a
   * revision that is not the eligible one is refused with both numbers said out
   * loud.
   *
   * The run id is the file name, so a second bind of the same run is the same
   * `EEXIST` question as everything else: the same revision and nonce is the
   * same bind arriving twice, and anything else is a conflict, with the
   * existing binding returned rather than replaced.
   */
  async bind(workflowId: string, revision: number, run: BindRun): Promise<BindResult> {
    // Before anything else: whose workflow this is. The binding is written from
    // the identity, so an identity that cannot be read or that belongs to
    // another id is the end of it rather than something to work around.
    const identity = await this.identityOf(workflowId);
    if (identity.outcome === "missing") {
      return {
        outcome: "no_such_workflow",
        problems: [unknownWorkflow(workflowId)],
      };
    }
    if (identity.outcome === "elsewhere") {
      return { outcome: "no_such_workflow", problems: [identity.problem] };
    }
    if (identity.outcome === "unreadable") {
      return { outcome: "not_eligible", problems: [identity.problem] };
    }

    const eligible = await this.eligibleRevision(workflowId);
    if (!eligible.eligible) {
      return {
        outcome: eligible.reason === "no_such_workflow" ? "no_such_workflow" : "not_eligible",
        problems: eligible.problems,
      };
    }

    if (eligible.revision.revision !== revision) {
      return {
        outcome: "not_eligible",
        problems: [
          storeProblem(
            EXCHANGE_STORE_PROBLEM_CODES.STORE_REVISION_NOT_ELIGIBLE,
            `Revision ${revision} of ${workflowId} cannot be bound: under ${eligible.mode} the revision to work from is ${eligible.revision.revision}.`,
          ),
        ],
      };
    }

    const sessionId = run.sessionId ?? identity.record.source.sessionId;
    const binding: Binding = {
      runId: run.runId,
      // The id the identity records, not the string the caller addressed this
      // with. The two differ when a caller's spelling merely sanitises to the
      // same directory, and this field is how a run is tied to the document the
      // user has open — the live session page matches runs against the open
      // document's own id, so a run filed under a near-miss is invisible.
      workflowId: identity.record.workflowId,
      revision,
      nonce: run.nonce,
      at: this.now(),
      ...(sessionId ? { sessionId } : {}),
    };

    const claim = await createExclusive(
      bindingPath(this.root, workflowId, run.runId),
      encodeRecord(binding),
    );
    if (claim.outcome === "created") return { outcome: "bound", binding };

    const held = parseBinding(claim.text, bindingName(workflowId, run.runId));
    if (!held.ok) return { outcome: "conflict", problems: [held.problem] };

    // Two runs, one file. Run ids become a file name through the same
    // sanitising as workflow ids, so `ANT-1/a` and `ANT-1:a` collide, and
    // reporting that as "this run is already bound" would send the caller
    // looking for a binding its run does not have. The identity path diagnoses
    // its own version of this collision precisely; so does this one.
    if (held.record.runId !== run.runId) {
      return {
        outcome: "conflict",
        binding: held.record,
        problems: [
          storeProblem(
            EXCHANGE_STORE_PROBLEM_CODES.STORE_BINDING_CONFLICT,
            `Run ${run.runId} cannot be bound to ${identity.record.workflowId}: run ${held.record.runId} already occupies the file both ids become. Nothing was overwritten.`,
          ),
        ],
      };
    }

    if (held.record.revision === revision && held.record.nonce === run.nonce) {
      return { outcome: "already_bound", binding: held.record };
    }

    // The holder is the binding on disk, not the caller: naming the asking run
    // as the one already bound reads as though it were arguing with itself.
    // The nonce is named as well as the revision, because a bind that differs
    // only in nonce is a second run wearing the first one's id, and a message
    // about revisions alone would say the two sides agree.
    return {
      outcome: "conflict",
      binding: held.record,
      problems: [
        storeProblem(
          EXCHANGE_STORE_PROBLEM_CODES.STORE_BINDING_CONFLICT,
          `Run ${held.record.runId} is already bound to revision ${held.record.revision} of ${held.record.workflowId} under nonce ${held.record.nonce}; this bind asked for revision ${revision} under nonce ${run.nonce}. The existing binding is unchanged.`,
        ),
      ],
    };
  }

  async readBinding(workflowId: string, runId: string): Promise<Binding | undefined> {
    const text = await readTextIfPresent(bindingPath(this.root, workflowId, runId));
    if (text === undefined) return undefined;
    const record = parseBinding(text, bindingName(workflowId, runId));
    return record.ok ? record.record : undefined;
  }

  /**
   * Everything waiting for the app, oldest first.
   *
   * Only `*.json`, and nothing inside `done/`. The atomic-write pattern used
   * everywhere else in Anthill leaves `<name>.<pid>.<seq>.tmp` beside its
   * target, and a reader that took every file in the directory would sooner or
   * later read half of one and act on it.
   *
   * A key that already has a copy in `done/` is skipped whatever is still in
   * `inbox/`. Consuming a drop is a create followed by an unlink, so a process
   * that dies between the two leaves the drop where it was, and a reader that
   * took the directory at face value would hand the app a request it has
   * already carried out. `dropInbox` consults `done/` so the sender is
   * idempotent across that crash; this is the same courtesy for the receiver.
   */
  async listInbox(): Promise<InboxListing> {
    const drops: InboxDrop[] = [];
    const damaged: DamagedDrop[] = [];
    const settled = new Set(await listDirectory(inboxDoneDir(this.root)));
    const unreadable = new Set<string>();

    for (const name of await listDirectory(inboxDir(this.root))) {
      const key = keyFromInboxFileName(name);
      if (key === undefined) continue;
      if (settled.has(name)) continue;
      const text = await readTextIfPresent(inboxPath(this.root, key));
      if (text === undefined) continue;

      const drop = parseInboxDrop(text, `inbox/${name}`);
      if (drop.ok) {
        drops.push(drop.record);
        continue;
      }

      unreadable.add(key);
      if (this.damagedBefore.has(key)) damaged.push({ key, problem: drop.problem });
    }

    // Only the keys still failing are remembered, so a drop that reads badly
    // once and well afterwards leaves nothing behind.
    this.damagedBefore = unreadable;

    drops.sort(
      (left, right) => left.at.localeCompare(right.at) || left.key.localeCompare(right.key),
    );
    return { drops, damaged };
  }

  /**
   * Ask the app to do something with a workflow.
   *
   * A request whose key has already been handled is not dropped again: `done/`
   * is checked first, so a server that drops a request, loses its answer and
   * drops it again does not make the app open the same workflow twice.
   */
  async dropInbox(input: InboxDropInput): Promise<DropInboxResult> {
    const settled = await readTextIfPresent(inboxDonePath(this.root, input.key));
    if (settled !== undefined) {
      const done = parseInboxDrop(settled, `inbox/done/${input.key}.json`);
      return { outcome: "already_dropped", ...(done.ok ? { drop: done.record } : {}) };
    }

    const drop: InboxDrop = {
      kind: input.kind,
      key: input.key,
      workflowId: input.workflowId,
      revision: input.revision,
      at: this.now(),
      ...(input.runId ? { runId: input.runId } : {}),
    };

    const claim = await createExclusive(inboxPath(this.root, input.key), encodeRecord(drop));
    if (claim.outcome === "created") return { outcome: "dropped", drop };

    const held = parseInboxDrop(claim.text, `inbox/${input.key}.json`);
    if (!held.ok) return { outcome: "conflict", problems: [held.problem] };

    const sameRequest =
      held.record.kind === drop.kind &&
      held.record.workflowId === drop.workflowId &&
      held.record.revision === drop.revision &&
      held.record.runId === drop.runId;
    if (sameRequest) return { outcome: "already_dropped", drop: held.record };

    return {
      outcome: "conflict",
      drop: held.record,
      problems: [
        storeProblem(
          EXCHANGE_STORE_PROBLEM_CODES.STORE_INBOX_CONFLICT,
          `Inbox key ${input.key} is already taken by a ${held.record.kind} request for revision ${held.record.revision} of ${held.record.workflowId}. Nothing was overwritten.`,
        ),
      ],
    };
  }

  /**
   * Take a drop out of the inbox, keeping a copy so a repeat is recognisable.
   *
   * A create followed by an unlink rather than a rename: a rename would replace
   * whatever `done/` already held under that key, and this store does not
   * replace files. `done/` is a record of what has been seen rather than a
   * second source of truth, so an entry already there is accepted as it stands.
   */
  async consumeInbox(key: string): Promise<ConsumeInboxResult> {
    const text = await readTextIfPresent(inboxPath(this.root, key));
    if (text === undefined) {
      const settled = await readTextIfPresent(inboxDonePath(this.root, key));
      return settled === undefined ? { outcome: "not_found" } : { outcome: "consumed" };
    }

    await createExclusive(inboxDonePath(this.root, key), text);
    await removeFile(inboxPath(this.root, key));
    return { outcome: "consumed" };
  }

  /* ---------------------------------------------------------------- */
  /* Choosing a revision                                               */
  /* ---------------------------------------------------------------- */

  private async approvedRevision(
    workflowId: string,
    workflow: ExchangeWorkflow,
  ): Promise<{ revision: StoredRevision } | { refusal: EligibilityRefused }> {
    const approved = workflow.ready?.revision;
    if (approved === undefined) {
      return {
        refusal: {
          eligible: false,
          reason: "awaiting_approval",
          problems: [
            storeProblem(
              EXCHANGE_STORE_PROBLEM_CODES.STORE_AWAITING_APPROVAL,
              "This handover waits for the user to approve a revision, and none has been approved yet.",
            ),
          ],
        },
      };
    }

    const revision = await this.readRevision(workflowId, approved);
    if (!revision) {
      return {
        refusal: {
          eligible: false,
          reason: "unreadable",
          revision: approved,
          problems: [
            storeProblem(
              EXCHANGE_STORE_PROBLEM_CODES.STORE_REVISION_UNKNOWN,
              `Revision ${approved} of ${workflowId} was approved and cannot be read back.`,
            ),
          ],
        },
      };
    }

    return { revision };
  }

  private headRevision(
    workflow: ExchangeWorkflow,
    workflowId: string,
  ): { revision: StoredRevision } | { refusal: EligibilityRefused } {
    if (workflow.head) return { revision: workflow.head };
    return {
      refusal: {
        eligible: false,
        // Telling "nothing has been submitted yet" apart from "everything that
        // was submitted is damaged" matters: one is waiting, the other is a
        // loss somebody has to be told about.
        reason: workflow.revisions.length > 0 ? "unreadable" : "no_revision",
        problems:
          workflow.problems.length > 0
            ? workflow.problems
            : [
                storeProblem(
                  EXCHANGE_STORE_PROBLEM_CODES.STORE_REVISION_UNKNOWN,
                  `Workflow ${workflowId} has no revision to work from.`,
                ),
              ],
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Reading a directory into records                                  */
  /* ---------------------------------------------------------------- */

  private async readRevisions(workflowId: string): Promise<{
    numbers: number[];
    head?: StoredRevision;
    problems: ExchangeProblem[];
  }> {
    const numbers: number[] = [];
    for (const name of await listDirectory(revisionsDir(this.root, workflowId))) {
      const revision = revisionFromFileName(name);
      if (revision !== undefined) numbers.push(revision);
    }
    numbers.sort((left, right) => left - right);

    // Head is the highest that can be *read*, which is not always the highest
    // that exists. Walking down from the top means a damaged snapshot costs
    // that snapshot and leaves the workflow with the last good one rather than
    // with nothing. Revisions below the head are not opened at all: this runs
    // on every poll, and a history is read on request, not on sight.
    const problems: ExchangeProblem[] = [];
    let head: StoredRevision | undefined;
    for (const revision of [...numbers].reverse()) {
      const text = await readTextIfPresent(revisionPath(this.root, workflowId, revision));
      if (text === undefined) continue;
      const record = parseRevision(text, revisionName(workflowId, revision));
      if (record.ok) {
        head = record.record;
        break;
      }
      problems.push(record.problem);
    }

    return { numbers, ...(head ? { head } : {}), problems };
  }

  private async readReadiness(workflowId: string): Promise<{
    record?: StoredReadiness;
    problems: ExchangeProblem[];
  }> {
    const numbers: number[] = [];
    for (const name of await listDirectory(revisionsDir(this.root, workflowId))) {
      const revision = revisionFromReadyFileName(name);
      if (revision !== undefined) numbers.push(revision);
    }
    // Highest revision first: several markers mean the user approved more than
    // once, and the approval that stands is the one for the newest content
    // rather than the one made most recently. The two part company when
    // somebody approves an older revision after a newer one, and the revision
    // number is the better answer — it is the order the content was written
    // in, which is a fact about this store, where the dates come from two
    // processes' clocks and need not agree with each other.
    numbers.sort((left, right) => right - left);

    const problems: ExchangeProblem[] = [];
    for (const revision of numbers) {
      const text = await readTextIfPresent(readyPath(this.root, workflowId, revision));
      if (text === undefined) continue;
      const record = parseReadiness(text, readyName(workflowId, revision));
      if (record.ok) return { record: record.record, problems };
      // The marker's name is the approval; only its date is lost.
      problems.push(record.problem);
      return { record: { revision }, problems };
    }

    return { problems };
  }

  private async readBindings(workflowId: string): Promise<{
    records: Binding[];
    problems: ExchangeProblem[];
  }> {
    const records: Binding[] = [];
    const problems: ExchangeProblem[] = [];
    for (const name of await listDirectory(bindingsDir(this.root, workflowId))) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      // The file name is a sanitised run id, and sanitising it again is the
      // identity, so this addresses the same file the listing produced.
      const runId = name.slice(0, -".json".length);
      const text = await readTextIfPresent(bindingPath(this.root, workflowId, runId));
      if (text === undefined) continue;
      const record = parseBinding(text, bindingName(workflowId, runId));
      if (record.ok) records.push(record.record);
      else problems.push(record.problem);
    }
    records.sort(
      (left, right) => left.at.localeCompare(right.at) || left.runId.localeCompare(right.runId),
    );
    return { records, problems };
  }

  /* ---------------------------------------------------------------- */
  /* Writing                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Try to put this content at one specific revision number.
   *
   * `retry` is not an outcome any caller sees: it means the number was taken by
   * something else, and the only correct response is to re-read the listing and
   * take the next one, which `addRevision` does.
   */
  private async writeRevision(
    workflowId: string,
    workflow: Workflow,
    by: RevisionAuthor,
    revision: number,
    knownDigest?: string,
  ): Promise<
    | { outcome: "added"; revision: number; digest: string }
    | { outcome: "unchanged"; revision: number; digest: string }
    | { outcome: "retry" }
  > {
    const digest = knownDigest ?? revisionDigest(workflow);
    const record: StoredRevision = { revision, createdAt: this.now(), by, digest, workflow };

    const claim = await createExclusive(
      revisionPath(this.root, workflowId, revision),
      encodeRecord(record),
    );
    if (claim.outcome === "created") return { outcome: "added", revision, digest };

    const held = parseRevision(claim.text, revisionName(workflowId, revision));
    if (!held.ok) return { outcome: "retry" };
    // Another writer put the same content at this number first. That is the
    // revision this caller wanted; nothing was added and nothing was lost.
    if (held.record.digest === digest) return { outcome: "unchanged", revision, digest };
    return { outcome: "retry" };
  }

  /**
   * Decide what an identity that already exists means for this submission.
   *
   * Three answers, and the differences between them matter to the sender: the
   * same handover arriving twice, a different handover claiming a name that is
   * taken, and two different ids that become the same directory name.
   */
  private async reconcileCreate(
    workflowId: string,
    submission: DraftSubmission,
    text: string,
  ): Promise<CreateResult> {
    const held = parseIdentity(text, `${workflowId}/identity.json`);
    if (!held.ok) return { outcome: "conflict", workflowId, problems: [held.problem] };

    if (held.record.workflowId !== workflowId) {
      return {
        outcome: "id_taken",
        workflowId,
        problems: [
          takenProblem(
            workflowId,
            `Workflow ${workflowId} cannot be stored: ${held.record.workflowId} already occupies the same directory. The two ids differ only in characters a directory name cannot carry.`,
          ),
        ],
      };
    }

    if (held.record.idempotencyKey !== submission.idempotencyKey) {
      return {
        outcome: "id_taken",
        workflowId,
        problems: [
          takenProblem(
            workflowId,
            `Workflow ${workflowId} was handed over by an earlier submission (key ${held.record.idempotencyKey}); this one carries key ${submission.idempotencyKey}. Nothing was overwritten. Revise the workflow that exists, or hand this one over under an id of its own.`,
          ),
        ],
      };
    }

    // What is missing is asked of the handover that is *stored*, not of the one
    // that has just arrived. `taskText` lives in the identity and the identity
    // is written once, so this submission's copy of it describes a handover
    // that may not be the one on disk — and an `already_exists` that reported
    // no problems because the arriving copy was fine would be telling the
    // sender that a workflow it can never make eligible is in good order.
    const problems = checkCompleteness(submission.workflow, held.record.source);

    // The same key, so this claims to be the same call. It is only the same
    // call if it says the same thing: revision 1 is what that key created, and
    // content that does not match it is a sender contradicting itself.
    const digest = revisionDigest(submission.workflow);
    const first = await this.readRevision(workflowId, 1);
    if (!first) {
      // The identity was written and the first revision was not — a process
      // that died between two creates. Finishing it is creating a file that
      // does not exist, not repairing one that does.
      const written = await this.writeRevision(workflowId, submission.workflow, "harness", 1, digest);
      if (written.outcome === "retry") {
        return {
          outcome: "conflict",
          workflowId,
          problems: [
            storeProblem(
              EXCHANGE_STORE_PROBLEM_CODES.STORE_REVISION_CONFLICT,
              `Workflow ${workflowId} exists with no readable first revision, and one could not be written.`,
            ),
          ],
        };
      }
      return {
        outcome: "already_exists",
        workflowId,
        revision: written.revision,
        ...(problems.length > 0 ? { problems } : {}),
      };
    }

    if (first.digest !== digest) {
      return {
        outcome: "conflict",
        workflowId,
        problems: [
          storeProblem(
            EXCHANGE_STORE_PROBLEM_CODES.STORE_IDENTITY_CONFLICT,
            `Key ${submission.idempotencyKey} created revision 1 of ${workflowId} from different content (${first.digest} against ${digest}). A repeat of a handover has to say the same thing; a changed workflow is a revision of this one.`,
            { field: "idempotencyKey" },
          ),
        ],
      };
    }

    return {
      outcome: "already_exists",
      workflowId,
      revision: first.revision,
      ...(problems.length > 0 ? { problems } : {}),
    };
  }

  /**
   * The handover this id belongs to, if this id is the one it belongs to.
   *
   * `elsewhere` is the case every caller that addresses a workflow by id has to
   * know about. Ids arrive from a harness and become a directory name through
   * `safeSegment`, which is not injective: `a/b` and `a:b` are two workflows
   * and one directory. The id a record was submitted under is written down in
   * it, so the check is a string comparison — and without it the second id
   * would read, approve and bind the first one's workflow while every answer
   * looked ordinary.
   */
  private async identityOf(
    workflowId: string,
  ): Promise<
    | { outcome: "read"; record: StoredIdentity }
    | { outcome: "missing" }
    | { outcome: "elsewhere"; problem: ExchangeProblem }
    | { outcome: "unreadable"; problem: ExchangeProblem }
  > {
    const text = await readTextIfPresent(identityPath(this.root, workflowId));
    if (text === undefined) return { outcome: "missing" };

    const record = parseIdentity(text, `${workflowId}/identity.json`);
    if (!record.ok) return { outcome: "unreadable", problem: record.problem };

    if (record.record.workflowId !== workflowId) {
      return {
        outcome: "elsewhere",
        problem: takenProblem(
          workflowId,
          `Workflow ${workflowId} is not stored here: ${record.record.workflowId} occupies the directory both ids become. The two differ only in characters a directory name cannot carry, and nothing of ${workflowId} has been handed over.`,
        ),
      };
    }

    return { outcome: "read", record: record.record };
  }
}

/** Nothing of that id is here, said the same way wherever it is discovered. */
function unknownWorkflow(workflowId: string): ExchangeProblem {
  return storeProblem(
    EXCHANGE_STORE_PROBLEM_CODES.STORE_WORKFLOW_UNKNOWN,
    `No workflow ${workflowId} has been handed over to this Anthill.`,
  );
}

/**
 * An id that belongs to somebody else's workflow.
 *
 * The one refusal in this store that carries an `ask`. A workflow id is the
 * document's own and the harness brings it — Anthill assigns nothing — so two
 * unrelated pieces of work can arrive under one name, and the only person who
 * can say which is which is the user who asked for them.
 */
function takenProblem(workflowId: string, message: string): ExchangeProblem {
  return storeProblem(EXCHANGE_STORE_PROBLEM_CODES.STORE_WORKFLOW_ID_TAKEN, message, {
    field: "workflow.id",
    ask: `Anthill already has a different piece of work filed under the name ${workflowId}. What should this one be called, so the two do not land on top of each other?`,
  });
}

/**
 * A submission has to address the document it carries.
 *
 * The exchange's workflow id and the document's own `id` are the same string
 * from the first submission onward, because that is how a run is tied to what
 * the user has open: the live session page matches runs against the open
 * document's id, and a run filed under anything else is invisible everywhere.
 */
function addressingProblem(
  addressed: string | undefined,
  carried: string,
): ExchangeProblem | undefined {
  if (addressed === undefined || addressed === carried) return undefined;
  return storeProblem(
    EXCHANGE_STORE_PROBLEM_CODES.STORE_WORKFLOW_ID_MISMATCH,
    `This is addressed to workflow ${addressed} and carries a document whose id is ${carried}. They have to be the same string, or the run that follows cannot be tied to what the user has open.`,
    { field: "workflowId" },
  );
}

/* The names a problem points at: what a person would call the file, not its path. */

function revisionName(workflowId: string, revision: number): string {
  return `${workflowId}/revisions/${revisionStem(revision)}.json`;
}

function readyName(workflowId: string, revision: number): string {
  return `${workflowId}/revisions/${revisionStem(revision)}.ready`;
}

function bindingName(workflowId: string, runId: string): string {
  return `${workflowId}/bindings/${runId}.json`;
}
