/**
 * Where pending runs live between app launches.
 *
 * Small enough to be one JSON file: a copied prompt is a short-lived thing, and
 * a handful of records is all this feature ever holds. It lives in Anthill's own
 * user-data folder and nowhere else — nothing is written near the user's
 * project, and nothing is sent anywhere.
 *
 * What is kept is deliberately thin: a run id, a nonce, the chosen CLI, the
 * workflow's id and name, and whatever the observers learned. Not the prompt — a
 * hash stands in for it, which is enough to tell one copy from another without
 * keeping the text.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { expireIfStale, isExpired, isOpen, type PendingRun } from "@anthill/live";

export class PendingRunStore {
  private runs: PendingRun[] = [];
  private loaded = false;
  /**
   * The read in flight, so concurrent callers share one.
   *
   * Two callers could both pass the `loaded` guard before either read
   * finished, and the second one's assignment overwrote whatever had been
   * written in between — which at startup is exactly when a run is registered.
   */
  private loading?: Promise<PendingRun[]>;
  /** Runs removed while the first read was still in flight. */
  private forgotten = new Set<string>();
  /**
   * All disk writes, chained.
   *
   * Two flushes racing on one file can land in either order, and losing that
   * race meant an older snapshot overwrote a newer one. Every write now joins
   * the back of this chain, so the file's last writer is always the caller
   * with the newest state.
   */
  private writing: Promise<void> = Promise.resolve();
  private mutations: Promise<void> = Promise.resolve();
  /** Distinguishes this writer's temp file from a concurrent process's. */
  private writeSeq = 0;

  constructor(private readonly path: string) {}

  /**
   * Read what was left behind, dropping anything too old to explain.
   *
   * A matched run is restored open even when its window lapsed while the app
   * was closed. Anthill has not looked since — the session may have gone on
   * writing all night — and settling the run from what was true at shutdown
   * would be deciding without looking. The first poll re-reads the records
   * (the observers start with fresh cursors, and the journal de-duplicates),
   * and *then* the ordinary rules apply: new evidence revives it, silence that
   * long closes it. Either way the answer comes from the file, not the clock.
   *
   * A run that never matched stays on the discovery clock: nothing was ever
   * being read, so there is nothing to look at again.
   */
  load(now: string): Promise<PendingRun[]> {
    if (this.loaded) return Promise.resolve(this.runs);
    // Handing back the read itself, rather than awaiting it inside an async
    // method, is what makes the single flight visible: every caller during the
    // first read holds the same promise.
    this.loading ??= this.read(now);
    return this.loading;
  }

  private async read(now: string): Promise<PendingRun[]> {
    const text = await readFile(this.path, "utf8").catch(() => "");
    let parsed: unknown = [];
    try {
      parsed = text ? JSON.parse(text) : [];
    } catch {
      parsed = [];
    }
    // Two passes, in this order. First settle anything whose window ran out
    // while the app was closed — a run cannot come back as "waiting" for a
    // session that can no longer appear. Then drop what is too old to explain.
    const onDisk = (Array.isArray(parsed) ? (parsed as PendingRun[]) : [])
      .map((run) => (run.detectedSessionId && isOpen(run) ? run : expireIfStale(run, now)))
      .filter((run) => !isExpired(run, now));

    // Anything already in memory arrived while this read was in flight, so it
    // is newer than the file and wins; anything removed in that window stays
    // removed rather than coming back from disk.
    const held = new Set(this.runs.map((run) => run.anthillRunId));
    this.runs = [
      ...this.runs,
      ...onDisk.filter(
        (run) => !held.has(run.anthillRunId) && !this.forgotten.has(run.anthillRunId),
      ),
    ];
    this.loaded = true;
    this.forgotten.clear();
    // The merged state is flushed before `loading` clears: a caller who saw
    // the store mid-read had their write skipped on the promise that this
    // flush would carry it, so it must happen while that promise still holds.
    await this.flush();
    this.loading = undefined;
    return this.runs;
  }

  all(): PendingRun[] {
    return this.runs;
  }

  find(runId: string): PendingRun | undefined {
    return this.runs.find((run) => run.anthillRunId === runId);
  }

  async put(run: PendingRun, requireDurable = false): Promise<void> {
    if (requireDurable) return this.mutate(async () => {
      await this.load(run.createdAt);
      await this.putRecord(run, true);
    });
    return this.putRecord(run, false);
  }

  private async putRecord(run: PendingRun, requireDurable: boolean): Promise<void> {
    const index = this.runs.findIndex((item) => item.anthillRunId === run.anthillRunId);
    const previous = index >= 0 ? this.runs[index] : undefined;
    if (index >= 0) this.runs[index] = run;
    else this.runs.unshift(run);
    try {
      await this.save(requireDurable);
    } catch (error) {
      const held = this.runs.indexOf(run);
      if (held >= 0) {
        if (previous) this.runs[held] = previous;
        else this.runs.splice(held, 1);
      }
      throw error;
    }
  }

  async remove(runId: string, requireDurable = false): Promise<void> {
    if (requireDurable) return this.mutate(async () => {
      if (this.loading) await this.loading;
      const previous = this.runs;
      this.runs = previous.filter((run) => run.anthillRunId !== runId);
      try { await this.save(true); }
      catch (error) { this.runs = previous; throw error; }
    });
    if (!this.loaded) this.forgotten.add(runId);
    this.runs = this.runs.filter((run) => run.anthillRunId !== runId);
    await this.save();
  }

  private mutate(action: () => Promise<void>): Promise<void> {
    const result = this.mutations.then(action);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  /**
   * Write, unless a read is still in flight.
   *
   * Writing mid-read would put a partial view — everything registered since
   * the app started, and nothing from before it — over the very file the read
   * is on its way to open. Whether that lost the file's contents came down to
   * which of the two won a race on the disk. The read merges and flushes when
   * it lands, so skipping the write here loses nothing.
   */
  private async save(requireDurable = false): Promise<void> {
    if (this.loading) {
      if (!requireDurable) return;
      await this.loading;
    }
    await this.flush(requireDurable);
  }

  async flush(requireDurable = false): Promise<void> {
    // The snapshot is taken now, not when the chain gets round to it — the
    // chain orders writes, and each write carries the state its caller saw.
    // In practice later state is a superset, so last-writer-wins is right.
    const snapshot = JSON.stringify(this.runs, null, 2);
    const written = this.writing.then(() => this.persist(snapshot));
    this.writing = written.catch(() => undefined);
    if (requireDurable) await written;
    else await this.writing;
  }

  /**
   * One serialized write: whole file to a temp name, then rename over.
   *
   * The rename is what makes a crash boring — the file is only ever an old
   * complete snapshot or a new complete snapshot, never a truncated one.
   */
  private async persist(snapshot: string): Promise<void> {
    const temp = `${this.path}.${process.pid}.${++this.writeSeq}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temp, snapshot, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
