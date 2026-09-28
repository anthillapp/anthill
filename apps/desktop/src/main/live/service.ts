/**
 * Passive observation, and nothing else.
 *
 * This service has no way to start an agent. It polls the files the user's own
 * CLIs write, folds what it finds through the pure state machine in
 * `@anthill/live`, and tells the renderer what it now knows. There is no start,
 * stop, attach, or approve anywhere in it, because Anthill does not have those
 * powers over a session it did not launch and must not pretend otherwise.
 *
 * Polling rather than filesystem subscriptions: the interesting files live in directories the
 * user's tools create and rotate, and a poll that only stats files whose date
 * could possibly be relevant is both simpler and harder to get wrong than a
 * tree of file watchers. It runs only while at least one run is still open, so an
 * idle Anthill does no filesystem work at all.
 *
 * A run Anthill lost is not quite idle. Its record on disk may start growing
 * again — the person stopped the session and resumed it an hour later, say —
 * and for as long as the record is kept, it is looked at again at a slower
 * cadence and picked back up by itself when it does (ANT-65). Only reading,
 * as ever: nothing is sent to the session to find out.
 */

import {
  type ObservationEvent,
  CLI_LABEL,
  TIMING,
  applyEvidence,
  boundSessionId,
  createPendingRun,
  expireIfStale,
  hasGoneQuiet,
  isOpen,
  isRecoverable,
  isVisible,
  reopenForAnotherLook,
  stopObserving,
  resumeFromEvidence,
  type Evidence,
  type MarkerCli,
  type PendingRun,
  type RunStep,
} from "@anthill/live";

import { ClaudeCodeObserver } from "./observers/claude-code.js";
import { CliReportObserver } from "./observers/cli-report.js";
import {
  endingNotices,
  forgetAnnounced,
  noticesFor,
  type AnnouncedSteps,
  type StepNotice,
} from "./step-notices.js";
import { isEnding } from "./workflow-status.js";
import { CodexObserver } from "./observers/codex.js";
import { PiObserver } from "./observers/pi.js";
import { HookLogObserver } from "./observers/hooks.js";
import type {
  LiveSessionObserver,
  ObservationEventDraft,
  ObserverCapabilities,
} from "./observers/types.js";
import { ObservationJournal } from "./journal.js";
import { PendingRunStore } from "./store.js";
import { claudeDesktopSessionsRoot, resolveClaudeSession } from "./claude-session.js";

/** How often open runs are looked at. Fast enough to feel automatic. */
const POLL_MS = 2_000;

/**
 * How often a run Anthill has stopped watching is checked for signs of life.
 *
 * Slower on purpose. A lost run is kept for a day, and a session that comes
 * back after an hour away does not need to be noticed within two seconds of
 * doing so; a stat of a few files every half-minute over a day is nothing,
 * and every two seconds over a day is a great deal of nothing.
 */
export const RECOVERY_POLL_MS = 30_000;

export type LiveSessionSnapshot = {
  runs: PendingRun[];
  capabilities: ObserverCapabilities[];
  storageError?: string;
};

export type StartObservationInput = {
  anthillRunId: string;
  correlationNonce: string;
  selectedCli: MarkerCli;
  promptVersion: string;
  bootstrapPromptHash: string;
  workflowId?: string;
  workflowName?: string;
  /** The steps the marker named, so a transition can be reported in words. */
  steps?: RunStep[];
};

/** Where each CLI keeps its records. Overridable so the service is testable. */
export type ObservationRoots = {
  claudeRoot?: string;
  claudeDesktopRoot?: string;
  codexRoot?: string;
  piRoot?: string;
  hookLogPath?: string;
  reportLogPath?: string;
  journalDir?: string;
};

