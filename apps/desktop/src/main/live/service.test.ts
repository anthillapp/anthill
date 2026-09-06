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

import { LiveSessionService, type LiveSessionSnapshot } from "./service.js";
import { PendingRunStore } from "./store.js";

const RUN_ID = "ANT-1A2B3C4D";
const NONCE = "9f8e7d";
const MARKED = `anthill-run-id: ${RUN_ID}\nanthill-nonce: ${NONCE}`;

type Harness = {
  service: LiveSessionService;
  store: PendingRunStore;
  claudeRoot: string;
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

  const service = new LiveSessionService(
    store,
    (snapshot) => published.push(snapshot),
    () => now,
    { claudeRoot, codexRoot: join(dir, "codex"), journalDir: join(dir, "observations") },
  );

  return { service, store, claudeRoot, storePath, published, setNow: (iso) => (now = iso) };
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
