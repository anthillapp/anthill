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

import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { eventFingerprint, type ObservationEvent } from "@anthill/live";

import type { ObservationEventDraft } from "./observers/types.js";

export class ObservationJournal {
  /** Events already on disk, per run, so a reopened run continues its numbering. */
  private readonly loaded = new Map<string, ObservationEvent[]>();
  private readonly fingerprints = new Map<string, Set<string>>();

  constructor(private readonly directory: string) {}

  private file(runId: string): string {
    return join(this.directory, `${runId}.jsonl`);
  }

  /** Everything recorded for a run, oldest first. */
  async read(runId: string): Promise<ObservationEvent[]> {
    const cached = this.loaded.get(runId);
    if (cached) return cached;

    const text = await readFile(this.file(runId), "utf8").catch(() => "");
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
    if (drafts.length === 0) return [];

    const events = await this.read(runId);
    const seen = this.fingerprints.get(runId) ?? new Set<string>();
    const recordedAt = new Date().toISOString();
    const added: ObservationEvent[] = [];

    for (const draft of drafts) {
      const fingerprint = eventFingerprint({ ...draft, runId });
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const event: ObservationEvent = {
        ...draft,
        runId,
        seq: events.length + added.length + 1,
        recordedAt,
      };
      added.push(event);
    }
    if (added.length === 0) return [];

    events.push(...added);
    this.fingerprints.set(runId, seen);

    await mkdir(this.directory, { recursive: true }).catch(() => undefined);
    await appendFile(
      this.file(runId),
      added.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    ).catch(() => undefined); // Losing a line is better than taking the app down.

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
    this.loaded.delete(runId);
    this.fingerprints.delete(runId);
    await rm(this.file(runId), { force: true }).catch(() => undefined);
  }
}
