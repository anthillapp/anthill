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

import { isPluginHarness, type PluginHarness } from "@anthill/workflow";

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
const UPDATE: Record<PluginHarness, string> = {
  "claude-code": "run `claude plugin update anthill@anthill`, then start a new session",
  codex: "reinstall the Anthill plugin in Codex (`codex plugin marketplace upgrade anthill-local`, then `codex plugin add anthill@anthill-local`), then start a new task",
  // VS Code has no command for it: a plugin is updated or reinstalled from its
  // plugins list.
  vscode: "update or reinstall the Anthill agent plugin in VS Code, then start a new chat",
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
  /**
   * Where this server runs from, when it is a checkout's build rather than a
   * plugin's bundled copy (ANT-302). Absent for a bundle, which is always the
   * version of the plugin that carries it.
   */
  checkoutServer?: string,
): string | undefined {
  if (!installed?.trim()) return undefined;
  const have = release(installed);
  const want = release(server);
  if (!have || !want || have === want) return undefined;

  // A launcher that named no harness, or one this server does not know, gets
  // Claude Code's command, as every plugin did before there was a choice.
  const how = UPDATE[isPluginHarness(host) ? host : "claude-code"];
  if (compare(have, want) < 0) {
    return (
      `The Anthill plugin installed in this harness is ${have}, but the Anthill it is talking to is ${want}. ` +
      `Its skill and instructions are out of date and may describe behaviour Anthill no longer has. ` +
      `Before relying on them, tell the user: to update it, ${how}.`
    );
  }
  /*
    A checkout's build, named by ~/.anthill/plugin.json, is behind the plugin.
    "Checkout or app" sent the agent to tell the user to update the app, which
    was already newer and changes nothing: every plugin runs this file instead
    of its own copy (ANT-302).
  */
  const root = checkoutServer ? /^(.*)[\\/]apps[\\/]mcp[\\/]dist[\\/]server\.js$/.exec(checkoutServer)?.[1] : undefined;
  if (root) {
    return (
      `The Anthill plugin installed in this harness is ${have}, but the server it starts is the Anthill checkout at ${root}, which is ${want}. ` +
      `Tell the user that checkout is behind the plugin, not the Anthill app: updating the app does not change it. ` +
      `To fix it, update the checkout and build its server again: \`cd ${root} && git pull && npm install && npm run build:deps && npm run build --workspace=@anthill/mcp\`, then start a new session.`
    );
  }
  return (
    `The Anthill plugin installed in this harness is ${have}, newer than the Anthill server it is talking to (${want}${checkoutServer ? `, at ${checkoutServer}` : ""}). ` +
    `Tell the user the server this plugin starts is behind the plugin; updating it to ${have} makes the two agree.`
  );
}
