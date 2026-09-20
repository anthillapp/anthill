#!/usr/bin/env node

/**
 * Passive Anthill observation hook.
 *
 * Local CLIs invoke this after the user explicitly enables Anthill observation
 * hooks. It records what passive observation needs from the hook payload and
 * exits successfully. It never starts, stops, approves, attaches to, or
 * otherwise controls the agent.
 *
 * It used to record the payload whole, which for Claude Code carries the full
 * shell command of a `Bash` call and the full contents of a `Write` — so a
 * session that touched a credential wrote it into this log permanently
 * (ANT-98). `minimalHookPayload` keeps the fields the observer reads and drops
 * the rest unexamined.
 */

import { mkdir, appendFile, rename, stat } from "node:fs/promises";
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
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;

  let data: unknown = input;
  try {
    data = input.trim() ? JSON.parse(input) : null;
  } catch {
    data = { raw: input };
  }

  const path = logPath();
  await mkdir(dirname(path), { recursive: true });
  await rotate(path);
  await appendFile(
    path,
    `${JSON.stringify({
      source: "anthill-observation-hook",
      harness,
      eventType,
      recordedAt: new Date().toISOString(),
      data: minimalHookPayload(data),
    })}\n`,
    "utf8",
  );
}

main()
  .catch(() => {
    // Hooks must never block or break the user's CLI session.
  })
  .finally(() => process.exit(0));

setTimeout(() => process.exit(0), 2_500).unref?.();
