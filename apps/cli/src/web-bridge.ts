import type { AnthillApi } from "../desktop/src/shared/ipc.js";

/**
 * The CLI's answer to the desktop's preload script.
 *
 * In Electron, `window.anthill` is injected by `src/preload/index.ts`. In a
 * browser tab there is no preload, so this module installs the same
 * `AnthillApi` over the WebSocket at `/api`: each method is a
 * request/response round trip, and each `on*` subscription is a push
 * channel delivered by the server. It runs only when `window.anthill` is
 * absent, so the same renderer bundle works in both shells unchanged.
 *
 * Bundled by vite (see `vite.config.ts`), not by tsc: this file is
 * deliberately excluded from the CLI tsconfig, which type-checks only the
 * main-process files.
 */

/**
 * Open the connection to the CLI and install `window.anthill`.
 */
export function installWebBridge(): Promise<AnthillApi> {
  throw new Error(
    "TODO(task 1): connect to /api on the page's own origin; one pending promise per request id, push channels fanned out to the on* listeners",
  );
}
