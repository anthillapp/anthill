import type { Server } from "node:http";
import type { Paths } from "./paths.js";

/**
 * The CLI's web interface: a `node:http` server bound to 127.0.0.1 that
 * serves the built renderer (`out/renderer`), a `/health` endpoint, and a
 * hand-rolled RFC6455 WebSocket at `/api` (no `ws` dependency; the
 * handshake and frame codec use `node:crypto`).
 *
 * Observation-only, like the desktop: the server makes no network calls of
 * its own — it only listens on the loopback interface and answers the
 * browser that opened it.
 */
export type ServerOptions = {
  host: string;
  port: number;
  paths: Paths;
  /** Where the built renderer lives on disk. */
  rendererDir: string;
};

export type CliServer = {
  server: Server;
  /** The port actually bound (the requested port, or the one chosen when 0). */
  port: number;
  close(): Promise<void>;
};

/**
 * Create and start the CLI server.
 */
export function startServer(options: ServerOptions): Promise<CliServer> {
  throw new Error(
    "TODO(task 1): bind the loopback server; serve the renderer, /health, and the /api WebSocket",
  );
}
