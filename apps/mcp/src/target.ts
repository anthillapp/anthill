/**
 * Which Anthill a chat's handovers reach.
 *
 * Anthill runs three ways, and each keeps its own exchange:
 *
 * | target         | what it is                                   | exchange                          |
 * | -------------- | -------------------------------------------- | --------------------------------- |
 * | `app`          | the installed Anthill.app (macOS)            | `<appData>/@anthill/desktop`      |
 * | `electron-dev` | the development build, `npm run dev:desktop` | `<appData>/@anthill/desktop-dev`  |
 * | `web`          | the web shell from source, `anthill`         | `~/.anthill/cli`                  |
 *
 * A handover is only ever seen by the Anthill whose exchange it was written
 * into, so the first thing a chat's first handover settles is which one that
 * is. The rule (architecture doc, §5.2):
 *
 *   1. Linux and Windows: `web`. There is no installed app there.
 *   2. `build: "dev"` on the first handover (macOS): `electron-dev`, and only
 *      from a checkout — it never falls back to the installed app.
 *   3. `--target <t>` (or `--dev`) in the plugin's `.mcp.json`.
 *   4. `"target"` in `~/.anthill/plugin.json`, for scripted QA.
 *   5. Otherwise, on macOS, `app`.
 *
 * There is deliberately no "whichever Anthill is running" rule: on a Mac in
 * daily use the installed app is nearly always open, so that rule would nearly
 * always pick it and look automatic while being wrong.
 *
 * The answer is **pinned** for the life of the server, which is the life of the
 * chat. Every workflow lives in exactly one exchange, and a draft created in
 * one and revised or bound in another is a workflow the second has never heard
 * of.
 */

import { defaultDataDir, ExchangeStore } from "@anthill/exchange-store";
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { LaunchReport, Launcher } from "./launch.js";
import { workflowUrl } from "./url.js";

export type Target = "app" | "electron-dev" | "web";

export const TARGETS: readonly Target[] = ["app", "electron-dev", "web"];

/** How a result names the Anthill it reached. */
export const TARGET_LABEL: Record<Target, string> = {
  app: "Anthill (installed app)",
  "electron-dev": "Anthill (dev build)",
  web: "Anthill (web)",
};

/** Where the target came from, so a wrong one can be traced to what chose it. */
export type TargetSource = "platform" | "build" | "flag" | "settings" | "default";

/**
 * A target as someone spelled it.
 *
 * `installed` and `dev` are the spellings the first version of this switch
 * used, kept so a `plugin.json` written then still means what it meant.
 */
export function readTarget(value: unknown): Target | undefined {
  if (value === "installed") return "app";
  if (value === "dev") return "electron-dev";
  return typeof value === "string" && (TARGETS as readonly string[]).includes(value) ? (value as Target) : undefined;
}

/** The settings file the plugin's launcher reads, and where the target is said. */
export function pluginSettingsPath(home: string = homedir()): string {
  return join(home, ".anthill", "plugin.json");
}

/**
 * The target the settings file names, if it names one.
 *
 * A file that is missing, damaged, or says something else says nothing.
 */
export function readTargetSetting(file: string = pluginSettingsPath()): Target | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return readTarget((JSON.parse(readFileSync(file, "utf8")) as { target?: unknown })?.target);
  } catch {
    return undefined;
  }
}

export type TargetEnvironment = {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
};

