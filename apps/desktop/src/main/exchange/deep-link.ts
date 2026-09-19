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
 * Three answers rather than a boolean, because the two ways of not succeeding
 * call for opposite treatment and a caller given `false` cannot tell them
 * apart. A parked handover is going to arrive — the next page to ask for its
 * pending workflow collects it — so saying it failed would be untrue and would
 * also produce the second opening a minute later. An unconfirmed one was sent
 * to a page that never answered, and whoever asked for it is the one who can
 * ask again.
 */
export type Delivery =
  /** The page acknowledged this exact path. */
  | "shown"
  /** There was no page to send to. The path waits for the next one. */
  | "parked"
  /** It was sent, and nothing came back. */
  | "unconfirmed";

/** An IPC send is not an acknowledgement that the page opened the document. */
export class WorkflowDelivery {
  currentPath: string | undefined;
  private pending?: { path: string; finish: (outcome: Delivery) => void };
  /**
   * `send` reports whether the message actually reached a page, so a path that
   * was parked instead resolves at once rather than waiting out a timeout for
   * an acknowledgement nobody is in a position to give.
   */
  async deliver(path: string, send: () => boolean, timeoutMs = 10_000): Promise<Delivery> {
    if (this.currentPath === path) return "shown";
    return new Promise<Delivery>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const record = {
        path,
        finish: (outcome: Delivery) => {
          if (timer) clearTimeout(timer);
          // Only while this is still the delivery in flight. An earlier one
          // timing out used to clear the slot whatever was in it, which
          // disowned the delivery that had replaced it: the page's
          // acknowledgement then matched nothing, and a workflow the user was
          // looking at was reported as never shown.
          if (this.pending === record) this.pending = undefined;
          resolve(outcome);
        },
      };
      timer = setTimeout(() => record.finish("unconfirmed"), timeoutMs);
      this.pending = record;
      try {
        if (!send()) record.finish("parked");
      } catch {
        record.finish("unconfirmed");
      }
    });
  }
  acknowledge(path: string): void {
    this.currentPath = path || undefined;
    if (this.pending?.path === path) this.pending.finish("shown");
  }
  reset(): void {
    this.currentPath = undefined;
    this.pending?.finish("unconfirmed");
  }
}
