/**
 * ANT-222: which Anthill a chat's handovers reach.
 *
 * The rule (architecture doc §5.2): Linux and Windows use the web shell; on
 * macOS a chat's `build: "dev"` chooses the development build, from a
 * checkout; then this plugin copy's `--target`, then the machine's
 * `plugin.json`; otherwise the installed app. The answer is pinned at the first
 * handover.
 */

import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEV_START_WINDOW_MS,
  TargetSession,
  appLauncher,
  appRunning,
  checkoutOf,
  devStart,
  electronDevLauncher,
  findInstalledApp,
  readTarget,
  readTargetSetting,
  resolveTarget,
  targetDataDir,
  webShellRunning,
  type DevStart,
  type TargetContext,
} from "./target.js";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "anthill-target-"));
}

const HOME = "/Users/someone";
const mac = (over: Partial<TargetContext> = {}): TargetContext => ({
  platform: "darwin", home: HOME, env: {}, checkout: "/src/anthill", ...over,
});

const pick = (context: TargetContext, build?: "dev") => {
  const resolution = resolveTarget(context, build ? { build } : {});
  return resolution.ok ? `${resolution.resolved.target}/${resolution.resolved.source}` : "refused";
};

describe("the rule", () => {
  it("uses the web shell on Linux and Windows, whatever else is said", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(pick(mac({ platform }))).toBe("web/platform");
      expect(pick(mac({ platform, flag: "app", setting: "electron-dev" }), "dev")).toBe("web/platform");
    }
  });

  it("gives a chat's --dev the development build, over the flag and the setting", () => {
    expect(pick(mac({ flag: "web", setting: "app" }), "dev")).toBe("electron-dev/build");
  });

  it("refuses --dev without a checkout rather than falling back to the installed app", () => {
    const resolution = resolveTarget(mac({ checkout: undefined }), { build: "dev" });
    expect(resolution.ok).toBe(false);
    expect(!resolution.ok && resolution.message).toContain("checkout");
  });

  it("then takes this plugin copy's --target, over the machine's setting", () => {
    expect(pick(mac({ flag: "web", setting: "electron-dev" }))).toBe("web/flag");
  });

  it("then the machine's plugin.json", () => {
    expect(pick(mac({ setting: "electron-dev" }))).toBe("electron-dev/settings");
  });

  it("otherwise, on macOS, the installed app", () => {
    expect(pick(mac())).toBe("app/default");
    expect(pick(mac({ checkout: undefined }))).toBe("app/default");
  });

  it("puts each target's exchange in its own data directory", () => {
    const environment = { platform: "darwin" as const, home: HOME, env: {} };
    expect(targetDataDir("app", environment)).toBe(join(HOME, "Library/Application Support/@anthill/desktop"));
    expect(targetDataDir("electron-dev", environment)).toBe(join(HOME, "Library/Application Support/@anthill/desktop-dev"));
    expect(targetDataDir("web", environment)).toBe(join(HOME, ".anthill/cli"));
    expect(targetDataDir("web", { platform: "linux", home: "/home/me", env: {} })).toBe("/home/me/.anthill/cli");
  });

  it("lets --data-dir move only the directory", () => {
    const resolution = resolveTarget(mac({ dataDir: "/var/anthill" }), { build: "dev" });
    expect(resolution.ok && resolution.resolved).toMatchObject({ target: "electron-dev", dataDir: "/var/anthill" });
  });
});

describe("how a target is spelled", () => {
  it.each([
    ["app", "app"], ["electron-dev", "electron-dev"], ["web", "web"],
    ["installed", "app"], ["dev", "electron-dev"],
  ])("reads %s as %s", (spelled, target) => {
    expect(readTarget(spelled)).toBe(target);
  });

  it.each([["staging"], [""], [3], [undefined]])("reads %j as nothing", (value) => {
    expect(readTarget(value)).toBeUndefined();
  });

  it("reads the machine's setting, and nothing from a missing, damaged or foreign file", async () => {
    const root = await dir();
    await writeFile(join(root, "dev.json"), JSON.stringify({ server: "/abs/server.js", target: "dev" }));
    expect(readTargetSetting(join(root, "dev.json"))).toBe("electron-dev");
    await writeFile(join(root, "web.json"), JSON.stringify({ target: "web" }));
    expect(readTargetSetting(join(root, "web.json"))).toBe("web");
    expect(readTargetSetting(join(root, "missing.json"))).toBeUndefined();
    await writeFile(join(root, "broken.json"), "{");
    expect(readTargetSetting(join(root, "broken.json"))).toBeUndefined();
    await writeFile(join(root, "other.json"), JSON.stringify({ target: "staging" }));
    expect(readTargetSetting(join(root, "other.json"))).toBeUndefined();
  });
});

