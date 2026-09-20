/**
 * The journal's two promises: it only ever grows, and it records a thing once.
 *
 * Both matter because the page is a fold over this file. If a re-read of a
 * transcript could add the same tool call twice, the feed would invent activity
 * that never happened; if the log could be rewritten, a replay would stop being
 * evidence of anything.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isRunId } from "@anthill/live";

import { ObservationJournal } from "./journal.js";
import type { ObservationEventDraft } from "./observers/types.js";

async function journal(): Promise<{ journal: ObservationJournal; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-journal-"));
  return { journal: new ObservationJournal(dir), dir };
}

function draft(partial: Partial<ObservationEventDraft> = {}): ObservationEventDraft {
  return {
    at: "2026-08-29T10:00:01.000Z",
    cli: "claude-code",
    source: "transcript",
    channel: "claude-code:transcript",
    sessionId: "sess-1",
    kind: "tool.start",
    title: "Bash",
    toolUseId: "toolu_1",
    ...partial,
  };
}

describe("the observation journal", () => {
  it("numbers events in the order they were appended", async () => {
    const { journal: log } = await journal();
    await log.append("ANT-1", [draft(), draft({ toolUseId: "toolu_2", title: "Read" })]);
    const events = await log.read("ANT-1");
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[0].runId).toBe("ANT-1");
  });

  it("records the same observation once, however often it is re-read", async () => {
    const { journal: log } = await journal();
    await log.append("ANT-1", [draft()]);
    const second = await log.append("ANT-1", [draft(), draft({ toolUseId: "toolu_2" })]);

    expect(second).toHaveLength(1);
    expect(second[0].toolUseId).toBe("toolu_2");
    expect(await log.read("ANT-1")).toHaveLength(2);
  });

  it("keeps a start and its end apart even though they share an id", async () => {
    const { journal: log } = await journal();
    await log.append("ANT-1", [draft(), draft({ kind: "tool.end", title: "Tool finished" })]);
    expect(await log.read("ANT-1")).toHaveLength(2);
  });

  it("does not replay CLI steps after a host id resolves and Anthill restarts", async () => {
    const { journal: log, dir } = await journal();
    const step = draft({ source: "anthill", channel: "anthill:report", kind: "step.marker", blockId: "fix", toolUseId: undefined, sessionId: "host-id" });
    await log.append("ANT-1", [step]);
    const reopened = new ObservationJournal(dir);
    expect(await reopened.append("ANT-1", [{ ...step, sessionId: "cli-id" }])).toEqual([]);
    expect(await reopened.read("ANT-1")).toHaveLength(1);
    expect(await reopened.append("ANT-1", [{ ...step, sessionId: "cli-id", at: "2026-08-29T10:01:01.000Z" }])).toHaveLength(1);
    // Vendor events still distinguish two actual sessions.
    expect(await reopened.append("ANT-1", [draft({ sessionId: "one" }), draft({ sessionId: "two" })])).toHaveLength(2);
  });

  it("survives a restart, continuing the numbering from the file", async () => {
    const { journal: log, dir } = await journal();
    await log.append("ANT-1", [draft()]);

    const reopened = new ObservationJournal(dir);
    expect(await reopened.read("ANT-1")).toHaveLength(1);
    const added = await reopened.append("ANT-1", [draft({ toolUseId: "toolu_2" })]);
    expect(added[0].seq).toBe(2);
  });

  it("tolerates a half-written last line from a killed app", async () => {
    const { journal: log, dir } = await journal();
    await log.append("ANT-1", [draft(), draft({ toolUseId: "toolu_2" })]);

    const path = join(dir, "ANT-1.jsonl");
    const text = await readFile(path, "utf8");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, `${text}{"runId":"ANT-1","seq":3,"ki`, "utf8");

    const reopened = new ObservationJournal(dir);
    expect(await reopened.read("ANT-1")).toHaveLength(2);
  });

  it("drops a run's log when the user stops observing it", async () => {
    const { journal: log } = await journal();
    await log.append("ANT-1", [draft()]);
    await log.forget("ANT-1");
    expect(await log.read("ANT-1")).toHaveLength(0);
  });
});

/**
 * A journal that was written by two apps at once.
 *
 * It happened: two instances shared one userData folder, each appended with
 * its own fingerprint set, and a session's every event landed twice,
 * interleaved, with two seq sequences. The file cannot be un-written; reading
 * it can at least refuse to repeat it.
 */
