/**
 * The observation service, end to end over a real filesystem.
 *
 * Everything here goes through the same path the app uses: a pending run is
 * registered, a transcript appears on disk, and the service is asked to look.
 * The clock is injected so a five-minute silence can be tested in a
 * millisecond.
 */

import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TIMING, type PendingRun } from "@anthill/live";

import { LiveSessionService, RECOVERY_POLL_MS, type LiveSessionSnapshot } from "./service.js";
import { PendingRunStore } from "./store.js";

const RUN_ID = "ANT-1A2B3C4D";
const NONCE = "9f8e7d";
const MARKED = `anthill-run-id: ${RUN_ID}\nanthill-nonce: ${NONCE}`;

type Harness = {
  service: LiveSessionService;
  store: PendingRunStore;
  claudeRoot: string;
  hookLogPath: string;
  reportLogPath: string;
  storePath: string;
  published: LiveSessionSnapshot[];
  setNow: (iso: string) => void;
};

async function harness(startAt = "2026-08-29T10:00:00.000Z"): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-service-"));
  const claudeRoot = join(dir, "claude");
  await mkdir(claudeRoot, { recursive: true });

  const storePath = join(dir, "live-sessions.json");
  const store = new PendingRunStore(storePath);
  const published: LiveSessionSnapshot[] = [];
  let now = startAt;

  const hookLogPath = join(dir, "hooks", "events.jsonl");
  const reportLogPath = join(dir, "cli", "harness-reports.jsonl");
  const service = new LiveSessionService(
    store,
    (snapshot) => published.push(snapshot),
    () => now,
    {
      claudeRoot,
      codexRoot: join(dir, "codex"),
      journalDir: join(dir, "observations"),
      hookLogPath,
      reportLogPath,
    },
  );

  return { service, store, claudeRoot, hookLogPath, reportLogPath, storePath, published, setNow: (iso) => (now = iso) };
}

/** One line in the log the user's installed hooks write. */
async function hookLine(
  path: string,
  sessionId: string,
  name: string,
  when: string,
  toolUseId?: string,
) {
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(
    path,
    JSON.stringify({
      source: "anthill-observation-hook",
      harness: "claude-code",
      eventType: name,
      recordedAt: when,
      data: {
        session_id: sessionId,
        hook_event_name: name,
        tool_name: "Bash",
        ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      },
    }) + "\n",
    "utf8",
  );
}