export class LiveSessionService {
  private readonly observers: Record<MarkerCli, LiveSessionObserver>;
  private readonly hooks: HookLogObserver;
  private readonly reports: CliReportObserver;
  private readonly journal: ObservationJournal;
  private readonly claudeDesktopRoot: string | undefined;
  private readonly sessionLookups = new Map<string, number>();
  private readonly sessionsSeen = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private capabilities: ObserverCapabilities[] = [];
  private polling = false;
  /** When lost runs were last checked, in epoch ms. Zero means never. */
  private recoveryLookedAt = 0;
  /** The step each run has already been announced as reaching. See step-notices.ts. */
  private readonly announced: AnnouncedSteps = new Map();
  /** Sessions already noted as carrying a bound run's marker, per run. */
  private readonly mismatched = new Map<string, Set<string>>();
  private readonly storageErrors = new Map<string, string>();

  constructor(
    private readonly store: PendingRunStore,
    private readonly publish: (snapshot: LiveSessionSnapshot) => void,
    private readonly now: () => string = () => new Date().toISOString(),
    roots: ObservationRoots = {},
    /** Told when a run's observed activity grew, so the page can catch up. */
    private readonly publishEvents: (runId: string, events: ObservationEvent[]) => void = () => undefined,
    /**
     * Where a step transition worth interrupting someone for is handed off to.
     *
     * Injected, and deliberately not `Notification` itself: whether one is
     * wanted is a preference this service has no business reading, and
     * delivering one is a platform's business rather than an observer's.
     */
    private readonly onStepNotice: (notice: StepNotice) => void = () => undefined,
    /**
     * Told when a run reaches an ending, so it can be written down somewhere
     * that outlives the run.
     *
     * The live store is a working set and drops a settled run a day later; a
     * workflow's last known outcome has to survive that, or every row on the
     * launch window turns grey a day after it was last used (ANT-84).
     */
    private readonly onSettled: (run: PendingRun) => void = () => undefined,
  ) {
    // An injected transcript root must never fall through to the user's metadata.
    this.claudeDesktopRoot = roots.claudeDesktopRoot ?? (roots.claudeRoot ? undefined : claudeDesktopSessionsRoot());
    this.observers = {
      "claude-code": roots.claudeRoot
        ? new ClaudeCodeObserver(roots.claudeRoot)
        : new ClaudeCodeObserver(),
      codex: roots.codexRoot ? new CodexObserver(roots.codexRoot) : new CodexObserver(),
      pi: roots.piRoot ? new PiObserver(roots.piRoot) : new PiObserver(),
    };
    this.hooks = roots.hookLogPath ? new HookLogObserver(roots.hookLogPath) : new HookLogObserver();
    this.reports = roots.reportLogPath
      ? new CliReportObserver(roots.reportLogPath)
      : new CliReportObserver();
    this.journal = new ObservationJournal(roots.journalDir ?? "");
  }

  /** Everything observed for one run, oldest first. The page folds this. */
  async events(runId: string): Promise<ObservationEvent[]> {
    return this.journal.tail(runId);
  }

  /** Read what was left behind and resume observing anything still open. */
  async start(): Promise<LiveSessionSnapshot> {
    await this.store.load(this.now());
    this.capabilities = await Promise.all(
      Object.values(this.observers).map((observer) => observer.detectCapabilities()),
    );
    this.schedule();
    return this.snapshot();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): LiveSessionSnapshot {
    return {
      runs: this.store.all().filter(isVisible),
      capabilities: this.capabilities,
      ...(this.storageErrors.size ? { storageError: [...this.storageErrors.values()][0] } : {}),
    };
  }

  registered(runId: string): PendingRun | undefined {
    return this.store.find(runId);
  }

  /** Register an external binding without manufacturing match evidence. */
  async registerBinding(input: StartObservationInput & { exchange: NonNullable<PendingRun["exchange"]>; boundAt: string }): Promise<boolean> {
    await this.start();
    const existing = this.store.find(input.anthillRunId);
    if (existing) {
      return existing.workflowId === input.workflowId && existing.correlationNonce === input.correlationNonce &&
        existing.selectedCli === input.selectedCli && existing.exchange?.revision === input.exchange.revision &&
        existing.exchange?.digest === input.exchange.digest && existing.exchange?.sessionId === input.exchange.sessionId;
    }
    const run: PendingRun = {
      ...createPendingRun({ ...input, now: input.boundAt }),
      exchange: input.exchange,
      ...(input.exchange.sessionId ? { detectedSessionId: input.exchange.sessionId } : {}),
      statusMessage: "Revision bound. Waiting for evidence from the external session.",
    };
    await this.store.put(run, true);
    this.schedule();
    await this.poll();
    this.announce();
    return true;
  }

