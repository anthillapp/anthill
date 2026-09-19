/**
 * The app's half of the exchange: reading what the MCP server left behind.
 *
 * The server and the app never speak. The server writes a request into
 * `exchange/inbox/` and the app finds it on its own schedule, which is the same
 * posture Anthill already takes towards the harnesses it observes — no socket,
 * no listener, nothing for a crashed process on either side to leave dangling.
 * Two kinds of request arrive: show this workflow to the user, and follow this
 * run.
 *
 * It is a poll, and that is deliberate. Nothing in this repository watches the
 * filesystem, and an inbox is the wrong place to be the first: on macOS
 * `fs.watch` coalesces events, misses them under load, and fires for the
 * temporary files a writer creates beside the real one — so a watch needs a
 * poll behind it to be trusted, and once there is a poll the watch is the part
 * not carrying its weight.
 *
 * What this module will not do is repair anything. A request naming a revision
 * that cannot be read is reported to the user and consumed; it is never
 * rewritten, re-derived or quietly skipped. And a request is only consumed once
 * the app has done what it asked: a drop moved to `done/` is this app's record
 * that the user was shown their workflow, and an app that was closed, or a user
 * who kept what they had open, must not produce one.
 */

import type {
  ExchangeStore,
  InboxDrop,
  StoredRevision,
} from "@anthill/exchange-store";
import type { SourceHarness } from "@anthill/workflow-exchange";

import { writeWorkingCopy } from "./working-copy.js";

/**
 * How often the inbox is looked at.
 *
 * The two seconds the live service polls its observers on. A handover is
 * something a person is waiting for with a harness open beside them, so the
 * cadence that is fast enough to feel automatic there is fast enough here.
 */
const INBOX_POLL_MS = 2_000;

/**
 * How many registrations in a row may fail before the user is told.
 *
 * A few seconds of quiet retrying, rather than a box for a hiccup the next
 * pass would have cured. Said once, when the count is reached: the retries go
 * on, and repeating the message every two seconds would be the nagging the
 * declined set exists to avoid.
 */
const REGISTRATION_ATTEMPTS = 3;

/** Whether there is anywhere to put a workflow in front of the user. */
export type OpenPermission =
  /** Go ahead. */
  | "yes"
  /** There is no window. Nothing is lost by asking again shortly. */
  | "no_window"
  /** The user would rather keep what they have open. */
  | "declined";

/**
 * What became of one attempt to put a workflow on screen.
 *
 * Four answers, because "it did not open" covers three situations that want
 * opposite treatment and a boolean forces the reader to pick one of them for
 * all three. Only `refused` is a document this build cannot open, which is a
 * fact about the file and does not change by being tried again. The other two
 * are about the window: a parked handover is on its way to the next page that
 * asks for one, and an unconfirmed one was sent to a page that has not
 * answered yet — the ten-second wait for an acknowledgement is the likeliest
 * of the three to be seen, and treating it as a refusal was what made one slow
 * page silence a handover for the rest of the session.
 */
export type OpenOutcome =
  /** The page confirmed it is showing this document. */
  | { kind: "shown" }
  /** There was no page to send to; the path waits for the next one. */
  | { kind: "parked" }
  /** Sent, and the page did not say it opened it. Worth asking again. */
  | { kind: "unconfirmed"; error: string }
  /** The document itself cannot be opened. Asking again would not help. */
  | { kind: "refused"; error: string };

/** A run the server bound, and everything needed to start following it. */
export type BoundRun = {
  sessionId?: string;
  boundAt: string;
  runId: string;
  nonce: string;
  /** The harness that handed the workflow over. The run is that tool's. */
  harness: SourceHarness;
  /** The document's own id, which is how a run is tied to what is open. */
  workflowId: string;
  /** The exact content the run is working from, digest and all. */
  revision: StoredRevision;
};

/**
 * Everything this reader needs from the window, and nothing else.
 *
 * Injected rather than imported so the reader can be tested: the real versions
 * of these open dialogs, push routes at the renderer and register runs with the
 * live service, none of which exists outside Electron.
 */
export type InboxEffects = {
  /**
   * Whatever keeps window work from overlapping, where there is a window.
   *
   * It covers asking the question and writing the working copy, and nothing
   * after them. The queue is shared with the window's own close handler, and
   * waiting inside it for the page to acknowledge a document is waiting for as
   * long as the page takes.
   */
  serialize?<T>(work: () => Promise<T>): Promise<T>;
  /**
   * May a workflow replace what the user is looking at?
   *
   * Asked before the working copy is written rather than after. The answer can
   * be no, only the person can give it, and a working copy overwritten on the
   * way to being refused would leave a harness's content in a file the user
   * believes is theirs.
   */
  mayOpen(path?: string): Promise<OpenPermission>;
  /** Open the workflow at this path, as the Open command would. */
  open(path: string): Promise<OpenOutcome>;
  /** Tell the user about something that arrived and cannot be acted on. */
  refuse(message: string): Promise<void>;
  /** Give a bound run somewhere for its progress to appear. */
  register(run: BoundRun): Promise<boolean>;
};

