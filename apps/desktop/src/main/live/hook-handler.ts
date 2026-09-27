/**
 * Passive Anthill observation hook.
 *
 * Local CLIs invoke this after the user explicitly enables Anthill observation
 * hooks. It records what passive observation needs from the hook payload and
 * exits successfully. It never starts, stops, approves, attaches to, or
 * otherwise controls the agent.
 *
 * No `#!` line: the hook command always runs this as `<execPath> <path>`, and
 * in the release build Sentry's plugin prepends its snippet to the file, which
 * leaves a `#!` mid-line and fails the build.
 *
 * It used to record the payload whole, which for Claude Code carries the full
 * shell command of a `Bash` call and the full contents of a `Write` — so a
 * session that touched a credential wrote it into this log permanently
 * (ANT-98). `minimalHookPayload` keeps the fields the observer reads and drops
 * the rest unexamined.
 */

import { constants } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { minimalHookPayload } from "./hook-payload.js";

/**
 * How large the log may get before it is rolled over.
 *
 * One previous file is kept and the one before that is dropped. A session
 * doing its work through subagents writes here constantly — 638 records out of
 * one run's 659 — so without a bound this grows for as long as Anthill is
 * installed, and what it holds is a record of the user's own machine.
 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * The most of a hook payload that is read.
 *
 * Far more than the fields kept need, and far less than a large tool response.
 * A payload past this is truncated, so it stops being JSON and lands as
 * unparseable — which is already handled, and which drops it.
 */
const MAX_STDIN_CHARS = 1024 * 1024;

/** Roll the log over when it has grown past its bound. Never fails the hook. */
async function rotate(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.size < MAX_LOG_BYTES) return;
    await rename(path, `${path}.1`);
  } catch {
    // No log yet, or a rename somebody else won. Either way there is nothing
    // to roll and the hook must not care.
  }
}

const args = process.argv.slice(2);
const offset = args[0] === "anthill-observation-hook" ? 1 : 0;
const harness = args[offset] ?? "unknown";
const eventType = args[offset + 1] ?? "unknown";

function logPath(): string {
  return process.env.ANTHILL_LIVE_HOOK_LOG ?? join(homedir(), ".anthill", "live-hooks", "events.jsonl");
}

async function main(): Promise<void> {
  /*
   * Bounded, because this is somebody else's process.
   *
   * A hook runs inside the user's CLI session with whatever that session hands
   * it. A payload carrying a large tool response was concatenated without
   * limit here, so a noisy call allocated it twice — once as stdin and once as
   * the parsed object (ANT-99). Nothing kept past `minimalHookPayload` is
   * anywhere near this size, so reading further could only cost memory.
   *
   * Stdin keeps being drained after the cap. A hook that stops reading gives
   * the CLI a broken pipe, and blocking the user's session is the one thing
   * this must never do.
   */
  let input = "";
  let capped = false;
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    if (capped) continue;
    input += chunk;
    if (input.length > MAX_STDIN_CHARS) {
      input = input.slice(0, MAX_STDIN_CHARS);
      capped = true;
    }
  }

  let data: unknown = input;
  try {
    data = input.trim() ? JSON.parse(input) : null;
  } catch {
    data = { raw: input };
  }

  const path = logPath();
  await mkdir(dirname(path), { recursive: true });
  await rotate(path);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({
        source: "anthill-observation-hook",
        harness,
        eventType,
        recordedAt: new Date().toISOString(),
        data: minimalHookPayload(data),
      })}\n`,
      "utf8",
    );
  } finally { await handle.close(); }
}

// Real hooks never interrupt the CLI. Anthill's own probe must report a failed
// write, otherwise an unwritable destination would be certified as working.
const failureCode = process.env.ANTHILL_OBSERVATION_PROBE === "1" ? 1 : 0;
main().then(() => process.exit(0), () => process.exit(failureCode));

setTimeout(() => process.exit(failureCode), 2_500).unref?.();
