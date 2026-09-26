import { describe, expect, it } from "vitest";

import {
  TIMING,
  applyEvidence,
  reopenForAnotherLook,
  resumeFromEvidence,
  isRecoverable,
  createPendingRun,
  expireIfStale,
  hasGoneQuiet,
  isExpired,
  isOpen,
  isWatching,
  statusLabel,
  type Evidence,
  type PendingRun,
} from "./pending-run.js";

const T0 = "2026-08-29T10:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function run(partial: Partial<PendingRun> = {}): PendingRun {
  return {
    ...createPendingRun({
      anthillRunId: "ANT-1A2B3C4D",
      correlationNonce: "9f8e7d",
      selectedCli: "claude-code",
      promptVersion: "1",
      bootstrapPromptHash: "abcd1234",
      workflowId: "workflow-1",
      workflowName: "Read the note",
      now: T0,
    }),
    ...partial,
  };
}

const strongMatch: Evidence = {
  kind: "match",
  sessionId: "sess-1",
  confidence: "strong",
  channel: "claude-code:transcript",
  at: later(5_000),
};

describe("creating a pending run", () => {
  it("starts waiting, with an expiry and no session", () => {
    const created = run();
    expect(created.state).toBe("pending_after_copy");
    expect(created.detectedSessionId).toBeUndefined();
    expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(TIMING.pendingTtlMs);
    expect(statusLabel(created)).toBe("Waiting for a session");
  });

  it("keeps a hash of the prompt rather than the prompt", () => {
    const created = run();
    expect(created.bootstrapPromptHash).toBe("abcd1234");
    expect(JSON.stringify(created)).not.toContain("You are");
  });
});

