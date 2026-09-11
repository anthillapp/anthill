import type { IpcCapabilities, AnthillApi } from "../../desktop/src/shared/ipc.js";
import type { Paths } from "./paths.js";

/**
 * The CLI's answer to the desktop's preload: it maps every `IpcChannel`
 * onto the same pure-Node service modules the desktop main process uses
 * (`services.ts`, `interpreters.ts`, `user-path.ts`, `save-destination.ts`,
 * `codex-models.ts`, `codex-capability.ts`, `agent-library.ts`, `live/*`),
 * and broadcasts the push channels over the WebSocket.
 *
 * Where the desktop uses dialogs, the CLI resolves from `--workspace` or
 * returns `null`/cancelled: `selectWorkspace`, `chooseRunFolder`, and the
 * folder-choose variants have no dialog to ask.
 *
 * The contract is shared, not copied: the channel names and the `AnthillApi`
 * shape come from `apps/desktop/src/shared/ipc.ts`, so a renderer written
 * for Electron runs against the CLI unchanged.
 */
export type BridgeOptions = {
  paths: Paths;
  /** The workspace the CLI was started with, if any. */
  workspace?: string;
  /** Broadcast a push-channel message to every connected client. */
  broadcast(channel: string, payload: unknown): void;
};

export type Bridge = {
  /** What the running CLI can actually do (the `app:capabilities` answer). */
  capabilities(): Promise<IpcCapabilities>;
  /**
   * Handle one request/response channel. `channel` is an `IpcChannel` value;
   * `args` are the structured-clone arguments the renderer sent.
   */
  handle(channel: string, ...args: unknown[]): Promise<unknown>;
  /** Subscribe to a push channel. Returns an unsubscribe function. */
  on(channel: string, listener: (payload: unknown) => void): () => void;
  /** The full `AnthillApi`, for the parts the renderer calls directly. */
  api: AnthillApi;
};

/**
 * Build the bridge for one CLI run.
 */
export function createBridge(options: BridgeOptions): Bridge {
  throw new Error(
    "TODO(task 1): construct the reused service modules and map each IpcChannel to its handler; forward the push channels to broadcast",
  );
}