export class ExchangeInbox {
  private timer: NodeJS.Timeout | undefined;
  /** Whether a pass is in flight, so a slow one is not overlapped by the next. */
  private reading = false;
  /**
   * Requests the user has already said no to.
   *
   * A declined drop stays in the inbox, because the request has not been
   * carried out and saying otherwise would tell the harness the user saw
   * something they did not. But asking again two seconds later is not asking,
   * it is nagging, so the answer is remembered for as long as this process
   * runs. The next start asks once more, by which time whatever the user was
   * protecting has been saved or abandoned.
   */
  private readonly declined = new Set<string>();

  /**
   * Damaged requests the user has already been told about.
   *
   * Consuming one can itself be refused — a `done/` record that disagrees with
   * the pending copy is exactly the damage being reported, and the store will
   * not write over either of them — so the request can still be there on the
   * next pass. Without this it would put the same box in front of the user
   * every two seconds for as long as the app is open.
   */
  private readonly reported = new Set<string>();

  /**
   * How many passes in a row each bind request has failed to register.
   *
   * A registration that fails is retried on the next pass and says nothing,
   * which is right for the first few — the live service may be starting, or
   * its store may be briefly unwritable — and wrong for ever. A run whose
   * registration never takes is a run whose progress reports land in the CLI's
   * log with nothing watching for them, and the only sign of it is a Live
   * Session page that stays empty while the harness works.
   */
  private readonly registrationFailures = new Map<string, number>();

