/**
 * The journal's two promises: it only ever grows, and it records a thing once.
 *
 * Both matter because the page is a fold over this file. If a re-read of a
 * transcript could add the same tool call twice, the feed would invent activity
 * that never happened; if the log could be rewritten, a replay would stop being
 * evidence of anything.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
