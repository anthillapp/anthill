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
  applyEvidence,
  createPendingRun,
  expireIfStale,
  hasGoneQuiet,
  isOpen,
  isRecoverable,
  isVisible,
  reopenForAnotherLook,
  resumeFromEvidence,
  type Evidence,
  type MarkerCli,
  type PendingRun,
  type RunStep,
} from "@anthill/live";

import { ClaudeCodeObserver } from "./observers/claude-code.js";
import { CliReportObserver } from "./observers/cli-report.js";
import { forgetAnnounced, noticesFor, type AnnouncedSteps, type StepNotice } from "./step-notices.js";
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
  private timer: NodeJS.Timeout | undefined;
  private capabilities: ObserverCapabilities[] = [];
  private polling = false;
  /** When lost runs were last checked, in epoch ms. Zero means never. */
  private recoveryLookedAt = 0;
  /** The step each run has already been announced as reaching. See step-notices.ts. */
  private readonly announced: AnnouncedSteps = new Map();

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
    };
  }

  /**
   * Whether this run has already been registered.
   *
   * Asked by anything that may be told about the same run twice — a request
   * from outside the app that was delivered once and recorded once, but whose
   * two writes a crash can fall between. `startObservation` replaces a record
   * of the same id, so a second registration would forget every transition the
   * observers had seen and leave the run waiting for a session it already
   * found. The snapshot does not answer this: it hides a dismissed run, and a
   * dismissed run is one that must stay dismissed.
   *
   * Only true of what has been loaded, so `start()` comes first.
   */
  knows(runId: string): boolean {
    return this.store.find(runId) !== undefined;
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
   */
  async startObservation(input: StartObservationInput): Promise<LiveSessionSnapshot> {
    const run = createPendingRun({ ...input, now: this.now() });
    await this.store.put(run);
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
    await this.store.remove(runId);
    this.forget(runId);
    // The log goes with the run: the user asked Anthill to stop keeping this.
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
    await this.store.put(reopened);
    this.schedule();
    // Look now, and wait for it: the author pressed a button that says
    // "look", and the answer should be in the response, not in a push later.
    await this.poll();
    return this.announce();
  }

  /** Hide a settled run without forgetting it was there. */
  async dismiss(runId: string): Promise<LiveSessionSnapshot> {
    const run = this.store.find(runId);
    if (run) await this.store.put({ ...run, dismissedAt: this.now() });
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
        const next = await this.advance(run, now);
        if (next !== run) {
          await this.store.put(next);
          this.rememberEnding(run, next);
          changed = true;
          // A run closed as lost keeps the observers' places in its records:
          // it is looked at again below, and re-reading the whole record on
          // each look would be the price of forgetting. Anything else that
          // closed is done with.
          if (!isOpen(next) && !isRecoverable(next, now)) this.forget(next.anthillRunId);
        }
      }

      if (lost.length > 0 && Date.parse(now) - this.recoveryLookedAt >= RECOVERY_POLL_MS) {
        this.recoveryLookedAt = Date.parse(now);
        for (const run of lost) {
          if (!isRecoverable(run, now)) {
            // Past keeping, or put away. Nothing more will be read for it.
            this.forget(run.anthillRunId);
            continue;
          }
          const next = await this.recover(run, now);
          if (next !== run) {
            await this.store.put(next);
            this.rememberEnding(run, next);
            changed = true;
          }
        }
      }

      if (changed) this.publish(this.snapshot());
    } finally {
      this.polling = false;
    }
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
    const { evidence, drafts } = await this.read(run, now);
    const added = await this.record(run, drafts);

    let next = run;
    for (const item of evidence) next = applyEvidence(next, item);

    // Order matters: a session that produced evidence this very poll is not
    // quiet, so the silence check runs against the folded state, not the old one.
    if (hasGoneQuiet(next, now)) next = applyEvidence(next, { kind: "quiet", at: now });
    next = expireIfStale(next, now);

    this.offerNotices(next, added);
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
    const { evidence, drafts } = await this.read(run, now);
    const added = await this.record(run, drafts);
    const next = resumeFromEvidence(run, evidence, now) ?? run;
    this.offerNotices(next, added);
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
      });
      evidence = result.evidence;
      drafts = result.events;
    } catch {
      // A scan that fails is not evidence of anything about the session.
      evidence = [];
    }

    // Hooks are read separately because the log is machine-wide and only
    // becomes relevant once another channel has matched the run to a session.
    try {
      const hooked = await this.hooks.poll(run, now);
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
    const sessionId = run.exchange?.sessionId;
    if (sessionId) {
      const conflicts = evidence.flatMap((item) => item.kind === "ambiguous" ? item.sessionIds :
        "sessionId" in item && item.sessionId !== sessionId ? [item.sessionId] : []);
      evidence = evidence.filter((item) => !("sessionId" in item) || item.sessionId === sessionId);
      evidence = evidence.filter((item) => item.kind !== "ambiguous");
      drafts = drafts.filter((item) => item.sessionId === sessionId);
      if (conflicts.length) {
        evidence.push({ kind: "ambiguous", sessionIds: [...new Set([sessionId, ...conflicts])], channel: "exchange:session-mismatch", at: now });
      }
    }
    // Observers with no transcript support must not shorten the report window.
    if (run.exchange) {
      evidence = evidence.filter((item) => item.kind !== "unobservable" && Date.parse(item.at) >= Date.parse(run.createdAt));
      drafts = drafts.filter((item) => Date.parse(item.at) >= Date.parse(run.createdAt));
    }
    return { evidence, drafts };
  }

  /** Write what was read into the journal, and say so if any of it was new. */
  private async record(
    run: PendingRun,
    drafts: ObservationEventDraft[],
  ): Promise<ObservationEvent[]> {
    if (drafts.length === 0) return [];
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
  private offerNotices(run: PendingRun, added: readonly ObservationEvent[]): void {
    if (added.length === 0) return;
    for (const notice of noticesFor(run, added, this.announced)) this.onStepNotice(notice);
  }
}