describe("evidence", () => {
  it("does not move last seen backwards when an older channel reports afterward", () => {
    const matched = applyEvidence(run(), strongMatch);
    const fresh = applyEvidence(matched, { kind: "activity", sessionId: "sess-1", at: later(10 * 60_000) });
    const next = applyEvidence(fresh, { kind: "activity", sessionId: "sess-1", channel: "anthill:report", at: later(10_000) });
    expect(next).toBe(fresh);
    expect(hasGoneQuiet(next, later(10 * 60_000 + 1000))).toBe(false);
  });

  it("pins a resolved Claude CLI identity without changing the original handover", () => {
    const bound = run({
      exchange: { revision: 1, digest: "abc", sessionId: "desktop-id", resolvedSessionId: "sess-1" },
      detectedSessionId: "sess-1",
    });
    expect(applyEvidence(bound, strongMatch).state).toBe("detected_live");
    for (const sessionId of ["desktop-id", "unrelated"]) {
      expect(applyEvidence(bound, { ...strongMatch, sessionId })).toBe(bound);
    }
    expect(bound.exchange?.sessionId).toBe("desktop-id");
    expect(applyEvidence({ ...bound, selectedCli: "codex" }, strongMatch).state).toBe("pending_after_copy");
  });

  it("goes live on a marker found in a record the tool wrote", () => {
    const next = applyEvidence(run(), strongMatch);
    expect(next.state).toBe("detected_live");
    expect(next.detectedSessionId).toBe("sess-1");
    expect(next.confidence).toBe("strong");
    expect(statusLabel(next)).toBe("Live session");
  });

  it("never claims live from a weak or medium match", () => {
    for (const confidence of ["weak", "medium"] as const) {
      const next = applyEvidence(run(), { ...strongMatch, confidence });
      expect(next.state).toBe("ambiguous_match");
      expect(statusLabel(next)).not.toBe("Live session");
      expect(next.detectedSessionId).toBeUndefined();
    }
  });

  it("calls two matching sessions ambiguous rather than picking one", () => {
    const next = applyEvidence(run(), {
      kind: "ambiguous",
      sessionIds: ["sess-1", "sess-2"],
      channel: "claude-code:transcript",
      at: later(5_000),
    });
    expect(next.state).toBe("ambiguous_match");
    expect(next.detectedSessionId).toBeUndefined();
    expect(next.statusMessage).toContain("2 local sessions");
  });

  it("settles on completion evidence", () => {
    const live = applyEvidence(run(), strongMatch);
    const done = applyEvidence(live, {
      kind: "completed",
      sessionId: "sess-1",
      channel: "codex:rollout",
      at: later(9_000),
    });
    expect(done.state).toBe("completed");
    expect(statusLabel(done)).toBe("Session finished");
  });

  it("settles on failure evidence", () => {
    const live = applyEvidence(run(), strongMatch);
    const failed = applyEvidence(live, {
      kind: "failed",
      sessionId: "sess-1",
      channel: "codex:rollout",
      at: later(9_000),
      detail: "Codex recorded an error.",
    });
    expect(failed.state).toBe("failed");
    expect(statusLabel(failed)).toBe("Session failed");
  });

  it("ignores evidence about a different session", () => {
    const live = applyEvidence(run(), strongMatch);
    const other = applyEvidence(live, {
      kind: "completed",
      sessionId: "sess-2",
      channel: "codex:rollout",
      at: later(9_000),
    });
    expect(other.state).toBe("detected_live");
  });

  it("takes back a wrongly-finished session when it writes again", () => {
    const done = applyEvidence(applyEvidence(run(), strongMatch), {
      kind: "completed",
      sessionId: "sess-1",
      channel: "claude-code:transcript",
      at: later(9_000),
    });
    // The old rule called a turn boundary the end of the session; the session
    // itself is the only thing that can settle that argument.
    const back = applyEvidence(done, { kind: "activity", sessionId: "sess-1", at: later(20_000) });
    expect(back.state).toBe("detected_live");
    expect(back.statusMessage).toContain("not finished after all");
  });

  it("says a report is a report, not a local session", () => {
    // The review's point: a lone `run` report used to say "found this run's
    // marker in a local session", which is not what happened. The message
    // says what actually happened.
    const viaReport = applyEvidence(run(), {
      kind: "activity",
      sessionId: "cli-report",
      at: later(20_000),
      channel: "anthill:report",
    });
    expect(viaReport.state).toBe("detected_live");
    expect(viaReport.statusMessage).toBe("The harness reported this run through the Anthill CLI.");
  });

  it("says a report that revives a finished run is a report, not a session", () => {
    const done = applyEvidence(applyEvidence(run(), strongMatch), {
      kind: "completed",
      sessionId: "sess-1",
      channel: "anthill:report",
      at: later(9_000),
    });
    const back = applyEvidence(done, {
      kind: "activity",
      sessionId: "sess-1",
      at: later(20_000),
      channel: "anthill:report",
    });
    expect(back.state).toBe("detected_live");
    expect(back.statusMessage).toBe(
      "The harness reported again through the Anthill CLI, so it was not finished after all.",
    );
  });

  it("settles a report-only run on a done report, on the harness's own word", () => {
    // No transcript was ever found: the only evidence is the harness's own
    // reports. The run can still finish — the review's point that the
    // channel could only ever end in `observation_lost`.
    const live = applyEvidence(run(), {
      kind: "activity",
      sessionId: "cli-report",
      at: later(20_000),
      channel: "anthill:report",
    });
    const done = applyEvidence(live, {
      kind: "completed",
      sessionId: "cli-report",
      channel: "anthill:report",
      at: later(30_000),
      detail: "The harness reported the work as finished.",
    });
    expect(done.state).toBe("completed");
    expect(done.statusMessage).toBe("The harness reported the work as finished.");
  });

  it("is not taken back by activity from the turn that already ended", () => {
    // An observer that re-reads an unchanged file reports the same last-written
    // moment again. That is the finished turn being described a second time,
    // not the session carrying on, and treating it as a revival left two real
    // runs stuck as live until they timed out as lost.
    const done = applyEvidence(applyEvidence(run(), strongMatch), {
      kind: "completed",
      sessionId: "sess-1",
      channel: "codex:rollout",
      at: later(9_000),
    });
    expect(applyEvidence(done, { kind: "activity", sessionId: "sess-1", at: later(9_000) })).toBe(
      done,
    );
    expect(applyEvidence(done, { kind: "activity", sessionId: "sess-1", at: later(4_000) })).toBe(
      done,
    );
  });

  it("keeps a recorded failure final", () => {
    const failed = applyEvidence(applyEvidence(run(), strongMatch), {
      kind: "failed",
      sessionId: "sess-1",
      channel: "codex:rollout",
      at: later(9_000),
    });
    expect(applyEvidence(failed, { kind: "activity", sessionId: "sess-1", at: later(20_000) })).toBe(
      failed,
    );
  });

  it("does not reopen a settled run", () => {
    const live = applyEvidence(run(), strongMatch);
    const done = applyEvidence(live, {
      kind: "completed",
      sessionId: "sess-1",
      channel: "codex:rollout",
      at: later(9_000),
    });
    expect(applyEvidence(done, { ...strongMatch, at: later(20_000) })).toBe(done);
  });

  it("loses observation when an observed session goes quiet", () => {
    const live = applyEvidence(run(), strongMatch);
    const lost = applyEvidence(live, { kind: "quiet", at: later(600_000) });
    expect(lost.state).toBe("observation_lost");
    expect(statusLabel(lost)).toBe("Observation lost");
  });

  it("does not call a run that never matched 'observation lost'", () => {
    const waiting = applyEvidence(run(), { kind: "quiet", at: later(600_000) });
    expect(waiting.state).toBe("pending_after_copy");
  });

  it("comes back to live if evidence resumes", () => {
    const lost = applyEvidence(applyEvidence(run(), strongMatch), {
      kind: "quiet",
      at: later(600_000),
    });
    const back = applyEvidence(lost, { kind: "activity", sessionId: "sess-1", at: later(700_000) });
    expect(back.state).toBe("detected_live");
  });

  it("shortens the wait when the CLI writes nothing readable", () => {
    const next = applyEvidence(run(), {
      kind: "unobservable",
      channel: "codex:rollout",
      at: T0,
      detail: "Codex has no local session records on this machine.",
    });
    expect(Date.parse(next.expiresAt) - Date.parse(next.createdAt)).toBe(TIMING.unobservableTtlMs);
    expect(next.statusMessage).toContain("no local session records");
  });
});