  /**
   * Begin observing a prompt the user is about to copy.
   *
   * Called before the text reaches the clipboard, so the record exists whatever
   * happens next — including the app closing between the copy and the paste.
   *
   * Which is exactly why the write has to be durable. That sentence was the
   * whole promise and the write did not keep it: a failure was swallowed, the
   * run sat in memory, Copy Prompt reported success, and the observation the
   * user had been told about was gone at the next launch (ANT-97). Raising
   * here means the copy is refused rather than the record being lost.
   */
  async startObservation(input: StartObservationInput): Promise<LiveSessionSnapshot> {
    const run = createPendingRun({ ...input, now: this.now() });
    await this.store.put(run, true);
    this.schedule();
    // Look immediately, and wait for it: a prompt copied a moment ago may
    // already have produced a session, and the caller should be told about it
    // in the answer rather than in a push a beat later.
    await this.poll();
    // Pushed as well as returned. The caller is the Prompt modal, but the thing
    // that has to react is the header indicator somewhere else in the tree, and
    // a poll that finds nothing new would otherwise never tell it.
    return this.announce();
  }

  /**
   * Stop Anthill's observation. This affects Anthill only.
   *
   * Nothing is signalled to the user's session — Anthill has no connection to
   * it and no business ending it. The record is dropped and the indicator goes.
   */
  async cancelObservation(runId: string): Promise<LiveSessionSnapshot> {
    const run = this.store.find(runId);
    /*
      A run that found its session keeps what was read: the button says only
      Anthill stops observing, and deleting the record made the run the author
      had just been watching unreachable — the workflow's chip then opened an
      older run in its place (ANT-191). It is closed and never picked back up.
    */
    if (run && run.detectedSessionId) {
      const stopped = stopObserving(run, this.now());
      await this.store.put(stopped, true);
      this.storageErrors.delete(runId);
      this.forget(runId);
      // Its row on the launch window says so, as any other ending would.
      this.onSettled(stopped);
      return this.announce();
    }
    // A copy no session ever carried has nothing to keep.
    await this.store.remove(runId, true);
    this.storageErrors.delete(runId);
    this.forget(runId);
    await this.journal.forget(runId);
    return this.announce();
  }

  /**
   * Look at a lost run's session records again.
   *
   * Reading, and only reading: the observers drop their positions and re-scan
   * the whole record from the top — the journal de-duplicates, so a re-read
   * adds nothing twice — and matching re-runs at the same tiers it always
   * uses. Nothing is sent to the session; it never knew Anthill existed.
   */
  async lookAgain(runId: string): Promise<LiveSessionSnapshot> {
    const run = this.store.find(runId);
    const reopened = run && reopenForAnotherLook(run, this.now());
    if (!reopened) return this.snapshot();

    this.forget(runId);
    await this.store.put(reopened, true);
    this.schedule();
    // Look now, and wait for it: the author pressed a button that says
    // "look", and the answer should be in the response, not in a push later.
    await this.poll();
    return this.announce();
  }

  /** Hide a settled run without forgetting it was there. */
  async dismiss(runId: string): Promise<LiveSessionSnapshot> {
    const run = this.store.find(runId);
    if (run) await this.store.put({ ...run, dismissedAt: this.now() }, true);
    // Put away is put away: a dismissed run is not looked at again, so there
    // is no reason to remember where its records were read to.
    this.forget(runId);
    return this.announce();
  }

  /** Drop every observer's place in this run's records. */
  private forget(runId: string): void {
    for (const observer of Object.values(this.observers)) observer.forget(runId);
    this.hooks.forget(runId);
    this.reports.forget(runId);
    forgetAnnounced(this.announced, runId);
    this.mismatched.delete(runId);
    this.sessionsSeen.delete(runId);
    this.sessionLookups.delete(runId);
  }

