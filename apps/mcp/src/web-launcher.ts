/**
 * The `web` launcher (ANT-231): bringing the web shell up for a handover.
 *
 * The only target on Linux and Windows, and on macOS through
 * `plugin:target -- web`. The web shell is `apps/cli` run from source: a
 * loopback server with a browser tab, which reads its own exchange inbox and
 * shows a handover in the tab that is open (ANT-228). So there are four
 * states, and one thing to do in each:
 *
 * | the shell                       | this launcher                                  | outcome    |
 * | ------------------------------- | ---------------------------------------------- | ---------- |
 * | running, a tab connected        | nothing: the tab is sent the handover          | `running`  |
 * | running, no tab                 | open `http://…/workflow/<id>` in the browser   | `opened`   |
 * | not running                     | start it, detached; it opens a tab itself      | `started`  |
 * | not built, or the start failed  | say so, with the command and the log           | `failed`   |
 *
 * "Running" is its `instance.lock` naming a live process; whether a tab is
 * connected is its `/health`. A start marker keeps two handovers in quick
 * succession from starting two shells, and the shell's own lock refuses a
 * second instance anyway. Nothing goes through a shell: `node` is this
 * process's own executable and every argument is an array element.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { typedPath } from "@anthill/live";

import type { LaunchReport, Launcher } from "./launch.js";
import {
  DEV_START_WINDOW_MS,
  detachedStart,
  pidAlive,
  webShellLink,
  webShellOrigin,
  webShellRunning,
  type DetachedStart,
  type WebShell,
} from "./target.js";
import { workflowIdFromUrl } from "./url.js";

/** How long a start is given before a second handover may start again: the same three minutes as the dev build. */
export const WEB_START_WINDOW_MS = DEV_START_WINDOW_MS;

/** How long to wait for a freshly started shell's lock, to put its port in the link. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 200;
const HEALTH_TIMEOUT_MS = 1_500;

/** Everything the web launcher touches, injected so a test starts, opens and asks nothing. */
export type WebStart = DetachedStart & {
  /** The shell on this data directory, if its lock names a live process. */
  running: (dataDir: string) => WebShell | undefined;
  /** Its `/health`: how many tabs are connected, or `undefined` when it does not answer (yet). */
  health: (shell: WebShell) => Promise<{ clients: number } | undefined>;
  /** Open a URL in the user's browser; `false` when nothing could. */
  open: (url: string) => Promise<boolean>;
  /** Whether a file exists: the built CLI. */
  exists: (path: string) => boolean;
  /** Wait, between looks at a starting shell's lock. */
  wait: (ms: number) => Promise<void>;
  /** Whether a process is alive: the one just started, or the one a start marker names. */
  alive: (pid: number) => boolean;
  /** The `node` to run the CLI with: this process's own. */
  node: string;
};

/** The built web shell, in a checkout. */
export function webShellCli(checkout: string): string {
  return join(checkout, "apps", "cli", "out", "cli", "src", "cli.js");
}

/** A path as the user's shell needs it typed (`@anthill/live`'s `typedPath`). */
const typed = (path: string): string => typedPath(path, process.platform);

