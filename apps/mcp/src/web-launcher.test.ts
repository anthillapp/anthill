/**
 * ANT-231. The `web` launcher, row by row.
 *
 * Everything it touches is injected: the lock it reads, the `/health` it asks,
 * the browser it opens and the process it starts. So each state of the table
 * in web-launcher.ts is set up directly, and what the launcher did is read
 * back off the fakes.
 */

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { WEB_START_WINDOW_MS, browserOpeners, webLauncher, webShellCli, type WebStart } from "./web-launcher.js";
import type { WebShell } from "./target.js";

const URL = "anthill://workflow/wf%201";
const DATA = "/home/someone/.anthill/cli";
const CHECKOUT = "/src/anthill";
const SHELL: WebShell = { host: "127.0.0.1", port: 4180, token: "t0k" };
const LINK = "http://127.0.0.1:4180/workflow/wf%201?token=t0k";

function world(over: Partial<WebStart> & { shell?: WebShell; clients?: number | "silent"; built?: boolean; upAfterStart?: WebShell; dead?: number[] } = {}) {
  let shell = over.shell;
  let marker: { pid?: number; at: number } | undefined;
  const clock = 5_000_000;
  const opened: string[] = [];
  const starts: { command: string; args: readonly string[]; cwd: string; log: string }[] = [];
  const deps: WebStart = {
    running: () => shell,
    health: async () => (over.clients === "silent" ? undefined : { clients: over.clients ?? 0 }),
    open: async (url) => { opened.push(url); return true; },
    exists: () => over.built ?? true,
    wait: async () => undefined,
    alive: (pid) => !(over.dead ?? []).includes(pid),
    node: "/usr/local/bin/node",
    now: () => clock,
    readMarker: () => marker,
    writeMarker: (next) => { marker = next; },
    start: async (command, args, cwd, log) => {
      starts.push({ command, args, cwd, log });
      shell = over.upAfterStart;
      return { pid: 4242 };
    },
    logFile: "/home/someone/.anthill/logs/web-shell.log",
    ...over,
  };
  return { deps, opened, starts, marker: () => marker, setMarker: (at: number) => { marker = { at }; }, clock };
}

