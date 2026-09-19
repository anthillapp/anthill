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

/** Closing and replacing a document must not race their async dirty dialogs. */
export class WindowOperations {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** An IPC send is not an acknowledgement that the page opened the document. */
export class WorkflowDelivery {
  currentPath: string | undefined;
  private pending?: { path: string; finish: (shown: boolean) => void };
  async deliver(path: string, send: () => void, timeoutMs = 10_000): Promise<boolean> {
    if (this.currentPath === path) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (shown: boolean) => {
        clearTimeout(timer);
        this.pending = undefined;
        resolve(shown);
      };
      this.pending = { path, finish };
      try { send(); } catch { finish(false); }
    });
  }
  acknowledge(path: string): void {
    this.currentPath = path || undefined;
    if (this.pending?.path === path) this.pending.finish(true);
  }
  reset(): void {
    this.currentPath = undefined;
    this.pending?.finish(false);
  }
}
