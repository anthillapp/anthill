/**
 * Adopting the author's PATH.
 *
 * This exists because a packaged Anthill reported both coding CLIs as missing
 * on a machine that had both. An app launched from Finder is started by launchd,
 * not by a shell, so it inherits a bare system PATH — no `~/.local/bin`, no
 * Homebrew, no version manager. Development could never show it: `npm run
 * dev:desktop` starts Electron from a shell, which is precisely the environment
 * the bug is absent in.
 *
 * The rule every test here holds: a failure leaves the PATH alone. Anthill
 * saying "not found" wrongly is bad; Anthill corrupting its own environment on
 * the strength of a garbled answer would be worse.
 */

import type { ChildProcessLike, SpawnFn } from "@anthill/runtimes";
import { describe, expect, it } from "vitest";

import { adoptUserPath, readShellPath } from "./user-path.js";

/** A shell that prints `stdout` and exits with `code`. */
function shellSaying(stdout: string, code = 0): SpawnFn {
  return () => {
    const out: ((...args: unknown[]) => void)[] = [];
    const closers: ((...args: unknown[]) => void)[] = [];
    const child: ChildProcessLike = {
      stdout: {
        on: (event: string, listener: (...args: unknown[]) => void) => {
          if (event === "data") out.push(listener);
          return undefined;
        },
        setEncoding: () => undefined,
      },
      stderr: { on: () => undefined, setEncoding: () => undefined },
      stdin: { write: () => true, end: () => undefined, on: () => undefined },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === "close") closers.push(listener);
        return undefined;
      },
      kill: () => undefined,
    };
    queueMicrotask(() => {
      for (const listener of out) listener(stdout);
      for (const listener of closers) listener(code);
    });
    return child;
  };
}

const SHELL = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };

describe("asking the shell", () => {
  it("takes the PATH the shell reports", async () => {
    const found = await readShellPath({
      spawnFn: shellSaying("__ANTHILL_PATH__/Users/a/.local/bin:/usr/bin:/bin"),
      env: { ...SHELL },
    });
    expect(found).toBe("/Users/a/.local/bin:/usr/bin:/bin");
  });

  /* A login shell prints greetings, version notices and whatever else somebody
     put in their rc file. The value has to be picked out of that. */
  it("finds the value among a login shell's own chatter", async () => {
    const found = await readShellPath({
      spawnFn: shellSaying(
        "Welcome back!\nnvm: using v22\n__ANTHILL_PATH__/opt/homebrew/bin:/usr/bin",
      ),
      env: { ...SHELL },
    });
    expect(found).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("says nothing when there is no shell to ask", async () => {
    expect(await readShellPath({ env: { PATH: "/usr/bin" } })).toBeUndefined();
  });

  it("says nothing when the shell fails or answers without the marker", async () => {
    expect(
      await readShellPath({ spawnFn: shellSaying("boom", 1), env: { ...SHELL } }),
    ).toBeUndefined();
    expect(
      await readShellPath({ spawnFn: shellSaying("no marker here"), env: { ...SHELL } }),
    ).toBeUndefined();
  });
});

describe("adopting it", () => {
  it("replaces the launchd PATH with the author's", async () => {
    const env = { ...SHELL };
    const changed = await adoptUserPath({
      spawnFn: shellSaying("__ANTHILL_PATH__/Users/a/.local/bin:/usr/bin:/bin"),
      env,
    });
    expect(changed).toBe(true);
    expect(env.PATH).toBe("/Users/a/.local/bin:/usr/bin:/bin");
  });

  /* The failure mode that must stay harmless. */
  it("leaves the PATH untouched when the shell cannot be asked", async () => {
    const env = { ...SHELL };
    const changed = await adoptUserPath({ spawnFn: shellSaying("", 1), env });
    expect(changed).toBe(false);
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("reports no change when the shell agrees with what we have", async () => {
    const env = { ...SHELL };
    expect(
      await adoptUserPath({ spawnFn: shellSaying("__ANTHILL_PATH__/usr/bin:/bin"), env }),
    ).toBe(false);
    expect(env.PATH).toBe("/usr/bin:/bin");
  });
});
