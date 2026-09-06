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
 */

import {
  type ObservationEvent,
  applyEvidence,
  createPendingRun,
  expireIfStale,
  hasGoneQuiet,
  isOpen,
  isVisible,
  reopenForAnotherLook,
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
    this.observers["claude-code"].forget(runId);
    this.observers.codex.forget(runId);
    this.hooks.forget(runId);
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

    this.observers["claude-code"].forget(runId);
    this.observers.codex.forget(runId);
    this.hooks.forget(runId);
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
    return this.announce();
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

  /** One pass over every open run. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = this.now();
      const open = this.store.all().filter(isOpen);

      if (open.length === 0) {
        this.stop();
        return;
      }

      let changed = false;
      for (const run of open) {
        const next = await this.advance(run, now);
        if (next !== run) {
          await this.store.put(next);
          changed = true;
          if (!isOpen(next)) {
            this.observers[next.selectedCli].forget(next.anthillRunId);
          }
        }
      }
      if (changed) this.publish(this.snapshot());
    } finally {
      this.polling = false;
    }
  }

  private async advance(run: PendingRun, now: string): Promise<PendingRun> {
    const observer = this.observers[run.selectedCli];
    let next = run;

    let evidence: Evidence[] = [];
    let drafts: ObservationEventDraft[] = [];
    try {
      const result = await observer.poll(run, now);
      evidence = result.evidence;
      drafts = result.events;
    } catch {
      // A scan that fails is not evidence of anything about the session.
      evidence = [];
    }

    // Hooks are read separately because the log is machine-wide and only
    // becomes relevant once another channel has matched the run to a session.
    try {
      drafts = [...drafts, ...(await this.hooks.poll(run, now))];
    } catch {
      // No hooks installed, or the log is unreadable. Neither is an error.
    }

    if (drafts.length > 0) {
      const added = await this.journal.append(run.anthillRunId, drafts);
      if (added.length > 0) {
        this.publishEvents(run.anthillRunId, await this.journal.tail(run.anthillRunId));
      }
    }

    for (const item of evidence) next = applyEvidence(next, item);

    // Order matters: a session that produced evidence this very poll is not
    // quiet, so the silence check runs against the folded state, not the old one.
    if (hasGoneQuiet(next, now)) next = applyEvidence(next, { kind: "quiet", at: now });
    next = expireIfStale(next, now);

    return next;
  }
}