export function webLauncher(dataDir: string, checkout: string | undefined, dependencies: WebStart): Launcher {
  const { running, health, open, exists, wait, alive, node, now, readMarker, writeMarker, start, logFile } = dependencies;
  // Absolute, so the shell started in the checkout reads the same directory
  // this server writes into, whatever either one's working directory is.
  const dir = resolve(dataDir);
  return async (url): Promise<LaunchReport> => {
    const workflowId = workflowIdFromUrl(url);
    // A link a page can use carries the shell's token, which it records once
    // it listens; before that there is no link worth giving.
    const linkFor = (shell: WebShell): string | undefined =>
      shell.token ? (workflowId ? webShellLink(shell, workflowId) : `${webShellOrigin(shell)}/`) : undefined;
    const withLink = (link: string | undefined) => (link ? { link } : {});

    const shell = running(dir);
    if (shell) {
      const link = linkFor(shell);
      const answer = await health(shell);
      // A lock is written just before the shell listens; a shell that does not
      // answer yet is starting, and shows the handover once it does.
      if (!answer) {
        return { outcome: "starting", ...withLink(link), message: `The web shell at ${webShellOrigin(shell)} is starting, and shows the handover once it is up.` };
      }
      if (answer.clients > 0) {
        return { outcome: "running", ...withLink(link), message: "The web shell is open in a browser tab, which takes the handover from its inbox and shows it." };
      }
      if (link && await open(link)) return { outcome: "opened", link };
      return {
        outcome: "failed",
        ...withLink(link),
        message: link
          ? "The web shell is running, but no browser could be opened on this machine. Open the link below to see the handover."
          : `The web shell at ${webShellOrigin(shell)} is running but gave no link to open (it predates ANT-231); open it from the address it printed.`,
      };
    }

    if (!checkout) {
      return {
        outcome: "failed",
        message: "The web shell is not running, and this server was not built in an Anthill checkout, so there is nothing to start. Start it with `anthill` from a checkout; the handover is stored and waits for it.",
      };
    }
    const cli = webShellCli(checkout);
    const command = `node ${typed(cli)} --data-dir=${typed(dir)}`;
    const marker = readMarker();
    // A start counts while it is recent and the process it started lives: one
    // that crashed on the way up does not hold the next handover off.
    if (marker && now() - marker.at < WEB_START_WINDOW_MS && (marker.pid === undefined || alive(marker.pid))) {
      return { outcome: "starting", message: "The web shell was started moments ago and is still coming up; it shows the handover once it is." };
    }
    if (!exists(cli)) {
      return {
        outcome: "failed",
        message: `The web shell is not running, and it is not built in ${checkout}. Build it with \`npm run build --workspace=@anthill/cli\` there, then start it with \`${command}\`. The handover is stored and waits for it.`,
      };
    }

    const started = await start(node, [cli, `--data-dir=${dir}`], checkout, logFile);
    if ("error" in started) {
      return {
        outcome: "failed",
        message: `The web shell is not running, and starting it failed (${started.error}). Start it with \`${command}\`; its log is ${logFile}. The handover is stored and waits for it.`,
      };
    }
    writeMarker({ ...(started.pid ? { pid: started.pid } : {}), at: now() });

    // The link needs the port and token, which the shell records once it
    // listens. Looked for within a few seconds; a shell that exits in that
    // time did not start.
    let link: string | undefined;
    for (let waited = 0; waited < LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
      const up = running(dir);
      link = up ? linkFor(up) : undefined;
      if (link) break;
      if (started.pid !== undefined && !alive(started.pid)) {
        return {
          outcome: "failed",
          message: `The web shell was started but exited at once; its log, ${logFile}, says why. Start it with \`${command}\` to see it happen. The handover is stored and waits for it.`,
        };
      }
      await wait(LOCK_POLL_MS);
    }
    return {
      outcome: "started",
      ...withLink(link),
      message: `Started the web shell (${command}); it opens a browser tab and shows the handover there. Its log is ${logFile}.`,
    };
  };
}

/**
 * The browser openers, per platform, with the URL as one argument and no shell.
 *
 * The same programs as the web shell's own (apps/cli/src/cli.ts,
 * `browserOpeners`), kept in step with it: this process cannot import the CLI.
 */
export function browserOpeners(platform: NodeJS.Platform, url: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] }[] {
  if (platform === "darwin") return [{ command: "/usr/bin/open", args: [url] }];
  if (platform === "win32") {
    return [{ command: `${env.SystemRoot ?? "C:\\Windows"}\\System32\\rundll32.exe`, args: ["url.dll,FileProtocolHandler", url] }];
  }
  return ["xdg-open", "wslview", "sensible-browser"].map((command) => ({ command, args: [url] }));
}

const OPENER_TIMEOUT_MS = 3_000;

/** Open a URL with the first opener that works. An opener still running after a few seconds counts as opened. */
async function openInBrowser(url: string): Promise<boolean> {
  for (const opener of browserOpeners(process.platform, url)) {
    const opened = await new Promise<boolean>((settle) => {
      let done = false;
      const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); settle(ok); } };
      const timer = setTimeout(() => finish(true), OPENER_TIMEOUT_MS);
      try {
        const child = spawn(opener.command, opener.args, { stdio: "ignore", windowsHide: true });
        child.on("error", () => finish(false));
        child.on("exit", (code) => finish(code === 0));
      } catch {
        finish(false);
      }
    });
    if (opened) return true;
  }
  return false;
}

/** Ask a web shell's `/health`, which only an Anthill web shell answers with its name. */
async function askHealth(shell: WebShell): Promise<{ clients: number } | undefined> {
  try {
    const response = await fetch(`${webShellOrigin(shell)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = (await response.json()) as { name?: unknown; clients?: unknown };
    if (body.name !== "anthill-cli") return undefined;
    return { clients: typeof body.clients === "number" ? body.clients : 0 };
  } catch {
    return undefined;
  }
}

/** The real web launcher's dependencies. */
export function webStart(): WebStart {
  return {
    ...detachedStart("web-shell"),
    running: webShellRunning,
    health: askHealth,
    open: openInBrowser,
    exists: existsSync,
    wait: (ms) => new Promise((settle) => setTimeout(settle, ms)),
    alive: pidAlive,
    node: process.execPath,
  };
}