  /** Tell everyone what is now true, and hand the same thing back. */
  private announce(): LiveSessionSnapshot {
    const snapshot = this.snapshot();
    this.publish(snapshot);
    return snapshot;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    // Never hold the process open for a poll loop.
    this.timer.unref?.();
  }

  /** One pass over every open run, and now and then over every lost one. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = this.now();
      const runs = this.store.all();
      const open = runs.filter(isOpen);
      const lost = runs.filter((run) => run.closedAt && run.state === "observation_lost");

      if (open.length === 0 && !lost.some((run) => isRecoverable(run, now))) {
        this.stop();
        return;
      }

      let changed = false;
      for (const run of open) {
        try {
          const next = await this.advance(run, now);
          if (!this.store.find(run.anthillRunId)) continue;
          if (next !== run) {
            await this.store.put(next, true);
            this.rememberEnding(run, next);
            changed = true;
            // Lost runs retain their cursor for recovery; settled runs do not.
            if (!isOpen(next) && !isRecoverable(next, now)) this.forget(next.anthillRunId);
          }
          if (this.storageErrors.delete(run.anthillRunId)) changed = true;
        } catch (error) {
          this.retryAfterStorageFailure(run, error);
          changed = true;
        }
      }

      if (lost.length > 0 && (this.storageErrors.size > 0 || Date.parse(now) - this.recoveryLookedAt >= RECOVERY_POLL_MS)) {
        this.recoveryLookedAt = Date.parse(now);
        for (const run of lost) {
          if (!isRecoverable(run, now)) {
            // Past keeping, or put away. Nothing more will be read for it.
            this.forget(run.anthillRunId);
            continue;
          }
          try {
            const next = await this.recover(run, now);
            if (!this.store.find(run.anthillRunId)) continue;
            if (next !== run) {
              await this.store.put(next, true);
              this.rememberEnding(run, next);
              changed = true;
            }
            if (this.storageErrors.delete(run.anthillRunId)) changed = true;
          } catch (error) {
            this.retryAfterStorageFailure(run, error);
            changed = true;
          }
        }
      }

      if (changed) this.publish(this.snapshot());
    } finally {
      this.polling = false;
    }
  }

  private retryAfterStorageFailure(run: PendingRun, error: unknown): void {
    if (!this.store.find(run.anthillRunId)) return;
    // The sources are replayable; the journal deduplicates already persisted
    // events. Keep notification history so a disk retry cannot notify twice.
    for (const observer of Object.values(this.observers)) observer.forget(run.anthillRunId);
    this.hooks.forget(run.anthillRunId);
    this.reports.forget(run.anthillRunId);
    this.mismatched.delete(run.anthillRunId);
    this.sessionLookups.delete(run.anthillRunId);
    this.storageErrors.set(run.anthillRunId, `Anthill could not save observed activity. Retrying automatically. The external session is unchanged. ${String(error)}`);
  }

  /**
   * Write down an ending the moment a run arrives at one.
   *
   * On the change rather than on every poll, so a settled run is recorded once
   * — and from the run itself, which is the only place that still knows which
   * workflow this was. The journals do not: their events carry a run id and no
   * workflow id.
   */
  private rememberEnding(before: PendingRun, after: PendingRun): void {
    if (!isEnding(after.state)) return;
    if (before.state === after.state && before.lastObservedAt === after.lastObservedAt) return;
    this.onSettled(after);
  }

  private async advance(run: PendingRun, now: string): Promise<PendingRun> {
    run = await this.resolveSession(run, now);
    const { evidence, drafts } = await this.read(run, now);
    const added = await this.record(run, drafts);

    let next = run;
    for (const item of evidence) next = applyEvidence(next, item);

    // Order matters: a session that produced evidence this very poll is not
    // quiet, so the silence check runs against the folded state, not the old one.
    if (hasGoneQuiet(next, now)) next = applyEvidence(next, { kind: "quiet", at: now });
    next = expireIfStale(next, now);

    this.offerNotices(next, added, run);
    // The run's own endings, judged from where it was to where it is now.
    for (const notice of endingNotices(run, next)) this.onStepNotice(notice);
    return next;
  }

