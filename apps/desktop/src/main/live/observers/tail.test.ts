/**
 * The tail reader, against the two things that actually went wrong in it.
 *
 * Both cases here cost a real run: a rollout with curly quotes in it was
 * reported as growing on every poll for as long as the app stayed open, and a
 * turn-completion record that landed mid-write was read past and lost.
 */

import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { newCursor, readNewLines, readRotatingLines } from "./tail.js";

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "anthill-tail-")), "log.jsonl");
}

describe("reading the new end of a growing file", () => {
  it("stops reporting growth once a file with non-ASCII text stops growing", async () => {
    // The bug: the read position was kept as a character count and compared
    // against a byte size. One curly apostrophe is enough to make the two
    // disagree forever, so the file looked like it had grown on every poll.
    const path = await scratch();
    await writeFile(path, '{"text":"I’ll run the tests — then stop"}\n', "utf8");

    const cursor = newCursor();
    const first = await readNewLines(path, cursor);
    expect(first.grew).toBe(true);
    expect(first.lines).toHaveLength(1);

    expect(await readNewLines(path, cursor)).toEqual({ lines: [], grew: false });
    expect(await readNewLines(path, cursor)).toEqual({ lines: [], grew: false });
  });

  it("keeps a half-written line instead of reading past it", async () => {
    // The bug: the cursor advanced to the end of the buffer, so the rest of a
    // line still being written was skipped when it finally arrived.
    const path = await scratch();
    await writeFile(path, '{"a":1}\n{"b":', "utf8");

    const cursor = newCursor();
    expect((await readNewLines(path, cursor)).lines).toEqual(['{"a":1}']);

    await appendFile(path, '2}\n', "utf8");
    expect((await readNewLines(path, cursor)).lines).toEqual(['{"b":2}']);
  });

  it("reports nothing at all while the first line is still incomplete", async () => {
    const path = await scratch();
    await writeFile(path, '{"partial"', "utf8");
    expect(await readNewLines(path, newCursor())).toEqual({ lines: [], grew: false });
  });

  it("returns only what was added, not the whole file again", async () => {
    const path = await scratch();
    await writeFile(path, '{"a":"é"}\n', "utf8");
    const cursor = newCursor();
    await readNewLines(path, cursor);

    await appendFile(path, '{"b":"ü"}\n{"c":"—"}\n', "utf8");
    expect((await readNewLines(path, cursor)).lines).toEqual(['{"b":"ü"}', '{"c":"—"}']);
  });

  it("starts over when a file shrank, because it was replaced rather than appended to", async () => {
    const path = await scratch();
    await writeFile(path, '{"old":1}\n{"old":2}\n', "utf8");
    const cursor = newCursor();
    await readNewLines(path, cursor);

    await writeFile(path, '{"new":1}\n', "utf8");
    expect((await readNewLines(path, cursor)).lines).toEqual(['{"new":1}']);
  });

  it("says nothing about a file that is not there", async () => {
    expect(await readNewLines(join(tmpdir(), "anthill-absent.jsonl"), newCursor())).toEqual({
      lines: [],
      grew: false,
    });
  });
});

/**
 * Reads are bounded, and a read that is bounded still makes progress (ANT-99).
 *
 * The whole unread remainder used to be allocated at once. Opening Anthill
 * against a session that had been running all day asked for one buffer the
 * size of its entire transcript.
 */
describe("a file larger than one read", () => {
  it("drains unread events from the old hook log before reading its replacement", async () => {
    const path = await scratch();
    await writeFile(path, '{"first":true}\n');
    const cursor = newCursor();
    await readRotatingLines(path, cursor);
    await appendFile(path, '{"unread":true}\n');
    await rename(path, `${path}.1`);
    await writeFile(path, '{"new":true}\n');
    expect((await readRotatingLines(path, cursor)).lines).toEqual(['{"unread":true}', '{"new":true}']);
    expect((await readRotatingLines(path, cursor)).lines).toEqual([]);
    expect((await readRotatingLines(path, newCursor())).lines).toEqual(['{"first":true}', '{"unread":true}', '{"new":true}']);
  });
  it("does not parse the suffix of an oversized line as a separate event", async () => {
    const path = await scratch();
    await writeFile(path, `${"x".repeat(4 * 1024 * 1024)}{"fake":true}\n{"real":true}\n`);
    const cursor = newCursor();
    await readNewLines(path, cursor);
    expect((await readNewLines(path, cursor)).lines).toEqual(['{"real":true}']);
  });

  it("reads a replacement even when its length did not shrink", async () => {
    const path = await scratch();
    await writeFile(path, '{"old":true}\n');
    const cursor = newCursor();
    await readNewLines(path, cursor);
    await writeFile(`${path}.next`, '{"new":true}\n');
    await rename(`${path}.next`, path);
    expect((await readNewLines(path, cursor)).lines).toEqual(['{"new":true}']);
  });
  it("catches up across several reads rather than allocating it all at once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-tail-big-"));
    const path = join(dir, "big.jsonl");
    // Comfortably past the 4 MB cap, in lines a transcript might plausibly
    // hold.
    const line = `{"filler":"${"x".repeat(999)}"}\n`;
    await writeFile(path, line.repeat(6000), "utf8");

    const cursor = newCursor();
    const first = await readNewLines(path, cursor);
    expect(first.lines.length).toBeGreaterThan(0);
    // It stopped short: one read did not swallow the file.
    expect(first.lines.length).toBeLessThan(6000);

    let total = first.lines.length;
    for (let round = 0; round < 10 && total < 6000; round += 1) {
      total += (await readNewLines(path, cursor)).lines.length;
    }
    expect(total).toBe(6000);

    await rm(dir, { recursive: true, force: true });
  });

  /**
   * The case that would otherwise wedge the cursor: no newline anywhere in a
   * full read, so every later poll asks for the same bytes and finds nothing,
   * for as long as the file exists.
   */
  it("steps over a line too long to ever complete, and says how much it skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-tail-long-"));
    const path = join(dir, "long.jsonl");
    await writeFile(path, `${"x".repeat(5 * 1024 * 1024)}\n{"after":true}\n`, "utf8");

    const cursor = newCursor();
    const skipped = await readNewLines(path, cursor);
    expect(skipped.lines).toEqual([]);
    expect(skipped.grew).toBe(false);
    expect(skipped.skippedBytes).toBeGreaterThan(0);

    // And the records after it are still reachable, which is the point of
    // stepping over rather than waiting.
    let found: string[] = [];
    for (let round = 0; round < 5 && found.length === 0; round += 1) {
      found = (await readNewLines(path, cursor)).lines.filter((l) => l.includes("after"));
    }
    expect(found).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("still waits for a short line that is only half written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-tail-partial-"));
    const path = join(dir, "partial.jsonl");
    await writeFile(path, '{"half":', "utf8");

    const cursor = newCursor();
    const nothing = await readNewLines(path, cursor);

    expect(nothing.lines).toEqual([]);
    expect(nothing.skippedBytes).toBeUndefined();
    // The cursor did not move, so the line is read once it is finished.
    await writeFile(path, '{"half":true}\n', "utf8");
    expect((await readNewLines(path, cursor)).lines).toEqual(['{"half":true}']);

    await rm(dir, { recursive: true, force: true });
  });
});