describe("a chat's pinned target", () => {
  const launch = async () => ({ outcome: "opened" as const });

  it("is resolved at the first handover and cannot change after", async () => {
    const root = await dir();
    const pinned: string[] = [];
    const session = new TargetSession(mac({ dataDir: root }), () => launch, (resolved) => pinned.push(resolved.target));

    const first = session.handover({ build: "dev" });
    expect("resolved" in first && first.resolved.target).toBe("electron-dev");
    const second = session.handover({});
    expect("resolved" in second && second.resolved.target).toBe("electron-dev");
    const read = session.read();
    expect("resolved" in read && read.resolved.target).toBe("electron-dev");
    expect(pinned).toEqual(["electron-dev"]);
  });

  it("is not pinned by a read before the first handover", async () => {
    const session = new TargetSession(mac({ dataDir: await dir() }), () => launch);
    const read = session.read();
    expect("resolved" in read && read.resolved.target).toBe("app");
    const dev = session.read({ build: "dev" });
    expect("resolved" in dev && dev.resolved.target).toBe("electron-dev");
    expect(session.target).toBeUndefined();
    const first = session.handover({ build: "dev" });
    expect("resolved" in first && first.resolved.target).toBe("electron-dev");
  });

  it("is not pinned by a refused handover", async () => {
    const session = new TargetSession(mac({ checkout: undefined, dataDir: await dir() }), () => launch);
    expect("refused" in session.handover({ build: "dev" })).toBe(true);
    expect(session.target).toBeUndefined();
    const next = session.handover({});
    expect("resolved" in next && next.resolved.target).toBe("app");
  });

  it("keeps one exchange store for the life of the chat", async () => {
    const session = new TargetSession(mac({ dataDir: await dir() }), () => launch);
    const first = session.handover();
    const second = session.handover();
    expect("store" in first && "store" in second && first.store === second.store).toBe(true);
  });
});

describe("the checkout this server was built in", () => {
  it("is three directories above dist/server.js, when its package is Anthill's", () => {
    const files: Record<string, string> = { "/src/anthill/package.json": JSON.stringify({ name: "anthill" }) };
    const read = (path: string) => {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path];
    };
    expect(checkoutOf("/src/anthill/apps/mcp/dist/server.js", read)).toBe("/src/anthill");
    files["/elsewhere/package.json"] = JSON.stringify({ name: "something-else" });
    expect(checkoutOf("/elsewhere/apps/mcp/dist/server.js", read)).toBeUndefined();
    expect(checkoutOf("/nowhere/apps/mcp/dist/server.js", read)).toBeUndefined();
    // Only the server's own place in a checkout counts, not any file under one.
    expect(checkoutOf("/src/anthill/apps/mcp/dist/other.js", read)).toBeUndefined();
    expect(checkoutOf("/src/anthill/x/y/z.js", read)).toBeUndefined();
  });
});

describe("the installed Anthill", () => {
  const plist = (id: string) => `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`;

  it("is found in /Applications or ~/Applications by its bundle id", async () => {
    const at = (files: Record<string, string>) => (path: string) => files[path];
    const nowhere = async () => undefined;
    expect(await findInstalledApp(HOME, at({ "/Applications/Anthill.app/Contents/Info.plist": plist("com.anthill.desktop") }), nowhere))
      .toBe("/Applications/Anthill.app");
    expect(await findInstalledApp(HOME, at({ [`${HOME}/Applications/Anthill.app/Contents/Info.plist`]: plist("com.anthill.desktop") }), nowhere))
      .toBe(`${HOME}/Applications/Anthill.app`);
    expect(await findInstalledApp(HOME, at({ "/Applications/Anthill.app/Contents/Info.plist": plist("com.example.other") }), nowhere))
      .toBeUndefined();
  });

  it("falls back to Spotlight for an app somebody moved", async () => {
    expect(await findInstalledApp(HOME, () => undefined, async () => "/Volumes/Apps/Anthill.app")).toBe("/Volumes/Apps/Anthill.app");
  });
});

describe("whether an Anthill is running", () => {
  it("counts an Electron build running when its lock names a live process", async () => {
    const root = await dir();
    await symlink(`this-host-${process.pid}`, join(root, "SingletonLock"));
    expect(appRunning(root)).toBe(true);
  });

  it("does not count a missing lock, or one a crash left behind", async () => {
    expect(appRunning(await dir())).toBe(false);
    const root = await dir();
    await symlink("this-host-999999999", join(root, "SingletonLock"));
    expect(appRunning(root)).toBe(false);
  });

  it("reads the web shell's port from its lock, and ignores a stale one", async () => {
    const root = await dir();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "instance.lock"), JSON.stringify({ pid: process.pid, port: 4180, host: "127.0.0.1", startedAt: "" }));
    expect(webShellRunning(root)).toEqual({ port: 4180, host: "127.0.0.1" });
    await writeFile(join(root, "instance.lock"), JSON.stringify({ pid: 999999999, port: 4180 }));
    expect(webShellRunning(root)).toBeUndefined();
    expect(webShellRunning(await dir())).toBeUndefined();
  });
});

