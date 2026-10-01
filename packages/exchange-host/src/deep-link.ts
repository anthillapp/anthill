/** Links carry an identity, never a filesystem path or an instruction to run. */
export function workflowIdFromLink(value: string): string | undefined {
  const match = /^anthill:\/\/workflow\/([^/?#]+)$/.exec(value);
  if (!match) return undefined;
  try {
    const id = decodeURIComponent(match[1]!);
    return id && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id) && id !== "." && id !== ".." ? id : undefined;
  } catch {
    return undefined;
  }
}

export function linksFromArgv(argv: readonly string[]): string[] {
  return argv.filter((arg) => /^anthill:/i.test(arg));
}

/**
 * One pass at a time over a set anything may add to, and never a missed
 * addition.
 *
 * The links waiting to be opened are drained by three different things — a
 * link arriving, a close the user cancelled, and the page asking for its
 * pending workflow — and a pass stops in the middle for a dialog. A second
 * call arriving then walked the same set: one link was carried out twice, and
 * a link the user had already said no to asked them again. A plain in-flight
 * flag would fix that and introduce the opposite fault, because a link that
 * arrives during a pass would then wait for whatever event happens next. So
 * the second call is recorded as a request, and the pass runs again for it.
 */
export class SerialDrain {
  private running = false;
  private again = false;
  constructor(private readonly pass: () => Promise<void>) {}
  async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }
}

/** Closing and replacing a document must not race their async dirty dialogs. */
export class WindowOperations {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * What became of one attempt to put a document in front of the user.
 *
 * A missing page leaves the request in its source queue; a user declining
 * navigation must not be asked again at every poll. A message that was sent
 * but never acknowledged is neither a confirmed display nor a refusal.
 */
export type Delivery =
  /** The page acknowledged this exact path. */
  | "shown"
  /** There was no page to send to. The caller keeps its request pending. */
  | "parked"
  /** The page's final discard check was declined. */
  | "declined"
  /** It was sent, and nothing came back. */
  | "unconfirmed";

/** An IPC send is not an acknowledgement that the page opened the document. */
export class WorkflowDelivery {
  currentPath: string | undefined;
  private sequence = 0;
  private active?: PendingDelivery;
  private readonly pending = new Map<string, PendingDelivery>();

  /** A separate navigation queue: waiting for a page must not hold the close queue. */
  deliver(path: string, send: (id: number) => boolean, timeoutMs = 10_000): Promise<Delivery> {
    const existing = this.pending.get(path);
    if (existing) return existing.promise;
    if (!this.active && this.currentPath === path) return Promise.resolve("shown");
    let settle!: (outcome: Delivery) => void;
    const promise = new Promise<Delivery>((resolve) => { settle = resolve; });
    const record: PendingDelivery = {
      id: ++this.sequence, path, promise, send, timeoutMs,
      finish: (outcome) => {
        if (this.pending.get(path) !== record) return;
        clearTimeout(record.timer);
        this.pending.delete(path);
        if (this.active === record) this.active = undefined;
        settle(outcome);
        queueMicrotask(() => this.dispatch());
      },
    };
    this.pending.set(path, record);
    this.dispatch();
    return promise;
  }

  private dispatch(): void {
    if (this.active) return;
    const record = this.pending.values().next().value;
    if (!record) return;
    this.active = record;
    if (this.currentPath === record.path) { record.finish("shown"); return; }
    record.timer = setTimeout(() => record.finish("unconfirmed"), record.timeoutMs);
    try {
      if (!record.send(record.id)) record.finish("parked");
    } catch {
      record.finish("unconfirmed");
    }
  }

  acknowledge(path: string, id?: number, outcome: "shown" | "declined" | "confirming" | "opening" = "shown"): void {
    if (id === undefined) {
      if (outcome === "shown") this.currentPath = path || undefined;
      return;
    }
    if (this.active?.id !== id || this.active.path !== path) return;
    if (outcome === "confirming" || outcome === "opening") {
      clearTimeout(this.active.timer);
      const record = this.active;
      if (outcome === "opening") record.timer = setTimeout(() => record.finish("unconfirmed"), record.timeoutMs);
      return;
    }
    if (outcome === "shown") this.currentPath = path;
    this.active.finish(outcome);
  }
  reset(): void {
    this.currentPath = undefined;
    for (const record of this.pending.values()) record.finish("unconfirmed");
  }
}

type PendingDelivery = {
  id: number;
  path: string;
  promise: Promise<Delivery>;
  send: (id: number) => boolean;
  timeoutMs: number;
  timer?: NodeJS.Timeout;
  finish(outcome: Delivery): void;
};