describe("the web launcher", () => {
  it("does nothing when the shell is running with a tab connected: the tab is sent the handover", async () => {
    const w = world({ shell: SHELL, clients: 1 });

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(report).toMatchObject({ outcome: "running", link: LINK });
    expect(w.opened).toEqual([]);
    expect(w.starts).toEqual([]);
  });

  it("opens the workflow's own page when the shell is running with no tab", async () => {
    const w = world({ shell: SHELL, clients: 0 });

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(report).toEqual({ outcome: "opened", link: LINK });
    expect(w.opened).toEqual([LINK]);
  });

  it("says so, with the link, when no browser can be opened", async () => {
    const w = world({ shell: SHELL, clients: 0, open: async () => false });

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(report).toMatchObject({ outcome: "failed", link: LINK });
    expect(report.message).toContain("no browser could be opened");
  });

  it("treats a shell whose /health does not answer yet as starting", async () => {
    const w = world({ shell: SHELL, clients: "silent" });

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(report).toMatchObject({ outcome: "starting", link: LINK });
    expect(w.opened).toEqual([]);
  });

  it("starts the shell when it is not running: this node, the built CLI, its data dir, detached, once", async () => {
    const w = world({ upAfterStart: SHELL });

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(w.starts).toEqual([{
      command: "/usr/local/bin/node",
      args: [webShellCli(CHECKOUT), `--data-dir=${DATA}`],
      cwd: CHECKOUT,
      log: "/home/someone/.anthill/logs/web-shell.log",
    }]);
    expect(report).toMatchObject({ outcome: "started", link: LINK });
    expect(report.message).toContain("web-shell.log");
    expect(w.marker()).toEqual({ pid: 4242, at: w.clock });

    // A second handover while it comes up starts nothing.
    const second = await webLauncher(DATA, CHECKOUT, { ...w.deps, running: () => undefined })(URL);
    expect(second.outcome).toBe("starting");
    expect(w.starts).toHaveLength(1);
  });

  it("starts it again once the start window has passed", async () => {
    const w = world();
    w.setMarker(w.clock - WEB_START_WINDOW_MS - 1);

    await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(w.starts).toHaveLength(1);
  });

  it("reports a start without a link when the shell has not taken its lock yet", async () => {
    const w = world();

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(report.outcome).toBe("started");
    expect(report.link).toBeUndefined();
  });

  it("says how to build it when the CLI is not built, and starts nothing", async () => {
    const w = world({ built: false });

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(report.outcome).toBe("failed");
    expect(report.message).toContain("npm run build --workspace=@anthill/cli");
    expect(w.starts).toEqual([]);
  });

  it("says so, with the command and the log, when the start fails", async () => {
    const w = world({ start: async () => ({ error: "spawn EACCES" }) });

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(report.outcome).toBe("failed");
    expect(report.message).toContain("spawn EACCES");
    expect(report.message).toContain(`node ${webShellCli(CHECKOUT)} --data-dir=${DATA}`);
    expect(report.message).toContain("web-shell.log");
    expect(w.marker()).toBeUndefined();
  });

  it("quotes a checkout path with spaces in the command it gives", async () => {
    const w = world({ start: async () => ({ error: "boom" }) });

    const report = await webLauncher(DATA, "/Users/some one/anthill", w.deps)(URL);

    expect(report.message).toContain(`node '${webShellCli("/Users/some one/anthill")}' --data-dir=${DATA}`);
  });

  it("waits for the token, which the shell records after it takes its lock, before giving a link", async () => {
    let looks = 0;
    const w = world({ upAfterStart: { host: "127.0.0.1", port: 4180 } });
    const deps: WebStart = {
      ...w.deps,
      running: () => (w.starts.length === 0 ? undefined : (looks += 1) < 3 ? { host: "127.0.0.1", port: 4180 } : SHELL),
    };

    const report = await webLauncher(DATA, CHECKOUT, deps)(URL);

    expect(report).toMatchObject({ outcome: "started", link: LINK });
  });

  it("gives no link for a shell that has not recorded its token yet", async () => {
    const w = world({ shell: { host: "127.0.0.1", port: 4180 }, clients: "silent" });

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(report.outcome).toBe("starting");
    expect(report.link).toBeUndefined();
  });

  it("says a shell that exits straight after starting did not start, with its log", async () => {
    const w = world({ dead: [4242] });

    const report = await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(report.outcome).toBe("failed");
    expect(report.message).toContain("exited at once");
    expect(report.message).toContain("web-shell.log");
  });

  it("does not let a start whose process died hold the next handover off", async () => {
    const w = world({ dead: [7] });
    w.deps.writeMarker({ pid: 7, at: w.clock });

    await webLauncher(DATA, CHECKOUT, w.deps)(URL);

    expect(w.starts).toHaveLength(1);
  });

  it("starts the shell on the data directory made absolute", async () => {
    const w = world();

    await webLauncher("relative/data", CHECKOUT, w.deps)(URL);

    expect(w.starts[0]!.args).toEqual([webShellCli(CHECKOUT), `--data-dir=${resolve("relative/data")}`]);
  });

  it("has nothing to start without a checkout", async () => {
    const w = world();

    const report = await webLauncher(DATA, undefined, w.deps)(URL);

    expect(report.outcome).toBe("failed");
    expect(w.starts).toEqual([]);
  });

  it.each([
    [{ host: "0.0.0.0", port: 4180, token: "t" }, "http://127.0.0.1:4180/workflow/wf%201?token=t"],
    // Bracketed as a URL needs; the CLI's own origin check does not accept it
    // yet, which is the CLI's to fix.
    [{ host: "::1", port: 4180, token: "t" }, "http://[::1]:4180/workflow/wf%201?token=t"],
  ])("reaches a shell bound to %j at %s", async (shell, link) => {
    const w = world({ shell, clients: 1 });
    expect((await webLauncher(DATA, CHECKOUT, w.deps)(URL)).link).toBe(link);
  });
});

describe("the MCP server's browser openers", () => {
  it.each(["darwin", "win32", "linux"] as const)("on %s: match the web shell's, the URL one argument", (platform) => {
    const openers = browserOpeners(platform, LINK, { SystemRoot: "C:\\Windows" });
    expect(openers.every((opener) => opener.args.at(-1) === LINK)).toBe(true);
    expect(openers[0]!.command).toBe(
      { darwin: "/usr/bin/open", win32: "C:\\Windows\\System32\\rundll32.exe", linux: "xdg-open" }[platform],
    );
  });
});
