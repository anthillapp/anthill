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
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { LaunchReport, Launcher } from "./launch.js";

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

/**
 * The web shell running on this data directory, and the port it listens on.
 *
 * `instance.lock` is the web shell's own single-instance lock:
 * `{pid, port, host, startedAt}`. The port is read from it and never assumed.
 */
export function webShellRunning(dataDir: string): { port: number; host: string } | undefined {
  try {
    const lock = JSON.parse(readFileSync(join(dataDir, "instance.lock"), "utf8")) as {
      pid?: unknown;
      port?: unknown;
      host?: unknown;
    };
    if (typeof lock.pid !== "number" || !alive(lock.pid)) return undefined;
    if (typeof lock.port !== "number") return undefined;
    return { port: lock.port, host: typeof lock.host === "string" ? lock.host : "127.0.0.1" };
  } catch {
    return undefined;
  }
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

  /** The pinned target, if a handover has pinned one. */
  get target(): ResolvedTarget | undefined {
    return this.pinned?.resolved;
  }

  handover(request: TargetRequest = {}): Reach | Refusal {
    if (this.pinned) return this.pinned;
    const resolution = resolveTarget(this.context, request);
    if (!resolution.ok) return { refused: resolution.message };
    this.pinned = this.reach(resolution.resolved);
    this.onPin(resolution.resolved);
    return this.pinned;
  }

  read(): Reach {
    if (this.pinned) return this.pinned;
    const resolution = resolveTarget(this.context);
    // Without a build request the rule cannot refuse.
    if (!resolution.ok) throw new Error(resolution.message);
    return this.reach(resolution.resolved);
  }

  private reach(resolved: ResolvedTarget): Reach {
    let store = this.cache.get(resolved.dataDir);
    if (!store) {
      store = new ExchangeStore(resolved.dataDir);
      this.cache.set(resolved.dataDir, store);
    }
    return { store, launch: this.launcherFor(resolved), resolved };
  }
}

/**
 * The launcher for the development build: it opens nothing.
 *
 * The installed app is the only one macOS can be asked to open — a development
 * build runs as the stock Electron bundle, which is every dev Electron on the
 * machine (ANT-137) — and it could not see this handover anyway. A running
 * development build picks the handover up from its own exchange.
 */
export function devLauncher(dataDir: string, running: (dir: string) => boolean = appRunning): Launcher {
  return async (url: string): Promise<LaunchReport> =>
    running(dataDir)
      ? { outcome: "running", message: "The development build is running and shows the handover from its own exchange." }
      : {
          outcome: "not_running",
          message:
            "The development build is not running, so nothing shows the handover yet. " +
            `Start it from the checkout with \`npm run dev:desktop\`; the handover is stored and ${url} opens it there.`,
        };
}

/**
 * The launcher for the web shell: it opens nothing yet.
 *
 * A running web shell picks the handover up from its own exchange. Starting
 * the shell, and opening its tab, is the web launcher's job (ANT-231).
 */
export function webLauncher(
  dataDir: string,
  running: (dir: string) => { port: number; host: string } | undefined = webShellRunning,
): Launcher {
  return async (): Promise<LaunchReport> => {
    const shell = running(dataDir);
    return shell
      ? { outcome: "running", message: `The web shell is running at http://${shell.host}:${shell.port}/ and shows the handover from its own exchange.` }
      : {
          outcome: "not_running",
          message: "The web shell is not running, so nothing shows the handover yet. Start it with `anthill` from the checkout; the handover is stored and waits for it.",
        };
  };
}
