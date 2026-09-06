/**
 * Reading the new end of a file the user's CLI is still writing.
 *
 * Every observer here follows a JSONL file that grows under it, and all three
 * of them got the same two things wrong before this module existed.
 *
 * The first was units. `stat` reports a size in *bytes*; a JavaScript string's
 * `length` is in UTF-16 code units. Keeping the read position as `text.length`
 * and comparing it against `info.size` works only while the file stays ASCII —
 * and a real transcript is full of curly quotes and em dashes. One Codex
 * rollout here was 788,864 bytes and 787,782 characters, so the comparison
 * `size <= offset` was false forever: the file counted as having grown on every
 * single poll, two seconds apart, for as long as the run stayed open. The run
 * was reported as active long after the session had finished, which was enough
 * to undo a completion that had already been recorded correctly.
 *
 * The second was partial lines. A poll can land in the middle of a write, and
 * consuming up to the end of the buffer threw away the half-written line — the
 * next read began after it, so that record was gone for good. It only takes the
 * turn-completion record landing in that gap to lose the end of a session.
 *
 * Both go away by advancing the cursor only to the last newline in the chunk,
 * counted in bytes. A newline byte cannot appear inside a UTF-8 multi-byte
 * sequence, so that boundary is always a whole line *and* a whole character.
 * Reading from the cursor rather than re-reading the file is a side benefit
 * that matters at these sizes.
 */

import { open, stat } from "node:fs/promises";

/** How far into a file an observer has read. Bytes, always. */
export type TailCursor = { bytes: number };

export type TailChunk = {
  /** Complete lines gained since the last read, blank ones dropped. */
  lines: string[];
  /**
   * Whether this read actually consumed anything.
   *
   * A file that gained only half a line has not yet produced anything to
   * report, and saying otherwise is how a finished session gets counted as
   * active.
   */
  grew: boolean;
};

const NEWLINE = 0x0a;
const NOTHING: TailChunk = { lines: [], grew: false };

export function newCursor(): TailCursor {
  return { bytes: 0 };
}

/**
 * Read whatever complete lines a file has gained, advancing the cursor.
 *
 * A file that shrank was replaced rather than appended to; the cursor restarts
 * so the new content is read rather than skipped.
 */
export async function readNewLines(path: string, cursor: TailCursor): Promise<TailChunk> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return NOTHING;
  if (info.size < cursor.bytes) cursor.bytes = 0;
  if (info.size === cursor.bytes) return NOTHING;

  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return NOTHING;

  try {
    const length = info.size - cursor.bytes;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, cursor.bytes);
    const chunk = buffer.subarray(0, bytesRead);

    // Stop at the last complete line. What follows it is still being written.
    const end = chunk.lastIndexOf(NEWLINE);
    if (end < 0) return NOTHING;

    cursor.bytes += end + 1;
    const lines = chunk
      .subarray(0, end + 1)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    return { lines, grew: lines.length > 0 };
  } catch {
    return NOTHING;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