describe("reading a journal two writers interleaved", () => {
  it("returns each event once, keeping the first occurrence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-journal-"));
    const journal = new ObservationJournal(dir);

    const event = (seq: number, kind: string, at: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        runId: "ANT-1",
        seq,
        at,
        recordedAt: at,
        cli: "codex",
        source: "rollout",
        channel: "codex:rollout",
        sessionId: "sess-1",
        kind,
        title: "exec",
        ...extra,
      });

    // Writer A's stream, then writer B re-appending the same session with its
    // own seq numbering — the exact shape found on disk.
    const lines = [
      event(1, "session.start", "2026-09-01T10:00:00.000Z"),
      event(2, "tool.start", "2026-09-01T10:00:05.000Z", { toolUseId: "call-1" }),
      event(3, "tool.end", "2026-09-01T10:00:06.000Z", { toolUseId: "call-1" }),
      event(1, "session.start", "2026-09-01T10:00:00.000Z"),
      event(2, "tool.start", "2026-09-01T10:00:05.000Z", { toolUseId: "call-1" }),
      event(3, "tool.end", "2026-09-01T10:00:06.000Z", { toolUseId: "call-1" }),
    ];
    await writeFile(join(dir, "ANT-1.jsonl"), lines.join("\n") + "\n", "utf8");

    const events = await journal.tail("ANT-1");
    expect(events).toHaveLength(3);
    expect(events.filter((item) => item.kind === "tool.start")).toHaveLength(1);
  });
});

/**
 * The record the diagram is folded from.
 *
 * ANT-73. `tail` defaulted to the last thousand events, which is a sensible
 * bound on how many cards to draw and a ruinous one on how much the page may
 * know: the graph is a fold over this same list, so once a session passed a
 * thousand events the steps it had announced early scrolled out from under it
 * and blocks that had run for an hour went back to saying "Waiting its turn".
 * Measured on the session it was reported from — 1531 events, 8 step markers,
 * only 2 of them inside the last thousand.
 */
describe("how much of a run the page is given", () => {
  async function longRun(count: number) {
    const { journal: log } = await journal();
    await log.append(
      "ANT-1",
      Array.from({ length: count }, (_, index) =>
        draft({
          kind: index === 0 ? "step.marker" : "tool.start",
          title: index === 0 ? "Step announced" : "Bash",
          ...(index === 0 ? { blockId: "n1" } : {}),
          toolUseId: `toolu_${index}`,
          at: new Date(Date.parse("2026-08-29T10:00:00.000Z") + index * 1000).toISOString(),
        }),
      ),
    );
    return log;
  }

  it("hands back everything, however long the session ran", async () => {
    const log = await longRun(1500);
    expect(await log.tail("ANT-1")).toHaveLength(1500);
  });

  it("keeps the step announced at the very start, which the graph needs", async () => {
    const log = await longRun(1500);
    const events = await log.tail("ANT-1");
    // The one event in 1500 that moves a block. Losing it is losing the block.
    expect(events.filter((event) => event.kind === "step.marker")).toHaveLength(1);
    expect(events[0].blockId).toBe("n1");
  });

  it("still trims when a caller asks it to", async () => {
    const log = await longRun(1500);
    const events = await log.tail("ANT-1", 10);
    expect(events).toHaveLength(10);
    // The newest ten, not the oldest.
    expect(events.at(-1)?.seq).toBe(1500);
  });
});

/**
 * A run id becomes a file name, so an id that is not ours must not address a
 * file (ANT-96).
 *
 * `liveCancel` carries a run id from the renderer to `forget`, which deletes
 * what the id resolves to. Before this, `../../something` resolved outside the
 * journal directory and was deleted.
 */
