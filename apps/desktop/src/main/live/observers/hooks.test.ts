/**
 * The hook channel, which is the only one that can say "waiting for you".
 *
 * The fixtures here are real Claude Code hook payloads captured on this
 * machine, so a change in what the CLI sends shows up as a failing test rather
 * than as a page that quietly stops reporting permission prompts.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPendingRun, type PendingRun } from "@anthill/live";

import { HookLogObserver } from "./hooks.js";

const RUN_ID = "ANT-1A2B3C4D";
const NONCE = "9f8e7d";

function pending(partial: Partial<PendingRun> = {}): PendingRun {
  return {
    ...createPendingRun({
      anthillRunId: RUN_ID,
      correlationNonce: NONCE,
      selectedCli: "claude-code",
      promptVersion: "1",
      bootstrapPromptHash: "abcd1234",
      now: new Date(Date.now() - 5_000).toISOString(),
    }),
    detectedSessionId: "sess-1",
    state: "detected_live",
    ...partial,
  };
}

async function log(rows: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-hooks-"));
  const path = join(dir, "events.jsonl");
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return path;
}

const line = (data: Record<string, unknown>) => ({
  source: "anthill-observation-hook",
  harness: "claude-code",
  eventType: data.hook_event_name,
  recordedAt: "2026-08-29T10:00:01.000Z",
  data: { session_id: "sess-1", ...data },
});

describe("the hook log observer", () => {
  it("reports nothing until the run has a session to match against", async () => {
    const path = await log([line({ hook_event_name: "Notification", message: "needs permission" })]);
    const result = await new HookLogObserver(path).poll(
      pending({ detectedSessionId: undefined, state: "pending_after_copy" }),
      new Date().toISOString(),
    );
    // Before a match, another session's hooks are somebody else's business.
    expect(result).toEqual({ evidence: [], events: [] });
  });

  it("ignores lines belonging to a different session", async () => {
    const path = await log([
      { ...line({ hook_event_name: "PreToolUse", tool_name: "Bash" }), data: { session_id: "other", hook_event_name: "PreToolUse" } },
    ]);
    expect(await new HookLogObserver(path).poll(pending(), new Date().toISOString())).toEqual({
      evidence: [],
      events: [],
    });
  });

  it("reads a permission prompt as the session waiting for a person", async () => {
    const path = await log([
      line({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }),
    ]);
    const { events } = await new HookLogObserver(path).poll(pending(), new Date().toISOString());
    expect(events).toEqual([
      expect.objectContaining({
        kind: "notification",
        title: "The session is waiting for you",
        detail: "Claude needs your permission to use Bash",
        source: "hook",
        channel: "claude-code:hook",
      }),
    ]);
  });

  it("reads a tool call with the time it actually took", async () => {
    const path = await log([
      line({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        duration_ms: 2400,
        tool_input: { command: "npm test", description: "Run the tests" },
        tool_response: {},
      }),
    ]);
    const { events } = await new HookLogObserver(path).poll(pending(), new Date().toISOString());
    expect(events[0]).toMatchObject({
      kind: "tool.end",
      toolName: "Bash",
      toolUseId: "toolu_1",
      durationMs: 2400,
      detail: "Run the tests",
      ok: true,
    });
  });

  it("takes a step marker out of the last assistant message and keeps nothing else", async () => {
    const path = await log([
      line({
        hook_event_name: "Stop",
        last_assistant_message: `Working on it.\nANTHILL-STEP ${RUN_ID} ${NONCE} implement\nSECRET-PROSE`,
      }),
    ]);
    const { events } = await new HookLogObserver(path).poll(pending(), new Date().toISOString());
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "step.marker", blockId: "implement" }),
    );
    expect(JSON.stringify(events)).not.toContain("SECRET-PROSE");
  });

  it("reads each line once, however often it is polled", async () => {
    const path = await log([line({ hook_event_name: "SessionStart" })]);
    const observer = new HookLogObserver(path);
    expect((await observer.poll(pending(), new Date().toISOString())).events).toHaveLength(1);
    expect(await observer.poll(pending(), new Date().toISOString())).toEqual({
      evidence: [],
      events: [],
    });
  });

  it("says nothing at all when hooks were never installed", async () => {
    const observer = new HookLogObserver(join(tmpdir(), "anthill-no-such-hook-log.jsonl"));
    expect(await observer.available()).toBe(false);
    expect(await observer.poll(pending(), new Date().toISOString())).toEqual({
      evidence: [],
      events: [],
    });
  });
});

/**
 * ANT-64. A session working through subagents writes its transcript rarely and
 * this log constantly, and the clock that decides "gone quiet" heard only the
 * transcript. What the page shows as work has to count as a sign of life.
 */
describe("hook lines as evidence the session is alive", () => {
  const at = (iso: string, data: Record<string, unknown>) => ({ ...line(data), recordedAt: iso });

  it("reports the newest kept line as activity from the run's session", async () => {
    const path = await log([
      at("2026-08-29T10:00:01.000Z", { hook_event_name: "PreToolUse", tool_name: "Bash" }),
      at("2026-08-29T10:00:04.000Z", { hook_event_name: "PostToolUse", tool_name: "Bash" }),
    ]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), new Date().toISOString());
    // One piece of evidence for the poll, at the moment of the latest line.
    expect(evidence).toEqual([{ kind: "activity", sessionId: "sess-1", at: "2026-08-29T10:00:04.000Z" }]);
  });

  it("says nothing about a line that belongs to another session", async () => {
    const path = await log([
      { ...line({ hook_event_name: "PreToolUse" }), data: { session_id: "other", hook_event_name: "PreToolUse" } },
    ]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), new Date().toISOString());
    expect(evidence).toEqual([]);
  });

  it("does not report a late line about an earlier moment as new activity", async () => {
    const path = await log([at("2026-08-29T10:00:09.000Z", { hook_event_name: "PreToolUse", tool_name: "Bash" })]);
    const observer = new HookLogObserver(path);
    await observer.poll(pending(), new Date().toISOString());

    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      path,
      JSON.stringify(at("2026-08-29T10:00:03.000Z", { hook_event_name: "PostToolUse", tool_name: "Bash" })) + "\n",
      "utf8",
    );
    const { evidence, events } = await observer.poll(pending(), new Date().toISOString());
    // The line is still shown; it just is not news about now.
    expect(events).toHaveLength(1);
    expect(evidence).toEqual([]);
  });
});
