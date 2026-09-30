/**
 * ANT-230. Opening the author's browser on every platform, without a shell.
 *
 * The platform and the spawner are injected, so nothing is launched: each
 * test records what would have been run and answers as the program would.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { browserOpeners, openBrowser, type OpenerDeps } from "./cli.js";

const URL_WITH_QUERY = "http://127.0.0.1:4173/workflow/wf-1?token=abc&x=1";

/** A spawner whose programs exit with the given codes (or fail to start, for "missing"). */
function machine(platform: NodeJS.Platform, answers: Record<string, number | "missing">) {
  const ran: { command: string; args: string[]; options: unknown }[] = [];
  const logged: string[] = [];
  const deps: OpenerDeps = {
    platform,
    spawn: (command, args, options) => {
      ran.push({ command, args, options });
      const answer = answers[command] ?? "missing";
      return {
        on(event: "error" | "exit", listener: (code?: number | null) => void) {
          if (event === "error" && answer === "missing") queueMicrotask(() => listener());
          if (event === "exit" && answer !== "missing") queueMicrotask(() => listener(answer));
          return this;
        },
      } as ReturnType<OpenerDeps["spawn"]>;
    },
    log: (line) => logged.push(line),
  };
  return { deps, ran, logged };
}

describe("the browser openers", () => {
  it.each([
    ["darwin", [{ command: "/usr/bin/open", args: [URL_WITH_QUERY] }]],
    ["win32", [{ command: expect.stringMatching(/\\System32\\rundll32\.exe$/), args: ["url.dll,FileProtocolHandler", URL_WITH_QUERY] }]],
    ["linux", ["xdg-open", "wslview", "sensible-browser"].map((command) => ({ command, args: [URL_WITH_QUERY] }))],
  ] as const)("on %s: the URL is one argument, whole", (platform, expected) => {
    expect(browserOpeners(platform, URL_WITH_QUERY)).toEqual(expected);
  });

  it.each(["darwin", "win32", "linux"] as const)("on %s: runs the opener with no shell and says it opened", async (platform) => {
    const [first] = browserOpeners(platform, URL_WITH_QUERY);
    const { deps, ran, logged } = machine(platform, { [first!.command]: 0 });

    expect(await openBrowser(URL_WITH_QUERY, deps)).toBe(true);

    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ command: first!.command, args: first!.args });
    expect(ran[0]!.options).not.toHaveProperty("shell");
    expect(logged).toEqual([]);
  });

  it("tries the next Linux opener when one is missing or fails", async () => {
    const { deps, ran } = machine("linux", { "xdg-open": "missing", wslview: 3, "sensible-browser": 0 });

    expect(await openBrowser(URL_WITH_QUERY, deps)).toBe(true);
    expect(ran.map((run) => run.command)).toEqual(["xdg-open", "wslview", "sensible-browser"]);
  });

  it.each(["darwin", "win32", "linux"] as const)("on a headless %s: prints the URL and tells the caller nothing opened", async (platform) => {
    const { deps, logged } = machine(platform, {});

    expect(await openBrowser(URL_WITH_QUERY, deps)).toBe(false);
    expect(logged).toEqual([`Open this in a browser: ${URL_WITH_QUERY}`]);
  });

  describe("an opener that is still running", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("counts as opened, and no second one is tried", async () => {
      vi.useFakeTimers();
      const ran: string[] = [];
      const deps: OpenerDeps = {
        platform: "linux",
        // xdg-open in the foreground for as long as the browser runs: it never exits.
        spawn: (command) => { ran.push(command); return { on() { return this; } } as ReturnType<OpenerDeps["spawn"]>; },
        log: () => { throw new Error("nothing should be printed"); },
      };

      const opened = openBrowser(URL_WITH_QUERY, deps);
      await vi.advanceTimersByTimeAsync(5000);

      expect(await opened).toBe(true);
      expect(ran).toEqual(["xdg-open"]);
    });

    it("moves on from a spawner that throws", async () => {
      const { deps, ran } = machine("linux", { wslview: 0 });
      const throwing: OpenerDeps = { ...deps, spawn: (command, args, options) => {
        if (command === "xdg-open") throw new Error("EINVAL");
        return deps.spawn(command, args, options);
      } };

      expect(await openBrowser(URL_WITH_QUERY, throwing)).toBe(true);
      expect(ran.map((run) => run.command)).toEqual(["wslview"]);
    });
  });
});
