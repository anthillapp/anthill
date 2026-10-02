/**
 * A pending run, and the state machine that decides what Anthill may claim.
 *
 * Anthill is not running anything here. It copied a prompt, the user started
 * the agent themselves somewhere else, and all Anthill has is whatever the tool
 * happened to write to disk on this machine. Every transition below is
 * therefore a claim about *evidence*, not about control — which is why
 * confidence travels with the state and why several of these states exist only
 * to say "Anthill no longer knows".
 *
 * Pure and time-injected: the whole machine is exercised in tests without a
 * filesystem, a CLI, or a clock.
 */

import type { MarkerCli } from "./marker.js";

export type LiveSessionState =
  /** Nothing copied, nothing being observed. */
  | "idle"
  /** A prompt was copied; no matching local session has appeared yet. */
  | "pending_after_copy"
  /** A session on this machine carries the marker and is producing evidence. */
  | "detected_live"
  /** The tool recorded that the work finished. */
  | "completed"
  /** The tool recorded a failure, or the pending run expired unmatched. */
  | "failed"
  /** A match was found and then went quiet without a finish. */
  | "observation_lost"
  /** More than one session matched, or only weak evidence exists. */
  | "ambiguous_match";

/**
 * How well the match is known.
 *
 * `exact` — the tool's own session id, known to be this run's.
 * `strong` — the marker was found in a record the tool wrote itself.
 * `medium` — the marker was found somewhere less reliable.
 * `weak` — timing, directory, or title only. Never enough to claim live.
 */
export type Confidence = "exact" | "strong" | "medium" | "weak";

export type PendingRun = {
  anthillRunId: string;
  workflowId?: string;
  /** Workflow name, so the indicator can say what is running. Not the prompt. */
  workflowName?: string;
  /**
   * The steps the marker named, as they were called when the prompt was copied.
   *
   * Kept with the run because the workflow lives in the editor and a run
   * outlives the screen that started it — and because these are exactly the
   * ids the prompt told the session to announce, so a marker that arrives
   * naming one of them can be named back in the author's own words. A run
   * started before this existed has none, and anything that reads them has to
   * treat an unknown id as unknown rather than guess.
   */
  steps?: RunStep[];
  /** Pinned handover identity. A binding is not evidence of live activity. */
  exchange?: {
    revision: number;
    digest: string;
    sessionId?: string;
    /** CLI identity explicitly resolved from Claude desktop's local session metadata. */
    resolvedSessionId?: string;
  };
  promptVersion: string;
  selectedCli: MarkerCli;
  createdAt: string;
  /**
   * When Anthill stops reading this run.
   *
   * Before a session is found this is the discovery deadline, set from the
   * copy. Once one is found it moves with the session's own evidence: a
   * deadline measured from the copy would close a run in the middle of work
   * that is plainly still happening.
   */
  expiresAt: string;
  correlationNonce: string;
  /** A hash, never the prompt itself — the text can be long and is private. */
  bootstrapPromptHash: string;
  state: LiveSessionState;
  detectedSessionId?: string;
  /** Which local record the evidence came from, for the status detail. */
  evidenceChannel?: string;
  confidence?: Confidence;
  /** When the session last produced evidence, not when Anthill last looked. */
  lastObservedAt?: string;
  statusMessage?: string;
  /**
   * When Anthill gave up watching.
   *
   * A lost session is worth staying on for a while: the CLI may simply be
   * thinking, and the observers keep their place in its files, so the moment it
   * writes again the run comes back to life on its own. But that cannot be
   * true forever — past the run's window Anthill stops looking, and a row that
   * can no longer change is history rather than something happening now.
   */
  closedAt?: string;
  /** Set when the user dismissed it, so cleanup can drop it. */
  dismissedAt?: string;
  /**
   * When the author pressed "Stop observing in Anthill" (ANT-191).
   *
   * The run and its record stay: the button promises that only Anthill stops
   * reading, and deleting what it had read made the run the author was just
   * watching unreachable — the workflow's chip fell back to an older run.
   * A stopped run is never picked back up by itself.
   */
  observationStoppedAt?: string;
  /**
   * When the person stopped the session by hand, while that is still the
   * last word on it (ANT-241).
   *
   * A stop closes the run as `observation_lost`, the state a session that may
   * come back is kept in (ANT-122). That state alone reads as Anthill having
   * lost sight of the session — "it may still be running" — when the person
   * pressed Stop themselves. Gone as soon as the run leaves that state.
   */
  stoppedByHandAt?: string;
};

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

