/**
 * `@anthill/mcp` — the local stdio MCP server a coding harness hands a workflow
 * over through.
 *
 * One process, spawned by the harness, speaking JSON-RPC on its own stdin and
 * stdout. It has no listener, makes no outbound request, holds no key, and the
 * only thing it touches on disk is Anthill's exchange directory: it writes
 * handovers into it and asks the app, by leaving a file, to go and look. The app
 * reads on its own schedule. Between the two there is no socket and no shared
 * lock, which is the whole reason `@anthill/exchange-store` writes the way it
 * does.
 *
 * Taking `@modelcontextprotocol/sdk` is the first protocol dependency in a
 * repository that hand-rolls an RFC6455 WebSocket rather than take `ws`, and
 * says so at `apps/cli/src/server.ts:16`. The reversal is deliberate and the two
 * cases are not alike: a frame codec is a hundred specified lines that are
 * finished once they are written, whereas MCP's JSON-RPC lifecycle, capability
 * negotiation and schema plumbing are a moving target maintained by somebody
 * else, and an Anthill that hand-rolled them would be re-reading the
 * specification every time a harness shipped. The dependency is pinned in this
 * workspace and nowhere else.
 *
 * **Nothing in this process may write to stdout.** It is the transport. A stray
 * `console.log` anywhere below this line corrupts the message stream and the
 * harness sees a protocol error rather than whatever was being reported.
 * Diagnostics go to stderr, which the harness shows as server output.
 */

import { ExchangeStore } from "@anthill/exchange-store";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

import { createHandlers } from "./handlers.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { readOptions, type ServerOptions } from "./options.js";
import { registerExchangeTools } from "./tools.js";

export const SERVER_NAME = "anthill";

/** The repository's version, which every workspace here carries in step. */
export const SERVER_VERSION = "0.6.6";

/**
 * A server with the four tools registered, ready to be connected to a transport.
 *
 * Separate from starting one so a test can build it without owning the process's
 * stdio.
 */
export function createMcpServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "Anthill", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerExchangeTools(server, createHandlers({ store: new ExchangeStore(options.dataDir) }));
  return server;
}

/**
 * Start the server on this process's stdin and stdout.
 *
 * Returns the exit code rather than calling `process.exit`, so that a bad
 * argument is reported and the process ends on its own — and so the same
 * function can be called from a test.
 */
export async function runServer(argv: readonly string[]): Promise<number> {
  const read = readOptions(argv);
  if (!read.ok) {
    process.stderr.write(`${read.message}\n`);
    return 2;
  }

  const server = createMcpServer(read.options);
  await server.connect(new StdioServerTransport());

  // Said on stderr once the transport is up, because the data directory is the
  // one thing that can be silently wrong: a server pointed at a directory the
  // app is not reading answers every call happily and opens nothing.
  process.stderr.write(`${SERVER_NAME} mcp server ready; exchange under ${read.options.dataDir}\n`);
  return 0;
}

// Started as a program rather than imported by a test. `process.argv[1]` is the
// script Node was given, so comparing it with this module's own URL is what
// tells the two apart.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runServer(process.argv.slice(2));
}
