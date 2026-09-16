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
} from "@anthill/live";

import { ClaudeCodeObserver } from "./observers/claude-code.js";
import { CodexObserver } from "./observers/codex.js";
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
};

/** Where each CLI keeps its records. Overridable so the service is testable. */
export type ObservationRoots = {
  claudeRoot?: string;
  codexRoot?: string;
  hookLogPath?: string;
  journalDir?: string;
};

export class LiveSessionService {
  private readonly observers: Record<MarkerCli, LiveSessionObserver>;
  private readonly hooks: HookLogObserver;
  private readonly journal: ObservationJournal;
  private timer: NodeJS.Timeout | undefined;
  private capabilities: ObserverCapabilities[] = [];
  private polling = false;
  /** When lost runs were last checked, in epoch ms. Zero means never. */
  private recoveryLookedAt = 0;

  constructor(
    private readonly store: PendingRunStore,
    private readonly publish: (snapshot: LiveSessionSnapshot) => void,
    private readonly now: () => string = () => new Date().toISOString(),
    roots: ObservationRoots = {},
    /** Told when a run's observed activity grew, so the page can catch up. */
    private readonly publishEvents: (runId: string, events: ObservationEvent[]) => void = () => undefined,
  ) {
    this.observers = {
      "claude-code": roots.claudeRoot
        ? new ClaudeCodeObserver(roots.claudeRoot)
        : new ClaudeCodeObserver(),
      codex: roots.codexRoot ? new CodexObserver(roots.codexRoot) : new CodexObserver(),
    };
    this.hooks = roots.hookLogPath ? new HookLogObserver(roots.hookLogPath) : new HookLogObserver();
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
    this.observers["claude-code"].forget(runId);
    this.observers.codex.forget(runId);
    this.hooks.forget(runId);
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
            changed = true;
          }
        }
      }

      if (changed) this.publish(this.snapshot());
    } finally {
      this.polling = false;
    }
  }

  private async advance(run: PendingRun, now: string): Promise<PendingRun> {
    const { evidence, drafts } = await this.read(run, now);
    await this.record(run, drafts);

    let next = run;
    for (const item of evidence) next = applyEvidence(next, item);

    // Order matters: a session that produced evidence this very poll is not
    // quiet, so the silence check runs against the folded state, not the old one.
    if (hasGoneQuiet(next, now)) next = applyEvidence(next, { kind: "quiet", at: now });
    next = expireIfStale(next, now);

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
    await this.record(run, drafts);
    return resumeFromEvidence(run, evidence, now) ?? run;
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

    return { evidence, drafts };
  }

  /** Write what was read into the journal, and say so if any of it was new. */
  private async record(run: PendingRun, drafts: ObservationEventDraft[]): Promise<void> {
    if (drafts.length === 0) return;
    const added = await this.journal.append(run.anthillRunId, drafts);
    if (added.length > 0) {
      this.publishEvents(run.anthillRunId, await this.journal.tail(run.anthillRunId));
    }
  }
}