export type Evidence =
  /** The marker was found in a session record the tool wrote. */
  | {
      kind: "match";
      sessionId: string;
      confidence: Confidence;
      channel: string;
      at: string;
      /** Where the session is running, if the record says. Shown, not stored long. */
      cwd?: string;
    }
  /** More than one session on this machine carries this run's marker. */
  | { kind: "ambiguous"; sessionIds: string[]; channel: string; at: string }
  /**
   * The matched session wrote something new.
   *
   * `channel` says which channel the evidence came through, so the status
   * message can be true: a report through the CLI is not a local session
   * record, and saying otherwise would tell the author something that did
   * not happen.
   */
  | {
      kind: "activity";
      sessionId: string;
      at: string;
      channel?: string;
      /**
       * Whether the new records include work: a prompt submitted or a tool
       * called. `false` is the observer saying they do not — the closing
       * reply after the done line, the turn ending, the Stop hook — and that
       * cannot take back a finish (ANT-188). Absent: the observer does not
       * say, and any later record counts, as before.
       */
      resumes?: boolean;
    }
  /**
   * A tool this session started has not reported back yet.
   *
   * Not the same claim as `activity`, and it must not be folded into it: the
   * session has written nothing since `since`, and saying otherwise would put
   * a moment on the record that nothing happened at. What it says is narrower
   * and stronger — work is in flight *right now*, because something opened and
   * has not closed.
   */
  | { kind: "working"; sessionId: string; at: string; since: string; detail?: string }
  /**
   * The session ended its turn at an approval and is waiting for the person's
   * answer.
   *
   * Codex records `task_complete` at the end of every turn, the one that asks
   * a gate's question included, and read as the session finishing it closed
   * the run while the chat sat open waiting to be answered (ANT-210). Reported
   * at the moment of the look, like `working`, for as long as nothing has been
   * said since; it keeps a run being followed live, and never revives one.
   */
  | { kind: "awaiting"; sessionId: string; at: string; since: string; detail?: string }
  /** The tool recorded that the work finished. */
  | { kind: "completed"; sessionId: string; channel: string; at: string; detail?: string }
  /**
   * The person stopped the session themselves.
   *
   * Not `completed`, which is Anthill's inference that a session finished what
   * it was doing, and not `failed`, which is the tool recording that something
   * went wrong. Somebody pressed a key: the turn ended where it was, and what
   * happens next is up to them. It is its own kind because those three want
   * different words on the page and none of them is true of the others.
   */
  | { kind: "interrupted"; sessionId: string; channel: string; at: string; detail?: string }
  /** The tool recorded a failure. */
  | { kind: "failed"; sessionId: string; channel: string; at: string; detail?: string }
  /** Nothing new for long enough that Anthill will not claim a live match. */
  | { kind: "quiet"; at: string }
  /** The tool has no local records Anthill can read at all. */
  | { kind: "unobservable"; channel: string; at: string; detail: string };

/* ------------------------------------------------------------------ */
/* Timings                                                             */
/* ------------------------------------------------------------------ */

