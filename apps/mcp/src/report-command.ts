/**
 * How the harness runs `anthill run/step/done` for this chat's Anthill (ANT-232).
 *
 * `bind_run` hands the agent the exact commands, so they have to work where
 * the agent runs them:
 *
 * | target                          | commands                                        |
 * | ------------------------------- | ----------------------------------------------- |
 * | `app`, `electron-dev`           | `anthill run/step/done …`                       |
 * | `web`, `anthill` on the PATH    | the same                                        |
 * | `web`, `anthill` not on it      | `<this node> <checkout>/apps/cli/out/cli/src/cli.js run/step/done …` |
 *
 * The last is a from-source install that never ran `npm link`, which is how
 * the web shell is usually run on Linux and Windows. `node` is this process's
 * own, so the commands work whatever PATH the harness has. The PATH is the
 * harness's — this server inherits it — and it is searched here, with no
 * shell. All of them write the same report file, `~/.anthill/cli/harness-reports.jsonl`,
 * which every Anthill reads; `--data-dir` is added only for a web shell that
 * keeps its data somewhere else.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { typedPath, type CliInvocation } from "@anthill/live";

import { targetDataDir, type ResolvedTarget, type TargetEnvironment } from "./target.js";
import { webShellCli } from "./web-launcher.js";

/** What the choice needs from the machine; injected so a test fixes the PATH and the files. */
export type InvocationDeps = TargetEnvironment & {
  /** Whether an executable file is at this path. */
  executable: (path: string) => boolean;
  /** This process's `node`. */
  node: string;
};

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
  if (resolved.target !== "web") return {};
  const platform = { platform: deps.platform };
  const dataDir = resolve(resolved.dataDir) === resolve(targetDataDir("web", deps))
    ? {}
    : { dataDir: resolve(resolved.dataDir), ...platform };
  if (onPath("anthill", deps) || !resolved.checkout) return dataDir;
  const cli = typedPath(webShellCli(resolved.checkout), deps.platform);
  // On Windows a line that starts with a quoted path is an expression to
  // PowerShell, not a command, so a `node` on the PATH — where its installer
  // puts it — leads instead. Without one, the quoted path works in cmd and Git
  // Bash but not in PowerShell, which would need `& ` in front: a known
  // limitation while Windows is experimental. Elsewhere this process's own
  // node, by path.
  const node = deps.platform === "win32" && onPath("node", deps) ? "node" : typedPath(deps.node, deps.platform);
  return { command: `${node} ${cli}`, ...dataDir };
}

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
  };
}
