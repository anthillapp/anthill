import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";

/** All cooperating writers use the same lease for a workflow's mutations. */
export async function withWorkflowLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lock(path, {
    realpath: false,
    stale: 60_000,
    update: 10_000,
    retries: { retries: 40, minTimeout: 25, maxTimeout: 100, factor: 1.2 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}
