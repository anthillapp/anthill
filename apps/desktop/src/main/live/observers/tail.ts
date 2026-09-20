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
export type TailCursor = { bytes: number; identity?: string; discardingLine?: boolean };

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
  /**
   * Bytes stepped over because one line was longer than a whole read.
   *
   * Reported rather than swallowed: an observer that silently skipped part of
   * a transcript would go on describing the session as though it had read all
   * of it. Nothing is inferred from the gap — it is not progress, and it is
   * not silence either.
   */
  skippedBytes?: number;
};

const NEWLINE = 0x0a;
const NOTHING: TailChunk = { lines: [], grew: false };

/**
 * The most a single read may take.
 *
 * The whole unread remainder used to be allocated at once, which is fine while
 * a transcript is small and is not what a first read of a long session looks
 * like: opening Anthill against a session that has been running all day asked
 * for one buffer the size of its entire transcript (ANT-99).
 *
 * A capped read is not a lost read. The cursor advances by what was consumed,
 * so the next poll continues where this one stopped, and polls are two seconds
 * apart — a backlog drains over a few of them instead of one allocation.
 */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export function newCursor(): TailCursor {
  return { bytes: 0 };
}

/** Drain the retained old hook log before crossing a rotation boundary. */
export async function readRotatingLines(path: string, cursor: TailCursor): Promise<TailChunk> {
  const previous = await stat(`${path}.1`).catch(() => undefined);
  const current = await stat(path).catch(() => undefined);
  const identity = (info: NonNullable<typeof previous>) => `${info.dev}:${info.ino}`;
  if (previous && (cursor.identity === undefined ||
      (identity(previous) === cursor.identity && (!current || identity(current) !== cursor.identity)))) {
    const old = await readNewLines(`${path}.1`, cursor);
    if (cursor.bytes < previous.size && (old.grew || old.skippedBytes)) return old;
    // A partial final line cannot be finished once the file has rotated.
    const next = await readNewLines(path, cursor);
    return { lines: [...old.lines, ...next.lines], grew: old.grew || next.grew,
      ...((old.skippedBytes || next.skippedBytes) ? { skippedBytes: (old.skippedBytes ?? 0) + (next.skippedBytes ?? 0) } : {}) };
  }
  return readNewLines(path, cursor);
}

/**
 * Read whatever complete lines a file has gained, advancing the cursor.
 *
 * A file that shrank was replaced rather than appended to; the cursor restarts
 * so the new content is read rather than skipped.
 */
export async function readNewLines(path: string, cursor: TailCursor): Promise<TailChunk> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return NOTHING;

  try {
    const info = await handle.stat();
    const identity = `${info.dev}:${info.ino}`;
    if ((cursor.identity !== undefined && cursor.identity !== identity) || info.size < cursor.bytes) {
      cursor.bytes = 0;
      cursor.discardingLine = false;
    }
    cursor.identity = identity;
    if (info.size === cursor.bytes) return NOTHING;
    const remaining = info.size - cursor.bytes;
    const length = Math.min(remaining, MAX_CHUNK_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, cursor.bytes);
    const chunk = buffer.subarray(0, bytesRead);

    // A capped read can stop halfway through an oversized record. Its suffix
    // is not a new JSONL record, even if it happens to look like valid JSON.
    let start = 0;
    if (cursor.discardingLine) {
      const first = chunk.indexOf(NEWLINE);
      if (first < 0) {
        cursor.bytes += bytesRead;
        return { lines: [], grew: false, skippedBytes: bytesRead };
      }
      start = first + 1;
      cursor.discardingLine = false;
    }

    // Stop at the last complete line. What follows it is still being written.
    const end = chunk.lastIndexOf(NEWLINE);
    if (end < 0) {
      /*
       * A line longer than one whole read.
       *
       * Without this the cursor never moves: every poll asks for the same
       * bytes, finds no newline, and reports nothing — for as long as the file
       * exists. The line is stepped over rather than waited for, because it
       * cannot be completed by waiting and the records after it can still be
       * read. Only a *full* chunk means that; a short one is a line still
       * being written, which is the ordinary case and must keep waiting.
       */
      if (bytesRead >= MAX_CHUNK_BYTES) {
        cursor.bytes += bytesRead;
        cursor.discardingLine = true;
        return { lines: [], grew: false, skippedBytes: bytesRead };
      }
      return NOTHING;
    }

    cursor.bytes += end + 1;
    const lines = chunk
      .subarray(start, end + 1)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    return { lines, grew: lines.length > 0, ...(start ? { skippedBytes: start } : {}) };
  } catch {
    return NOTHING;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
