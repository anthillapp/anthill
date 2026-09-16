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

/**
 * A tool that started and has not come back.
 *
 * ANT-71, measured from the session it was reported in. The last thing either
 * channel recorded was `PreToolUse Bash` — a `swift build` — and eight minutes
 * later Anthill said "Observation lost" while that build was still running.
 * Nothing more *can* arrive until a tool returns, so the silence after it is
 * the tool working; reading it as absence gets more wrong the longer the tool
 * takes.
 */
describe("work still in flight", () => {
  const NOW = "2026-08-29T10:10:00.000Z";
  const at = (iso: string, data: Record<string, unknown>) => ({ ...line(data), recordedAt: iso });
  const started = (iso: string, id = "toolu_1", tool = "Bash") =>
    at(iso, { hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: id });
  const finished = (iso: string, id = "toolu_1", tool = "Bash") =>
    at(iso, { hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: id });

  it("reports the session as working while the call is open", async () => {
    const path = await log([started("2026-08-29T10:02:00.000Z")]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence).toContainEqual(
      expect.objectContaining({
        kind: "working",
        sessionId: "sess-1",
        at: NOW,
        since: "2026-08-29T10:02:00.000Z",
      }),
    );
  });

  it("keeps saying so on a later poll that reads nothing new", async () => {
    // The whole point: the log stops growing precisely because the tool is
    // busy, and that is when the old clock started counting towards silence.
    const path = await log([started("2026-08-29T10:02:00.000Z")]);
    const observer = new HookLogObserver(path);
    await observer.poll(pending(), "2026-08-29T10:02:01.000Z");
    const { evidence, events } = await observer.poll(pending(), NOW);
    expect(events).toEqual([]);
    expect(evidence.some((item) => item.kind === "working")).toBe(true);
  });

  it("names the tool, so the page can say what is running", async () => {
    const path = await log([started("2026-08-29T10:02:00.000Z")]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    const working = evidence.find((item) => item.kind === "working");
    expect(working && "detail" in working && working.detail).toContain("Bash has been running");
  });

  it("stops once the call reports back", async () => {
    const path = await log([
      started("2026-08-29T10:02:00.000Z"),
      finished("2026-08-29T10:02:30.000Z"),
    ]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence.some((item) => item.kind === "working")).toBe(false);
  });

  it("follows the newest open call when several are running", async () => {
    const path = await log([
      started("2026-08-29T10:01:00.000Z", "toolu_1"),
      started("2026-08-29T10:05:00.000Z", "toolu_2"),
    ]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "working", since: "2026-08-29T10:05:00.000Z" }),
    );
  });

  it("gives up on a call too old to believe", async () => {
    // Nothing ever retracts a PreToolUse. The reported log still held one from
    // a permission prompt nobody answered, open for over an hour — a record
    // like that must not keep a dead session looking alive all day.
    const path = await log([started("2026-08-29T09:00:00.000Z")]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence.some((item) => item.kind === "working")).toBe(false);
  });

  it("says nothing about a call belonging to another session", async () => {
    const path = await log([
      {
        ...started("2026-08-29T10:02:00.000Z"),
        data: { session_id: "other", hook_event_name: "PreToolUse", tool_use_id: "toolu_9" },
      },
    ]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence).toEqual([]);
  });
});

/**
 * The delegations a session says it is still waiting on.
 *
 * ANT-75. Claude Code puts a \`background_tasks\` list on its Stop records —
 * its own account of what it dispatched and has not finished. Measured over
 * the reported session: seventeen tasks, sixteen of which left the list when
 * they finished, so the list is maintained rather than appended to and is
 * worth reading. The seventeenth is why it still expires.
 */