async function writeTranscript(
  root: string,
  sessionId: string,
  options: { marked?: boolean; stopReason?: string } = {},
) {
  await mkdir(join(root, "-tmp-scratch"), { recursive: true });
  const rows: unknown[] = [
    {
      type: "user",
      sessionId,
      timestamp: "2026-08-29T10:00:05.000Z",
      message: { role: "user", content: options.marked === false ? "hello" : MARKED },
    },
  ];
  if (options.stopReason) {
    rows.push({
      type: "assistant",
      sessionId,
      timestamp: "2026-08-29T10:00:06.000Z",
      message: { role: "assistant", stop_reason: options.stopReason, content: [] },
    });
  }
  await writeFile(
    join(root, "-tmp-scratch", `${sessionId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

const observeRequest = {
  anthillRunId: RUN_ID,
  correlationNonce: NONCE,
  selectedCli: "claude-code" as const,
  promptVersion: "1",
  bootstrapPromptHash: "abcd1234",
  workflowId: "workflow-1",
  workflowName: "Read the note",
};

function only(snapshot: LiveSessionSnapshot): PendingRun {
  expect(snapshot.runs).toHaveLength(1);
  return snapshot.runs[0];
}

describe("registering an observation", () => {
  it("creates a waiting run and persists it before anything is detected", async () => {
    const { service, storePath } = await harness();
    await service.start();
    const snapshot = await service.startObservation(observeRequest);

    expect(only(snapshot).state).toBe("pending_after_copy");
    const saved = JSON.parse(await readFile(storePath, "utf8")) as PendingRun[];
    expect(saved[0].anthillRunId).toBe(RUN_ID);
    // The prompt itself is never written down.
    expect(JSON.stringify(saved)).not.toContain(MARKED);
  });

  it("tells the rest of the app at once, so the header can show it", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);

    // The Prompt modal gets the answer, but the indicator lives elsewhere in
    // the tree and only ever hears about a run through this push.
    expect(h.published.at(-1)?.runs).toHaveLength(1);
    expect(h.published.at(-1)?.runs[0].state).toBe("pending_after_copy");
  });

  it("has no way to start, join, or stop a session", () => {
    const surface = Object.getOwnPropertyNames(LiveSessionService.prototype);
    for (const forbidden of ["launch", "attach", "join", "run", "spawn", "interrupt", "approve"]) {
      expect(surface.some((name) => name.toLowerCase().includes(forbidden))).toBe(false);
    }
  });
});

describe("detection", () => {
  it("goes live when a marked transcript appears", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);

    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow("2026-08-29T10:00:10.000Z");
    await h.service.poll();

    const run = only(h.service.snapshot());
    expect(run.state).toBe("detected_live");
    expect(run.detectedSessionId).toBe("sess-1");
    expect(run.confidence).toBe("strong");
    expect(h.published.length).toBeGreaterThan(0);
  });

  it("stays waiting for a session that does not carry the marker", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);

    await writeTranscript(h.claudeRoot, "sess-other", { marked: false });
    h.setNow("2026-08-29T10:00:10.000Z");
    await h.service.poll();

    expect(only(h.service.snapshot()).state).toBe("pending_after_copy");
  });

  it("loses observation when the session goes silent", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow("2026-08-29T10:00:10.000Z");
    await h.service.poll();

    h.setNow(new Date(Date.parse("2026-08-29T10:00:10.000Z") + TIMING.activityTtlMs + 1_000).toISOString());
    await h.service.poll();

    const run = only(h.service.snapshot());
    expect(run.state).toBe("observation_lost");
    expect(run.statusMessage).toContain("may still be running");
  });

  /**
   * ANT-64. A session that delegates writes its own transcript rarely and the
   * hook log constantly: in the run this was reported from, 638 of 659
   * records came through hooks, and the transcript was silent for thirteen
   * minutes while subagents worked. The quiet clock heard only the
   * transcript, so the run was declared lost in the middle of the work.
   */
  it("hears the hooks as a sign of life while the transcript is silent", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow("2026-08-29T10:00:10.000Z");
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");

    // Thirteen minutes of subagent work: nothing in the transcript, a hook
    // line every two minutes.
    const base = Date.parse("2026-08-29T10:00:10.000Z");
    for (let minute = 2; minute <= 13; minute += 2) {
      const when = new Date(base + minute * 60_000).toISOString();
      await hookLine(h.hookLogPath, "sess-1", "PostToolUse", when);
      h.setNow(when);
      await h.service.poll();
      expect(only(h.service.snapshot()).state).toBe("detected_live");
    }
    expect(only(h.service.snapshot()).lastObservedAt).toBe(new Date(base + 12 * 60_000).toISOString());
  });

  it("fails a run that waited out its window without a match", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);

    h.setNow(new Date(Date.parse("2026-08-29T10:00:00.000Z") + TIMING.pendingTtlMs + 1_000).toISOString());
    await h.service.poll();

    const run = only(h.service.snapshot());
    expect(run.state).toBe("failed");
    expect(run.statusMessage).toContain("No matching local session");
  });
});

describe("recovery across a restart", () => {
  it("brings back an unexpired run and settles it on the next look", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");

    // A second service over the same files is exactly what a restart is.
    const store = new PendingRunStore(h.storePath);
    const restarted = new LiveSessionService(
      store,
      () => undefined,
      () => "2026-08-29T10:00:20.000Z",
      {
        claudeRoot: h.claudeRoot,
        codexRoot: join(h.claudeRoot, "..", "codex"),
        journalDir: join(h.claudeRoot, "..", "observations"),
      },
    );
    const resumed = await restarted.start();
    expect(only(resumed).state).toBe("pending_after_copy");

    await restarted.poll();
    expect(only(restarted.snapshot()).state).toBe("detected_live");
  });

  it("drops records too old to be worth explaining", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);

    const wayLater = new Date(
      Date.parse("2026-08-29T10:00:00.000Z") + TIMING.retentionMs * 2,
    ).toISOString();
    const store = new PendingRunStore(h.storePath);
    expect(await store.load(wayLater)).toHaveLength(0);
  });
});

/** One line in the report file the harness's CLI writes. */
async function reportLine(path: string, report: Record<string, unknown>) {
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, JSON.stringify(report) + "\n", "utf8");
}

describe("the harness's own report", () => {
  const START = "2026-08-29T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();

  it("is a sign of life before a transcript is found", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);

    // The harness says it is here, through the CLI, before any transcript
    // carries the marker.
    await reportLine(h.reportLogPath, {
      kind: "run",
      runId: RUN_ID,
      nonce: NONCE,
      at: at(30_000),
    });
    h.setNow(at(30_000));
    await h.service.poll();

    const run = only(h.service.snapshot());
    expect(run.state).toBe("detected_live");
    expect(run.lastObservedAt).toBe(at(30_000));
  });

  it("lands the steps the harness announces", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);

    await reportLine(h.reportLogPath, {
      kind: "step",
      runId: RUN_ID,
      nonce: NONCE,
      stepId: "implement",
      at: at(40_000),
    });
    h.setNow(at(40_000));
    await h.service.poll();

    const events = await h.service.events(RUN_ID);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "step.marker", blockId: "implement", source: "anthill" }),
    );
  });

  it("ignores a report for a different run", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);

    await reportLine(h.reportLogPath, {
      kind: "step",
      runId: "ANT-DEADBEEF",
      nonce: NONCE,
      stepId: "implement",
      at: at(40_000),
    });
    h.setNow(at(40_000));
    await h.service.poll();

    expect(await h.service.events(RUN_ID)).toHaveLength(0);
  });

  it("keeps a quiet session alive on the report's clock", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow(at(10_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");

    // The transcript goes quiet; the harness keeps reporting through the CLI.
    for (const minute of [2, 6, 12]) {
      await reportLine(h.reportLogPath, {
        kind: "step",
        runId: RUN_ID,
        nonce: NONCE,
        stepId: `part-${minute}`,
        at: at(minute * 60_000),
      });
      h.setNow(at(minute * 60_000));
      await h.service.poll();
      expect(only(h.service.snapshot()).state).toBe("detected_live");
    }
    expect(only(h.service.snapshot()).lastObservedAt).toBe(at(12 * 60_000));
  });
});

describe("cancelling observation", () => {
  it("forgets the run and sends nothing to the session", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow("2026-08-29T10:00:10.000Z");
    await h.service.poll();

    const before = await readFile(join(h.claudeRoot, "-tmp-scratch", "sess-1.jsonl"), "utf8");
    const after = await h.service.cancelObservation(RUN_ID);

    expect(after.runs).toHaveLength(0);
    expect(h.published.at(-1)?.runs).toHaveLength(0);
    // The user's own session file is untouched: Anthill only ever read it.
    expect(await readFile(join(h.claudeRoot, "-tmp-scratch", "sess-1.jsonl"), "utf8")).toBe(before);
  });

  it("keeps a settled run until it is dismissed", async () => {
    const h = await harness();
    await h.service.start();
    await h.service.startObservation(observeRequest);
    h.setNow(new Date(Date.parse("2026-08-29T10:00:00.000Z") + TIMING.pendingTtlMs + 1_000).toISOString());
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("failed");

    const dismissed = await h.service.dismiss(RUN_ID);
    expect(dismissed.runs).toHaveLength(0);
  });
});

/**
 * A session that outlasts the window the copy was given.
 *
 * ANT-19 / ANT-5, driven through the service rather than the state machine,
 * because the bug was only fatal in combination: `expireIfStale` closed the
 * run, `isOpen` then answered false for good, and the poll loop stopped
 * including it in the scan — so the observers never read another byte of a
 * transcript that was still growing, and no later evidence could undo it.
 *
 * Thirty minutes is how long Anthill waits to find out whether anyone pasted
 * the prompt. It was also being spent as the budget for the work.
 */
describe("a workflow that takes longer than half an hour", () => {
  const START = "2026-08-29T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();

  async function say(root: string, sessionId: string, text: string, when: string) {
    await appendFile(
      join(root, "-tmp-scratch", `${sessionId}.jsonl`),
      JSON.stringify({
        type: "assistant",
        sessionId,
        timestamp: when,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }) + "\n",
      "utf8",
    );
  }

  it("keeps reading it for as long as it keeps writing", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");

    h.setNow(at(10_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");

    // Two hours of ordinary work: something every four minutes, comfortably
    // inside the silence threshold and four times past the copy's window.
    for (let minute = 4; minute <= 120; minute += 4) {
      const when = at(minute * 60_000);
      await say(h.claudeRoot, "sess-1", `Working on part ${minute / 4}.`, when);
      h.setNow(when);
      await h.service.poll();

      const run = only(h.service.snapshot());
      expect(run.state).toBe("detected_live");
      expect(run.closedAt).toBeUndefined();
    }

    // And it was actually being read the whole way, not merely left open.
    expect(only(h.service.snapshot()).lastObservedAt).toBe(at(120 * 60_000));
  });

  it("reads the steps it announces after the thirtieth minute", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow(at(10_000));
    await h.service.poll();

    // Well past the old deadline, and the marker still lands.
    const late = at(TIMING.pendingTtlMs + 5 * 60_000);
    await say(h.claudeRoot, "sess-1", `ANTHILL-STEP ${RUN_ID} ${NONCE} implement`, late);
    h.setNow(late);
    await h.service.poll();

    const events = await h.service.events(RUN_ID);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "step.marker", blockId: "implement" }),
    );
  });

  it("still gives up on a session that has genuinely stopped", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow(at(10_000));
    await h.service.poll();

    // Nothing more is ever written. Quiet first, then closed — but closed on
    // its own silence, not on the age of the copy.
    h.setNow(at(TIMING.activityTtlMs + 60_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("observation_lost");
    expect(only(h.service.snapshot()).closedAt).toBeUndefined();

    h.setNow(at(TIMING.silenceTtlMs + 10 * 60_000));
    await h.service.poll();
    const run = only(h.service.snapshot());
    expect(run.state).toBe("observation_lost");
    expect(run.closedAt).toBeDefined();
  });

  it("leaves a prompt nobody pasted on the clock it was given", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);

    h.setNow(at(TIMING.pendingTtlMs + 1_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("failed");
  });
});

/**
 * Picking a session back up.
 *
 * ANT-20's two halves the service owns: a restart does not settle a matched
 * run from stale state — the first poll looks before anything is decided —
 * and "Look again" reopens a closed lost run by re-reading the whole record,
 * with the journal's fingerprints keeping the re-read from doubling anything.
 */
describe("looking again", () => {
  const START = "2026-08-29T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();

  async function say(root: string, sessionId: string, text: string, when: string) {
    await appendFile(
      join(root, "-tmp-scratch", `${sessionId}.jsonl`),
      JSON.stringify({
        type: "assistant",
        sessionId,
        timestamp: when,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }) + "\n",
      "utf8",
    );
  }

  it("a restart looks before it settles: overnight steps are read, not discarded", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow(at(10_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");

    // The app closes. The session keeps working and announces a step well
    // past what would have been the run's window.
    const lateStep = at(50 * 60_000);
    await say(h.claudeRoot, "sess-1", `ANTHILL-STEP ${RUN_ID} ${NONCE} implement`, lateStep);

    // A second service over the same store is exactly what a restart is.
    const store = new PendingRunStore(h.storePath);
    const restarted = new LiveSessionService(
      store,
      () => undefined,
      () => at(51 * 60_000),
      {
        claudeRoot: h.claudeRoot,
        codexRoot: join(h.claudeRoot, "..", "codex"),
        journalDir: join(h.claudeRoot, "..", "observations"),
      },
    );
    const resumed = await restarted.start();
    // Restored open, not settled from what was true at shutdown.
    expect(only(resumed).closedAt).toBeUndefined();

    await restarted.poll();
    const run = only(restarted.snapshot());
    expect(run.state).toBe("detected_live");
    const events = await restarted.events(RUN_ID);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "step.marker", blockId: "implement" }),
    );
  });

  it("a restart still settles a session that genuinely died", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow(at(10_000));
    await h.service.poll();

    // Nothing more is ever written. Restart long after the silence window.
    const store = new PendingRunStore(h.storePath);
    const restarted = new LiveSessionService(
      store,
      () => undefined,
      () => at(2 * 60 * 60_000),
      {
        claudeRoot: h.claudeRoot,
        codexRoot: join(h.claudeRoot, "..", "codex"),
        journalDir: join(h.claudeRoot, "..", "observations"),
      },
    );
    await restarted.start();
    await restarted.poll();
    const run = only(restarted.snapshot());
    // The answer came from the file — it had nothing new — not from the clock
    // at load time.
    expect(run.state).toBe("observation_lost");
    expect(run.closedAt).toBeDefined();
  });

  it("Look again reopens a closed lost run and reads what it missed", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow(at(10_000));
    await h.service.poll();

    // The run closes as lost: the session went quiet past the whole window.
    h.setNow(at(50 * 60_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("observation_lost");
    expect(only(h.service.snapshot()).closedAt).toBeDefined();
    const before = (await h.service.events(RUN_ID)).length;

    // The session was alive all along; Anthill just was not reading it.
    await say(h.claudeRoot, "sess-1", `ANTHILL-STEP ${RUN_ID} ${NONCE} implement`, at(52 * 60_000));
    h.setNow(at(53 * 60_000));
    const snapshot = await h.service.lookAgain(RUN_ID);

    const run = only(snapshot);
    expect(run.closedAt).toBeUndefined();
    expect(run.state).toBe("detected_live");
    const events = await h.service.events(RUN_ID);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "step.marker", blockId: "implement" }),
    );
    // The re-read walked the whole file, and nothing appears twice.
    const fingerprints = events.map((e) => `${e.kind}|${e.at}|${e.title}`);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    expect(events.length).toBeGreaterThan(before);
  });

  it("Look again does nothing for a run that never matched", async () => {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    h.setNow(at(TIMING.pendingTtlMs + 1_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("failed");

    const snapshot = await h.service.lookAgain(RUN_ID);
    expect(only(snapshot).state).toBe("failed");
    expect(only(snapshot).closedAt).toBeDefined();
  });
});

/**
 * Picking a lost session back up without being asked.
 *
 * ANT-65. The run this came from was declared lost twice while its session
 * was working; the first time the author noticed, the only way back was a
 * button. A lost run's records are now looked at again, slowly, for as long
 * as the record is kept — and the run comes back by itself when they grow.
 * Reading, as ever: nothing here sends anything to the session.
 */
describe("a lost session that writes again", () => {
  const START = "2026-08-29T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();
  const minutes = (n: number) => at(n * 60_000);

  async function say(root: string, sessionId: string, text: string, when: string) {
    await appendFile(
      join(root, "-tmp-scratch", `${sessionId}.jsonl`),
      JSON.stringify({
        type: "assistant",
        sessionId,
        timestamp: when,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }) + "\n",
      "utf8",
    );
  }

  /** A run Anthill found, lost, and closed — the state "Look again" is offered in. */
  async function lostAndClosed(): Promise<Harness> {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow(at(10_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");

    // The transcript's last word was at 10:00:05; half an hour of silence
    // after it closes the run.
    h.setNow(minutes(31));
    await h.service.poll();
    const run = only(h.service.snapshot());
    expect(run.state).toBe("observation_lost");
    expect(run.closedAt).toBeDefined();
    return h;
  }

  it("is picked back up when its transcript grows", async () => {
    const h = await lostAndClosed();

    await say(h.claudeRoot, "sess-1", "Back to it.", minutes(60));
    h.setNow(minutes(60));
    await h.service.poll();

    const run = only(h.service.snapshot());
    expect(run.state).toBe("detected_live");
    expect(run.closedAt).toBeUndefined();
    expect(run.lastObservedAt).toBe(minutes(60));
    expect(run.statusMessage).toContain("picked it back up");
    expect(run.statusMessage).toContain("Nothing was sent to the session");
    // And the header was told, not just the store.
    expect(h.published.at(-1)?.runs[0].state).toBe("detected_live");
  });

  it("stays picked up on the very next look", async () => {
    const h = await lostAndClosed();
    await say(h.claudeRoot, "sess-1", "Back to it.", minutes(60));
    h.setNow(minutes(60));
    await h.service.poll();

    h.setNow(at(60 * 60_000 + 2_000));
    await h.service.poll();
    const run = only(h.service.snapshot());
    expect(run.state).toBe("detected_live");
    expect(run.closedAt).toBeUndefined();
  });

  it("is picked back up by its hooks too, when the transcript is the quiet channel", async () => {
    const h = await lostAndClosed();

    await hookLine(h.hookLogPath, "sess-1", "PreToolUse", minutes(60));
    h.setNow(minutes(60));
    await h.service.poll();

    expect(only(h.service.snapshot()).state).toBe("detected_live");
  });

  it("keeps what the session wrote while Anthill was not claiming to watch", async () => {
    const h = await lostAndClosed();
    await say(h.claudeRoot, "sess-1", `ANTHILL-STEP ${RUN_ID} ${NONCE} implement`, minutes(60));
    h.setNow(minutes(60));
    await h.service.poll();

    expect(await h.service.events(RUN_ID)).toContainEqual(
      expect.objectContaining({ kind: "step.marker", blockId: "implement" }),
    );
  });

  it("is not reopened by re-reading records it already saw, even after a restart", async () => {
    const h = await lostAndClosed();

    // A second service over the same files is exactly what a restart is. Its
    // observers start from scratch and read the whole transcript again.
    const store = new PendingRunStore(h.storePath);
    const restarted = new LiveSessionService(store, () => undefined, () => minutes(60), {
      claudeRoot: h.claudeRoot,
      codexRoot: join(h.claudeRoot, "..", "codex"),
      journalDir: join(h.claudeRoot, "..", "observations"),
      hookLogPath: h.hookLogPath,
    });
    await restarted.start();
    await restarted.poll();

    const run = only(restarted.snapshot());
    expect(run.state).toBe("observation_lost");
    expect(run.closedAt).toBeDefined();
  });

  it("looks slowly — not on every tick", async () => {
    const h = await lostAndClosed();
    // The recovery look last ran at the moment of closing; a transcript that
    // grows ten seconds later waits for the next look.
    h.setNow(minutes(60));
    await h.service.poll();
    await say(h.claudeRoot, "sess-1", "Back to it.", at(60 * 60_000 + 10_000));
    h.setNow(at(60 * 60_000 + 10_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("observation_lost");

    h.setNow(at(60 * 60_000 + 10_000 + RECOVERY_POLL_MS));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");
  });

  it("stops looking once the record is past keeping", async () => {
    const h = await lostAndClosed();
    const late = at(TIMING.retentionMs + 60 * 60_000);
    await say(h.claudeRoot, "sess-1", "Back to it.", late);
    h.setNow(late);
    await h.service.poll();

    const run = only(h.service.snapshot());
    expect(run.state).toBe("observation_lost");
    expect(run.closedAt).toBeDefined();
  });

  it("keeps the poll loop alive for a lost run, and lets it go once there is nothing to look for", async () => {
    const h = await lostAndClosed();
    const timer = () => (h.service as unknown as { timer?: unknown }).timer;
    expect(timer()).toBeDefined();

    await h.service.dismiss(RUN_ID);
    await h.service.poll();
    expect(timer()).toBeUndefined();
  });
});

/**
 * A session in the middle of a long tool call.
 *
 * ANT-71, driven end to end because that is the only place the bug was
 * visible: the observers were each behaving as written, and the run still went
 * to "Observation lost" eight minutes into a `swift build` the session was
 * demonstrably running. The last thing either channel had recorded was the
 * call *starting* — which is the strongest sign of life there is, and the one
 * the clock counted as silence.
 */
describe("a session waiting on a tool it started", () => {
  const START = "2026-08-29T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();

  async function live(): Promise<Harness> {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow(at(10_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");
    return h;
  }

  it("stays live while the call is outstanding, past the quiet threshold", async () => {
    const h = await live();
    await hookLine(h.hookLogPath, "sess-1", "PreToolUse", at(60_000), "toolu_1");

    // Well past activityTtlMs with nothing further written anywhere — which is
    // exactly what a build looks like from outside.
    for (const minute of [2, 6, 12, 20]) {
      h.setNow(at(minute * 60_000));
      await h.service.poll();
      const run = only(h.service.snapshot());
      expect(run.state).toBe("detected_live");
      expect(run.statusMessage).toContain("still working");
    }
  });

  it("goes quiet once the call reports back and nothing follows", async () => {
    const h = await live();
    await hookLine(h.hookLogPath, "sess-1", "PreToolUse", at(60_000), "toolu_1");
    h.setNow(at(2 * 60_000));
    await h.service.poll();

    await hookLine(h.hookLogPath, "sess-1", "PostToolUse", at(3 * 60_000), "toolu_1");
    h.setNow(at(3 * 60_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");

    // Now there really is nothing outstanding, so silence means what it says.
    h.setNow(at(3 * 60_000 + TIMING.activityTtlMs + 1_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("observation_lost");
  });

  it("does not let one forgotten call keep a dead session alive all day", async () => {
    const h = await live();
    await hookLine(h.hookLogPath, "sess-1", "PreToolUse", at(60_000), "toolu_1");
    h.setNow(at(2 * 60_000));
    await h.service.poll();

    // A call nothing ever closes stops counting on the same clock that decides
    // a matched session has stopped being worth reading.
    h.setNow(at(60_000 + TIMING.silenceTtlMs + 60_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("observation_lost");
  });
});

/**
 * A delegating session that actually finished.
 *
 * ANT-75, end to end, because that is where it bit: every observer behaved as
 * written and the run still came to rest at "Observation lost" with its last
 * step unknown, so the diagram never went green. The reported session made 14
 * backgrounded delegations, ended its turn cleanly at 04:09:14, and wrote
 * nothing after.
 */
describe("a session that delegated in the background and then finished", () => {
  const START = "2026-08-29T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();

  /** Dispatch to a background agent, take the receipt, end the turn. */
  async function delegatedAndDone(h: Harness) {
    const file = join(h.claudeRoot, "-tmp-scratch", "sess-1.jsonl");
    const rows = [
      {
        type: "assistant",
        sessionId: "sess-1",
        timestamp: at(60_000),
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_9",
              name: "Agent",
              input: { subagent_type: "developer", run_in_background: true },
            },
          ],
        },
      },
      {
        type: "user",
        sessionId: "sess-1",
        timestamp: at(62_000),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9" }] },
      },
      {
        type: "assistant",
        sessionId: "sess-1",
        timestamp: at(64_000),
        message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
      },
    ];
    await appendFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  }

  async function live(): Promise<Harness> {
    const h = await harness(START);
    await h.service.start();
    await h.service.startObservation(observeRequest);
    await writeTranscript(h.claudeRoot, "sess-1");
    h.setNow(at(10_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");
    return h;
  }

  it("is reported as finished, so the diagram can go green", async () => {
    const h = await live();
    // The hook channel is carrying this run, which is what lets the transcript
    // stop assuming the handover is still outstanding. Opened and closed, so
    // nothing is left in flight to keep the session looking busy.
    await hookLine(h.hookLogPath, "sess-1", "PreToolUse", at(30_000), "toolu_1");
    await hookLine(h.hookLogPath, "sess-1", "PostToolUse", at(31_000), "toolu_1");
    h.setNow(at(40_000));
    await h.service.poll();

    await delegatedAndDone(h);
    h.setNow(at(70_000));
    await h.service.poll();

    // Quiet on every channel, well past the settle window.
    h.setNow(at(70_000 + 12 * 60_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("completed");
  });

  it("is not reported as finished while the session says it is still waiting", async () => {
    const h = await live();
    await hookLine(h.hookLogPath, "sess-1", "PreToolUse", at(30_000), "toolu_1");
    await hookLine(h.hookLogPath, "sess-1", "PostToolUse", at(31_000), "toolu_1");
    h.setNow(at(40_000));
    await h.service.poll();

    await delegatedAndDone(h);
    // Its own account of what is outstanding, on the record.
    await appendFile(
      h.hookLogPath,
      JSON.stringify({
        source: "anthill-observation-hook",
        harness: "claude-code",
        eventType: "Stop",
        recordedAt: at(66_000),
        data: {
          session_id: "sess-1",
          hook_event_name: "Stop",
          background_tasks: [
            { id: "bg1", type: "subagent", status: "running", description: "Stage 2 OCR" },
          ],
        },
      }) + "\n",
      "utf8",
    );
    h.setNow(at(70_000));
    await h.service.poll();

    h.setNow(at(70_000 + 12 * 60_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).toBe("detected_live");
  });

  it("stays unfinished when the transcript is the only channel", async () => {
    // No hook line was ever kept for this run, so nothing can retract the
    // handover and the old assumption is still the honest one.
    const h = await live();
    await delegatedAndDone(h);
    h.setNow(at(70_000));
    await h.service.poll();

    h.setNow(at(70_000 + 12 * 60_000));
    await h.service.poll();
    expect(only(h.service.snapshot()).state).not.toBe("completed");
  });
});
