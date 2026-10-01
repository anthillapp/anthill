/**
 * How the harness runs `anthill run/step/done` for this chat's Anthill (ANT-232).
 *
 * `bind_run` hands the agent the exact commands, so they have to work where
 * the agent runs them:
 *
 * | target                          | commands                                        |
 * | ------------------------------- | ----------------------------------------------- |
 * | `anthill` on the PATH           | `anthill run/step/done …`                       |
 * | `web`, not on it, a checkout    | `<this node> <checkout>/apps/cli/out/cli/src/cli.js run/step/done …` |
 * | not on it, this server in a plugin | `<this node> <plugin>/server/anthill-report.mjs run/step/done …` |
 * | not on it, this server in a checkout | `<this node> <checkout>/apps/cli/out/cli/src/cli.js run/step/done …` |
 * | not on it, neither              | `anthill run/step/done …`, all there is to offer |
 *
 * The checkout's CLI is a from-source install that never ran `npm link`, which
 * is how the web shell is usually run on Linux and Windows. The plugin's
 * reporter is what a plugin installed from GitHub or a directory carries
 * beside its server (scripts/build-plugin-server.mjs): someone with the
 * installed app and no CLI has no `anthill` at all. `node` is this process's
 * own, so the commands work whatever PATH the harness has. The PATH is the
 * harness's — this server inherits it — and it is searched here, with no
 * shell. All of them write the same report file, `~/.anthill/cli/harness-reports.jsonl`,
 * which every Anthill reads; `--data-dir` is added only for a web shell that
 * keeps its data somewhere else.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { typedPath, type CliInvocation } from "@anthill/live";

import { targetDataDir, type ResolvedTarget, type TargetEnvironment } from "./target.js";
import { webShellCli } from "./web-launcher.js";

/** What the choice needs from the machine; injected so a test fixes the PATH and the files. */
export type InvocationDeps = TargetEnvironment & {
  /** Whether an executable file is at this path. */
  executable: (path: string) => boolean;
  /** This process's `node`. */
  node: string;
  /** The reporter this server's plugin carries beside it, when it is in one. */
  reporter?: string;
};

/** The reporter's file name beside a bundled server. */
export const PLUGIN_REPORTER = "anthill-report.mjs";

/** The harness PATH's `anthill`, looked up as a shell would, without one. */
export function onPath(name: string, deps: InvocationDeps): string | undefined {
  const path = deps.env.PATH ?? deps.env.Path ?? "";
  const extensions = deps.platform === "win32"
    ? (deps.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of path.split(deps.platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (deps.executable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** How this chat's harness should run the CLI; `{}` is plain `anthill`. */
export function reportingInvocation(resolved: ResolvedTarget, deps: InvocationDeps): CliInvocation {
  const onThePath = onPath("anthill", deps) !== undefined;
  const reporter = deps.reporter ? { command: `${nodeFor(deps)} ${typedPath(deps.reporter, deps.platform)}` } : {};
  // A server built in a checkout has no reporter beside it, and with no
  // `anthill` on the PATH plain `anthill run …` cannot run: every report of a
  // chat sent to the dev build failed with "command not found" (ANT-249). The
  // checkout's own CLI reports the same way, so it stands in for the reporter.
  const checkoutCli = !deps.reporter && resolved.checkout
    ? { command: `${nodeFor(deps)} ${typedPath(webShellCli(resolved.checkout), deps.platform)}` }
    : {};
  if (resolved.target !== "web") return onThePath ? {} : deps.reporter ? reporter : checkoutCli;
  const platform = { platform: deps.platform };
  const dataDir = resolve(resolved.dataDir) === resolve(targetDataDir("web", deps))
    ? {}
    : { dataDir: resolve(resolved.dataDir), ...platform };
  if (onThePath) return dataDir;
  if (!resolved.checkout) return { ...reporter, ...dataDir };
  const cli = typedPath(webShellCli(resolved.checkout), deps.platform);
  return { command: `${nodeFor(deps)} ${cli}`, ...dataDir };
}

/**
 * The node a reporting command starts with.
 *
 * On Windows a line that starts with a quoted path is an expression to
 * PowerShell, not a command, so a `node` on the PATH — where its installer
 * puts it — leads instead. Without one, the quoted path works in cmd and Git
 * Bash but not in PowerShell, which would need `& ` in front: a known
 * limitation while Windows is experimental. Elsewhere this process's own
 * node, by path.
 */
function nodeFor(deps: InvocationDeps): string {
  return deps.platform === "win32" && onPath("node", deps) ? "node" : typedPath(deps.node, deps.platform);
}

/**
 * Where a plugin's reporter is, if this server is the copy bundled into one:
 * the bundle is a single file, so this module's own URL is the server's.
 * Built with tsc it is apps/mcp/dist, where there is none.
 */
const besideThisServer = join(dirname(fileURLToPath(import.meta.url)), PLUGIN_REPORTER);

/** The real machine. */
export function invocationDeps(environment: TargetEnvironment): InvocationDeps {
  return {
    ...environment,
    executable: (path) => {
      try {
        if (!statSync(path).isFile()) return false;
        if (environment.platform !== "win32") accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    node: process.execPath,
    ...(existsSync(besideThisServer) ? { reporter: besideThisServer } : {}),
  };
}