describe("staleness", () => {
  it("fails an unmatched run once it expires, saying no session was found", () => {
    const stale = expireIfStale(run(), later(TIMING.pendingTtlMs + 1));
    expect(stale.state).toBe("failed");
    expect(statusLabel(stale)).toBe("No session detected");
    expect(stale.statusMessage).toContain("No matching local session");
  });

  it("does not expire a run that is still inside its window", () => {
    const fresh = run();
    expect(expireIfStale(fresh, later(60_000))).toBe(fresh);
  });

  it("ends an observed run as lost rather than failed", () => {
    const live = applyEvidence(run(), strongMatch);
    // Measured from the session's last word, not from the copy.
    const stale = expireIfStale(live, later(5_000 + TIMING.silenceTtlMs + 1));
    expect(stale.state).toBe("observation_lost");
  });

  it("knows when an observed session has been quiet too long", () => {
    const live = applyEvidence(run(), strongMatch);
    expect(hasGoneQuiet(live, later(10_000))).toBe(false);
    expect(hasGoneQuiet(live, later(TIMING.activityTtlMs + 10_000))).toBe(true);
  });

  it("drops settled records once they are old enough to forget", () => {
    const done = applyEvidence(applyEvidence(run(), strongMatch), {
      kind: "completed",
      sessionId: "sess-1",
      channel: "codex:rollout",
      at: later(9_000),
    });
    // A finished run is still read for a while, in case it writes again, so it
    // has to be closed before retention can drop it.
    const closed = expireIfStale(done, later(9_000 + TIMING.silenceTtlMs + 1));
    expect(closed.state).toBe("completed");
    expect(isExpired(closed, later(60_000))).toBe(false);
    expect(isExpired(closed, later(TIMING.retentionMs + 60_000))).toBe(true);
  });

  it("only keeps scanning while a run could still change", () => {
    expect(isOpen(run())).toBe(true);
    expect(isOpen(applyEvidence(run(), strongMatch))).toBe(true);
    // "Finished" is an inference from silence, so the session is still read —
    // it can disprove it by writing again. A recorded failure is final.
    expect(isOpen({ ...run(), state: "completed" })).toBe(true);
    expect(isOpen({ ...run(), state: "failed" })).toBe(false);
    expect(isOpen({ ...run(), state: "completed", closedAt: T0 })).toBe(false);
  });
});