describe("work the session handed to somebody else", () => {
  const NOW = "2026-08-29T10:10:00.000Z";
  const at = (iso: string, data: Record<string, unknown>) => ({ ...line(data), recordedAt: iso });
  const task = (id: string, description: string, status = "running") => ({
    id,
    type: "subagent",
    status,
    description,
    agent_type: "developer",
  });
  const stop = (iso: string, tasks: unknown[]) =>
    at(iso, { hook_event_name: "Stop", background_tasks: tasks });

  it("reports the session as working while it says it is waiting", async () => {
    const path = await log([stop("2026-08-29T10:05:00.000Z", [task("t1", "Stage 2 OCR")])]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "working", sessionId: "sess-1", at: NOW }),
    );
    const working = evidence.find((item) => item.kind === "working");
    expect(working && "detail" in working && working.detail).toContain("Stage 2 OCR");
  });

  it("stops once the task leaves the list, which is how finishing is reported", async () => {
    // No terminal status ever appears — every entry in the reported session
    // said "running". A finished task is simply gone from the next record.
    const path = await log([
      stop("2026-08-29T10:05:00.000Z", [task("t1", "Stage 2 OCR")]),
      stop("2026-08-29T10:06:00.000Z", []),
    ]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence.some((item) => item.kind === "working")).toBe(false);
  });

  it("keeps saying so on a poll that reads nothing new", async () => {
    const path = await log([stop("2026-08-29T10:05:00.000Z", [task("t1", "Stage 2 OCR")])]);
    const observer = new HookLogObserver(path);
    await observer.poll(pending(), "2026-08-29T10:05:01.000Z");
    const { evidence, events } = await observer.poll(pending(), NOW);
    expect(events).toEqual([]);
    expect(evidence.some((item) => item.kind === "working")).toBe(true);
  });

  it("gives up on a task listed for longer than it can be believed", async () => {
    // The seventeenth: a shell task called "Wait for fixture OCR tests to
    // finish", carried for five hours, long after the work it named was over.
    // Against it, the longest delegation genuinely running lasted 81 minutes —
    // and spent none of that silent, because its subagent's own hooks arrive
    // under this session.
    const path = await log([
      stop("2026-08-29T09:00:00.000Z", [task("stuck", "Wait for fixture OCR tests to finish")]),
    ]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence.some((item) => item.kind === "working")).toBe(false);
  });

  it("ignores an entry that is not running", async () => {
    const path = await log([stop("2026-08-29T10:05:00.000Z", [task("t1", "Done already", "completed")])]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence.some((item) => item.kind === "working")).toBe(false);
  });

  it("says nothing about another session's list", async () => {
    const path = await log([
      {
        ...stop("2026-08-29T10:05:00.000Z", [task("t1", "Someone else")]),
        data: { session_id: "other", hook_event_name: "Stop", background_tasks: [task("t1", "x")] },
      },
    ]);
    const { evidence } = await new HookLogObserver(path).poll(pending(), NOW);
    expect(evidence).toEqual([]);
  });
});

/**
 * Whether this log is carrying news about a run.
 *
 * The transcript observer asks, because what it may infer from silence depends
 * on whether anything else is listening (ANT-75).
 */
describe("what the hook log says it covers", () => {
  it("covers a run once it has kept a line for it", async () => {
    const path = await log([line({ hook_event_name: "PreToolUse", tool_name: "Bash" })]);
    const observer = new HookLogObserver(path);
    expect(observer.watching(RUN_ID)).toBe(false);
    await observer.poll(pending(), new Date().toISOString());
    expect(observer.watching(RUN_ID)).toBe(true);
  });

  it("does not claim a run whose lines belong to another session", async () => {
    const path = await log([
      { ...line({ hook_event_name: "PreToolUse" }), data: { session_id: "other", hook_event_name: "PreToolUse" } },
    ]);
    const observer = new HookLogObserver(path);
    await observer.poll(pending(), new Date().toISOString());
    expect(observer.watching(RUN_ID)).toBe(false);
  });

  it("forgets a run it is told to forget", async () => {
    const path = await log([line({ hook_event_name: "PreToolUse", tool_name: "Bash" })]);
    const observer = new HookLogObserver(path);
    await observer.poll(pending(), new Date().toISOString());
    observer.forget(RUN_ID);
    expect(observer.watching(RUN_ID)).toBe(false);
  });
});