  /**
   * Look at a lost run's records for signs of life, and pick it back up on any.
   *
   * What the records gained is kept whether or not it reopens the run: the
   * observers have moved past it, and a step the session announced while
   * Anthill was not claiming to watch is still a step the session announced.
   */
  private async recover(run: PendingRun, now: string): Promise<PendingRun> {
    run = await this.resolveSession(run, now);
    const { evidence, drafts } = await this.read(run, now);
    const added = await this.record(run, drafts);
    const next = resumeFromEvidence(run, evidence, now) ?? run;
    this.offerNotices(next, added);
    return next;
  }

  /** Repair a host-id handover only through Claude's explicit local mapping. */
  private async resolveSession(run: PendingRun, now: string): Promise<PendingRun> {
    if (run.selectedCli !== "claude-code" || !run.exchange?.sessionId ||
        run.exchange.resolvedSessionId || !this.claudeDesktopRoot) return run;
    const last = this.sessionLookups.get(run.anthillRunId);
    if (last !== undefined && Date.parse(now) - last < RECOVERY_POLL_MS) return run;
    this.sessionLookups.set(run.anthillRunId, Date.parse(now));
    const resolved = await resolveClaudeSession(this.claudeDesktopRoot, run.exchange.sessionId);
    if (!resolved || resolved === run.exchange.sessionId) return run;
    // Re-read hooks/transcripts skipped under the old id, but do not replay
    // reported steps or reset the user's notification history.
    for (const observer of Object.values(this.observers)) observer.forget(run.anthillRunId);
    this.hooks.forget(run.anthillRunId);
    this.sessionsSeen.delete(run.anthillRunId);
    const next = {
      ...run,
      exchange: { ...run.exchange, resolvedSessionId: resolved },
      detectedSessionId: resolved,
    };
    await this.record(next, [{
      at: now, cli: run.selectedCli, source: "anthill", kind: "notification",
      channel: "exchange:session-resolution", sessionId: resolved,
      title: "Claude desktop session resolved to its CLI session",
      detail: `Claude's local session metadata maps ${run.exchange.sessionId} to ${resolved}. The original handover is unchanged; Anthill observes the CLI session's records.`,
    }]);
    return next;
  }