describe("a session that outlives the window the copy was given", () => {
  // ANT-19 / ANT-5. The thirty minutes on a copied prompt answers "did anyone
  // paste it". Applying that same deadline to a session that is writing closed
  // real work mid-run, and closing is permanent — the run stopped being
  // scanned, and a fresh copy carries a nonce the running session will never
  // print, so there was no way back.

  it("keeps reading a session that is still writing, however long it takes", () => {
    let next = applyEvidence(run(), strongMatch);
    // Two hours of ordinary work: a step every four minutes, well inside the
    // quiet threshold and far outside the copy's window.
    for (let minute = 4; minute <= 120; minute += 4) {
      const at = later(minute * 60_000);
      next = applyEvidence(next, { kind: "activity", sessionId: "sess-1", at });
      next = expireIfStale(next, at);
      expect(next.state).toBe("detected_live");
      expect(next.closedAt).toBeUndefined();
      expect(isOpen(next)).toBe(true);
    }
  });

  it("does not close a run that produced evidence moments ago", () => {
    const live = applyEvidence(run(), strongMatch);
    const busy = applyEvidence(live, {
      kind: "activity",
      sessionId: "sess-1",
      at: later(TIMING.pendingTtlMs - 60_000),
    });
    // The copy's deadline has passed; the session has not stopped.
    const after = expireIfStale(busy, later(TIMING.pendingTtlMs + 1));
    expect(after.state).toBe("detected_live");
    expect(after.closedAt).toBeUndefined();
  });

  it("still closes it once the session has genuinely stopped", () => {
    const live = applyEvidence(run(), strongMatch);
    const last = later(TIMING.pendingTtlMs);
    const busy = applyEvidence(live, { kind: "activity", sessionId: "sess-1", at: last });

    const stillOpen = expireIfStale(busy, later(TIMING.pendingTtlMs + TIMING.silenceTtlMs - 1));
    expect(stillOpen.closedAt).toBeUndefined();

    const closed = expireIfStale(busy, later(TIMING.pendingTtlMs + TIMING.silenceTtlMs + 1));
    expect(closed.state).toBe("observation_lost");
    expect(closed.closedAt).toBeDefined();
    expect(isOpen(closed)).toBe(false);
  });

  it("leaves an unclaimed prompt on the discovery clock it was given", () => {
    // Nothing ever matched, so the question is still "did anyone paste it",
    // and that question does expire.
    const stale = expireIfStale(run(), later(TIMING.pendingTtlMs + 1));
    expect(stale.state).toBe("failed");
    expect(stale.closedAt).toBeDefined();
  });

  it("does not let a late read of an old record shorten the window", () => {
    const live = applyEvidence(run(), strongMatch);
    const recent = applyEvidence(live, {
      kind: "activity",
      sessionId: "sess-1",
      at: later(20 * 60_000),
    });
    const replayed = applyEvidence(recent, {
      kind: "activity",
      sessionId: "sess-1",
      at: later(6_000),
    });
    expect(Date.parse(replayed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(recent.expiresAt));
  });
});

describe("a session that goes quiet, and then does not come back", () => {
  const live = () => applyEvidence(run(), strongMatch);

  it("keeps watching a lost session, because it can come back on its own", () => {
    const lost = applyEvidence(live(), { kind: "quiet", at: later(600_000) });
    expect(lost.state).toBe("observation_lost");
    // Still open: the observers keep their place in the session's files.
    expect(isOpen(lost)).toBe(true);
    expect(isWatching(lost)).toBe(true);
  });

  it("brings it back the moment the session writes again", () => {
    const lost = applyEvidence(live(), { kind: "quiet", at: later(600_000) });
    const back = applyEvidence(lost, { kind: "activity", sessionId: "sess-1", at: later(700_000) });
    expect(back.state).toBe("detected_live");
    expect(isWatching(back)).toBe(true);
  });

  it("stops watching once the run's window has passed", () => {
    const lost = applyEvidence(live(), { kind: "quiet", at: later(600_000) });
    // Silence is not evidence, so the window still ends a full silent stretch
    // after the last thing the session actually wrote.
    const closed = expireIfStale(lost, later(5_000 + TIMING.silenceTtlMs + 1));

    expect(closed.state).toBe("observation_lost");
    expect(closed.closedAt).toBeDefined();
    // Nothing more can arrive, so nothing more is scanned for.
    expect(isOpen(closed)).toBe(false);
    // And it is no longer something happening now.
    expect(isWatching(closed)).toBe(false);
    expect(closed.statusMessage).toContain("may still be running");
  });

  it("closes an unmatched run too, rather than scanning for it forever", () => {
    const stale = expireIfStale(run(), later(TIMING.pendingTtlMs + 1));
    expect(stale.state).toBe("failed");
    expect(isOpen(stale)).toBe(false);
  });

  it("counts a finished session as watched-no-longer", () => {
    const done = applyEvidence(live(), {
      kind: "completed",
      sessionId: "sess-1",
      channel: "codex:rollout",
      at: later(9_000),
    });
    expect(isWatching(done)).toBe(false);
  });
});

/**
 * Two sessions carrying one marker.
 *
 * ANT-6. Ambiguity was only ever reported before a session had been chosen.
 * Afterwards a second matching session could quietly replace the first, and
 * the tracked id could alternate between them poll after poll — each switch
 * arriving as `exact` evidence and therefore looking like certainty.
 */
describe("a marker that turns up in more than one session", () => {
  const other: Evidence = {
    kind: "match",
    sessionId: "sess-2",
    confidence: "strong",
    channel: "claude-code:transcript",
    at: later(9_000),
  };

  it("does not swap the tracked session for another one", () => {
    const live = applyEvidence(run(), strongMatch);
    expect(live.detectedSessionId).toBe("sess-1");

    const conflicted = applyEvidence(live, other);
    expect(conflicted.state).toBe("ambiguous_match");
    expect(conflicted.detectedSessionId).toBe("sess-1");
    expect(conflicted.statusMessage).toContain("cannot say which one");
  });

  it("keeps saying so while the tracked session goes on working", () => {
    // The session being followed is alive. That was never the question.
    const conflicted = applyEvidence(applyEvidence(run(), strongMatch), other);
    const busy = applyEvidence(conflicted, {
      kind: "activity",
      sessionId: "sess-1",
      at: later(20_000),
    });
    expect(busy.state).toBe("ambiguous_match");
    expect(busy.lastObservedAt).toBe(later(20_000));
  });

  it("comes back out when the field narrows to the one it was following", () => {
    const conflicted = applyEvidence(applyEvidence(run(), strongMatch), other);
    const resolved = applyEvidence(conflicted, { ...strongMatch, at: later(30_000) });
    expect(resolved.state).toBe("detected_live");
    expect(resolved.detectedSessionId).toBe("sess-1");
  });

  it("still takes the first match it sees", () => {
    const live = applyEvidence(run(), strongMatch);
    expect(live.state).toBe("detected_live");
  });
});

/**
 * Looking again at a session Anthill lost.
 *
 * ANT-20. Reconnect here means exactly one thing: resume reading the files
 * the CLI writes on this machine. The rules below are mostly about who does
 * NOT get reopened, because that is where the honesty lives.
 */
/**
 * ANT-119. `working` could reopen a finished run the way `activity` can, but
 * without `activity`'s guard: a tool call still open from *before* the session
 * said it was done kept reviving a run the harness had explicitly reported
 * finished, poll after poll, for as long as the stale record lived.
 */
describe("a finished run and a claim of work", () => {
  const finished = () =>
    applyEvidence(applyEvidence(run(), strongMatch), {
      kind: "completed", sessionId: "sess-1", channel: "anthill:report", at: later(10 * 60_000),
      detail: "The harness reported the work as finished.",
    });

  it("is not reopened by a call that was already open when it finished", () => {
    const next = applyEvidence(finished(), {
      kind: "working", sessionId: "sess-1", at: later(12 * 60_000), since: later(8 * 60_000),
    });
    expect(next.state).toBe("completed");
    expect(next.statusMessage).toContain("reported the work as finished");
  });

  it("is reopened by work that started after it finished, which is a real revival", () => {
    const next = applyEvidence(finished(), {
      kind: "working", sessionId: "sess-1", at: later(12 * 60_000), since: later(11 * 60_000),
    });
    expect(next.state).toBe("detected_live");
  });
});

describe("reopening a run for another look", () => {
  const lostAndClosed = (): PendingRun => ({
    ...applyEvidence(run(), strongMatch),
    state: "observation_lost",
    closedAt: later(40 * 60_000),
  });

  it("reopens a closed lost run with a fresh window to look in", () => {
    const at = later(60 * 60_000);
    const reopened = reopenForAnotherLook(lostAndClosed(), at);
    expect(reopened).toBeDefined();
    expect(reopened?.closedAt).toBeUndefined();
    expect(reopened?.state).toBe("observation_lost");
    // The window is measured from the look, not from the old evidence —
    // otherwise the next poll would re-close it for the very silence the
    // author is asking Anthill to look past.
    expect(Date.parse(reopened?.expiresAt as string)).toBe(
      Date.parse(at) + TIMING.silenceTtlMs,
    );
    expect(reopened?.statusMessage).toContain("Nothing was sent to the session");
  });

  it("keeps the session it was reading, so matching has something to check", () => {
    const reopened = reopenForAnotherLook(lostAndClosed(), later(60 * 60_000));
    expect(reopened?.detectedSessionId).toBe("sess-1");
  });

  it("is scanned again once reopened", () => {
    const reopened = reopenForAnotherLook(lostAndClosed(), later(60 * 60_000)) as PendingRun;
    expect(isOpen(reopened)).toBe(true);
    expect(isWatching(reopened)).toBe(true);
  });

  it("refuses a run that is still open – it is already being read", () => {
    const lost = { ...applyEvidence(run(), strongMatch), state: "observation_lost" as const };
    expect(reopenForAnotherLook(lost, later(1_000))).toBeUndefined();
  });

  it("refuses a run that never matched – there is no session to look for", () => {
    const neverMatched = { ...run(), state: "failed" as const, closedAt: later(1_000) };
    expect(reopenForAnotherLook(neverMatched, later(2_000))).toBeUndefined();
  });

  it("refuses a recorded failure – the tool's own word stands", () => {
    const failed = {
      ...applyEvidence(run(), strongMatch),
      state: "failed" as const,
      closedAt: later(1_000),
    };
    expect(reopenForAnotherLook(failed, later(2_000))).toBeUndefined();
  });

  it("refuses a dismissed run – the author put it away", () => {
    const dismissed = { ...lostAndClosed(), dismissedAt: later(41 * 60_000) };
    expect(reopenForAnotherLook(dismissed, later(60 * 60_000))).toBeUndefined();
  });
});

/**
 * Picking a lost session back up without being asked.
 *
 * ANT-65. The reopening is the one "Look again" does; what is new is that
 * evidence can do it. The rules are mostly about which evidence cannot,
 * because a run that reopens on a re-reading of its own old records would
 * come back on every launch and never actually be lost.
 */
describe("resuming a lost run from evidence", () => {
  const lostAndClosed = (): PendingRun => ({
    ...applyEvidence(run(), strongMatch),
    state: "observation_lost",
    closedAt: later(40 * 60_000),
  });
  const activity = (at: string, sessionId = "sess-1"): Evidence => ({ kind: "activity", sessionId, at });

  it("is worth another look for as long as the record is kept", () => {
    expect(isRecoverable(lostAndClosed(), later(60 * 60_000))).toBe(true);
    expect(isRecoverable(lostAndClosed(), later(TIMING.retentionMs + 5_000 + 60_000))).toBe(false);
  });

  it("is not worth a look when Look again would refuse it either", () => {
    const lost = { ...applyEvidence(run(), strongMatch), state: "observation_lost" as const };
    expect(isRecoverable(lost, later(1_000))).toBe(false);
    expect(isRecoverable({ ...lostAndClosed(), dismissedAt: later(41 * 60_000) }, later(60 * 60_000))).toBe(false);
    expect(isRecoverable({ ...run(), state: "failed", closedAt: later(1_000) }, later(2_000))).toBe(false);
  });

  it("picks the session back up when it writes again", () => {
    const at = later(60 * 60_000);
    const resumed = resumeFromEvidence(lostAndClosed(), [activity(at)], at);
    expect(resumed?.state).toBe("detected_live");
    expect(resumed?.closedAt).toBeUndefined();
    expect(resumed?.lastObservedAt).toBe(at);
    expect(isOpen(resumed as PendingRun)).toBe(true);
    expect(resumed?.statusMessage).toBe(
      "The session started writing again after 60 minutes unseen, so Anthill picked it back up. Nothing was sent to the session.",
    );
  });

  it("does not close again on its next look", () => {
    const at = later(60 * 60_000);
    const resumed = resumeFromEvidence(lostAndClosed(), [activity(at)], at) as PendingRun;
    expect(hasGoneQuiet(resumed, later(60 * 60_000 + 2_000))).toBe(false);
    expect(expireIfStale(resumed, later(60 * 60_000 + 2_000))).toBe(resumed);
  });

  it("is not fooled by a re-reading of the records it already saw", () => {
    // An observer starting from scratch reports the old activity again, at
    // the old time. That is not the session coming back.
    const lost = lostAndClosed();
    expect(resumeFromEvidence(lost, [activity(lost.lastObservedAt as string)], later(60 * 60_000))).toBeUndefined();
    expect(resumeFromEvidence(lost, [activity(later(1_000))], later(60 * 60_000))).toBeUndefined();
  });

  it("ignores silence, unreadability, and another session's work", () => {
    const at = later(60 * 60_000);
    expect(resumeFromEvidence(lostAndClosed(), [{ kind: "quiet", at }], at)).toBeUndefined();
    expect(
      resumeFromEvidence(
        lostAndClosed(),
        [{ kind: "unobservable", channel: "c", at, detail: "nothing to read" }],
        at,
      ),
    ).toBeUndefined();
    expect(resumeFromEvidence(lostAndClosed(), [activity(at, "sess-2")], at)).toBeUndefined();
  });

  it("comes back ambiguous, not reconnected, when a second session now carries the marker", () => {
    const at = later(60 * 60_000);
    const resumed = resumeFromEvidence(
      lostAndClosed(),
      [{ ...strongMatch, sessionId: "sess-2", at }],
      at,
    );
    expect(resumed?.state).toBe("ambiguous_match");
    expect(resumed?.closedAt).toBeUndefined();
    expect(resumed?.detectedSessionId).toBe("sess-1");
  });

  it("takes the session's own ending as a return too", () => {
    const at = later(60 * 60_000);
    const resumed = resumeFromEvidence(
      lostAndClosed(),
      [{ kind: "completed", sessionId: "sess-1", channel: "c", at, detail: "Finished." }],
      at,
    );
    expect(resumed?.state).toBe("completed");
    expect(resumed?.statusMessage).toBe("Finished.");
  });

  it("is not resumed by a report from a session it never tied", () => {
    // The done report names the synthetic report session, not the session the
    // run was reading. Recovery is about the session coming back, and a
    // report is not that — the path stays as it was.
    const at = later(60 * 60_000);
    expect(
      resumeFromEvidence(
        lostAndClosed(),
        [
          {
            kind: "completed",
            sessionId: "cli-report",
            channel: "anthill:report",
            at,
            detail: "done",
          },
        ],
        at,
      ),
    ).toBeUndefined();
  });

  it("never resumes a run Look again would refuse", () => {
    const at = later(60 * 60_000);
    const dismissed = { ...lostAndClosed(), dismissedAt: later(41 * 60_000) };
    expect(resumeFromEvidence(dismissed, [activity(at)], at)).toBeUndefined();
    const failed = { ...applyEvidence(run(), strongMatch), state: "failed" as const, closedAt: later(1_000) };
    expect(resumeFromEvidence(failed, [activity(at)], at)).toBeUndefined();
    const expired = later(TIMING.retentionMs + 60 * 60_000);
    expect(resumeFromEvidence(lostAndClosed(), [activity(expired)], expired)).toBeUndefined();
  });
});

/**
 * A tool that started and has not come back.
 *
 * ANT-71. The quiet clock asks "when did anything last arrive?". While a tool
 * is running the honest answer is "nothing can arrive yet", and treating that
 * as absence declared a session lost eight minutes into a build it was in the
 * middle of.
 */
describe("work still in flight", () => {
  const live = (): PendingRun => applyEvidence(run(), strongMatch);
  const working = (ms: number): Evidence => ({
    kind: "working",
    sessionId: "sess-1",
    at: later(ms),
    since: later(5_000),
    detail: "Bash has been running since 10:00:05.",
  });

  it("keeps a live session live, however long the tool takes", () => {
    const busy = applyEvidence(live(), working(20 * 60_000));
    expect(busy.state).toBe("detected_live");
    expect(hasGoneQuiet(busy, later(20 * 60_000 + 1_000))).toBe(false);
  });

  it("says what is running rather than claiming the session wrote something", () => {
    const busy = applyEvidence(live(), working(10 * 60_000));
    expect(busy.statusMessage).toBe(
      "Bash has been running since 10:00:05. It has not reported back yet, so the session is still working.",
    );
    // The moment is the observation, not an invented write by the session.
    expect(busy.lastObservedAt).toBe(later(10 * 60_000));
  });

  it("brings back a session already given up on", () => {
    const lost = { ...live(), state: "observation_lost" as const };
    expect(applyEvidence(lost, working(10 * 60_000)).state).toBe("detected_live");
  });

  it("does not speak for another session", () => {
    const busy = applyEvidence(live(), { ...working(10 * 60_000), sessionId: "sess-2" } as Evidence);
    expect(busy).toBe(live() === busy ? busy : busy);
    expect(busy.lastObservedAt).toBe(live().lastObservedAt);
  });

  it("does not make a run live that was never matched", () => {
    // A tool call is not a match. Only the channels that read the marker say
    // which session this run is.
    expect(applyEvidence(run(), working(10_000)).state).toBe("pending_after_copy");
  });

  it("does not reopen a session the tool recorded as failed", () => {
    const failed = { ...live(), state: "failed" as const };
    expect(applyEvidence(failed, working(10 * 60_000)).state).toBe("failed");
  });
});
