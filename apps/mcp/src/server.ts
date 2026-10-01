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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createHandlers } from "./handlers.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { disabledLauncher, openUrl } from "./launch.js";
import { readOptions, type ServerOptions } from "./options.js";
import {
  TargetSession,
  appLauncher,
  checkoutOf,
  currentEnvironment,
  devStart,
  electronDevLauncher,
  readTargetSetting,
  resolveTarget,
  type ResolvedTarget,
  type TargetContext,
} from "./target.js";
import { PLUGIN_HOST_ENV, PLUGIN_VERSION_ENV, pluginDriftNotice } from "./plugin-drift.js";
import { webLauncher, webStart } from "./web-launcher.js";
import { registerExchangeTools } from "./tools.js";

const SERVER_NAME = "anthill";

/**
 * The version this server reports at initialize.
 *
 * Read from the package rather than written out here. It was a literal, and the
 * 0.7.0 release moved every manifest in the repository and left it behind
 * saying 0.6.6 — under a comment claiming the two were kept in step. A number
 * that has to be remembered in two places is a number that will disagree with
 * itself; this one can only be wrong if the package is.
 *
 * The copy bundled into a plugin has no package.json beside it, so
 * scripts/build-plugin-server.mjs writes the package's version in as
 * `__ANTHILL_MCP_VERSION__`. Built with tsc it is not defined, and the package
 * is read as before.
 */
declare const __ANTHILL_MCP_VERSION__: string | undefined;
const SERVER_VERSION =
  typeof __ANTHILL_MCP_VERSION__ === "string"
    ? __ANTHILL_MCP_VERSION__
    : String((createRequire(import.meta.url)("../package.json") as { version?: unknown }).version ?? "0.0.0");

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
function createMcpServer(options: ServerOptions, drift: string | undefined, targets: TargetSession): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "Anthill", version: SERVER_VERSION },
    // An out-of-date installed plugin leads the instructions, because the
    // skill that brought the harness here is the thing that is stale (ANT-120).
    { instructions: drift ? `${drift}\n\n${SERVER_INSTRUCTIONS}` : SERVER_INSTRUCTIONS },
  );

  registerExchangeTools(server, createHandlers({ targets }));
  return server;
}

/**
 * Everything the target rule reads, gathered when the server starts: the
 * platform, this plugin copy's flag, the machine's setting, a directory given
 * outright, and the checkout this server was built in.
 */
function targetContext(options: ServerOptions): TargetContext {
  const setting = readTargetSetting();
  const checkout = checkoutOf(fileURLToPath(import.meta.url));
  return {
    ...currentEnvironment(),
    ...(options.target ? { flag: options.target } : {}),
    ...(setting ? { setting } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(checkout ? { checkout } : {}),
  };
}

/** How each target is brought up, unless launching was turned off. */
function launcherFor(options: ServerOptions) {
  return (resolved: ResolvedTarget) => {
    if (!options.launch) return disabledLauncher;
    if (resolved.target === "electron-dev") return electronDevLauncher(resolved.dataDir, resolved.checkout, devStart());
    if (resolved.target === "web") return webLauncher(resolved.dataDir, resolved.checkout, webStart());
    return appLauncher(openUrl, resolved.checkout);
  };
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

  // The launcher of the installed plugin copy says what version it was
  // installed at; a copy nobody refreshed is the thing this catches.
  const drift = pluginDriftNotice(
    process.env[PLUGIN_VERSION_ENV],
    process.env[PLUGIN_HOST_ENV],
    SERVER_VERSION,
  );
  if (drift) process.stderr.write(`${SERVER_NAME} mcp server: ${drift}\n`);

  const context = targetContext(read.options);
  const targets = new TargetSession(context, launcherFor(read.options), (resolved) => {
    process.stderr.write(
      `${SERVER_NAME} mcp server: this chat's handovers go to ${resolved.label} (${resolved.source}); exchange under ${resolved.dataDir}\n`,
    );
  });
  const server = createMcpServer(read.options, drift, targets);

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
  // Before any handover, what the rule answers without a build request: the
  // first handover may still ask for the development build (--dev), and it is
  // then that the target is pinned and said again.
  const tentative = resolveTarget(context);
  process.stderr.write(
    `${SERVER_NAME} mcp server ready; ` +
      (tentative.ok
        ? `handovers go to ${tentative.resolved.label} unless the first asks for the dev build; exchange under ${tentative.resolved.dataDir}`
        : "the target is settled at the first handover") +
      `${read.options.launch ? "" : "; not opening Anthill (--no-launch)"}\n`,
  );
  return 0;
}

/**
 * Whether this module is the program Node was started with, rather than one a
 * test imported. `process.argv[1]` is the script Node was given, and
 * `import.meta.url` is where Node found it after following links, so the two
 * are compared as real paths. Compared as given, a server started through a
 * symlinked path (a temporary directory on macOS, a linked checkout or plugin
 * folder) took itself for an import and exited at once, answering nothing.
 */
function startedAsProgram(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (startedAsProgram()) {
  // Assigned only on a refusal to start. A clean start returns 0, and writing
  // that back would overwrite a code the transport had already set on its way
  // past.
  const code = await runServer(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
