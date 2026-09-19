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

const SERVER_NAME = "anthill";

/** The repository's version, which every workspace here carries in step. */
const SERVER_VERSION = "0.6.6";

/**
 * What the process ends on when the transport fails.
 *
 * Non-zero because a transport error is a message that was never answered:
 * either a request this server could not read, or — past the transport's 10 MB
 * buffer — the connection itself going away. Somebody is waiting for a reply
 * that is not coming, and ending on 0 tells the harness this session finished
 * the way an ordinary one does. Distinct from the 2 a bad argument returns,
 * which is a fault in how the server was started rather than in what it was
 * asked.
 */
const TRANSPORT_FAILURE_EXIT_CODE = 1;

/**
 * What stderr is told when the transport fails.
 *
 * Its own function because a string built inside an event handler is a string
 * nothing ever reads back. The wording is the whole of what a harness gets when
 * the connection dies, and the wiring test matches on it from the outside.
 */
function transportFailureLine(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${SERVER_NAME} mcp server: the connection to the harness failed: ${reason}\n`;
}

/**
 * A server with the four tools registered, ready to be connected to a transport.
 *
 * Separate from starting one because the two decide different things: this
 * decides what the server can answer, and `runServer` decides which streams it
 * answers on and what the process ends with. Neither is reachable from a unit
 * test — the wiring test spawns the built program and speaks JSON-RPC to it,
 * which is the only way to see what a harness sees.
 */
function createMcpServer(options: ServerOptions): McpServer {
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
async function runServer(argv: readonly string[]): Promise<number> {
  const read = readOptions(argv);
  if (!read.ok) {
    process.stderr.write(`${read.message}\n`);
    return 2;
  }

  const server = createMcpServer(read.options);

  const transport = new StdioServerTransport();
  // Set before `connect`, and both halves of that matter. `connect` chains
  // whatever handler it finds onto the protocol's own, so a handler installed
  // afterwards would replace the SDK's rather than run beside it — and the
  // transport starts reading inside `connect`, so an error on the first chunk
  // would have nowhere to go at all. Without this the process ends on 0 with an
  // empty stderr: a connection that died and a clean shutdown look identical.
  transport.onerror = (error) => {
    process.stderr.write(transportFailureLine(error));
    process.exitCode = TRANSPORT_FAILURE_EXIT_CODE;
  };
  await server.connect(transport);

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
  // Assigned only on a refusal to start. A clean start returns 0, and writing
  // that back would overwrite a code the transport had already set on its way
  // past.
  const code = await runServer(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
