#!/usr/bin/env node

/**
 * Passive Anthill observation hook.
 *
 * Local CLIs invoke this after the user explicitly enables Anthill observation
 * hooks. It records the hook payload locally and exits successfully. It never
 * starts, stops, approves, attaches to, or otherwise controls the agent.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  await appendFile(
    path,
    `${JSON.stringify({
      source: "anthill-observation-hook",
      harness,
      eventType,
      recordedAt: new Date().toISOString(),
      data,
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
