/**
 * The append-only record of what Anthill observed for one run.
 *
 * One JSONL file per Anthill run, in Anthill's own user-data folder. It is the
 * durable half of the Live Session page: the page is a fold over this log, so a
 * session can be reopened after a restart and show exactly what it showed
 * before, and a defect in the fold can be reproduced from the file rather than
 * from a session nobody can start again.
 *
 * Two rules make the log trustworthy:
 *
 * - **Append only.** Nothing here rewrites or removes an event. A later read of
 *   the same transcript cannot change what was already recorded.
 * - **Written once.** Observers re-read files as they grow and can legitimately
 *   see the same record twice; a fingerprint of the vendor's own fields keeps
 *   the second sighting out of the log, so the sequence numbers stay meaningful.
 *
 * JSONL rather than a database, for the same reason as elsewhere in Anthill:
 * the file is the record, it is readable without Anthill, and a half-written
 * last line costs one event instead of the log.
 */

import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { eventFingerprint, isRunId, type ObservationEvent } from "@anthill/live";

import type { ObservationEventDraft } from "./observers/types.js";

export class ObservationJournal {
  /** Events already on disk, per run, so a reopened run continues its numbering. */
  private readonly loaded = new Map<string, ObservationEvent[]>();
  private readonly fingerprints = new Map<string, Set<string>>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  /**
   * The log for one run, or nothing when the id is not one of ours.
   *
   * A run id arrives here from the renderer — `liveCancel` carries one — and
   * becomes a file name. `../../something` addressed a file outside this
   * directory, and `forget` deletes what this resolves to, so a traversal id
   * deleted somebody else's `.jsonl` (ANT-96).
   *
   * The id is refused rather than repaired. Replacing bad characters would
   * give two different ids one file, and a session would then read and delete
   * another's record — a quieter bug than the one being fixed.
   */
  private file(runId: string): string | undefined {
    return isRunId(runId) ? join(this.directory, `${runId}.jsonl`) : undefined;
  }

  /** Everything recorded for a run, oldest first. */
  async read(runId: string): Promise<ObservationEvent[]> {
    const cached = this.loaded.get(runId);
    if (cached) return cached;

    const path = this.file(runId);
    if (!path) return [];
    let text = "";
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { text = await handle.readFile("utf8"); }
      finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const events: ObservationEvent[] = [];
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line) as ObservationEvent;
        // The same dedup on the way in as on the way out. A second app
        // instance sharing this file — each with its own fingerprint set —
        // once interleaved a full duplicate of a session into a journal, and
        // a record that can be appended twice must at least refuse to be
        // *read* twice, or the feed shows every action doubled. The first
        // occurrence wins; its seq ordering is the coherent one.
        const fingerprint = eventFingerprint(event);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        events.push(event);
      } catch {
        // The last line of a log from a killed app may be half-written.
      }
    }
    this.loaded.set(runId, events);
    this.fingerprints.set(runId, seen);
    return events;
  }

  /**
   * Add what a poll saw, skipping anything already recorded.
   *
   * Returns the events that were actually new, so a caller can tell whether
   * there is anything worth telling the renderer about.
   */
  async append(runId: string, drafts: readonly ObservationEventDraft[]): Promise<ObservationEvent[]> {
    const result = this.writing.then(() => this.appendBatch(runId, drafts));
    this.writing = result.then(() => undefined, () => undefined);
    return result;
  }

  private async appendBatch(runId: string, drafts: readonly ObservationEventDraft[]): Promise<ObservationEvent[]> {
    if (drafts.length === 0) return [];
    // Checked before any work rather than at the write: an id with no file of
    // ours behind it should not be given a sequence number either.
    const path = this.file(runId);
    if (!path) return [];

    const events = await this.read(runId);
    const seen = this.fingerprints.get(runId) ?? new Set<string>();
    const recordedAt = new Date().toISOString();
    const added: ObservationEvent[] = [];
    // Held apart from `seen`, which is the cached set itself: marking a
    // fingerprint there before the write means a failed write still leaves the
    // event recorded as already handled, which is the bug being fixed.
    const marked = new Set<string>();

    for (const draft of drafts) {
      const fingerprint = eventFingerprint({ ...draft, runId });
      if (seen.has(fingerprint) || marked.has(fingerprint)) continue;
      marked.add(fingerprint);

      const event: ObservationEvent = {
        ...draft,
        runId,
        seq: events.length + added.length + 1,
        recordedAt,
      };
      added.push(event);
    }
    if (added.length === 0) return [];

    /*
     * The file first, and the memory of it only if that worked.
     *
     * These were the other way round, with the write's failure swallowed: a
     * full disk or a permissions error left the events pushed into the cache
     * and their fingerprints marked seen, so the log had no record of them and
     * nothing would ever write them again — the next poll saw the same
     * transcript lines and skipped them as already recorded. The page showed
     * them until the app closed and could not show them afterwards (ANT-97).
     *
     * A failure is raised so the service rewinds its observer cursors before
     * retrying. Otherwise their offsets have already consumed this batch.
     */
    await mkdir(this.directory, { recursive: true });
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      // Separate a partial last record left by an interrupted append from the
      // retried batch. Complete duplicates are removed by fingerprint on read.
      await handle.writeFile("\n" + added.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
      await handle.sync();
    } finally { await handle.close(); }

    events.push(...added);
    for (const fingerprint of marked) seen.add(fingerprint);
    this.fingerprints.set(runId, seen);
    return added;
  }

  /**
   * What the page is given: everything, unless a caller asks for less.
   *
   * It used to default to the last thousand, which was a cap on how much the
   * *feed* draws applied to how much the page is allowed to *know*. The
   * diagram is a fold over this record, so once a session passed a thousand
   * events the steps announced early scrolled out from under it and blocks
   * that had run for an hour went back to saying "Waiting its turn"
   * (ANT-73). Drawing is bounded where the drawing happens.
   */
  async tail(runId: string, limit?: number): Promise<ObservationEvent[]> {
    const events = await this.read(runId);
    return limit === undefined ? events : events.slice(-limit);
  }

  /** Drop a run's log entirely — used when the user stops observing it. */
  async forget(runId: string): Promise<void> {
    const result = this.writing.then(async () => {
      const path = this.file(runId);
      if (path) await rm(path, { force: true });
      this.loaded.delete(runId);
      this.fingerprints.delete(runId);
    });
    this.writing = result.catch(() => undefined);
    return result;
  }
}
