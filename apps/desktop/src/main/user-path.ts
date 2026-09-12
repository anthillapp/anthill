/**
 * The `PATH` the author actually has, rather than the one macOS hands a
 * double-clicked app.
 *
 * An app launched from Finder or the Dock is started by launchd, not by a
 * shell, so it inherits a bare system `PATH` — no `~/.local/bin`, no Homebrew,
 * no nvm, no asdf. Every one of those is where a coding CLI normally lives.
 * Anthill's whole relationship with Claude Code, Codex, and Pi is "find the
 * command the author already has", so in a packaged build it found none of
 * them and said they were not installed. They were; nobody had told the app
 * where to look.
 *
 * It never showed up in development because `npm run dev:desktop` starts
 * Electron *from a shell*, which is exactly the environment the bug is absent
 * in — the one class of defect a development build cannot surface.
 *
 * So the shell is asked. `$SHELL -ilc` runs it as an interactive login shell,
 * which is the only thing that reads the files where a `PATH` is actually
 * assembled — `.zprofile`, `.zshrc`, and whatever a version manager appends to
 * them. Nothing of Anthill's is executed: the shell is asked to print one
 * variable and exit.
 *
 * Three things keep that from being reckless. The output is bracketed by a
 * marker, because a login shell prints greetings and whatever else somebody put
 * in their rc file, and the `PATH` has to be picked out of that. There is a
 * timeout, because a shell configuration that waits for input would otherwise
 * hang the app before its window appears. And a failure changes nothing: the
 * process keeps the `PATH` it started with, and the screen goes on saying
 * honestly that it cannot find the CLI.
 */

import { runProcess, type SpawnFn } from "@anthill/runtimes";

/** Wraps the value so it can be found among a login shell's own chatter. */
const MARKER = "__ANTHILL_PATH__";

/** Long enough for a heavy rc file, short enough not to delay the window. */
const TIMEOUT_MS = 5_000;

/**
 * What the author's login shell says `PATH` is.
 *
 * `undefined` when there is no shell to ask, it failed, or its answer did not
 * contain the marker — all of which mean "no better information", never "the
 * PATH is empty".
 */
export async function readShellPath(options: {
  spawnFn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const shell = env.SHELL;
  // No shell recorded — a rare environment, and not one to guess about.
  if (!shell) return undefined;

  const outcome = await runProcess({
    command: shell,
    // `command printf` rather than `echo`, which some shells embellish.
    args: ["-ilc", `command printf '%s%s' '${MARKER}' "$PATH"`],
    timeoutMs: TIMEOUT_MS,
    ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
  }).catch(() => undefined);

  if (!outcome || outcome.spawnError || outcome.exitCode !== 0) return undefined;

  const at = outcome.stdout.lastIndexOf(MARKER);
  if (at === -1) return undefined;
  const value = outcome.stdout.slice(at + MARKER.length).trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Take on the author's `PATH`, if it can be learned.
 *
 * Returns whether anything changed, which is only really of interest to a test:
 * callers have nothing to do differently either way, because the failure mode
 * is simply the `PATH` this process already had.
 */
export async function adoptUserPath(options: {
  spawnFn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const found = await readShellPath(options);
  if (!found || found === env.PATH) return false;
  env.PATH = found;
  return true;
}