/*
  ANT-225. With --dev, Anthill starts the development build itself when it is
  not running — once, however many handovers arrive while it comes up.
*/
describe("a handover to the development build", () => {
  const url = "anthill://workflow/w1";
  function world(over: Partial<DevStart> = {}) {
    const starts: { command: string; args: readonly string[]; cwd: string; log: string }[] = [];
    let marker: { pid?: number; at: number } | undefined;
    let clock = 1_000_000;
    const deps: DevStart = {
      running: () => false,
      now: () => clock,
      readMarker: () => marker,
      writeMarker: (next) => { marker = next; },
      start: async (command, args, cwd, log) => {
        starts.push({ command, args, cwd, log });
        return { pid: 4242 };
      },
      npm: "/opt/node/bin/npm",
      logFile: "/home/me/.anthill/logs/dev-desktop.log",
      ...over,
    };
    return { deps, starts, tick: (ms: number) => { clock += ms; }, marker: () => marker };
  }

  it("starts nothing when the build is already running", async () => {
    const { deps, starts } = world({ running: () => true });
    const report = await electronDevLauncher("/dev-data", "/src/anthill", deps)(url);
    expect(report.outcome).toBe("running");
    expect(starts).toEqual([]);
  });

  it("starts npm run dev:desktop in the checkout, detached, once", async () => {
    const { deps, starts, marker } = world();
    const launch = electronDevLauncher("/dev-data", "/src/anthill", deps);
    const first = await launch(url);
    expect(first.outcome).toBe("started");
    expect(first.message).toContain("about a minute");
    expect(starts).toEqual([
      { command: "/opt/node/bin/npm", args: ["run", "dev:desktop"], cwd: "/src/anthill", log: "/home/me/.anthill/logs/dev-desktop.log" },
    ]);
    expect(marker()).toEqual({ pid: 4242, at: 1_000_000 });

    const second = await launch(url);
    expect(second.outcome).toBe("starting");
    expect(starts).toHaveLength(1);
  });

  it("starts it again once the start window has passed without the build coming up", async () => {
    const { deps, starts, tick } = world();
    const launch = electronDevLauncher("/dev-data", "/src/anthill", deps);
    await launch(url);
    tick(DEV_START_WINDOW_MS + 1);
    expect((await launch(url)).outcome).toBe("started");
    expect(starts).toHaveLength(2);
  });

  it("says what to run, and where the log is, when the start fails", async () => {
    const { deps } = world({ start: async () => ({ error: "spawn npm ENOENT" }) });
    const report = await electronDevLauncher("/dev-data", "/src/anthill", deps)(url);
    expect(report.outcome).toBe("failed");
    expect(report.message).toContain("cd /src/anthill && npm run dev:desktop");
    expect(report.message).toContain("dev-desktop.log");
  });

  it("starts nothing without a checkout, and says so", async () => {
    const { deps, starts } = world();
    const report = await electronDevLauncher("/dev-data", undefined, deps)(url);
    expect(report.outcome).toBe("failed");
    expect(report.message).toContain("not built in an Anthill checkout");
    expect(starts).toEqual([]);
  });
});

describe("starting a detached process for the development build", () => {
  // Node itself stands in for npm: a real spawn, and no build.
  it("starts it detached with its output in the log, and says when it cannot", async () => {
    const home = await dir();
    const start = devStart(home);
    expect(start.logFile).toBe(join(home, ".anthill", "logs", "dev-desktop.log"));

    const started = await start.start(process.execPath, ["-e", "process.stdout.write('dev build up')"], home, start.logFile);
    expect("pid" in started && typeof started.pid).toBe("number");
    for (let i = 0; i < 50 && !(await readFile(start.logFile, "utf8").catch(() => "")).includes("dev build up"); i += 1) {
      await new Promise((settle) => setTimeout(settle, 50));
    }
    expect(await readFile(start.logFile, "utf8")).toContain("dev build up");

    const failed = await start.start(join(home, "no-such-npm"), ["run", "dev:desktop"], home, start.logFile);
    expect("error" in failed).toBe(true);

    start.writeMarker({ pid: 1, at: 5 });
    expect(start.readMarker()).toEqual({ pid: 1, at: 5 });
  });
});

describe("the installed app's launcher", () => {
  const url = "anthill://workflow/w1";
  const missing = async () => ({ outcome: "no_handler" as const, message: "Anthill could not be opened: it is not installed." });

  it("points at --dev when the app is missing and there is a checkout", async () => {
    const report = await appLauncher(missing, "/src/anthill")(url);
    expect(report.outcome).toBe("no_handler");
    expect(report.message).toContain("/anthill:workflow design --dev");
  });

  it("says nothing of --dev without a checkout, or when the app opened", async () => {
    expect((await appLauncher(missing, undefined)(url)).message).not.toContain("--dev");
    expect(await appLauncher(async () => ({ outcome: "opened" }), "/src/anthill")(url)).toEqual({ outcome: "opened" });
  });
});