  constructor(
    private readonly store: ExchangeStore,
    private readonly effects: InboxEffects,
    private readonly pollMs: number = INBOX_POLL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.look(), this.pollMs);
    // Nothing here should be the reason the process stays alive.
    this.timer.unref?.();
    // A workflow handed over while the app was closed is already waiting, and
    // two seconds of an empty launch window is two seconds of looking broken.
    this.look();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass over the inbox.
   *
   * Public so a test can drive it without a clock, and so `start` can take a
   * look at once rather than waiting out its first interval. Two passes never
   * overlap: a slow one — a dialog the user has not answered — would otherwise
   * be asked the same question again underneath itself.
   */
  async read(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      await this.pass();
    } finally {
      this.reading = false;
    }
  }

  /**
   * A look that cannot fail the caller.
   *
   * Everything a pass can throw is a filesystem the app does not control — a
   * permission, a volume that went away — and the answer to all of it is the
   * same: say so where somebody can find it, and look again in two seconds.
   * `read` propagates instead, so a test sees what happened.
   */
  private look(): void {
    void this.read().catch((error) => {
      console.error("[anthill] could not read the exchange inbox:", error);
    });
  }

  private async pass(): Promise<void> {
    const { drops, damaged } = await this.store.listInbox();

    for (const { key, problem } of damaged) {
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      await this.effects.refuse(problem.message);
      // Consumed rather than left alone. A drop that merely failed to parse is
      // reported only after failing twice, so this is not a file caught
      // mid-arrival, and a request nobody can read does not become readable by
      // being read again every two seconds. The copy in `done/` is the
      // evidence; nothing about it was repaired, and the store refuses the
      // consume outright where that would mean writing over a record.
      await this.store.consumeInbox(key);
    }

    // Binds first, and all of them: registering a run touches no window and
    // asks the user nothing, so there is no reason for one to wait behind a
    // workflow somebody has yet to look at.
    for (const drop of drops) {
      if (drop.kind === "bind") await this.follow(drop);
    }

    // At most one workflow is offered per pass. The screen shows one thing at a
    // time, and the question a second one would have to ask — whether to
    // discard the work the first just put on screen — is one the user has had
    // no chance to answer yet.
    const next = drops.find((drop) => drop.kind === "display" && !this.declined.has(drop.key));
    if (next) await this.display(next);
  }

  /**
   * Put a submitted revision in front of the user.
   *
   * The order is the whole of it: read what is being asked for, ask whether it
   * may be shown, write the working copy, open it, and only then record the
   * request as carried out.
   *
   * The window's queue is held for the question and the write and let go
   * before the page is waited on. Those two are what must not race the
   * window's own dialogs; an acknowledgement takes as long as the renderer
   * takes to mount a document, and holding a queue that the close handler
   * shares for that long swallowed every close click for ten seconds and
   * answered every other request with "there is no window".
   */
  private async display(drop: InboxDrop): Promise<void> {
    const revision = await this.store.readRevision(drop.workflowId, drop.revision);
    if (!revision) {
      await this.effects.refuse(
        `Anthill was asked to show revision ${drop.revision} of ${drop.workflowId} and cannot read it. Nothing was changed.`,
      );
      await this.store.consumeInbox(drop.key);
      return;
    }

    const path = this.store.workingCopyPath(drop.workflowId);
    const prepared = await this.serialized(() => this.prepare(drop, path, revision.workflow));
    if (!prepared) return;

    const opened = await this.effects.open(path);
    if (opened.kind === "shown") {
      // Only a confirmed display acknowledges the handover.
      await this.store.consumeInbox(drop.key);
      return;
    }
    if (opened.kind === "refused") {
      await this.effects.refuse(
        `Anthill could not open ${drop.workflowId}, which was handed over to it: ${opened.error}`,
      );
      this.declined.add(drop.key);
    }
    // `parked` and `unconfirmed` are neither. Nothing was said no to, so the
    // request stays where it is and the next pass asks again — the same answer
    // `no_window` already gets, and for the same reason: the user has not
    // refused anything, the window simply was not ready to be told.
  }

  /**
   * Ask whether this workflow may take the screen, and lay it down if it may.
   *
   * `false` means the pass is over for this drop, and whichever of the three
   * reasons applies has already recorded itself.
   */
  private async prepare(drop: InboxDrop, path: string, workflow: StoredRevision["workflow"]): Promise<boolean> {
    const permission = await this.effects.mayOpen(path);
    // Left exactly where it is, both times. The workflow is stored and the
    // request still stands; what has not happened is the user seeing it.
    if (permission === "no_window") return false;
    if (permission === "declined") {
      this.declined.add(drop.key);
      return false;
    }

    try {
      await writeWorkingCopy(path, workflow);
    } catch (error) {
      this.declined.add(drop.key);
      await this.effects.refuse(
        `Anthill could not prepare ${drop.workflowId}: ${error instanceof Error ? error.message : String(error)} The handover remains pending. Fix the file or storage problem, then reopen its link or restart Anthill.`,
      );
      return false;
    }
    return true;
  }

  /** Whatever the host uses to keep window work from overlapping, if it has one. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    return this.effects.serialize ? this.effects.serialize(work) : work();
  }

  /** Start following a run the server bound to a revision. */
  private async follow(drop: InboxDrop): Promise<void> {
    const stored = await this.store.readWorkflow(drop.workflowId);
    // The store's own reader refuses a bind drop that names no run, so a drop
    // without one cannot arrive through `listInbox`. The check is what lets the
    // rest of this read plainly.
    const binding = drop.runId
      ? stored?.bindings.find((candidate) => candidate.runId === drop.runId)
      : undefined;
    const revision = binding
      ? await this.store.readRevision(drop.workflowId, binding.revision)
      : undefined;
    const harness = stored?.identity?.source.harness;

    if (!binding || !revision || !harness || drop.revision !== binding.revision ||
        (binding.digest && binding.digest !== revision.digest)) {
      await this.effects.refuse(
        `Anthill was asked to follow run ${drop.runId ?? "(unnamed)"} of ${drop.workflowId} and cannot read what it is bound to. The run will not appear on the Live Session page.`,
      );
      await this.store.consumeInbox(drop.key);
      return;
    }

    const registered = await this.effects.register({
      runId: binding.runId,
      nonce: binding.nonce,
      boundAt: binding.at,
      ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
      harness,
      workflowId: binding.workflowId,
      revision,
    });

    // A registration that did not happen leaves the request where it is, so the
    // next pass tries again. The alternative is a run reporting progress that
    // nothing is listening for, which looks to the user like a harness that
    // never started.
    if (registered) {
      this.registrationFailures.delete(drop.key);
      await this.store.consumeInbox(drop.key);
      return;
    }

    const failures = (this.registrationFailures.get(drop.key) ?? 0) + 1;
    this.registrationFailures.set(drop.key, failures);
    // Said once, on the pass that reaches the count. Retrying in silence for
    // ever is how a bound run stays invisible while the harness works through
    // it, and the same failure on the display path has always raised a box.
    if (failures === REGISTRATION_ATTEMPTS) {
      await this.effects.refuse(
        `Anthill has failed ${failures} times to start following run ${binding.runId} of ${drop.workflowId}. The run is bound to revision ${binding.revision} and the harness may already be working on it, but its progress reports have nothing watching for them, so the run will not appear on the Live Session page. Anthill keeps trying; restarting it is the other way out. Nothing was changed.`,
      );
    }
  }
}