export const TIMING = {
  /**
   * How long a copied prompt waits to be claimed by a session.
   *
   * This asks about discovery — did the user paste it anywhere? — and the
   * question is settled the moment a session carries the marker. It was never
   * meant to be a budget for the work itself.
   */
  pendingTtlMs: 30 * 60 * 1000,
  /** Shorter, when the chosen CLI writes nothing Anthill can read. */
  unobservableTtlMs: 2 * 60 * 1000,
  /** How long a detected session may be quiet before Anthill stops claiming it. */
  activityTtlMs: 5 * 60 * 1000,
  /**
   * How long after its last evidence a matched run is still worth reading.
   *
   * Measured from the session's own last word rather than from the copy, so a
   * workflow may take as long as the work takes. Silence this long is the only
   * thing that closes a session Anthill actually found.
   */
  silenceTtlMs: 30 * 60 * 1000,
  /** How long a finished or failed record is kept for the user to read. */
  retentionMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * States that are still worth spending a filesystem scan on.
 *
 * `observation_lost` is among them on purpose: that is what makes a session
 * that went quiet and then wrote again come back by itself. Once the run has
 * been closed, nothing more can arrive and the scanning stops.
 */
export function isOpen(run: PendingRun): boolean {
  if (run.closedAt) return false;
  return (
    run.state === "pending_after_copy" ||
    run.state === "detected_live" ||
    run.state === "observation_lost" ||
    run.state === "ambiguous_match" ||
    // A finished session is still read, because "finished" is an inference from
    // silence and the session can disprove it by writing again. Only `failed`
    // is taken as final: something the tool recorded, rather than something
    // Anthill concluded.
    run.state === "completed"
  );
}

/**
 * Whether this run is something happening now, rather than something that
 * happened. What belongs under "Sessions", in other words.
 */
export function isWatching(run: PendingRun): boolean {
  return isOpen(run) && run.state !== "completed" && run.state !== "failed";
}

/** States the indicator shows at all. */
export function isVisible(run: PendingRun): boolean {
  return run.state !== "idle" && !run.dismissedAt;
}

/** One step of the workflow a run was copied from: the marker's id, and its name. */
export type RunStep = {
  id: string;
  name: string;
  /** An Approval Gate: a turn that ends on it is waiting for a person (ANT-210). */
  gate?: true;
};

export type NewRunInput = {
  anthillRunId: string;
  correlationNonce: string;
  selectedCli: MarkerCli;
  promptVersion: string;
  bootstrapPromptHash: string;
  workflowId?: string;
  workflowName?: string;
  steps?: RunStep[];
  now: string;
};

export function createPendingRun(input: NewRunInput): PendingRun {
  return {
    anthillRunId: input.anthillRunId,
    correlationNonce: input.correlationNonce,
    selectedCli: input.selectedCli,
    promptVersion: input.promptVersion,
    bootstrapPromptHash: input.bootstrapPromptHash,
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.workflowName ? { workflowName: input.workflowName } : {}),
    ...(input.steps && input.steps.length > 0 ? { steps: input.steps } : {}),
    createdAt: input.now,
    expiresAt: new Date(Date.parse(input.now) + TIMING.pendingTtlMs).toISOString(),
    state: "pending_after_copy",
    statusMessage: "Waiting for the pasted prompt to start a session.",
  };
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

/** The original handover stays intact even when its desktop id resolves to a CLI id. */
export function boundSessionId(run: PendingRun): string | undefined {
  if (!run.exchange?.sessionId) return undefined;
  return (run.selectedCli === "claude-code" ? run.exchange.resolvedSessionId : undefined)
    ?? run.exchange.sessionId;
}

/**
 * Push a matched run's window out, measuring it from this evidence.
 *
 * Never earlier than it already is. Evidence can arrive out of order, and a
 * late read of an old record should not shorten the life of a run.
 */
function windowFrom(run: PendingRun, at: string): string {
  const fromEvidence = Date.parse(at) + TIMING.silenceTtlMs;
  return new Date(Math.max(fromEvidence, Date.parse(run.expiresAt))).toISOString();
}

/**
 * Fold one piece of evidence into a run.
 *
 * Pure, and never destructive: a run that has already finished is not reopened
 * by a late scan, and weak evidence never produces a live claim no matter what
 * state the run is in.
 */
export function applyEvidence(run: PendingRun, evidence: Evidence): PendingRun {
  const next = foldEvidence(run, evidence);
  // Stopped by hand only for as long as the stop is what closed it (ANT-241).
  if (next.stoppedByHandAt && next.state !== "observation_lost") {
    const { stoppedByHandAt: _gone, ...rest } = next;
    return rest;
  }
  return next;
}

/**
 * What a run bound to its session says about the evidence behind it.
 *
 * A plugin binds a run to the session's own id, so the run never goes through
 * the marker match that names a channel and a confidence: it goes live on the
 * first record that session writes. The page then read "no evidence · unknown
 * confidence" for a session it was visibly reading (ANT-248). The binding is
 * the strongest evidence there is, so the first channel that confirms it is
 * named and the confidence is strong.
 */
function boundEvidence(run: PendingRun, channel: string | undefined): Pick<PendingRun, "evidenceChannel" | "confidence"> {
  if (!boundSessionId(run)) return {};
  return {
    ...(run.evidenceChannel ?? channel ? { evidenceChannel: run.evidenceChannel ?? channel } : {}),
    confidence: run.confidence ?? "strong",
  };
}

function foldEvidence(run: PendingRun, evidence: Evidence): PendingRun {
  const pinned = boundSessionId(run);
  if (pinned && "sessionId" in evidence && evidence.sessionId !== pinned) return run;
  // A recorded failure is the tool's own word and stands. "Completed" is
  // Anthill's inference from a quiet turn, and a session that writes again has
  // just disproved it — so activity, and only activity, can take it back.
  if (run.state === "failed") return run;
  // `working` joins `activity` here for the same reason: "completed" is an
  // inference drawn from silence, and both of these are positive statements
  // about right now that contradict it. One says the session wrote something,
  // the other that it has work outstanding — either disproves the silence the
  // conclusion rests on (ANT-75).
  if (run.state === "completed" && evidence.kind !== "activity" && evidence.kind !== "working") {
    return run;
  }

  switch (evidence.kind) {
    case "match": {
      // A guess is never enough to say a session is being observed. It is worth
      // saying out loud that something might be there, which is what
      // `ambiguous_match` is for.
      if (evidence.confidence === "weak" || evidence.confidence === "medium") {
        return {
          ...run,
          state: "ambiguous_match",
          expiresAt: windowFrom(run, evidence.at),
          confidence: evidence.confidence,
          evidenceChannel: evidence.channel,
          lastObservedAt: evidence.at,
          statusMessage:
            "A local session might match this run, but not well enough to be sure.",
        };
      }
      // Exact evidence for a *different* session does not outrank exact
      // evidence for the one being followed; it contradicts it. Overwriting
      // the tracked id let two sessions carrying one marker take turns being
      // "the" session, poll by poll, each switch looking like certainty.
      //
      // Unless the run is already ambiguous. Then nothing is being followed —
      // that is what the state means — and a strong match is the observer
      // reporting that the contest resolved, possibly to the other candidate:
      // the one Anthill had picked first may be the one that died.
      if (
        run.detectedSessionId &&
        run.detectedSessionId !== evidence.sessionId &&
        run.state !== "ambiguous_match"
      ) {
        return {
          ...run,
          state: "ambiguous_match",
          expiresAt: windowFrom(run, evidence.at),
          confidence: "medium",
          evidenceChannel: evidence.channel,
          lastObservedAt: evidence.at,
          statusMessage:
            "A second local session carries this run's marker, so Anthill cannot say which one to follow.",
        };
      }
      return {
        ...run,
        state: "detected_live",
        expiresAt: windowFrom(run, evidence.at),
        detectedSessionId: evidence.sessionId,
        confidence: evidence.confidence,
        evidenceChannel: evidence.channel,
        lastObservedAt: evidence.at,
        statusMessage: "Anthill found this run's marker in a local session.",
      };
    }

    case "ambiguous":
      return {
        ...run,
        state: "ambiguous_match",
        expiresAt: windowFrom(run, evidence.at),
        confidence: "medium",
        evidenceChannel: evidence.channel,
        lastObservedAt: evidence.at,
        statusMessage: `${evidence.sessionIds.length} local sessions carry this marker, so Anthill cannot say which one to observe.`,
      };

    case "awaiting":
      if (run.state !== "detected_live") return run;
      if (run.detectedSessionId && run.detectedSessionId !== evidence.sessionId) return run;
      return {
        ...run,
        expiresAt: windowFrom(run, evidence.at),
        lastObservedAt: evidence.at,
        statusMessage: evidence.detail ?? "The session is waiting for your answer at an approval.",
      };

    case "working": {
      if (run.detectedSessionId && run.detectedSessionId !== evidence.sessionId) return run;
      // The same rule `activity` has, for the same reason: only work that
      // *started* after the finish disproves it. A call still open from before
      // the session said it was done is a record nothing closed, not work that
      // is happening — and taking it as a revival is how a run the harness had
      // explicitly reported finished went back to "still working" (ANT-119).
      if (
        run.state === "completed" &&
        run.lastObservedAt &&
        Date.parse(evidence.since) <= Date.parse(run.lastObservedAt)
      ) {
        return run;
      }
      // Only for a session already being followed. A run still waiting for its
      // first match is not made live by a tool call it has not tied to itself.
      if (
        run.state !== "detected_live" &&
        run.state !== "observation_lost" &&
        run.state !== "completed"
      ) {
        return run;
      }
      return {
        ...run,
        state: "detected_live",
        expiresAt: windowFrom(run, evidence.at),
        lastObservedAt: evidence.at,
        statusMessage: evidence.detail
          ? `${evidence.detail} It has not reported back yet, so the session is still working.`
          : "A tool this session started has not reported back yet, so it is still working.",
      };
    }

    case "activity": {
      if (run.detectedSessionId && run.detectedSessionId !== evidence.sessionId) return run;
      // Channels are polled separately. An older CLI report must not undo the
      // freshness already established by a newer transcript or hook record.
      if (run.lastObservedAt && Date.parse(evidence.at) < Date.parse(run.lastObservedAt)) return run;
      // Only work done *after* the finish disproves it. An observer that
      // re-reports the same moment is describing the turn that already ended,
      // and taking that as a revival is how a finished run gets stuck looking
      // live until it times out as lost.
      if (
        run.state === "completed" &&
        run.lastObservedAt &&
        Date.parse(evidence.at) <= Date.parse(run.lastObservedAt)
      ) {
        return run;
      }
      // Later, but not work: the rest of the turn that said it was done — its
      // closing reply, the turn ending, the Stop hook. Claude Code prints the
      // done line and then goes on writing for seconds, and each of those
      // records used to turn a finished run back into a live one that nothing
      // would ever finish again (ANT-188). The session is still there, so the
      // record is fresher; the run is still finished.
      if (run.state === "completed" && evidence.resumes === false) {
        return { ...run, expiresAt: windowFrom(run, evidence.at), lastObservedAt: evidence.at };
      }
      // Work arriving from the session being followed says the session is
      // alive. It does not say it is the right session, so it keeps an
      // ambiguous run fresh without resolving it — only the field narrowing
      // back to one does that, and the observers report it when it happens.
      if (run.state === "ambiguous_match") {
        return { ...run, expiresAt: windowFrom(run, evidence.at), lastObservedAt: evidence.at };
      }
      const resumed = run.state === "completed" || run.state === "observation_lost";
      // A report is the harness talking to the CLI, not a local session
      // record: the message says what actually happened.
      const viaReport = evidence.channel === "anthill:report";
      return {
        ...run,
        ...boundEvidence(run, evidence.channel),
        ...(viaReport ? { evidenceChannel: run.evidenceChannel ?? evidence.channel, confidence: run.confidence ?? "strong" as const } : {}),
        state: "detected_live",
        expiresAt: windowFrom(run, evidence.at),
        lastObservedAt: evidence.at,
        statusMessage: viaReport
          ? resumed
            ? "The harness reported again through the Anthill CLI, so it was not finished after all."
            : "The harness reported this run through the Anthill CLI."
          : resumed
            ? "The session started writing again, so it was not finished after all."
            : "Anthill found this run's marker in a local session.",
      };
    }

    case "completed": {
      if (run.detectedSessionId && run.detectedSessionId !== evidence.sessionId) return run;
      // The ending is dated when the session said it, which can be before
      // records already read from the same poll; the run's freshness does not
      // go backwards for it (ANT-188).
      const latest =
        run.lastObservedAt && Date.parse(run.lastObservedAt) > Date.parse(evidence.at)
          ? run.lastObservedAt
          : evidence.at;
      return {
        ...run,
        ...boundEvidence(run, evidence.channel),
        state: "completed",
        expiresAt: windowFrom(run, latest),
        lastObservedAt: latest,
        evidenceChannel: evidence.channel,
        statusMessage: evidence.detail ?? "The session recorded that it finished.",
      };
    }

    /*
      A stop the person made, read out of the record rather than waited out.
      ANT-122: an interrupt fires no hook at all — neither `Stop` nor
      `SessionEnd` — so a session stopped by hand used to sit at "Live" until
      the five-minute silence rule reached it, while its own transcript had
      said so within the second.

      `observation_lost` rather than an ending of its own: the CLI may still
      be open and the person may type again, and that state is the one that is
      already recoverable — a session that starts writing is picked back up
      (ANT-64, ANT-65). Only a run being followed can be stopped this way; one
      that already settled is not reopened to be stopped.
    */
    case "interrupted":
      // The session being followed, and only it. A run with no session of its
      // own has nothing to stop: the stop is a fact about one transcript, and
      // without a binding or a match there is nothing saying that transcript
      // is this run's.
      if (!run.detectedSessionId || run.detectedSessionId !== evidence.sessionId) return run;
      // A run still being followed. `pending_after_copy` counts: a run a
      // plugin bound carries its session id from the moment of binding and
      // sits in that state until its first evidence lands — which, for a
      // session that was stopped, is the same poll that carries the stop.
      // Refusing it there meant the one state where the stop is the only news
      // there is was the one state that ignored it (ANT-122).
      if (run.state !== "detected_live" && run.state !== "pending_after_copy") return run;
      return {
        ...run,
        ...boundEvidence(run, evidence.channel),
        state: "observation_lost",
        lastObservedAt: evidence.at,
        evidenceChannel: evidence.channel,
        stoppedByHandAt: evidence.at,
        statusMessage:
          evidence.detail ?? "You stopped this session. Anthill is no longer reading it; nothing was sent to the session.",
      };

    case "failed":
      if (run.detectedSessionId && run.detectedSessionId !== evidence.sessionId) return run;
      return {
        ...run,
        ...boundEvidence(run, evidence.channel),
        state: "failed",
        lastObservedAt: evidence.at,
        evidenceChannel: evidence.channel,
        statusMessage: evidence.detail ?? "The session recorded a failure.",
      };

    case "quiet":
      // Only a run that was actually being observed can lose observation. A run
      // still waiting for its first evidence is simply still waiting.
      if (run.state !== "detected_live") return run;
      return {
        ...run,
        state: "observation_lost",
        statusMessage:
          "The session stopped writing anything Anthill can read. It may still be running.",
      };

    case "unobservable":
      return {
        ...run,
        expiresAt: new Date(Date.parse(run.createdAt) + TIMING.unobservableTtlMs).toISOString(),
        statusMessage: evidence.detail,
      };
  }
}

/**
 * Expire a run that has waited long enough.
 *
 * A pending run that never matched becomes `failed` with a label that says what
 * actually happened — no session was found — rather than implying the agent
 * failed at something.
 *
 * A run that did match reaches its window only after that much silence, so
 * arriving here means the session has genuinely stopped saying anything
 * readable — not merely that the work is taking a while.
 */
export function expireIfStale(run: PendingRun, now: string): PendingRun {
  if (!isOpen(run)) return run;
  if (Date.parse(now) < Date.parse(run.expiresAt)) return run;

  // A session that finished stays finished when its window runs out; only one
  // that was still being followed becomes "lost".
  if (run.state === "completed") return { ...run, closedAt: now };

  if (run.exchange && run.state === "pending_after_copy") {
    return {
      ...run, state: "observation_lost", closedAt: now,
      statusMessage: "No progress evidence arrived for the bound revision. The external session may still be running; Anthill can look again.",
    };
  }

  if (run.state === "detected_live" || run.state === "observation_lost") {
    return {
      ...run,
      state: "observation_lost",
      closedAt: now,
      statusMessage:
        "Anthill stopped watching. The session may still be running; Anthill can no longer tell.",
    };
  }
  return {
    ...run,
    state: "failed",
    closedAt: now,
    statusMessage:
      run.state === "ambiguous_match"
        ? "Anthill never found a single session it could observe."
        : "No matching local session appeared.",
  };
}

/**
 * Reopen a closed run so Anthill looks at its session's records again.
 *
 * "Look again" is a control over what Anthill reads — the only thing Anthill
 * owns. The session is not attached to, resumed, or signalled; it never knew
 * Anthill existed and still does not.
 *
 * Only a run that was being read and then lost qualifies. A run that never
 * matched has no session to look for; a recorded failure is the tool's own
 * word and stands; a dismissed run was put away by the author. Cancelled runs
 * cannot arrive here at all — cancelling removes the record entirely, which is
 * what makes "never resurrect a run the author stopped" structural rather than
 * a rule to remember.
 *
 * The reopened run keeps its session id, and the re-scan re-runs matching at
 * the same tiers: if two sessions now carry the marker, the answer is
 * `ambiguous_match`, not a reconnection to one of them.
 */
export function reopenForAnotherLook(run: PendingRun, now: string): PendingRun | undefined {
  if (!run.closedAt || run.dismissedAt || run.observationStoppedAt) return undefined;
  if (run.state !== "observation_lost") return undefined;
  if (!run.detectedSessionId) return undefined;

  const { closedAt, ...open } = run;
  void closedAt;
  return {
    ...open,
    state: "observation_lost",
    // A fresh silence window, measured from the look rather than from the old
    // evidence — otherwise the reopened run would close again on the next poll
    // for the very silence the author is asking Anthill to look past.
    expiresAt: new Date(Date.parse(now) + TIMING.silenceTtlMs).toISOString(),
    statusMessage:
      "Anthill is reading the session's records again. Nothing was sent to the session.",
  };
}

/**
 * Whether a closed run is still worth a slower look for signs of life.
 *
 * Exactly the runs "Look again" would accept — a session Anthill was reading
 * and then lost, not put away by the author — for as long as the record is
 * kept at all. A lost session is not a finished one: the person may have
 * stopped it and picked it up an hour later, or Anthill may simply have missed
 * what it was doing (ANT-64 was the second), and either way the record on
 * disk starts growing again. Waiting for a button press to notice that made
 * the button the only way back (ANT-65).
 */
export function isRecoverable(run: PendingRun, now: string): boolean {
  if (!run.closedAt || run.dismissedAt || run.observationStoppedAt) return false;
  if (run.state !== "observation_lost" || !run.detectedSessionId) return false;
  return !isExpired(run, now);
}

/**
 * Whether one piece of evidence is the session doing something *after* the
 * moment the run last saw it.
 *
 * Anything else is a re-reading of old records. An observer that starts from
 * scratch — after the app restarts, say — reports the whole record again, and
 * reporting activity from before the loss as a return would reopen every lost
 * run on every launch. Silence and "nothing to read" are never news.
 */
function isNewsSince(evidence: Evidence, run: PendingRun, since: number): boolean {
  switch (evidence.kind) {
    case "quiet":
    case "unobservable":
    // A stop is not a sign of life. Re-reading a lost run's transcript finds
    // the interrupt that closed it, and taking that as a return would reopen
    // the run on the strength of the record that ended it.
    case "interrupted":
    // Nothing written: the session is still waiting where it was.
    case "awaiting":
      return false;
    case "ambiguous":
      // Only sessions still speaking are counted as contenders, so this is
      // about now by construction.
      return true;
    case "working":
      // Reported at the moment of the look, and only while something is
      // genuinely outstanding — so it is always about now, never a re-reading.
      return evidence.sessionId === run.detectedSessionId;
    case "activity":
    case "completed":
    case "failed":
      if (evidence.sessionId !== run.detectedSessionId) return false;
      return Date.parse(evidence.at) > since;
    case "match":
      return Date.parse(evidence.at) > since;
  }
}

/** "a minute", "12 minutes", "3 hours" — for the note that says how long. */
function forHowLong(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return "a minute";
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

/**
 * Pick a lost run back up if its session has written again.
 *
 * The same reopening "Look again" does, made by the evidence rather than by
 * the author, and only by evidence that is news. Everything after the
 * reopening is the ordinary fold: matching re-runs at its usual tiers, so a
 * second session now carrying the marker makes the run ambiguous rather than
 * quietly reconnecting to one of them.
 *
 * Returns nothing when there is nothing to do, so a caller can tell a resumed
 * run from an untouched one by identity alone.
 */
export function resumeFromEvidence(
  run: PendingRun,
  evidence: readonly Evidence[],
  now: string,
): PendingRun | undefined {
  if (!isRecoverable(run, now)) return undefined;
  const since = Date.parse(run.lastObservedAt ?? run.createdAt);
  const news = evidence.filter((item) => isNewsSince(item, run, since));
  if (news.length === 0) return undefined;

  const reopened = reopenForAnotherLook(run, now);
  if (!reopened) return undefined;

  let next = reopened;
  for (const item of news) next = applyEvidence(next, item);
  if (next.state !== "detected_live") return next;
  return {
    ...next,
    statusMessage: `The session started writing again after ${forHowLong(Date.parse(now) - since)} unseen, so Anthill picked it back up. Nothing was sent to the session.`,
  };
}

/** Whether a detected run has been quiet long enough to stop claiming it. */
export function hasGoneQuiet(run: PendingRun, now: string): boolean {
  if (run.state !== "detected_live" || !run.lastObservedAt) return false;
  return Date.parse(now) - Date.parse(run.lastObservedAt) > TIMING.activityTtlMs;
}

/** Records old enough to drop on the next start. */
export function isExpired(run: PendingRun, now: string): boolean {
  const last = run.lastObservedAt ?? run.createdAt;
  return !isOpen(run) && Date.parse(now) - Date.parse(last) > TIMING.retentionMs;
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export const CLI_LABEL: Record<MarkerCli, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  pi: "Pi",
  vscode: "VS Code",
};

/**
 * The short label the header shows.
 *
 * Every one of these is about what Anthill knows, never about what Anthill is
 * doing — it is not doing anything.
 */
/**
 * Stop reading a session the author asked Anthill to stop observing.
 *
 * Closed, and kept: what was read stays readable, and nothing picks the run
 * back up. A session that had already settled keeps its ending; one still
 * being followed is marked as no longer observed — which is what happened,
 * rather than a claim that it finished or was lost (ANT-191).
 */
export function stopObserving(run: PendingRun, now: string): PendingRun {
  const settled = run.state === "completed" || run.state === "failed";
  return {
    ...run,
    state: settled ? run.state : "observation_lost",
    closedAt: run.closedAt ?? now,
    observationStoppedAt: now,
    statusMessage: settled
      ? run.statusMessage
      : "You stopped observing this session in Anthill. The session itself was not touched.",
  };
}

export function statusLabel(run: PendingRun): string {
  if (run.observationStoppedAt && run.state === "observation_lost") return "Not observing";
  switch (run.state) {
    case "pending_after_copy":
      return run.exchange ? "Waiting for external progress" : "Waiting for a session";
    case "detected_live":
      return "Live session";
    case "completed":
      return "Session finished";
    case "failed":
      return run.detectedSessionId ? "Session failed" : "No session detected";
    case "observation_lost":
      return run.stoppedByHandAt ? "Stopped by hand" : "Observation lost";
    case "ambiguous_match":
      return "Ambiguous session";
    case "idle":
      return "";
  }
}