  /** Everything the run's channels have gained since they were last read. */
  private async read(
    run: PendingRun,
    now: string,
  ): Promise<{ evidence: Evidence[]; drafts: ObservationEventDraft[] }> {
    const observer = this.observers[run.selectedCli];

    let evidence: Evidence[] = [];
    let drafts: ObservationEventDraft[] = [];
    try {
      const result = await observer.poll(run, now, {
        hooksWatching: this.hooks.watching(run.anthillRunId),
        hooksWaiting: this.hooks.waiting(run.anthillRunId, now),
      });
      evidence = result.evidence;
      drafts = result.events;
      const pinned = boundSessionId(run);
      if (pinned && (drafts.some((item) => item.sessionId === pinned) ||
          evidence.some((item) => "sessionId" in item && item.sessionId === pinned))) {
        this.sessionsSeen.add(run.anthillRunId);
      }
    } catch {
      // A scan that fails is not evidence of anything about the session.
      evidence = [];
    }

    // A stop the person made reaches only the transcript, and it settles what
    // the hook log is still claiming: whatever was open when they pressed the
    // key is not coming back. Said before the hooks are read, so this poll's
    // own "still working" does not undo the stop that produced it (ANT-122).
    for (const item of evidence) {
      if (item.kind === "interrupted") this.hooks.stopped(run.anthillRunId, item.at);
    }

    // Hooks are read separately because the log is machine-wide and only
    // becomes relevant once another channel has matched the run to a session.
    try {
      const hooked = await this.hooks.poll(withSessionFrom(run, evidence), now);
      evidence = [...evidence, ...hooked.evidence];
      drafts = [...drafts, ...hooked.events];
    } catch {
      // No hooks installed, or the log is unreadable. Neither is an error.
    }

    // Reports are read the same way: a file the CLI writes on the harness's
    // behalf, matched on the marker's two halves. Not gated on a session
    // match — a report can arrive before the session file does.
    try {
      const reported = await this.reports.poll(run, now);
      evidence = [...evidence, ...reported.evidence];
      drafts = [...drafts, ...reported.events];
    } catch {
      // The CLI was never run, or the file is unreadable. Neither is an error.
    }

    // A plugin binds an explicit session, unlike discovery from a pasted
    // marker. A copied marker in a second transcript must not move that binding.
    const sessionId = boundSessionId(run);
    if (sessionId) {
      const conflicts = new Set(evidence.flatMap((item) => item.kind === "ambiguous" ? item.sessionIds :
        "sessionId" in item && item.sessionId !== sessionId ? [item.sessionId] : []));
      for (const draft of drafts) if (draft.sessionId && draft.sessionId !== sessionId) conflicts.add(draft.sessionId);
      conflicts.delete(sessionId);
      /*
        Whether this session's own records have been found.

        The report channel is not evidence of it: it borrows whatever id the
        run carries rather than reading one, so a run bound to an id no
        transcript holds looks located by that measure alone — which is how
        the case this guards against went unnoticed.

        Judged after a minute, because a session that has just started has
        often not written anything yet, and a warning that is usually wrong is
        one nobody reads by the time it is right.
      */
      const found = drafts.some((item) => item.sessionId === sessionId && item.channel !== "anthill:report");
      if (found) this.sessionsSeen.add(run.anthillRunId);
      const overdue = Date.parse(now) - Date.parse(run.createdAt) > TIMING.activityTtlMs;
      evidence = evidence.filter((item) => (!("sessionId" in item) || item.sessionId === sessionId) && item.kind !== "ambiguous");
      drafts = [
        ...drafts.filter((item) => item.sessionId === sessionId),
        ...this.noteMismatch(run, sessionId, conflicts, now),
        ...(this.sessionsSeen.has(run.anthillRunId) || !overdue ? [] : this.noteUnseen(run, sessionId, now)),
      ];
    }
    // Observers with no transcript support must not shorten the report window.
    if (run.exchange) {
      evidence = evidence.filter((item) => item.kind !== "unobservable" && Date.parse(item.at) >= Date.parse(run.createdAt));
      drafts = drafts.filter((item) => Date.parse(item.at) >= Date.parse(run.createdAt));
    }
    return { evidence, drafts };
  }

  /**
   * Write down that another local session on this machine carries this run's
   * marker — as a note, never as evidence.
   *
   * The binding is the answer to the question `ambiguous_match` exists to say
   * nobody has: a plugin named the session, so there is nothing to be
   * uncertain about and the second transcript is simply not this run. Feeding
   * the mismatch back in as an `ambiguous` item took a pinned run from
   * `detected_live` to `ambiguous_match`, demoted its confidence and put a
   * status message on screen contradicting the binding — the very thing the
   * filtering in `read` exists to prevent, arriving through the one kind of
   * evidence the fold's own guard cannot recognise as being about a different
   * session, because it names several.
   *
   * Once per session id per run: the other transcript keeps being read for as
   * long as it keeps growing, and a note on every poll would be a feed of the
   * same sentence rather than a record of something that happened.
   */
  /**
   * Say so when the session a binding named has left no records at all.
   *
   * The filter above keeps a bound run to the session the harness said it was
   * working in. When that id is wrong, the filter is total: every word the
   * session wrote is discarded, and the page draws the steps the CLI reported
   * against a feed with nothing in it — beside a badge reading "strong". A
   * handover once recorded the desktop app's own session id, which is the same
   * for every session it starts, and it looked exactly like a quiet run.
   *
   * Once per run: it is a fact about the binding, not about this poll, and a
   * line every two seconds would bury the work it is complaining about.
   */
  private noteUnseen(run: PendingRun, sessionId: string, now: string): ObservationEventDraft[] {
    const noted = this.mismatched.get(run.anthillRunId) ?? new Set<string>();
    this.mismatched.set(run.anthillRunId, noted);
    const key = `unseen:${sessionId}`;
    if (noted.has(key)) return [];
    noted.add(key);
    return [
      {
        at: now,
        cli: run.selectedCli,
        source: "anthill",
        channel: "exchange:session-mismatch",
        sessionId,
        kind: "notification",
        title: "The session this run was bound to has written nothing here",
        detail: `The handover named ${sessionId}, and no local ${CLI_LABEL[run.selectedCli]} record carries that id. Progress reported through the CLI still arrives; everything the session itself writes is being passed over, because it cannot be told from another session's.`,
      },
    ];
  }

