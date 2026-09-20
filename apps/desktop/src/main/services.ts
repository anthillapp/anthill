/**
 * Main-process wiring for the run history store.
 *
 * This file is what is left of a larger one. It held `@anthill/engine`, the
 * agent runtimes and an approval gate, because the desktop process could
 * execute a workflow: `startRun` took a caller-supplied workspace path, ran
 * the engine against a shared checkout and inherited the parent environment.
 * Nothing in the shipped window reached it — the renderer that did was never
 * mounted — so it was a capability with no product behind it and a wide
 * surface (ANT-95). The optional runner is ANT-52 and is not this.
 *
 * The store stays, and is not runner-only: it holds the run history the launch
 * window lists and the workflow snapshot each Live Session is drawn from.
 */

import { createRunStore, type RunStore } from "@anthill/run-store";

/**
 * What the app keeps of the old run services: the history store, and nothing
 * else.
 *
 * It also held a list of agent runtimes and an approval gate, because the
 * process could execute a workflow. It cannot now (ANT-95) — but the store is
 * not runner-only and never was: it holds the run history the launch window
 * lists, and the snapshot each Live Session is drawn from.
 */
export type RunServices = {
  store: RunStore;
};

/**
 * Open the run store. Call once at startup.
 *
 * `nativeBinding` points at the Electron-ABI build of better-sqlite3 produced
 * by `scripts/fetch-electron-sqlite.mjs` — the copy npm installs is compiled
 * for the system Node and Electron cannot load it.
 */
export async function createServices(
  runsDir: string,
  nativeBinding?: string,
): Promise<RunServices> {
  const store = await createRunStore({ rootDir: runsDir, nativeBinding });
  return { store };
}