describe("a run id that did not come from Anthill", () => {
  const ESCAPES = [
    "../escaped",
    "../../escaped",
    "ANT-1/../../escaped",
    "/etc/anthill",
    "ANT-1/nested",
    "ant-lowercase",
    "NOTANT-12345678",
    "",
    "ANT-",
  ];

  it("is not a run id", () => {
    for (const value of ESCAPES) expect(isRunId(value), value).toBe(false);
    expect(isRunId("ANT-ABC12345")).toBe(true);
  });

  it("deletes nothing outside the journal directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "anthill-journal-escape-"));
    const outside = join(root, "escaped.jsonl");
    await writeFile(outside, "someone else's record\n");
    const journal = new ObservationJournal(join(root, "journal"));

    for (const value of ESCAPES) await journal.forget(value);

    // The file is still there, with its contents intact.
    expect(await readFile(outside, "utf8")).toBe("someone else's record\n");
    await rm(root, { recursive: true, force: true });
  });

  it("reads and writes nothing under an id that is not ours", async () => {
    const root = await mkdtemp(join(tmpdir(), "anthill-journal-escape-"));
    const journal = new ObservationJournal(join(root, "journal"));

    for (const value of ESCAPES) {
      const added = await journal.append(value, [
        { at: new Date().toISOString(), cli: "claude-code", source: "anthill",
          kind: "notification", channel: "test", title: "should not be written" },
      ]);
      expect(added, value).toEqual([]);
      expect(await journal.read(value), value).toEqual([]);
    }

    // Nothing was created for any of them, not even an empty directory entry.
    const listed = await readdir(join(root, "journal")).catch(() => []);
    expect(listed).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("still records a run id that is ours", async () => {
    const root = await mkdtemp(join(tmpdir(), "anthill-journal-ok-"));
    const journal = new ObservationJournal(join(root, "journal"));

    const added = await journal.append("ANT-ABC12345", [
      { at: new Date().toISOString(), cli: "claude-code", source: "anthill",
        kind: "notification", channel: "test", title: "kept" },
    ]);

    expect(added).toHaveLength(1);
    expect(await journal.read("ANT-ABC12345")).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  });
});

/**
 * A write that did not happen must not be remembered as one that did (ANT-97).
 *
 * The cache and the fingerprint set used to advance before the append, and the
 * append's failure was swallowed. A full disk or a read-only directory
 * therefore lost the events twice over: they were not in the log, and the next
 * poll — seeing the very same transcript lines — skipped them as already
 * recorded.
 */
describe("an append that cannot reach the disk", () => {
  const draft = (title: string): ObservationEventDraft => ({
    at: new Date().toISOString(), cli: "claude-code", source: "anthill",
    kind: "notification", channel: "test", title,
  });

  it("reports nothing added, and lets the next poll try again", async () => {
    const base = await mkdtemp(join(tmpdir(), "anthill-journal-ro-"));
    const dir = join(base, "journal");
    await mkdir(dir, { recursive: true });
    const journal = new ObservationJournal(dir);

    // A directory the process cannot write into is the shape of a permissions
    // failure, and of a full disk as far as this code can tell them apart.
    await chmod(dir, 0o500);
    const refused = await journal.append("ANT-ABC12345", [draft("first")]);
    expect(refused).toEqual([]);

    // The retry is the point: nothing was marked seen, so the same event is
    // still offered and now lands.
    await chmod(dir, 0o700);
    const accepted = await journal.append("ANT-ABC12345", [draft("first")]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].title).toBe("first");

    // And it is genuinely on disk, numbered from one.
    const written = await readFile(join(dir, "ANT-ABC12345.jsonl"), "utf8");
    expect(written.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(written.trim()).seq).toBe(1);

    await rm(base, { recursive: true, force: true });
  });

  it("leaves what was already recorded alone", async () => {
    const base = await mkdtemp(join(tmpdir(), "anthill-journal-ro-"));
    const dir = join(base, "journal");
    await mkdir(dir, { recursive: true });
    const journal = new ObservationJournal(dir);

    await journal.append("ANT-ABC12345", [draft("kept")]);
    // The file, not the directory: a read-only directory still allows an
    // append to a file that already exists inside it.
    const file = join(dir, "ANT-ABC12345.jsonl");
    await chmod(file, 0o400);
    await journal.append("ANT-ABC12345", [draft("lost")]);
    await chmod(file, 0o600);

    // The failed append neither removed the first event nor renumbered it.
    const events = await journal.read("ANT-ABC12345");
    expect(events.map((event) => event.title)).toEqual(["kept"]);

    await rm(base, { recursive: true, force: true });
  });
});