  private noteMismatch(
    run: PendingRun,
    sessionId: string,
    conflicts: ReadonlySet<string>,
    now: string,
  ): ObservationEventDraft[] {
    if (conflicts.size === 0) return [];
    const noted = this.mismatched.get(run.anthillRunId) ?? new Set<string>();
    this.mismatched.set(run.anthillRunId, noted);
    const drafts: ObservationEventDraft[] = [];
    for (const other of conflicts) {
      if (noted.has(other)) continue;
      noted.add(other);
      drafts.push({
        at: now,
        cli: run.selectedCli,
        source: "anthill",
        channel: "exchange:session-mismatch",
        sessionId,
        kind: "notification",
        title: "Another local session carries this run's marker",
        detail: `Anthill is following ${sessionId}, the session the handover named, and is not reading ${other} for this run.`,
      });
    }
    return drafts;
  }

  /** Write what was read into the journal, and say so if any of it was new. */
  private async record(
    run: PendingRun,
    drafts: ObservationEventDraft[],
  ): Promise<ObservationEvent[]> {
    if (drafts.length === 0 || !this.store.find(run.anthillRunId)) return [];
    const added = await this.journal.append(run.anthillRunId, drafts);
    if (added.length === 0) return [];
    this.publishEvents(run.anthillRunId, await this.journal.tail(run.anthillRunId));
    return added;
  }

  /**
   * Offer whatever the run just did as something worth interrupting for.
   *
   * Given the run as it is *after* this poll's evidence has been folded in, not
   * before. The first poll that finds a session both discovers it and reads its
   * first step marker, and against the pre-evidence run that step belongs to a
   * run still listed as waiting for a session — so the one notification most
   * worth having would be the one always refused.
   *
   * Only events the journal accepted as new are offered, which is what keeps a
   * lost run being picked back up from replaying every step it ever announced.
   */
  private offerNotices(run: PendingRun, added: readonly ObservationEvent[], was?: PendingRun): void {
    if (added.length === 0) return;
    for (const notice of noticesFor(run, added, this.announced, was)) this.onStepNotice(notice);
  }
}

/**
 * The run as the hook reader should see it this poll.
 *
 * The hooks only read for a session the run already names, and the run only
 * names one once this poll's evidence has been folded in — after the hooks
 * were read. So on the poll that found the session the hooks were handed a
 * run with no session and read nothing, and everything they had waited a
 * poll longer (ANT-161). A single strong match this poll names the session
 * for them now; ambiguity, or a match that contradicts a binding, does not.
 */
export function withSessionFrom(run: PendingRun, evidence: readonly Evidence[]): PendingRun {
  if (run.detectedSessionId) return run;
  if (evidence.some((item) => item.kind === "ambiguous")) return run;
  const matches = new Set(
    evidence.flatMap((item) => (item.kind === "match" && item.confidence === "strong" ? [item.sessionId] : [])),
  );
  if (matches.size !== 1) return run;
  const [sessionId] = matches;
  const bound = boundSessionId(run);
  if (bound && bound !== sessionId) return run;
  return { ...run, detectedSessionId: sessionId };
}
