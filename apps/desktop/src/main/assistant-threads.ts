/**
 * What the author and the assistant said to each other, per workflow.
 *
 * The thread was React state inside the panel, so closing the panel destroyed
 * it: reopening the assistant over the same workflow began from an empty sheet,
 * and every request, refusal and proposal that had been argued out was gone
 * (ANT-82). The sidebar's whole premise is that nothing leaves the thread, and
 * a record that cannot survive its own close button does not keep that promise.
 *
 * So the thread lives here, next to the other things Anthill remembers about a
 * machine, with the properties that follow from what it is:
 *
 * - **Keyed by the workflow's own id**, which is minted when the workflow is
 *   created and written into its file, so the same thread comes back after a
 *   save, a reopen, and a restart — and a conversation begun before the first
 *   save is already attached to the thing it was about.
 * - **One thread per workflow, never merged.** Two workflows are two
 *   conversations; reading one can never return the other's.
 * - **Turns are stored as written and given back as written.** This store does
 *   not know what a turn is — the panel owns that shape and validates on the
 *   way in — so a turn kind added later needs no migration here.
 * - **Writes are serialized and atomic**, the lesson ANT-7 paid for: every
 *   write joins one chain and lands whole via a temp file and a rename, so a
 *   crash mid-write leaves the previous record rather than half of this one.
 *
 * Nothing here is sent anywhere. The file sits in Anthill's own folder beside
 * the pending runs and the agent library.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The envelope's version.
 *
 * Bumped when the *file's* shape changes, not when a turn kind is added. A file
 * written by a newer Anthill is read as empty rather than guessed at: giving
 * back turns from a shape this version does not understand is how a thread
 * comes back subtly wrong, which is worse than coming back missing.
 */
export const THREADS_VERSION = 1;

/**
 * How many workflows' threads are kept.
 *
 * A bound on the file, not on any conversation: threads are dropped whole and
 * oldest-first, never trimmed from the inside, because a thread with its
 * beginning missing is a worse answer than no thread at all.
 */
const KEEP_THREADS = 40;

type Thread = { updatedAt: string; turns: unknown[] };

type Stored = { version: number; threads: Record<string, Thread> };

const EMPTY: Stored = { version: THREADS_VERSION, threads: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the file into a shape this version understands.
 *
 * Every failure lands on the same answer — no threads — because none of them is
 * a reason to stop the workflow opening. A missing file is a machine that has
 * not used the assistant yet; a corrupt one is a machine that will get a fresh
 * record the next time something is said.
 */
function parse(text: string): Stored {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return EMPTY;
  }
  if (!isRecord(value) || value.version !== THREADS_VERSION) return EMPTY;
  if (!isRecord(value.threads)) return EMPTY;

  const threads: Record<string, Thread> = {};
  for (const [id, thread] of Object.entries(value.threads)) {
    if (!isRecord(thread) || !Array.isArray(thread.turns)) continue;
    const updatedAt = typeof thread.updatedAt === "string" ? thread.updatedAt : "";
    threads[id] = { updatedAt, turns: thread.turns };
  }
  return { version: THREADS_VERSION, threads };
}

export class AssistantThreadStore {
  private stored?: Stored;
  private loading?: Promise<Stored>;
  private writing: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  constructor(
    private readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** This workflow's turns, oldest first. An unknown workflow has none. */
  async read(workflowId: string): Promise<unknown[]> {
    if (!workflowId) return [];
    const stored = await this.load();
    return stored.threads[workflowId]?.turns ?? [];
  }

  /**
   * Record this workflow's thread as it now stands.
   *
   * The whole thread each time rather than an append: the panel is the author
   * of the record and turns change after they are made — a proposal becomes
   * applied, or refuses and gains a reason — so the last word on what a thread
   * contains has to be the panel's, not an accumulation this store guessed at.
   *
   * An empty thread is stored as an absence. There is nothing to come back to,
   * and keeping the key would have the file grow one entry per workflow that
   * was merely opened with the panel showing.
   */
  async write(workflowId: string, turns: unknown[]): Promise<void> {
    if (!workflowId) return;
    const stored = await this.load();
    if (turns.length === 0) {
      delete stored.threads[workflowId];
    } else {
      stored.threads[workflowId] = { updatedAt: this.now(), turns };
    }
    this.prune(stored);
    await this.flush();
  }

  /** Forget this workflow's thread. Asked for explicitly, never inferred. */
  async clear(workflowId: string): Promise<void> {
    if (!workflowId) return;
    const stored = await this.load();
    delete stored.threads[workflowId];
    await this.flush();
  }

  private load(): Promise<Stored> {
    if (this.stored) return Promise.resolve(this.stored);
    this.loading ??= readFile(this.path, "utf8").then(
      (text) => (this.stored = parse(text)),
      // No file yet, or one this process cannot read. Either way, start clean
      // rather than refuse — the assistant opening matters more than the record.
      () => (this.stored = { version: THREADS_VERSION, threads: {} }),
    );
    return this.loading;
  }

  /** Keep the file bounded by dropping the threads nobody has touched lately. */
  private prune(stored: Stored): void {
    const ids = Object.keys(stored.threads);
    if (ids.length <= KEEP_THREADS) return;
    const oldest = ids
      .sort((a, b) => (stored.threads[a].updatedAt < stored.threads[b].updatedAt ? -1 : 1))
      .slice(0, ids.length - KEEP_THREADS);
    for (const id of oldest) delete stored.threads[id];
  }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(this.stored ?? EMPTY, null, 2);
    this.writing = this.writing.then(() => this.persist(snapshot));
    await this.writing;
  }

  private async persist(snapshot: string): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      this.writeSeq += 1;
      const temp = `${this.path}.${process.pid}.${this.writeSeq}.tmp`;
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, this.path);
    } catch {
      // Losing the record is better than taking the app down.
    }
  }
}