export function currentEnvironment(): TargetEnvironment {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/** Each target's own data directory, which holds its exchange. */
export function targetDataDir(target: Target, environment: TargetEnvironment): string {
  const { platform, home, env } = environment;
  if (target === "web") return join(home, ".anthill", "cli");
  return defaultDataDir({ platform, home, env, packaged: target === "app" });
}

/**
 * The checkout this server was built in, if it was built in one.
 *
 * Read off the server's own path — `<checkout>/apps/mcp/dist/server.js` — and
 * believed only when `<checkout>/package.json` is Anthill's. It is the only
 * place a checkout path comes from: never a harness, never a workflow, both of
 * which Anthill does not control. The development build and the web shell are
 * started from here, so a server without one can serve neither.
 *
 * scripts/plugin-target.mjs makes the same test before a build exists; keep
 * the two in step.
 */
export function checkoutOf(serverFile: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): string | undefined {
  if (!/[\\/]apps[\\/]mcp[\\/]dist[\\/]server\.js$/.test(serverFile)) return undefined;
  const root = dirname(dirname(dirname(dirname(serverFile))));
  try {
    const name = (JSON.parse(read(join(root, "package.json"))) as { name?: unknown }).name;
    return name === "anthill" ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Anthill's bundle id — `appId` in apps/desktop/package.json. */
const BUNDLE_ID = "com.anthill.desktop";

/**
 * Where the installed Anthill is, if it is installed (macOS).
 *
 * The two places an app is installed from a `.dmg`, the same ones
 * `installed-runtime.ts` looks in, with its bundle id read out of Info.plist;
 * then Spotlight, for an app somebody moved elsewhere. Spotlight is asked by
 * bundle id through `execFile`, never a shell.
 */
export async function findInstalledApp(
  home: string = homedir(),
  read: (path: string) => string | undefined = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  spotlight: () => Promise<string | undefined> = findBySpotlight,
): Promise<string | undefined> {
  for (const app of ["/Applications/Anthill.app", join(home, "Applications", "Anthill.app")]) {
    if (read(join(app, "Contents", "Info.plist"))?.includes(BUNDLE_ID)) return app;
  }
  return spotlight();
}

function findBySpotlight(): Promise<string | undefined> {
  return new Promise((settle) => {
    execFile("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`], { timeout: 2_000 }, (error, stdout) => {
      settle(error ? undefined : String(stdout).split("\n").find((line) => line.endsWith(".app")));
    });
  });
}

/**
 * Whether an Electron Anthill is running on this data directory.
 *
 * Electron holds its single-instance lock as a `SingletonLock` link in the
 * data directory, pointing at `<host>-<pid>`. The link outlives a crash, so the
 * process it names has to be alive too; one that cannot be checked is taken as
 * not running, which only changes what the message says.
 */
export function appRunning(dataDir: string): boolean {
  try {
    const owner = readlinkSync(join(dataDir, "SingletonLock"));
    return alive(Number(owner.slice(owner.lastIndexOf("-") + 1)));
  } catch {
    return false;
  }
}

/** Whether a process is alive, for a caller outside this module (the web launcher's start marker). */
export function pidAlive(pid: number): boolean {
  return alive(pid);
}

/**
 * The web shell running on this data directory, and the port it listens on.
 *
 * `instance.lock` is the web shell's own single-instance lock:
 * `{pid, port, host, startedAt, token?}` (apps/cli/src/cli.ts, LOCK_FILE). The
 * port is read from it and never assumed; the token is there once it listens.
 */
export function webShellRunning(dataDir: string): WebShell | undefined {
  try {
    const lock = JSON.parse(readFileSync(join(dataDir, "instance.lock"), "utf8")) as {
      pid?: unknown;
      port?: unknown;
      host?: unknown;
      token?: unknown;
    };
    if (typeof lock.pid !== "number" || !alive(lock.pid)) return undefined;
    if (typeof lock.port !== "number") return undefined;
    return {
      port: lock.port,
      host: typeof lock.host === "string" ? lock.host : "127.0.0.1",
      ...(typeof lock.token === "string" && lock.token ? { token: lock.token } : {}),
    };
  } catch {
    return undefined;
  }
}

/** A running web shell, as its `instance.lock` describes it (apps/cli/src/cli.ts, LOCK_FILE). */
export type WebShell = { port: number; host: string; token?: string };

/**
 * Where to reach a web shell from this machine: a wildcard bind is reached on
 * loopback, and an IPv6 address needs its brackets in a URL.
 */
function reachableHost(host: string): string {
  if (host === "" || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

/** The web shell's origin, e.g. `http://127.0.0.1:4173`. */
export function webShellOrigin(shell: WebShell): string {
  return `http://${reachableHost(shell.host)}:${shell.port}`;
}

/**
 * The link that opens one handed-over workflow in the web shell (ANT-231):
 * `http://<host>:<port>/workflow/<id>`, carrying the shell's token so the
 * page it opens can talk to it. There is no `anthill://` handler on Linux and
 * Windows; this is the web shell's equivalent.
 */
export function webShellLink(shell: WebShell, workflowId: string): string {
  return `${webShellOrigin(shell)}/workflow/${encodeURIComponent(workflowId)}${shell.token ? `?token=${encodeURIComponent(shell.token)}` : ""}`;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What a chat's handover can ask for. Only the first handover's request counts. */
export type TargetRequest = { build?: "dev" };

/** Everything the rule reads, gathered once when the server starts. */
export type TargetContext = TargetEnvironment & {
  /** `--target` / `--dev` in the plugin's `.mcp.json`. */
  flag?: Target;
  /** `"target"` in `~/.anthill/plugin.json`. */
  setting?: Target;
  /** `--data-dir`: overrides only the directory, keeps the target's launcher. */
  dataDir?: string;
  /** The checkout this server was built in. */
  checkout?: string;
};

export type ResolvedTarget = {
  target: Target;
  source: TargetSource;
  label: string;
  dataDir: string;
  checkout?: string;
};

export type Resolution = { ok: true; resolved: ResolvedTarget } | { ok: false; message: string };

/** The rule, as a function of what it reads. */
export function resolveTarget(context: TargetContext, request: TargetRequest = {}): Resolution {
  const chosen = choose(context, request);
  if ("message" in chosen) return { ok: false, message: chosen.message };
  const { target, source } = chosen;
  return {
    ok: true,
    resolved: {
      target,
      source,
      label: TARGET_LABEL[target],
      dataDir: context.dataDir ?? targetDataDir(target, context),
      ...(context.checkout ? { checkout: context.checkout } : {}),
    },
  };
}

function choose(
  context: TargetContext,
  request: TargetRequest,
): { target: Target; source: TargetSource } | { message: string } {
  if (context.platform !== "darwin") return { target: "web", source: "platform" };
  if (request.build === "dev") {
    return context.checkout
      ? { target: "electron-dev", source: "build" }
      : {
          message:
            "--dev asks for Anthill's development build, and this server was not built in an Anthill checkout, so there is none to start. " +
            "Build it from a checkout (npm run build:deps && npm run build --workspace=@anthill/mcp) and point ~/.anthill/plugin.json at that server, or drop --dev to use the installed app.",
        };
  }
  if (context.flag) return { target: context.flag, source: "flag" };
  if (context.setting) return { target: context.setting, source: "settings" };
  return { target: "app", source: "default" };
}

/** What a handler needs once the target is known. */
export type Reach = {
  store: ExchangeStore;
  launch: Launcher;
  resolved: ResolvedTarget;
  /**
   * The link a result gives for a workflow: `anthill://workflow/<id>` for the
   * desktop builds, the web shell's own `http://` link for `web` while it is
   * running, which is when there is a port to put in it.
   */
  link: (workflowId: string) => string;
};

export type Refusal = { refused: string };

/** The launcher each target is reached through, given its resolution. */
export type LauncherFor = (resolved: ResolvedTarget) => Launcher;

/**
 * One chat's target: resolved at the first handover and kept.
 *
 * `handover` is for the calls that leave something in an exchange — they pin.
 * `read` is for the calls that only look: it uses the pinned target, and before
 * anything is pinned, the rule without a build request, without pinning it, so
 * a chat that picks up an existing workflow by reading it first is not decided
 * by that read.
 */
export class TargetSession {
  private pinned: Reach | undefined;
  private readonly cache = new Map<string, ExchangeStore>();

  constructor(
    private readonly context: TargetContext,
    private readonly launcherFor: LauncherFor,
    private readonly onPin: (resolved: ResolvedTarget) => void = () => undefined,
  ) {}

  /** The machine the targets are resolved on: platform, home and environment. */
  get environment(): TargetEnvironment {
    const { platform, home, env } = this.context;
    return { platform, home, env };
  }

  /** The pinned target, if a handover has pinned one. */
  get target(): ResolvedTarget | undefined {
    return this.pinned?.resolved;
  }

  handover(request: TargetRequest = {}): Reach | Refusal {
    if (this.pinned) {
      // A later call asking for a different build than the one the chat is
      // pinned to is refused: switching builds takes a new chat, because the
      // workflows so far live in the pinned one's exchange.
      if (request.build === "dev" && this.context.platform === "darwin" && this.pinned.resolved.target !== "electron-dev") {
        return {
          refused:
            `This chat's handovers already go to ${this.pinned.resolved.label}, and --dev asks for the development build. ` +
            "Switching builds takes a new chat: the workflows so far are in this one's exchange.",
        };
      }
      return this.pinned;
    }
    const resolution = resolveTarget(this.context, request);
    if (!resolution.ok) return { refused: resolution.message };
    this.pinned = this.reach(resolution.resolved);
    this.onPin(resolution.resolved);
    return this.pinned;
  }

  /**
   * A look that does not decide. With a build request — a session picking a
   * `--dev` handover back up reads it before it binds — it looks in that
   * build's exchange, still without pinning.
   */
  read(request: TargetRequest = {}): Reach | Refusal {
    if (this.pinned) return this.pinned;
    const resolution = resolveTarget(this.context, request);
    if (!resolution.ok) return { refused: resolution.message };
    return this.reach(resolution.resolved);
  }

  private reach(resolved: ResolvedTarget): Reach {
    let store = this.cache.get(resolved.dataDir);
    if (!store) {
      store = new ExchangeStore(resolved.dataDir);
      this.cache.set(resolved.dataDir, store);
    }
    const link = resolved.target === "web"
      ? (workflowId: string) => {
          // Only a link a page can use: one that carries the shell's token,
          // which it records once it listens.
          const shell = webShellRunning(resolved.dataDir);
          return shell?.token ? webShellLink(shell, workflowId) : workflowUrl(workflowId);
        }
      : workflowUrl;
    return { store, launch: this.launcherFor(resolved), resolved, link };
  }
}


/**
 * The installed app's launcher, which also points at `--dev` when it cannot
 * find the app and this server was built in a checkout (ANT-225).
 */
export function appLauncher(open: Launcher, checkout: string | undefined): Launcher {
  return async (url) => {
    const report = await open(url);
    if (report.outcome !== "no_handler" || !checkout) return report;
    return {
      ...report,
      message:
        `${report.message ?? "Anthill is not installed."} ` +
        "This server was built in an Anthill checkout, so `/anthill:workflow design --dev …` in a new chat reaches its development build instead.",
    };
  };
}

/** How long a start the server made counts as still coming up. */
export const DEV_START_WINDOW_MS = 3 * 60 * 1000;

/** What starting the development build needs, injected so a test starts nothing. */
export type DevStart = {
  /** Whether the build is running on its data directory. */
  running: (dataDir: string) => boolean;
  now: () => number;
  /** The start marker: when this server last started the build. */
  readMarker: () => { pid?: number; at: number } | undefined;
  writeMarker: (marker: { pid?: number; at: number }) => void;
  /** Start `command args` in `cwd`, detached, writing its output to `log`. */
  start: (command: string, args: readonly string[], cwd: string, log: string) => Promise<{ pid?: number } | { error: string }>;
  /** `npm`, found next to this Node rather than on the harness's PATH. */
  npm: string;
  logFile: string;
};

/**
 * The launcher for the development build (ANT-225).
 *
 * Running: nothing to do — it picks the handover up from its own exchange.
 * Not running: start `npm run dev:desktop` in the checkout, detached, and say
 * it takes about a minute; the handover waits in its inbox and is shown when
 * the build comes up. A start marker keeps two handovers in quick succession
 * from starting it twice: for three minutes, or until the build's own lock
 * appears, a second handover only says it is still starting.
 *
 * Nothing goes through a shell: `npm` and its arguments are an argument array,
 * and the working directory is the checkout this server was built in — the only
 * place a checkout path comes from.
 */
export function electronDevLauncher(dataDir: string, checkout: string | undefined, dependencies: DevStart): Launcher {
  const { running, now, readMarker, writeMarker, start, npm, logFile } = dependencies;
  const command = `cd ${checkout ?? "<your Anthill checkout>"} && npm run dev:desktop`;
  return async (url) => {
    if (running(dataDir)) {
      return { outcome: "running", message: "The development build is running and shows the handover from its own exchange." };
    }
    if (!checkout) {
      return {
        outcome: "failed",
        message: `The development build is not running, and this server was not built in an Anthill checkout, so there is nothing to start. Run \`${command}\` in one; the handover is stored and ${url} opens it there.`,
      };
    }
    const marker = readMarker();
    if (marker && now() - marker.at < DEV_START_WINDOW_MS) {
      return { outcome: "starting", message: "The development build was started moments ago and is still coming up; it shows the handover once it is." };
    }
    const started = await start(npm, ["run", "dev:desktop"], checkout, logFile);
    if ("error" in started) {
      return {
        outcome: "failed",
        message: `The development build is not running, and starting it failed (${started.error}). Run \`${command}\` yourself; its log is ${logFile}. The handover is stored and waits for it.`,
      };
    }
    writeMarker({ ...(started.pid ? { pid: started.pid } : {}), at: now() });
    return {
      outcome: "started",
      message: `Starting the development build (npm run dev:desktop in ${checkout}); it takes about a minute, and the handover waits in its inbox until it is up. Its log is ${logFile}.`,
    };
  };
}

/** Starting a program in the background, once: what the dev build and the web shell launchers share. */
export type DetachedStart = {
  now: () => number;
  /** The start marker: when this server last started the program. */
  readMarker: () => { pid?: number; at: number } | undefined;
  writeMarker: (marker: { pid?: number; at: number }) => void;
  /** Start `command args` in `cwd`, detached, writing its output to `log`. */
  start: (command: string, args: readonly string[], cwd: string, log: string) => Promise<{ pid?: number } | { error: string }>;
  logFile: string;
};

/**
 * The real detached start, for the program called `name`: its log is
 * `~/.anthill/logs/<name>.log` and its start marker `<name>.starting`.
 */
export function detachedStart(name: string, home: string = homedir()): DetachedStart {
  const logs = join(home, ".anthill", "logs");
  const markerFile = join(logs, `${name}.starting`);
  const logFile = join(logs, `${name}.log`);
  return {
    now: () => Date.now(),
    readMarker: () => {
      try {
        const marker = JSON.parse(readFileSync(markerFile, "utf8")) as { pid?: unknown; at?: unknown };
        return typeof marker.at === "number" ? { at: marker.at, ...(typeof marker.pid === "number" ? { pid: marker.pid } : {}) } : undefined;
      } catch {
        return undefined;
      }
    },
    writeMarker: (marker) => {
      try {
        mkdirSync(logs, { recursive: true });
        writeFileSync(markerFile, JSON.stringify(marker));
      } catch {
        // A marker that cannot be written only means a second handover might
        // start the program again, which its own lock then refuses.
      }
    },
    start: (command, args, cwd, log) =>
      new Promise((settle) => {
        let out: number;
        try {
          // Owner-only: what the program prints can include the web shell's token.
          mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
          out = openSync(log, "a", 0o600);
        } catch (error) {
          settle({ error: `the log ${log} could not be opened: ${(error as Error).message}` });
          return;
        }
        const child = spawn(command, [...args], {
          cwd,
          detached: true,
          stdio: ["ignore", out, out],
          windowsHide: true,
          // `npm` finds `node` on PATH; give it the directory of this one.
          env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
        });
        // Either event may come first, and an error can still follow a spawn; the
        // log is closed once and the first answer stands.
        let open = true;
        const close = () => { if (open) { open = false; closeSync(out); } };
        child.once("spawn", () => {
          child.unref();
          close();
          settle({ ...(child.pid ? { pid: child.pid } : {}) });
        });
        child.on("error", (error) => {
          close();
          settle({ error: error.message });
        });
      }),
    logFile,
  };
}

/** The real start of the development build: a detached `npm` whose output goes to a log file. */
export function devStart(home: string = homedir()): DevStart {
  const beside = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return {
    ...detachedStart("dev-desktop", home),
    running: appRunning,
    npm: existsSync(beside) ? beside : "npm",
  };
}
