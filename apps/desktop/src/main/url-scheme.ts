/**
 * Who opens `anthill://` links on this Mac (ANT-137).
 *
 * The packaged app, and nothing else. A dev run used to register itself too —
 * `setAsDefaultProtocolClient("anthill", process.execPath, [appPath])` — but on
 * macOS the path and arguments are ignored (Electron documents them as
 * Windows-only), so what it actually registered was the running *bundle*: the
 * stock `Electron.app` from `node_modules`, bundle id `com.github.Electron`.
 * That id belongs to every dev Electron on the machine, not to Anthill.
 * LaunchServices then handed links to whichever of them it liked — on the
 * machine this was found on, one of six, from an unrelated project — and each
 * opened Electron's default "To run a local app" window, because none of them
 * is started with Anthill's app path. The link was lost, and the installed
 * Anthill, running the whole time, never heard of it.
 *
 * A dev run could not have used a link anyway: it reads the `desktop-dev` data
 * directory, and a link names a workflow in the installed app's exchange.
 *
 * The packaged app claims the scheme when it starts and again whenever it
 * becomes active, if it has lost it. Registering once at start was not
 * enough: after one dev run — or an older checkout still carrying the old
 * line — the installed Anthill stayed unreachable by link until relaunched.
 */

export const WORKFLOW_SCHEME = "anthill";

/** The part of Electron's `app` this needs, so the rule can be tested without Electron. */
export type SchemeHost = {
  isPackaged: boolean;
  isDefaultProtocolClient(protocol: string): boolean;
  setAsDefaultProtocolClient(protocol: string): boolean;
};

/**
 * Make the installed Anthill the handler for its own links, if it is not.
 *
 * Returns whether a registration was made, for the caller's log. Never
 * registers from a dev run, for the reason above.
 */
export function claimScheme(host: SchemeHost): boolean {
  if (!host.isPackaged) return false;
  if (host.isDefaultProtocolClient(WORKFLOW_SCHEME)) return false;
  return host.setAsDefaultProtocolClient(WORKFLOW_SCHEME);
}
