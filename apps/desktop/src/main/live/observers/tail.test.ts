/**
 * The tail reader, against the two things that actually went wrong in it.
 *
 * Both cases here cost a real run: a rollout with curly quotes in it was
 * reported as growing on every poll for as long as the app stayed open, and a
 * turn-completion record that landed mid-write was read past and lost.
 */

import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { newCursor, readNewLines } from "./tail.js";

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
