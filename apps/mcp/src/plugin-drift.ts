/**
 * Whether the plugin a harness installed is the one this Anthill ships.
 *
 * ANT-120. A plugin installed from a directory is a copy, not a live mount:
 * `claude plugin install` takes the plugin as it is that day and nothing ever
 * refreshes it. The skill a user was running sat four releases behind the
 * server it talked to — still describing an approval gate removed two releases
 * earlier — and the only sign was a stale slash-command hint.
 *
 * The launcher is the one part of the installed copy that runs on every
 * session, so it reads its own manifest and passes the version it was
 * installed at to the server. The server knows its own. When the two differ,
 * the harness is told — in the instructions it reads at connect, and on
 * stderr — with the one command that fixes it.
 */

/** The harness a plugin copy was installed into, as its launcher reports it. */
export type PluginHost = "claude-code" | "codex";

/** Environment the launcher sets on the server it spawns. Not the harness's. */
export const PLUGIN_VERSION_ENV = "ANTHILL_PLUGIN_VERSION";
export const PLUGIN_HOST_ENV = "ANTHILL_PLUGIN_HOST";

/** The release a version names, without a build suffix such as `+codex.…`. */
function release(version: string): string {
  return version.trim().split("+")[0] ?? "";
}

function compare(a: string, b: string): number {
  const parts = (value: string) => value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** How to refresh an installed copy, per harness. */
const UPDATE: Record<PluginHost, string> = {
  "claude-code": "run `claude plugin update anthill@anthill`, then start a new session",
  codex: "reinstall the Anthill plugin in Codex from this checkout's marketplace, then start a new task",
};

/**
 * A notice to put in front of the harness, or nothing when there is nothing to say.
 *
 * Nothing when the launcher did not report a version — an older launcher, or
 * the server started by hand — because an absent version is not evidence of an
 * old one.
 */
export function pluginDriftNotice(
  installed: string | undefined,
  host: string | undefined,
  server: string,
): string | undefined {
  if (!installed?.trim()) return undefined;
  const have = release(installed);
  const want = release(server);
  if (!have || !want || have === want) return undefined;

  const how = UPDATE[host === "codex" ? "codex" : "claude-code"];
  if (compare(have, want) < 0) {
    return (
      `The Anthill plugin installed in this harness is ${have}, but the Anthill it is talking to is ${want}. ` +
      `Its skill and instructions are out of date and may describe behaviour Anthill no longer has. ` +
      `Before relying on them, tell the user: to update it, ${how}.`
    );
  }
  return (
    `The Anthill plugin installed in this harness is ${have}, newer than the Anthill it is talking to (${want}). ` +
    `Tell the user their Anthill checkout or app is behind the plugin; updating Anthill to ${have} makes the two agree.`
  );
}
