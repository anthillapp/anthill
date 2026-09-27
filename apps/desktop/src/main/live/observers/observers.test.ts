/**
 * The observers, run against fixtures shaped like the real thing.
 *
 * The record shapes here were copied from actual files on this machine — a
 * Claude Code transcript under `~/.claude/projects` and a Codex rollout under
 * `~/.codex/sessions` — so a change in what either tool writes shows up as a
 * failing test rather than as an indicator that quietly stops working.
 */

import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyEvidence, createPendingRun, type PendingRun } from "@anthill/live";

import { ClaudeCodeObserver } from "./claude-code.js";
import { CodexObserver } from "./codex.js";
import { PiObserver } from "./pi.js";

const RUN_ID = "ANT-1A2B3C4D";
const NONCE = "9f8e7d";

function pending(cli: "claude-code" | "codex" | "pi"): PendingRun {
  return createPendingRun({
    anthillRunId: RUN_ID,
    correlationNonce: NONCE,
    selectedCli: cli,
    promptVersion: "1",
    bootstrapPromptHash: "abcd1234",
    now: new Date(Date.now() - 5_000).toISOString(),
  });
}

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-observer-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  roots.length = 0;
});

/* ------------------------------------------------------------------ */
/* Claude Code                                                         */
/* ------------------------------------------------------------------ */

const MARKED_PROMPT = `<!-- Anthill run marker.\nanthill-run-id: ${RUN_ID}\nanthill-nonce: ${NONCE}\n-->\n\nRead the note.`;

function claudeTranscript(
  sessionId: string,
  options: {
    marked: boolean;
    stopReason?: string;
    step?: string;
    tool?: boolean;
    delegate?: "Task" | "Agent";
  },
) {
  const at = new Date().toISOString();
  const rows: unknown[] = [
    {
      type: "user",
      sessionId,
      timestamp: at,
      cwd: "/tmp/scratch",
      message: { role: "user", content: options.marked ? MARKED_PROMPT : "Read the note." },
    },
  ];
  if (options.step || options.tool || options.delegate || options.stopReason) {
    rows.push({
      type: "assistant",
      sessionId,
      timestamp: at,
      message: {
        role: "assistant",
        ...(options.stopReason ? { stop_reason: options.stopReason } : {}),
        content: [
          { type: "thinking", thinking: "PRIVATE-REASONING-SHOULD-NEVER-BE-READ" },
          {
            type: "text",
            text: options.step
              ? `ANTHILL-STEP ${RUN_ID} ${NONCE} ${options.step}`
              : "It says pumpernickel.",
          },
          ...(options.tool
            ? [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "Bash",
                  input: { command: "ls -la", description: "List files" },
                },
              ]
            : []),
          ...(options.delegate
            ? [
                {
                  type: "tool_use",
                  id: "toolu_2",
                  name: options.delegate,
                  input: { subagent_type: "reader", description: "Read note.txt" },
                },
              ]
            : []),
        ],
      },
    });
  }
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function writeClaude(dir: string, project: string, sessionId: string, body: string) {
  await mkdir(join(dir, project), { recursive: true });
  await writeFile(join(dir, project, `${sessionId}.jsonl`), body, "utf8");
}

describe("the Claude Code observer", () => {
  it("says so when there is nothing on this machine to read", async () => {
    const observer = new ClaudeCodeObserver(join(await root(), "missing"));
    const capabilities = await observer.detectCapabilities();
    expect(capabilities.available).toBe(false);

    const { evidence } = await observer.poll(pending("claude-code"), new Date().toISOString());
    expect(evidence).toEqual([
      expect.objectContaining({ kind: "unobservable", channel: "claude-code:transcript" }),
    ]);
  });

  it("recognises the session whose recorded user message carries the marker", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", claudeTranscript("sess-1", { marked: true }));

    const { evidence } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "match",
        sessionId: "sess-1",
        confidence: "strong",
        channel: "claude-code:transcript",
      }),
    ]);
  });

  it("ignores a session that does not carry the marker", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-other", "sess-2", claudeTranscript("sess-2", { marked: false }));

    const { evidence } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(evidence).toEqual([]);
  });

  it("calls two marked sessions ambiguous rather than choosing", async () => {
    const dir = await root();
    await writeClaude(dir, "-a", "sess-1", claudeTranscript("sess-1", { marked: true }));
    await writeClaude(dir, "-b", "sess-2", claudeTranscript("sess-2", { marked: true }));

    const { evidence } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(evidence[0].kind).toBe("ambiguous");
  });

  it("reports a finished turn only once it has also been quiet", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeTranscript("sess-1", { marked: true, stopReason: "end_turn" }),
    );
    const observer = new ClaudeCodeObserver(dir);
    const run = pending("claude-code");

    const first = await observer.poll(run, new Date().toISOString());
    expect(first.evidence.some((item) => item.kind === "completed")).toBe(false);

    const live = { ...run, detectedSessionId: "sess-1", state: "detected_live" as const };
    // The settle window is the same silence that would otherwise be called
    // "observation lost" — a turn boundary alone is not the end of a session.
    const later = new Date(Date.now() + 6 * 60_000).toISOString();
    const second = await observer.poll(live, later);
    expect(second.evidence).toEqual([
      expect.objectContaining({
        kind: "completed",
        sessionId: "sess-1",
        detail: "The session finished its turn and has been quiet since.",
      }),
    ]);
  });

  it("does not keep reporting activity for a transcript that stopped growing", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", claudeTranscript("sess-1", { marked: true }));
    const observer = new ClaudeCodeObserver(dir);
    const live = {
      ...pending("claude-code"),
      detectedSessionId: "sess-1",
      state: "detected_live" as const,
    };

    await observer.poll(live, new Date().toISOString());
    // Nothing was appended between the two polls, so there is nothing to say.
    expect((await observer.poll(live, new Date().toISOString())).evidence).toEqual([]);
  });

  /**
   * ANT-47. The stop reason was read and only ever used to time a settle five
   * minutes later, so a session watched through the transcript alone had no
   * record that the agent had handed control back — the diagram said
   * "Working", and then "Done", at a step where somebody was needed.
   */
  it("writes down the moment the agent stopped, not only the fact for later", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeTranscript("sess-1", { marked: true, stopReason: "end_turn" }),
    );
    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(events.filter((item) => item.kind === "turn.end")).toHaveLength(1);
  });

  it("says nothing about a turn that is only pausing to call a tool", async () => {
    // `tool_use` is the agent stopping to act, not stopping to wait.
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeTranscript("sess-1", { marked: true, tool: true, stopReason: "tool_use" }),
    );
    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(events.some((item) => item.kind === "turn.end")).toBe(false);
  });

  it("never carries a thinking block out of a transcript", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeTranscript("sess-1", { marked: true, stopReason: "end_turn" }),
    );
    const { evidence } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE-REASONING");
  });
});

/* ------------------------------------------------------------------ */
/* Codex                                                               */
/* ------------------------------------------------------------------ */

function codexRollout(
  sessionId: string,
  options: {
    marked: boolean;
    complete?: boolean;
    error?: string;
    step?: string;
    /**
     * The thread this file belongs to, when it is not the session's own. A
     * Codex sub-thread — the "Approve for me" reviewer, say — writes the
     * parent's `session_id` and its own `id`, plus `parent_thread_id`.
     */
    thread?: string;
  },
) {
  const at = new Date().toISOString();
  const rows: unknown[] = [
    {
      timestamp: at,
      type: "session_meta",
      payload: {
        session_id: sessionId,
        id: options.thread ?? sessionId,
        ...(options.thread ? { parent_thread_id: sessionId } : {}),
        cwd: "/tmp/scratch",
      },
    },
    {
      timestamp: at,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.marked ? MARKED_PROMPT : "Read the note." }],
      },
    },
    {
      timestamp: at,
      type: "response_item",
      payload: { type: "reasoning", content: [{ text: "PRIVATE-REASONING-SHOULD-NEVER-BE-READ" }] },
    },
  ];
  if (options.step) {
    rows.push({
      timestamp: at,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `ANTHILL-STEP ${RUN_ID} ${NONCE} ${options.step}` }],
      },
    });
  }
  if (options.complete) {
    rows.push({ timestamp: at, type: "event_msg", payload: { type: "task_complete" } });
  }
  if (options.error) {
    rows.push({
      timestamp: at,
      type: "event_msg",
      payload: { type: "error", message: options.error },
    });
  }
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function writeCodex(dir: string, sessionId: string, body: string) {
  const day = join(dir, "2026", "08", "29");
  await mkdir(day, { recursive: true });
  await writeFile(join(day, `rollout-2026-08-29T10-00-00-${sessionId}.jsonl`), body, "utf8");
}

describe("the Codex observer", () => {
  it("recognises the session whose recorded user message carries the marker", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: true }));

    const { evidence } = await new CodexObserver(dir).poll(
      pending("codex"),
      new Date().toISOString(),
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "match",
        sessionId: "sess-cx",
        confidence: "strong",
        channel: "codex:rollout",
      }),
    ]);
  });

  it("reads Codex's own completion record rather than inferring one", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: true, complete: true }));

    const run = { ...pending("codex"), detectedSessionId: "sess-cx", state: "detected_live" as const };
    const { evidence } = await new CodexObserver(dir).poll(run, new Date().toISOString());
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "completed", sessionId: "sess-cx" }),
    );
  });

  it("reports a recorded error as a failure", async () => {
    const dir = await root();
    await writeCodex(
      dir,
      "sess-cx",
      codexRollout("sess-cx", { marked: true, error: "the model stream stopped" }),
    );

    const run = { ...pending("codex"), detectedSessionId: "sess-cx", state: "detected_live" as const };
    const { evidence } = await new CodexObserver(dir).poll(run, new Date().toISOString());
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "failed", detail: "the model stream stopped" }),
    );
  });

  it("never carries a reasoning record out of a rollout", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: true, complete: true }));
    const { evidence } = await new CodexObserver(dir).poll(
      pending("codex"),
      new Date().toISOString(),
    );
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE-REASONING");
  });

  it("advertises that it can report both completion and failure", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: false }));
    const capabilities = await new CodexObserver(dir).detectCapabilities();
    expect(capabilities).toMatchObject({ reportsCompletion: true, reportsFailure: true });
  });

  /*
    ANT-129. A handover made through the exchange never pastes the prompt, so
    the session's own rollout carries the marker only inside tool calls — and
    the file that matched was the "Approve for me" reviewer's, whose request
    quotes the command. Its every verdict ended in `task_complete`, and the
    page said "Session finished" while the agent was still working.
  */
  it("matches the rollout a binding named, with no marker in any user message", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: false }));

    const run = {
      ...pending("codex"),
      exchange: { revision: 1, digest: "abcd1234", sessionId: "sess-cx" },
    };
    const { evidence } = await new CodexObserver(dir).poll(run, new Date().toISOString());
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "match", sessionId: "sess-cx", confidence: "strong" }),
    );
  });

  it("lets a reviewer sub-thread neither end the session nor speak for it", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: false, step: "implement" }));
    await writeCodex(
      dir,
      "review-1",
      codexRollout("sess-cx", { marked: true, complete: true, thread: "review-1" }),
    );

    const run = {
      ...pending("codex"),
      exchange: { revision: 1, digest: "abcd1234", sessionId: "sess-cx" },
      detectedSessionId: "sess-cx",
      state: "detected_live" as const,
    };
    const { evidence, events } = await new CodexObserver(dir).poll(run, new Date().toISOString());

    expect(evidence).not.toContainEqual(expect.objectContaining({ kind: "completed" }));
    // The session's own work still comes through.
    expect(events).toContainEqual(expect.objectContaining({ kind: "step.marker", blockId: "implement" }));
    // The reviewer's does not: not its request, not its verdict, not its ending.
    expect(events.map((event) => event.kind)).not.toContain("prompt.submit");
    expect(events.map((event) => event.kind)).not.toContain("turn.end");
    expect(events.filter((event) => event.kind === "message")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* pi                                                                  */
/* ------------------------------------------------------------------ */

function piSession(
  sessionId: string,
  options: {
    marked: boolean;
    stopReason?: string;
    error?: string;
    step?: string;
    tool?: boolean;
  },
) {
  const at = new Date().toISOString();
  const rows: unknown[] = [
    { type: "session", version: 3, id: sessionId, timestamp: at, cwd: "/tmp/scratch" },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: at,
      message: { role: "user", content: options.marked ? MARKED_PROMPT : "Read the note." },
    },
  ];
  if (options.step || options.tool || options.stopReason || options.error) {
    rows.push({
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: at,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "PRIVATE-REASONING-SHOULD-NEVER-BE-READ" },
          {
            type: "text",
            text: options.step
              ? `ANTHILL-STEP ${RUN_ID} ${NONCE} ${options.step}`
              : "It says pumpernickel.",
          },
          ...(options.tool
            ? [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -la" } }]
            : []),
        ],
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 35 },
        stopReason:
          options.stopReason ?? (options.error ? "error" : options.tool ? "toolUse" : "stop"),
        ...(options.error ? { errorMessage: options.error } : {}),
      },
    });
  }
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function writePi(dir: string, sessionId: string, body: string) {
  const project = join(dir, "--tmp-scratch--");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `1750000000000_${sessionId}.jsonl`), body, "utf8");
}

/**
 * A session file that holds earlier work: an assistant message that ended
 * before the Anthill prompt was pasted in. The run-local state those earlier
 * records set must not leak into the run that the marker starts.
 */
function piSessionWithEarlierWork(
  sessionId: string,
  earlier: { stopReason: string; errorMessage?: string },
) {
  const at = new Date().toISOString();
  const rows: unknown[] = [
    { type: "session", version: 3, id: sessionId, timestamp: at, cwd: "/tmp/scratch" },
    {
      type: "message",
      id: "m0",
      parentId: null,
      timestamp: at,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Earlier work." }],
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 300 },
        stopReason: earlier.stopReason,
        ...(earlier.errorMessage ? { errorMessage: earlier.errorMessage } : {}),
      },
    },
    {
      type: "message",
      id: "m1",
      parentId: "m0",
      timestamp: at,
      message: { role: "user", content: MARKED_PROMPT },
    },
  ];
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

describe("the pi observer", () => {
  it("says so when there is nothing on this machine to read", async () => {
    const observer = new PiObserver(join(await root(), "missing"));
    const capabilities = await observer.detectCapabilities();
    expect(capabilities.available).toBe(false);

    const { evidence } = await observer.poll(pending("pi"), new Date().toISOString());
    expect(evidence).toEqual([
      expect.objectContaining({ kind: "unobservable", channel: "pi:session" }),
    ]);
  });

  it("recognises the session whose recorded user message carries the marker", async () => {
    const dir = await root();
    await writePi(dir, "sess-pi", piSession("sess-pi", { marked: true }));

    const { evidence } = await new PiObserver(dir).poll(
      pending("pi"),
      new Date().toISOString(),
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "match",
        sessionId: "sess-pi",
        confidence: "strong",
        channel: "pi:session",
      }),
    ]);
  });

  it("does not call the session finished just because a turn ended", async () => {
    const dir = await root();
    await writePi(dir, "sess-pi", piSession("sess-pi", { marked: true, stopReason: "stop" }));
    const observer = new PiObserver(dir);
    const run = { ...pending("pi"), detectedSessionId: "sess-pi", state: "detected_live" as const };

    await observer.poll(run, new Date().toISOString());
    // Half a minute of thinking between turns is an agent working, not an agent
    // that has stopped.
    const soon = new Date(Date.now() + 45_000).toISOString();
    const { evidence } = await observer.poll(run, soon);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("calls it finished once the silence is as long as losing it would take", async () => {
    const dir = await root();
    await writePi(dir, "sess-pi", piSession("sess-pi", { marked: true, stopReason: "stop" }));
    const observer = new PiObserver(dir);
    const run = { ...pending("pi"), detectedSessionId: "sess-pi", state: "detected_live" as const };

    await observer.poll(run, new Date().toISOString());
    const muchLater = new Date(Date.now() + 6 * 60_000).toISOString();
    const { evidence } = await observer.poll(run, muchLater);
    expect(evidence).toContainEqual(expect.objectContaining({ kind: "completed" }));
  });

  it("reports a recorded error as a failure", async () => {
    const dir = await root();
    await writePi(
      dir,
      "sess-pi",
      piSession("sess-pi", { marked: true, error: "the model stream stopped" }),
    );

    const run = { ...pending("pi"), detectedSessionId: "sess-pi", state: "detected_live" as const };
    const { evidence } = await new PiObserver(dir).poll(run, new Date().toISOString());
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "failed", detail: "the model stream stopped" }),
    );
  });

  it("reports an aborted session as a failure", async () => {
    const dir = await root();
    await writePi(dir, "sess-pi", piSession("sess-pi", { marked: true, stopReason: "aborted" }));

    const run = { ...pending("pi"), detectedSessionId: "sess-pi", state: "detected_live" as const };
    const { evidence } = await new PiObserver(dir).poll(run, new Date().toISOString());
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "failed", detail: "The session was aborted." }),
    );
  });

  it("never carries a thinking block out of a session file", async () => {
    const dir = await root();
    await writePi(dir, "sess-pi", piSession("sess-pi", { marked: true, stopReason: "stop" }));
    const { evidence, events } = await new PiObserver(dir).poll(
      pending("pi"),
      new Date().toISOString(),
    );
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE-REASONING");
    expect(JSON.stringify(events)).not.toContain("PRIVATE-REASONING");
  });

  it("advertises that it can report both completion and failure", async () => {
    const dir = await root();
    await writePi(dir, "sess-pi", piSession("sess-pi", { marked: false }));
    const capabilities = await new PiObserver(dir).detectCapabilities();
    expect(capabilities).toMatchObject({ reportsCompletion: true, reportsFailure: true });
  });

  /**
   * A session file can outlive its runs: the same file holds earlier work.
   * An `error` recorded before the marker must not fail the run, and a `stop`
   * recorded before the marker must not settle it before pi has answered.
   */
  it("does not fail the run on an error recorded before the marker", async () => {
    const dir = await root();
    await writePi(
      dir,
      "sess-pi",
      piSessionWithEarlierWork("sess-pi", {
        stopReason: "error",
        errorMessage: "an earlier error",
      }),
    );

    const run = { ...pending("pi"), detectedSessionId: "sess-pi", state: "detected_live" as const };
    const { evidence, events } = await new PiObserver(dir).poll(run, new Date().toISOString());
    // State: the earlier error does not fail the run.
    expect(evidence.some((item) => item.kind === "failed")).toBe(false);
    // Emitted events: the earlier work's message, usage, and turn-end do not
    // leak into the run the marker starts. The session metadata and the marker
    // itself do surface.
    expect(events.some((event) => event.kind === "message")).toBe(false);
    expect(events.some((event) => event.kind === "usage")).toBe(false);
    expect(events.some((event) => event.kind === "turn.end")).toBe(false);
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(events.some((event) => event.kind === "session.start")).toBe(true);
    expect(events.some((event) => event.kind === "prompt.submit")).toBe(true);
  });

  it("does not settle the run on a stop recorded before the marker", async () => {
    const dir = await root();
    await writePi(
      dir,
      "sess-pi",
      piSessionWithEarlierWork("sess-pi", { stopReason: "stop" }),
    );

    const observer = new PiObserver(dir);
    const run = { ...pending("pi"), detectedSessionId: "sess-pi", state: "detected_live" as const };
    // Six minutes of silence after the prompt was pasted in — long enough to
    // settle a turn that had ended, if one had.
    const muchLater = new Date(Date.now() + 6 * 60_000).toISOString();
    const { evidence, events } = await observer.poll(run, muchLater);
    // State: the earlier stop does not settle the run.
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
    // Emitted events: the earlier work's message, usage, and turn-end do not
    // leak into the run the marker starts. The session metadata and the marker
    // itself do surface.
    expect(events.some((event) => event.kind === "message")).toBe(false);
    expect(events.some((event) => event.kind === "usage")).toBe(false);
    expect(events.some((event) => event.kind === "turn.end")).toBe(false);
    expect(events.some((event) => event.kind === "session.start")).toBe(true);
    expect(events.some((event) => event.kind === "prompt.submit")).toBe(true);
  });
});

describe("a session that was alive long before this run", () => {
  /** A transcript row from days ago, of the kind a long-lived session is full of. */
  function oldTranscript(sessionId: string) {
    const old = new Date(Date.now() - 6 * 86_400_000).toISOString();
    const now = new Date().toISOString();
    return (
      [
        {
          type: "assistant",
          sessionId,
          timestamp: old,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "old_1", name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          type: "user",
          sessionId,
          timestamp: now,
          message: { role: "user", content: MARKED_PROMPT },
        },
        {
          type: "assistant",
          sessionId,
          timestamp: now,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "new_1", name: "Read", input: { file_path: "a.ts" } }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n"
    );
  }

  it("records only what happened after the prompt was pasted", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", oldTranscript("sess-1"));

    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );

    // The whole file has to be read to find the marker, but six days of someone
    // else's work is not this run's activity.
    expect(events.map((event) => event.toolUseId)).not.toContain("old_1");
    expect(events.map((event) => event.toolUseId)).toContain("new_1");
  });

  it("does not call the session finished just because a turn ended", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeTranscript("sess-1", { marked: true, stopReason: "end_turn" }),
    );
    const observer = new ClaudeCodeObserver(dir);
    const run = { ...pending("claude-code"), detectedSessionId: "sess-1", state: "detected_live" as const };

    await observer.poll(run, new Date().toISOString());
    // Half a minute of thinking between turns is an agent working, not an agent
    // that has stopped. The old fifteen-second window ended observation here.
    const soon = new Date(Date.now() + 45_000).toISOString();
    const { evidence } = await observer.poll(run, soon);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("calls it finished once the silence is as long as losing it would take", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeTranscript("sess-1", { marked: true, stopReason: "end_turn" }),
    );
    const observer = new ClaudeCodeObserver(dir);
    const run = { ...pending("claude-code"), detectedSessionId: "sess-1", state: "detected_live" as const };

    await observer.poll(run, new Date().toISOString());
    const muchLater = new Date(Date.now() + 6 * 60_000).toISOString();
    const { evidence } = await observer.poll(run, muchLater);
    expect(evidence).toContainEqual(expect.objectContaining({ kind: "completed" }));
  });
});

describe("what each CLI's records yield as activity", () => {
  it("reads an announced step out of a Claude Code transcript", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeTranscript("sess-1", { marked: true, step: "implement" }),
    );
    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "step.marker", blockId: "implement" }),
    );
    // The step id is the only thing taken out of what the agent wrote.
    expect(JSON.stringify(events)).not.toContain("PRIVATE-REASONING");
    expect(JSON.stringify(events)).not.toContain("pumpernickel");
  });

  it("reads a Claude Code tool call as activity, naming what it acted on", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeTranscript("sess-1", { marked: true, tool: true }),
    );
    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "tool.start",
        toolName: "Bash",
        toolUseId: "toolu_1",
        detail: "List files",
      }),
    );
  });

  it.each(["Task", "Agent"] as const)(
    "reads a %s delegation as a subagent, keeping the name it was given",
    async (toolName) => {
      const dir = await root();
      await writeClaude(
        dir,
        "-tmp-scratch",
        "sess-1",
        claudeTranscript("sess-1", { marked: true, delegate: toolName }),
      );
      const { events } = await new ClaudeCodeObserver(dir).poll(
        pending("claude-code"),
        new Date().toISOString(),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "subagent.start", agentName: "reader" }),
      );
    },
  );

  it("reads Codex's own turn-completion record as activity, which Claude Code has none of", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: true, complete: true }));
    const { events } = await new CodexObserver(dir).poll(pending("codex"), new Date().toISOString());
    expect(events).toContainEqual(expect.objectContaining({ kind: "session.start" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn.end" }));
    expect(JSON.stringify(events)).not.toContain("PRIVATE-REASONING");
  });

  it("reads an announced step out of a Codex rollout", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: true, step: "test" }));
    const { events } = await new CodexObserver(dir).poll(pending("codex"), new Date().toISOString());
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "step.marker", blockId: "test", source: "rollout" }),
    );
  });

  /*
   * ANT-147. Told to "print" the markers, Codex Desktop printed them with a
   * shell: the lines exist only in the command's output, as its exec tool
   * records it — stdout JSON-encoded inside a `custom_tool_call_output` part.
   */
  describe("a step announced from a command", () => {
    const row = (payload: unknown) =>
      JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload });
    const printf = (callId: string, step: string) => [
      row({
        type: "custom_tool_call",
        call_id: callId,
        name: "exec",
        input: `const r = await tools.exec_command({cmd:"printf '%s\\n' 'ANTHILL-STEP ${RUN_ID} ${NONCE} ${step}'"}); text(r);`,
      }),
      row({
        type: "custom_tool_call_output",
        call_id: callId,
        output: [
          { type: "input_text", text: "Script completed\nOutput:\n" },
          {
            type: "input_text",
            text: JSON.stringify({ exit_code: 0, output: `ANTHILL-STEP ${RUN_ID} ${NONCE} ${step}\n/tmp/scratch\n` }),
          },
        ],
      }),
    ];
    const steps = (events: { kind: string; blockId?: string }[]) =>
      events.filter((event) => event.kind === "step.marker").map((event) => event.blockId);

    it("moves the step, read from the command's output", async () => {
      const dir = await root();
      const body = codexRollout("sess-cx", { marked: true }) + [...printf("c1", "implement"), ...printf("c2", "test")].join("\n") + "\n";
      await writeCodex(dir, "sess-cx", body);
      const { events } = await new CodexObserver(dir).poll(pending("codex"), new Date().toISOString());
      expect(steps(events)).toEqual(["implement", "test"]);
    });

    it("reads a plain function call's output too", async () => {
      const dir = await root();
      const body =
        codexRollout("sess-cx", { marked: true }) +
        [
          row({ type: "function_call", call_id: "c1", name: "shell", arguments: "{}" }),
          row({ type: "function_call_output", call_id: "c1", output: `ANTHILL-STEP ${RUN_ID} ${NONCE} fix\n` }),
        ].join("\n") +
        "\n";
      await writeCodex(dir, "sess-cx", body);
      const { events } = await new CodexObserver(dir).poll(pending("codex"), new Date().toISOString());
      expect(steps(events)).toEqual(["fix"]);
    });

    it("counts a step printed and then repeated in the reply once, and a real return again", async () => {
      const dir = await root();
      const reply = (text: string) => row({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      const body =
        codexRollout("sess-cx", { marked: true }) +
        [
          ...printf("c1", "test"),
          reply(`ANTHILL-STEP ${RUN_ID} ${NONCE} test`),
          ...printf("c2", "fix"),
          ...printf("c3", "test"),
        ].join("\n") +
        "\n";
      await writeCodex(dir, "sess-cx", body);
      const { events } = await new CodexObserver(dir).poll(pending("codex"), new Date().toISOString());
      expect(steps(events)).toEqual(["test", "fix", "test"]);
    });

    it("does not take the step from a command that only names the line", async () => {
      const dir = await root();
      const body =
        codexRollout("sess-cx", { marked: true }) +
        [
          printf("c1", "implement")[0],
          row({ type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "exit_code 1: permission denied" }] }),
        ].join("\n") +
        "\n";
      await writeCodex(dir, "sess-cx", body);
      const { events } = await new CodexObserver(dir).poll(pending("codex"), new Date().toISOString());
      expect(steps(events)).toEqual([]);
    });
  });

  it("reads an announced step out of a pi session file", async () => {
    const dir = await root();
    await writePi(dir, "sess-pi", piSession("sess-pi", { marked: true, step: "implement" }));
    const { events } = await new PiObserver(dir).poll(pending("pi"), new Date().toISOString());
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "step.marker", blockId: "implement", source: "session" }),
    );
  });

  it("reads a pi tool call as activity, and the result that closes it", async () => {
    const dir = await root();
    const body =
      piSession("sess-pi", { marked: true, tool: true }) +
      JSON.stringify({
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "bash",
          content: [{ type: "text", text: "total 0" }],
          isError: false,
        },
      }) + "\n";
    await writePi(dir, "sess-pi", body);
    const { events } = await new PiObserver(dir).poll(pending("pi"), new Date().toISOString());
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "tool.start", toolName: "bash", toolUseId: "call_1" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "tool.end", toolUseId: "call_1", ok: true }),
    );
  });

  it("keeps activity from a session this run does not own", async () => {
    const dir = await root();
    await writeClaude(dir, "-other", "sess-other", claudeTranscript("sess-other", { marked: false, tool: true }));
    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(events).toEqual([]);
  });
});

describe("the two CLIs are not claimed to be equal", () => {
  it("says Claude Code cannot report a failure, and Codex can", async () => {
    const dir = await root();
    await mkdir(join(dir, "-x"), { recursive: true });
    const claude = await new ClaudeCodeObserver(dir).detectCapabilities();
    const codex = await new CodexObserver(dir).detectCapabilities();
    expect(claude.reportsFailure).toBe(false);
    expect(codex.reportsFailure).toBe(true);
  });
});

describe("a finished session stays finished", () => {
  /**
   * Two runs were lost to this. Codex recorded `task_complete`, the observer
   * reported it, and two seconds later the next poll reported the same
   * unchanged file as fresh activity — which took the run back to
   * `detected_live`, froze its last-seen time at the moment it finished, and
   * left it to drift into `observation_lost` five minutes later.
   */
  it("reports no further activity once a rollout containing curly quotes stops growing", async () => {
    const dir = await root();
    const body = codexRollout("sess-cx", { marked: true, complete: true }).replace(
      "Read the note.",
      "Read the note – I’ll wait.",
    );
    await writeCodex(dir, "sess-cx", body);

    const observer = new CodexObserver(dir);
    const run = pending("codex");
    const first = await observer.poll(run, new Date().toISOString());
    expect(first.evidence.map((item) => item.kind)).toEqual(["match", "completed"]);

    // The state machine has moved the run on; the file has not changed.
    const detected: PendingRun = { ...run, state: "completed", detectedSessionId: "sess-cx" };
    for (let poll = 0; poll < 3; poll += 1) {
      const again = await observer.poll(detected, new Date().toISOString());
      expect(again.evidence).toEqual([]);
      expect(again.events).toEqual([]);
    }
  });

  it("does not call a chunk of skipped reasoning activity", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: true, complete: true }));

    const observer = new CodexObserver(dir);
    const run = pending("codex");
    await observer.poll(run, new Date().toISOString());

    // Codex writes its own working out to the same file. Anthill skips those
    // records by name, so the file grows without anything to report.
    const day = join(dir, "2026", "08", "29");
    await appendFile(
      join(day, "rollout-2026-08-29T10-00-00-sess-cx.jsonl"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "response_item",
        payload: { type: "reasoning", content: [{ text: "PRIVATE-REASONING" }] },
      }) + "\n",
      "utf8",
    );

    const detected: PendingRun = { ...run, state: "completed", detectedSessionId: "sess-cx" };
    const after = await observer.poll(detected, new Date().toISOString());
    expect(after.evidence).toEqual([]);
  });

  it("still notices the session writing real work again", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexRollout("sess-cx", { marked: true, complete: true }));

    const observer = new CodexObserver(dir);
    const run = pending("codex");
    await observer.poll(run, new Date().toISOString());

    const day = join(dir, "2026", "08", "29");
    await appendFile(
      join(day, "rollout-2026-08-29T10-00-00-sess-cx.jsonl"),
      JSON.stringify({
        // Explicitly later than the fixture's rows: on a fast machine the whole
        // test fits in one millisecond, and activity at the already-reported
        // timestamp is — correctly — not reported twice.
        timestamp: new Date(Date.now() + 50).toISOString(),
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", call_id: "call-9" },
      }) + "\n",
      "utf8",
    );

    const detected: PendingRun = { ...run, state: "completed", detectedSessionId: "sess-cx" };
    const after = await observer.poll(detected, new Date().toISOString());
    expect(after.evidence.map((item) => item.kind)).toEqual(["activity"]);
  });
});

/**
 * What the agent said.
 *
 * ANT-16. Both observers took the step markers out of a message and threw the
 * message itself away, so the page's Messages filter was a tab that could only
 * ever be empty — and a reader watching a long session had tool names and
 * nothing else to go on. One line survives now, built by removing: no
 * reasoning, no fenced code, no correlation plumbing.
 */
describe("one line of what the agent said", () => {
  const PROSE = [
    "I have read the note and will start on the first step now.",
    "",
    "```bash",
    "export SECRET_TOKEN=hunter2",
    "```",
    `ANTHILL-STEP ${RUN_ID} ${NONCE} implement`,
  ].join("\n");

  function claudeSaying(sessionId: string, text: string) {
    const at = new Date().toISOString();
    return (
      [
        {
          type: "user",
          sessionId,
          timestamp: at,
          cwd: "/tmp/scratch",
          message: { role: "user", content: MARKED_PROMPT },
        },
        {
          type: "assistant",
          sessionId,
          timestamp: at,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "PRIVATE-REASONING-SHOULD-NEVER-BE-READ" },
              { type: "text", text },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n"
    );
  }

  function codexSaying(sessionId: string, text: string) {
    const at = new Date().toISOString();
    return (
      [
        { timestamp: at, type: "session_meta", payload: { session_id: sessionId, cwd: "/tmp/x" } },
        {
          timestamp: at,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: MARKED_PROMPT }],
          },
        },
        {
          timestamp: at,
          type: "response_item",
          payload: { type: "reasoning", content: [{ text: "PRIVATE-REASONING-SHOULD-NEVER-BE-READ" }] },
        },
        {
          timestamp: at,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n"
    );
  }

  it("reaches the feed from a Claude Code transcript", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", claudeSaying("sess-1", PROSE));
    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "message",
        detail: "I have read the note and will start on the first step now.",
      }),
    );
  });

  it("reaches the feed from a Codex rollout", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-cx", codexSaying("sess-cx", PROSE));
    const { events } = await new CodexObserver(dir).poll(
      pending("codex"),
      new Date().toISOString(),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "message",
        detail: "I have read the note and will start on the first step now.",
      }),
    );
  });

  it("still leaves the reasoning, the fenced code and the plumbing behind", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", claudeSaying("sess-1", PROSE));
    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    const dump = JSON.stringify(events);
    expect(dump).not.toContain("PRIVATE-REASONING");
    expect(dump).not.toContain("SECRET_TOKEN");
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("ANTHILL-STEP");
  });

  it("announces the step as a step, and does not repeat it as a message", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeSaying("sess-1", `ANTHILL-STEP ${RUN_ID} ${NONCE} implement`),
    );
    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(events.filter((event) => event.kind === "step.marker")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "message")).toHaveLength(0);
  });
});

/**
 * A session that handed a stage to somebody else.
 *
 * ANT-18, built from the transcript that filed it. The orchestrator dispatched
 * stage 4 to a background agent, said so, ended its turn, and then wrote
 * nothing for twelve minutes while the work happened somewhere this file never
 * describes. A terminal stop reason plus five minutes of silence was read as an
 * ending, so Anthill announced "Session finished" for seven minutes in the
 * middle of the largest stage of the workflow. The same transcript had two
 * earlier pauses that came within a minute of doing the same.
 */
describe("a session that delegates and then waits", () => {
  const at = (ms: number) => new Date(Date.parse("2026-08-29T10:00:00.000Z") + ms).toISOString();

  function transcript(sessionId: string, rows: unknown[]) {
    return (
      [
        {
          type: "user",
          sessionId,
          timestamp: at(0),
          cwd: "/tmp/scratch",
          message: { role: "user", content: MARKED_PROMPT },
        },
        ...rows,
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n"
    );
  }

  function assistant(sessionId: string, when: number, content: unknown[], stop?: string) {
    return {
      type: "assistant",
      sessionId,
      timestamp: at(when),
      message: { role: "assistant", ...(stop ? { stop_reason: stop } : {}), content },
    };
  }

  /** The exact shape from the report: dispatch, wrap-up, then a long silence. */
  function dispatched(sessionId: string, tool: string) {
    return transcript(sessionId, [
      assistant(
        sessionId,
        4_000,
        [{ type: "tool_use", id: "toolu_9", name: tool, input: { description: "Stage 4" } }],
        "tool_use",
      ),
      {
        type: "user",
        sessionId,
        timestamp: at(5_000),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_9", is_error: false }],
        },
      },
      assistant(sessionId, 6_000, [{ type: "text", text: "Stage 4 dispatched." }], "end_turn"),
    ]);
  }

  async function look(body: string, quietMs: number) {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", body);
    return new ClaudeCodeObserver(dir).poll(pending("claude-code"), at(quietMs));
  }

  it("is not called finished while the delegate is working", async () => {
    // Twelve minutes of silence, which is what the report measured.
    const { evidence } = await look(dispatched("sess-1", "SendMessage"), 12 * 60_000);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("stays that way however long the stage takes", async () => {
    const { evidence } = await look(dispatched("sess-1", "SendMessage"), 3 * 60 * 60_000);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("says nothing rather than the wrong thing – the quiet path handles it", async () => {
    // Anthill has no record of the delegate's work, so the honest report is
    // that it cannot see anything, which is recoverable and says so.
    const { evidence } = await look(dispatched("sess-1", "SendMessage"), 12 * 60_000);
    expect(evidence.some((item) => item.kind === "failed")).toBe(false);
  });

  it("also waits on a delegation that has not come back", async () => {
    const body = transcript("sess-2", [
      assistant(
        "sess-2",
        4_000,
        [{ type: "tool_use", id: "toolu_1", name: "Task", input: { subagent_type: "reader" } }],
        "tool_use",
      ),
      assistant("sess-2", 6_000, [{ type: "text", text: "Handed it over." }], "end_turn"),
    ]);
    const { evidence } = await look(body, 12 * 60_000);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("settles once a delegation that comes back has come back", async () => {
    const body = transcript("sess-3", [
      assistant(
        "sess-3",
        4_000,
        [{ type: "tool_use", id: "toolu_1", name: "Task", input: { subagent_type: "reader" } }],
        "tool_use",
      ),
      {
        type: "user",
        sessionId: "sess-3",
        timestamp: at(5_000),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false }],
        },
      },
      assistant("sess-3", 6_000, [{ type: "text", text: "All done." }], "end_turn"),
    ]);
    const { evidence } = await look(body, 12 * 60_000);
    expect(evidence.some((item) => item.kind === "completed")).toBe(true);
  });

  it("still settles an ordinary session that simply finished", async () => {
    const body = transcript("sess-4", [
      assistant("sess-4", 4_000, [{ type: "text", text: "It says pumpernickel." }], "end_turn"),
    ]);
    const { evidence } = await look(body, 12 * 60_000);
    expect(evidence.some((item) => item.kind === "completed")).toBe(true);
  });

  it("does not settle before the silence is long enough", async () => {
    const body = transcript("sess-5", [
      assistant("sess-5", 4_000, [{ type: "text", text: "Nearly there." }], "end_turn"),
    ]);
    const { evidence } = await look(body, 60_000);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  /**
   * The same delegation, sent to the background.
   *
   * ANT-70, measured from the session it was reported in. `Agent` was treated
   * as a delegation that comes back, because normally it does: in that
   * transcript two foreground `Agent` calls returned after 428 and 773
   * seconds. The three background ones returned in *two* — the tool reports
   * that the agent was started, and the work then runs for half an hour
   * writing nothing here. So the wait was recorded and cleared two seconds
   * later, the turn ended, and five minutes on Anthill said "Session
   * finished" while the agent was still going.
   *
   * `run_in_background` is what separates the two, not the tool's name.
   */
  function backgrounded(sessionId: string, tool: string) {
    return transcript(sessionId, [
      assistant(
        sessionId,
        4_000,
        [
          {
            type: "tool_use",
            id: "toolu_9",
            name: tool,
            input: { subagent_type: "developer", description: "Stage 2", run_in_background: true },
          },
        ],
        "tool_use",
      ),
      {
        type: "user",
        sessionId,
        // Two seconds, because all it says is that the agent was started.
        timestamp: at(6_000),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_9", is_error: false }],
        },
      },
      assistant(sessionId, 7_000, [{ type: "text", text: "Stage 2 is running." }], "end_turn"),
    ]);
  }

  it.each(["Agent", "Task"] as const)(
    "is not called finished while a backgrounded %s is working",
    async (tool) => {
      // Thirty-seven minutes, which is what the reported session measured.
      const { evidence } = await look(backgrounded("sess-6", tool), 37 * 60_000);
      expect(evidence.some((item) => item.kind === "completed")).toBe(false);
    },
  );

  it("stays that way for as long as the background agent takes", async () => {
    const { evidence } = await look(backgrounded("sess-7", "Agent"), 3 * 60 * 60_000);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("is not fooled by the instant result the dispatch returns", async () => {
    // The result came back, so the old rule had nothing left to wait on. It is
    // a receipt for the dispatch, not the delegate's work.
    const { evidence } = await look(backgrounded("sess-8", "Agent"), 12 * 60_000);
    expect(evidence.some((item) => item.kind === "failed")).toBe(false);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("does not settle while another channel is still hearing the session", async () => {
    // ANT-70's second half. Even with nothing in this file, the hook log was
    // reporting the session's tool calls throughout; the run's own clock had
    // moved, and this observer was the only thing that had not noticed.
    const dir = await root();
    const body = transcript("sess-10", [
      assistant("sess-10", 4_000, [{ type: "text", text: "Kicked it off." }], "end_turn"),
    ]);
    await writeClaude(dir, "-tmp-scratch", "sess-10", body);

    const heardElsewhere: PendingRun = {
      ...pending("claude-code"),
      detectedSessionId: "sess-10",
      state: "detected_live",
      lastObservedAt: at(11 * 60_000),
    };
    const { evidence } = await new ClaudeCodeObserver(dir).poll(heardElsewhere, at(12 * 60_000));
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("settles once every channel has gone quiet", async () => {
    const dir = await root();
    const body = transcript("sess-11", [
      assistant("sess-11", 4_000, [{ type: "text", text: "That is everything." }], "end_turn"),
    ]);
    await writeClaude(dir, "-tmp-scratch", "sess-11", body);

    const heardLongAgo: PendingRun = {
      ...pending("claude-code"),
      detectedSessionId: "sess-11",
      state: "detected_live",
      lastObservedAt: at(4_000),
    };
    const { evidence } = await new ClaudeCodeObserver(dir).poll(heardLongAgo, at(12 * 60_000));
    expect(evidence.some((item) => item.kind === "completed")).toBe(true);
  });

  /**
   * The other half of the trade <issue>ANT-70</issue> made.
   *
   * Making \`dispatched\` sticky for backgrounded delegation stopped Anthill
   * calling a working session finished. It also stopped it calling a finished
   * session finished: one backgrounded delegation and the flag never cleared,
   * so a workflow that demonstrably completed sat at "Observation lost" with
   * its last step unknown and the diagram never went green (ANT-75).
   *
   * The flag now stands down when the hook log is carrying news about the run,
   * because then the question is answered by evidence rather than by a
   * permanent assumption. With no hooks, the transcript is alone and the
   * assumption is still the honest answer.
   */
  const watched = { hooksWatching: true };

  async function lookWith(body: string, quietMs: number, context?: { hooksWatching: boolean }) {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", body);
    return new ClaudeCodeObserver(dir).poll(pending("claude-code"), at(quietMs), context);
  }

  it("settles a backgrounded delegation once another channel is watching", async () => {
    const { evidence } = await lookWith(backgrounded("sess-1", "Agent"), 12 * 60_000, watched);
    expect(evidence.some((item) => item.kind === "completed")).toBe(true);
  });

  it("still refuses to settle it when the transcript is the only channel", async () => {
    // Nothing can retract the handover here, so the assumption stands.
    const { evidence } = await lookWith(backgrounded("sess-1", "Agent"), 12 * 60_000);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
    const { evidence: explicit } = await lookWith(
      backgrounded("sess-1", "Agent"),
      12 * 60_000,
      { hooksWatching: false },
    );
    expect(explicit.some((item) => item.kind === "completed")).toBe(false);
  });

  it("does not settle on a delegation that has not come back, watched or not", async () => {
    // \`awaiting\` is a different claim: a foreground delegation whose result
    // has not arrived is work this file will describe, once it does.
    const body = transcript("sess-2", [
      assistant(
        "sess-2",
        4_000,
        [{ type: "tool_use", id: "toolu_1", name: "Task", input: { subagent_type: "reader" } }],
        "tool_use",
      ),
      assistant("sess-2", 6_000, [{ type: "text", text: "Handed it over." }], "end_turn"),
    ]);
    const { evidence } = await lookWith(body, 12 * 60_000, watched);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("still settles an ordinary session when a channel is watching", async () => {
    const body = transcript("sess-4", [
      assistant("sess-4", 4_000, [{ type: "text", text: "It says pumpernickel." }], "end_turn"),
    ]);
    const { evidence } = await lookWith(body, 12 * 60_000, watched);
    expect(evidence.some((item) => item.kind === "completed")).toBe(true);
  });

  it("still settles a foreground delegation that came back", async () => {
    // The guard must not swallow the ordinary case: a foreground Agent's
    // result is the work itself, and the session really has finished.
    const body = transcript("sess-9", [
      assistant(
        "sess-9",
        4_000,
        [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "reader" } }],
        "tool_use",
      ),
      {
        type: "user",
        sessionId: "sess-9",
        timestamp: at(400_000),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false }],
        },
      },
      assistant("sess-9", 401_000, [{ type: "text", text: "All done." }], "end_turn"),
    ]);
    const { evidence } = await look(body, 401_000 + 12 * 60_000);
    expect(evidence.some((item) => item.kind === "completed")).toBe(true);
  });
});

/**
 * The same marker in two transcripts, after one of them was already chosen.
 *
 * ANT-6, from the observer's side. The guard only ran before a session had
 * been picked, so a second session appearing later was reported as an ordinary
 * strong match and quietly took over.
 */
describe("a second session that turns up after the first", () => {
  const detected = { ...pending("claude-code"), detectedSessionId: "sess-a" } as const;

  async function twoSessions() {
    const dir = await root();
    await writeClaude(dir, "-tmp-a", "sess-a", claudeTranscript("sess-a", { marked: true }));
    await writeClaude(dir, "-tmp-b", "sess-b", claudeTranscript("sess-b", { marked: true }));
    return dir;
  }

  it("is reported as ambiguous even though one was already being followed", async () => {
    const dir = await twoSessions();
    const { evidence } = await new ClaudeCodeObserver(dir).poll(detected, new Date().toISOString());
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "ambiguous",
        sessionIds: expect.arrayContaining(["sess-a", "sess-b"]),
      }),
    ]);
  });

  it("reports nothing from either while it cannot tell them apart", async () => {
    const dir = await twoSessions();
    const { events } = await new ClaudeCodeObserver(dir).poll(detected, new Date().toISOString());
    expect(events).toEqual([]);
  });

  it("says so again for Codex, which had the same guard", async () => {
    const dir = await root();
    await writeCodex(dir, "sess-x", codexRollout("sess-x", { marked: true }));
    await writeCodex(dir, "sess-y", codexRollout("sess-y", { marked: true }));
    const { evidence } = await new CodexObserver(dir).poll(
      { ...pending("codex"), detectedSessionId: "sess-x" },
      new Date().toISOString(),
    );
    expect(evidence).toEqual([
      expect.objectContaining({ kind: "ambiguous", sessionIds: expect.arrayContaining(["sess-x", "sess-y"]) }),
    ]);
  });

  it("offers a way back when only the followed session is left", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-a", "sess-a", claudeTranscript("sess-a", { marked: true }));
    const { evidence } = await new ClaudeCodeObserver(dir).poll(
      { ...detected, state: "ambiguous_match" },
      new Date().toISOString(),
    );
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "match", sessionId: "sess-a", confidence: "strong" }),
    );
  });
});

/**
 * How a contest of two sessions ends.
 *
 * From the In Review audit's finding on ANT-6: ambiguity could only resolve
 * when `distinct` shrank to one, but transcripts outlive their sessions and
 * files never leave the disk — so two matching files kept a run ambiguous for
 * the rest of its life. The contest is now between candidates still speaking,
 * and a session that recorded an ending or fell fully quiet has left it.
 */
describe("a contest of two sessions, and how it ends", () => {
  const T0 = Date.parse("2026-08-29T10:00:00.000Z");
  const at = (ms: number) => new Date(T0 + ms).toISOString();

  function claudeAt(sessionId: string, when: string, extra: string) {
    const rows: unknown[] = [
      {
        type: "user",
        sessionId,
        timestamp: when,
        cwd: "/tmp/scratch",
        message: { role: "user", content: MARKED_PROMPT },
      },
      {
        type: "assistant",
        sessionId,
        timestamp: when,
        message: { role: "assistant", content: [{ type: "text", text: extra }] },
      },
    ];
    return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  }

  it("recovers to the candidate still speaking once the other has gone quiet", async () => {
    const dir = await root();
    // sess-a stopped writing forty minutes ago; sess-b wrote a minute ago.
    await writeClaude(dir, "-tmp-a", "sess-a", claudeAt("sess-a", at(0), "Working."));
    await writeClaude(dir, "-tmp-b", "sess-b", claudeAt("sess-b", at(39 * 60_000), "Working."));

    const observer = new ClaudeCodeObserver(dir);
    const ambiguousRun = {
      ...pending("claude-code"),
      state: "ambiguous_match" as const,
      detectedSessionId: "sess-b",
    };
    const { evidence } = await observer.poll(ambiguousRun, at(40 * 60_000));

    expect(evidence.some((item) => item.kind === "ambiguous")).toBe(false);
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "match", sessionId: "sess-b", confidence: "strong" }),
    );
  });

  it("recovers to the *other* candidate when the tracked one is the one that died", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-a", "sess-a", claudeAt("sess-a", at(0), "Working."));
    await writeClaude(dir, "-tmp-b", "sess-b", claudeAt("sess-b", at(39 * 60_000), "Working."));

    const observer = new ClaudeCodeObserver(dir);
    const { evidence } = await observer.poll(
      { ...pending("claude-code"), state: "ambiguous_match", detectedSessionId: "sess-a" },
      at(40 * 60_000),
    );
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "match", sessionId: "sess-b" }),
    );
  });

  it("stays ambiguous while both are still speaking", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-a", "sess-a", claudeAt("sess-a", at(39 * 60_000), "Working."));
    await writeClaude(dir, "-tmp-b", "sess-b", claudeAt("sess-b", at(39 * 60_000), "Working."));

    const { evidence } = await new ClaudeCodeObserver(dir).poll(
      { ...pending("claude-code"), state: "ambiguous_match", detectedSessionId: "sess-a" },
      at(40 * 60_000),
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "ambiguous",
        sessionIds: expect.arrayContaining(["sess-a", "sess-b"]),
      }),
    ]);
  });

  it("says nothing new when every candidate has gone quiet", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-a", "sess-a", claudeAt("sess-a", at(0), "Done."));
    await writeClaude(dir, "-tmp-b", "sess-b", claudeAt("sess-b", at(60_000), "Done."));

    const { evidence, events } = await new ClaudeCodeObserver(dir).poll(
      { ...pending("claude-code"), state: "ambiguous_match", detectedSessionId: "sess-a" },
      at(40 * 60_000),
    );
    expect(evidence).toEqual([]);
    expect(events).toEqual([]);
  });

  it("retires a Codex candidate on its own recorded ending, not only on silence", async () => {
    const dir = await root();
    // Both wrote moments ago, but sess-x recorded task_complete.
    await writeCodex(dir, "sess-x", codexRollout("sess-x", { marked: true, complete: true }));
    await writeCodex(dir, "sess-y", codexRollout("sess-y", { marked: true }));

    const { evidence } = await new CodexObserver(dir).poll(
      { ...pending("codex"), state: "ambiguous_match", detectedSessionId: "sess-y" },
      new Date().toISOString(),
    );
    expect(evidence.some((item) => item.kind === "ambiguous")).toBe(false);
    expect(evidence).toContainEqual(
      expect.objectContaining({ kind: "match", sessionId: "sess-y" }),
    );
  });

  it("lets the state machine accept the survivor from an ambiguous run", () => {
    // The takeover end to end: ambiguous with A tracked, strong match for B.
    const run = applyEvidence(
      {
        ...pending("claude-code"),
        state: "ambiguous_match" as const,
        detectedSessionId: "sess-a",
      },
      {
        kind: "match",
        sessionId: "sess-b",
        confidence: "strong",
        channel: "claude-code:transcript",
        at: new Date().toISOString(),
      },
    );
    expect(run.state).toBe("detected_live");
    expect(run.detectedSessionId).toBe("sess-b");
  });
});

/**
 * What each harness records about its own spending.
 *
 * ANT-9 / ANT-21. Always the vendor's numbers, never an estimate — and for
 * Claude Code, taken once per message: a message streams as several records
 * that each repeat the same usage, so summing per record would double-count.
 */
describe("token usage, as the harness recorded it", () => {
  it("reads Claude Code usage once per message, however many records stream it", async () => {
    const dir = await root();
    const when = new Date().toISOString();
    const record = (content: unknown[]) => ({
      type: "assistant",
      sessionId: "sess-1",
      timestamp: when,
      message: {
        id: "msg_1",
        role: "assistant",
        usage: { input_tokens: 5, cache_read_input_tokens: 95, output_tokens: 40 },
        content,
      },
    });
    const body =
      [
        {
          type: "user",
          sessionId: "sess-1",
          timestamp: when,
          message: { role: "user", content: MARKED_PROMPT },
        },
        // The same message, streamed as two records with the usage repeated.
        record([{ type: "text", text: "First half." }]),
        record([{ type: "text", text: "Second half." }]),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n";
    await writeClaude(dir, "-tmp-scratch", "sess-1", body);

    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    const usage = events.filter((event) => event.kind === "usage");
    expect(usage).toHaveLength(1);
    // Fresh input and cache traffic both count as read.
    expect(usage[0].tokens).toEqual({ in: 100, out: 40 });
  });

  it("reads Codex's token_count slices", async () => {
    const dir = await root();
    const when = new Date().toISOString();
    const rows = [
      { timestamp: when, type: "session_meta", payload: { session_id: "sess-cx", cwd: "/tmp/x" } },
      {
        timestamp: when,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: MARKED_PROMPT }],
        },
      },
      {
        timestamp: when,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 999, cached_input_tokens: 0, output_tokens: 999 },
            last_token_usage: { input_tokens: 300, cached_input_tokens: 700, output_tokens: 55 },
          },
        },
      },
    ];
    await writeCodex(dir, "sess-cx", rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const { events } = await new CodexObserver(dir).poll(pending("codex"), new Date().toISOString());
    const usage = events.filter((event) => event.kind === "usage");
    // The slice, not the running total — slices sum; totals repeated would not.
    expect(usage).toHaveLength(1);
    expect(usage[0].tokens).toEqual({ in: 1000, out: 55 });
  });

  it("emits nothing where a record carries no usage – unavailable, not zero", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeTranscript("sess-1", { marked: true, step: "implement" }),
    );
    const { events } = await new ClaudeCodeObserver(dir).poll(
      pending("claude-code"),
      new Date().toISOString(),
    );
    expect(events.filter((event) => event.kind === "usage")).toHaveLength(0);
  });
});

/**
 * Who each harness says wrote a message.
 *
 * ANT-24. The rule is that the answer comes from the record. Claude Code has
 * an `isSidechain` field for a turn taken by a delegate; every transcript this
 * was written against carries it false throughout, which agrees with what
 * ANT-18 found — the delegate's work is not written here at all.
 */
describe("the author of a message", () => {
  const when = () => new Date().toISOString();

  function claudeSaying(text: string, extra: Record<string, unknown> = {}) {
    const at = when();
    return (
      [
        {
          type: "user",
          sessionId: "sess-1",
          timestamp: at,
          cwd: "/tmp/scratch",
          message: { role: "user", content: MARKED_PROMPT },
        },
        {
          type: "assistant",
          sessionId: "sess-1",
          timestamp: at,
          ...extra,
          message: { role: "assistant", content: [{ type: "text", text }] },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n"
    );
  }

  it("is the main agent for an ordinary Claude Code turn", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", claudeSaying("Starting now."));
    const { events } = await new ClaudeCodeObserver(dir).poll(pending("claude-code"), when());
    const message = events.find((event) => event.kind === "message");
    expect(message?.author).toEqual({ kind: "main" });
  });

  it("is a subagent when the record marks the turn as one", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeSaying("Handled it.", { isSidechain: true, agentName: "Reviewer" }),
    );
    const { events } = await new ClaudeCodeObserver(dir).poll(pending("claude-code"), when());
    const message = events.find((event) => event.kind === "message");
    expect(message?.author).toEqual({ kind: "subagent", name: "Reviewer" });
  });

  // ANT-60: a delegate's turn ending is signed, so it is not read as the session's.
  it("signs a subagent's turn ending, and leaves the session's own unsigned", async () => {
    const ending = (text: string, extra: Record<string, unknown> = {}) => {
      const at = when();
      return [
        { type: "user", sessionId: "sess-1", timestamp: at, cwd: "/tmp/scratch", message: { role: "user", content: MARKED_PROMPT } },
        {
          type: "assistant",
          sessionId: "sess-1",
          timestamp: at,
          ...extra,
          message: { id: `msg-${text}`, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
        },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    };

    const sub = await root();
    await writeClaude(sub, "-tmp-scratch", "sess-1", ending("Handled it.", { isSidechain: true, agentName: "Reviewer" }));
    const delegated = (await new ClaudeCodeObserver(sub).poll(pending("claude-code"), when())).events;
    expect(delegated.find((event) => event.kind === "turn.end")?.author).toEqual({ kind: "subagent", name: "Reviewer" });

    const main = await root();
    await writeClaude(main, "-tmp-scratch", "sess-1", ending("Done."));
    const own = (await new ClaudeCodeObserver(main).poll(pending("claude-code"), when())).events;
    const ended = own.find((event) => event.kind === "turn.end");
    expect(ended).toBeDefined();
    expect(ended?.author).toBeUndefined();
  });

  it("is a nameless subagent rather than a guessed one", async () => {
    const dir = await root();
    await writeClaude(
      dir,
      "-tmp-scratch",
      "sess-1",
      claudeSaying("Handled it.", { isSidechain: true }),
    );
    const { events } = await new ClaudeCodeObserver(dir).poll(pending("claude-code"), when());
    const message = events.find((event) => event.kind === "message");
    expect(message?.author).toEqual({ kind: "subagent" });
  });

  it("is the main agent for a Codex rollout message", async () => {
    const dir = await root();
    const at = when();
    const rows = [
      { timestamp: at, type: "session_meta", payload: { session_id: "sess-cx", cwd: "/tmp/x" } },
      {
        timestamp: at,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: MARKED_PROMPT }],
        },
      },
      {
        timestamp: at,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Starting the survey." }],
        },
      },
    ];
    await writeCodex(dir, "sess-cx", rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const { events } = await new CodexObserver(dir).poll(pending("codex"), when());
    const message = events.find((event) => event.kind === "message");
    expect(message?.author).toEqual({ kind: "main" });
  });
});

/**
 * What a delegate said.
 *
 * ANT-54. The Live Session feed showed a subagent's tool calls and the moment
 * it finished, and never a word it wrote — the page said so itself, in the
 * list of things Anthill cannot tell you. The words were on disk the whole
 * time: Claude Code writes each delegate to
 * \`<project>/<sessionId>/subagents/agent-*.jsonl\`, and the observer walked one
 * directory level and never looked inside.
 *
 * Measured on a live session while fixing it: two delegate transcripts, 75 and
 * 424 records, holding twelve messages the feed had no way to show.
 */
describe("a session's delegates", () => {
  const at = (ms: number) => new Date(Date.parse("2026-08-29T10:00:00.000Z") + ms).toISOString();

  async function writeDelegate(
    dir: string,
    project: string,
    sessionId: string,
    file: string,
    rows: unknown[],
    meta?: Record<string, unknown>,
  ) {
    await mkdir(join(dir, project, sessionId, "subagents"), { recursive: true });
    await writeFile(
      join(dir, project, sessionId, "subagents", file),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );
    // The sibling Claude Code writes beside every delegate, naming what it was for.
    if (meta) {
      await writeFile(
        join(dir, project, sessionId, "subagents", file.replace(/\.jsonl$/, ".meta.json")),
        JSON.stringify(meta),
        "utf8",
      );
    }
  }

  /** A delegate turn: the parent's session id, and every row a sidechain. */
  const said = (text: string, when: number, stop?: string) => ({
    type: "assistant",
    sessionId: "sess-1",
    isSidechain: true,
    timestamp: at(when),
    message: {
      role: "assistant",
      ...(stop ? { stop_reason: stop } : {}),
      content: [{ type: "text", text }],
    },
  });

  /** A run that started when these fixtures did, so nothing predates it. */
  function following(): PendingRun {
    return {
      ...createPendingRun({
        anthillRunId: RUN_ID,
        correlationNonce: NONCE,
        selectedCli: "claude-code",
        promptVersion: "1",
        bootstrapPromptHash: "abcd1234",
        now: at(0),
      }),
      detectedSessionId: "sess-1",
      state: "detected_live" as const,
    };
  }

  async function followed(rows: unknown[], meta?: Record<string, unknown>) {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", claudeTranscript("sess-1", { marked: true }));
    await writeDelegate(dir, "-tmp-scratch", "sess-1", "agent-a1.jsonl", rows, meta);
    return new ClaudeCodeObserver(dir).poll(following(), at(60_000));
  }

  /** The shape Claude Code actually writes, copied from a live session. */
  const META = {
    agentType: "general-purpose",
    description: "Survey session observation",
    toolUseId: "toolu_01DGF",
    spawnDepth: 1,
    requestShape: "background",
  };

  it("carries the call that started the delegate on everything it wrote (ANT-163)", async () => {
    const { events } = await followed(
      [said("[ANTHILL implement] Editing calc.py.", 10_000), said("Done.", 12_000, "end_turn")],
      META,
    );
    const fromDelegate = events.filter((event) => event.author?.kind === "subagent");
    expect(fromDelegate.length).toBeGreaterThan(0);
    for (const event of fromDelegate) expect(event.parentToolUseId).toBe("toolu_01DGF");
    // Its turn ending is signed and linked too, which is how a background
    // delegation is known to be over.
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn.end", parentToolUseId: "toolu_01DGF" }));
    // And a message's tag is read, then left out of what is shown.
    const message = events.find((event) => event.kind === "message");
    expect(message).toMatchObject({ stepTag: "implement", detail: "Editing calc.py." });
  });

  it("signs the delegate's words with what it was for", async () => {
    // The feed said "Subagent" and nothing else, on a run with two of them
    // (ANT-54). The description is the label that tells them apart.
    const { events } = await followed([said("Exploring the repository structure.", 10_000)], META);
    const message = events.find((event) => event.kind === "message");
    expect(message?.author).toEqual({ kind: "subagent", name: "Survey session observation" });
  });

  it("falls back to the agent type when no description was given", async () => {
    const { events } = await followed([said("On it.", 10_000)], { agentType: "macos-developer" });
    const message = events.find((event) => event.kind === "message");
    expect(message?.author).toEqual({ kind: "subagent", name: "macos-developer" });
  });

  it("stays an unnamed subagent when the record names nothing", async () => {
    // No meta file at all, or one that cannot be read: a subagent, honestly,
    // rather than a name invented from a nearby Task call.
    const { events } = await followed([said("Nameless.", 10_000)]);
    const message = events.find((event) => event.kind === "message");
    expect(message?.author).toEqual({ kind: "subagent" });
  });

  it("reads what the delegate wrote", async () => {
    const { events } = await followed([said("Written to docs/00-open-questions.md.", 10_000)]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "message",
        detail: "Written to docs/00-open-questions.md.",
      }),
    );
  });

  it("says a subagent wrote it, not the session", async () => {
    const { events } = await followed([said("Nine schemas parse.", 10_000)]);
    const message = events.find((event) => event.kind === "message");
    expect(message?.author?.kind).toBe("subagent");
  });

  it("does not ask a delegate to carry the run marker", async () => {
    // It was never handed one: the marker is in the prompt somebody pasted
    // into the session. Where the file sits answers the same question better.
    const { events } = await followed([said("No marker anywhere in here.", 10_000)]);
    expect(events.some((event) => event.kind === "message")).toBe(true);
  });

  it("counts a delegate's turn as the session being alive", async () => {
    const { evidence } = await followed([said("Still going.", 10_000)]);
    expect(evidence).toContainEqual(expect.objectContaining({ kind: "activity", sessionId: "sess-1" }));
  });

  it("never lets a delegate finishing settle the run", async () => {
    // A subagent ending its turn is not the session ending, however long the
    // quiet that follows.
    const { evidence } = await followed([said("My part is done.", 10_000, "end_turn")]);
    expect(evidence.some((item) => item.kind === "completed")).toBe(false);
  });

  it("looks only under the session it is following", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", claudeTranscript("sess-1", { marked: true }));
    await writeDelegate(dir, "-tmp-scratch", "sess-9", "agent-other.jsonl", [
      { ...said("Somebody else's delegate.", 10_000), sessionId: "sess-9" },
    ]);
    const { events } = await new ClaudeCodeObserver(dir).poll(following(), at(60_000));
    expect(events.some((event) => event.detail === "Somebody else's delegate.")).toBe(false);
  });

  it("looks for none at all before a session has been matched", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-1", claudeTranscript("sess-1", { marked: false }));
    await writeDelegate(dir, "-tmp-scratch", "sess-1", "agent-a1.jsonl", [said("Too early.", 10_000)]);
    const { events } = await new ClaudeCodeObserver(dir).poll(pending("claude-code"), at(60_000));
    expect(events).toEqual([]);
  });
});

/*
  ANT-159. What an observer reports must not depend on how much of the file
  one poll happened to read. Codex's opening record used to be dropped when it
  was read before the marker, and a full re-read after a restart then added it
  to the journal after `task_complete`.
*/
describe("the same record whatever the read size", () => {
  const base = Date.now();
  const T = (s: number) => new Date(base + s * 1000).toISOString();
  const rows = [
    { timestamp: T(6), type: "session_meta", payload: { session_id: "sess-cx", id: "sess-cx", cli_version: "0.1" } },
    {
      timestamp: T(7),
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: MARKED_PROMPT }] },
    },
    {
      timestamp: T(10),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `ANTHILL-STEP ${RUN_ID} ${NONCE} test` }],
      },
    },
    {
      timestamp: T(30),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Tests pass.\nANTHILL-DONE ${RUN_ID} ${NONCE}` }],
      },
    },
    { timestamp: T(37), type: "event_msg", payload: { type: "task_complete" } },
  ].map((row) => JSON.stringify(row));

  const shape = (events: { kind: string; at: string; completion?: string }[]) =>
    events.map((event) => `${event.at} ${event.kind}${event.completion ? ` ${event.completion}` : ""}`);

  async function readInSteps(dir: string, sizes: number[]) {
    const day = join(dir, "2026", "08", "29");
    await mkdir(day, { recursive: true });
    const path = join(day, "rollout-2026-08-29T10-00-00-sess-cx.jsonl");
    await writeFile(path, "", "utf8");
    const observer = new CodexObserver(dir);
    let run: PendingRun = pending("codex");
    const seen: { kind: string; at: string; completion?: string }[] = [];
    let offset = 0;
    for (const size of sizes) {
      await appendFile(path, rows.slice(offset, offset + size).map((row) => `${row}\n`).join(""), "utf8");
      offset += size;
      const result = await observer.poll(run, T(40));
      run = result.evidence.reduce((next, evidence) => applyEvidence(next, evidence), run);
      seen.push(...result.events);
    }
    return seen;
  }

  it("reports the opening once, in line or all at once", async () => {
    const whole = await readInSteps(await root(), [rows.length]);
    const lineByLine = await readInSteps(await root(), rows.map(() => 1));
    const pairs = await readInSteps(await root(), [1, 2, 2]);

    expect(shape(whole).sort()).toEqual([
      `${T(6)} session.start`,
      `${T(7)} prompt.submit`,
      `${T(10)} step.marker`,
      `${T(30)} message`,
      `${T(30)} session.end done`,
      `${T(37)} turn.end task_complete`,
    ].sort());
    expect(shape(lineByLine).sort()).toEqual(shape(whole).sort());
    expect(shape(pairs).sort()).toEqual(shape(whole).sort());
  });
});

describe("the harness's own done line, journalled", () => {
  it("is a session end with the done completion in a Claude Code reply", async () => {
    const dir = await root();
    const at = new Date().toISOString();
    const body = [
      { type: "user", sessionId: "sess-cc", timestamp: at, cwd: "/tmp/scratch", message: { role: "user", content: MARKED_PROMPT } },
      {
        type: "assistant",
        sessionId: "sess-cc",
        timestamp: at,
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: `All green.\nANTHILL-DONE ${RUN_ID} ${NONCE}` }],
        },
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeClaude(dir, "-tmp-scratch", "sess-cc", body);

    const run = { ...pending("claude-code"), detectedSessionId: "sess-cc", state: "detected_live" as const };
    const { events } = await new ClaudeCodeObserver(dir).poll(run, new Date().toISOString());
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "session.end", completion: "done", author: { kind: "main" } }),
    );
  });

  it("is not journalled for a done line that does not carry this run's nonce", async () => {
    const dir = await root();
    const at = new Date().toISOString();
    const body = [
      { type: "user", sessionId: "sess-cc", timestamp: at, cwd: "/tmp/scratch", message: { role: "user", content: MARKED_PROMPT } },
      {
        type: "assistant",
        sessionId: "sess-cc",
        timestamp: at,
        message: { role: "assistant", content: [{ type: "text", text: `ANTHILL-DONE ${RUN_ID} 000000` }] },
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeClaude(dir, "-tmp-scratch", "sess-cc", body);

    const run = { ...pending("claude-code"), detectedSessionId: "sess-cc", state: "detected_live" as const };
    const { events } = await new ClaudeCodeObserver(dir).poll(run, new Date().toISOString());
    expect(events.filter((event) => event.completion)).toEqual([]);
  });
});

/*
  ANT-162. The prompt now tells an agent that cannot put a marker in its reply
  to print it with a command. Codex's command output was already read
  (ANT-147); Claude Code's tool results now are too. And since each step now
  carries its own concrete line, a command that prints the prompt itself must
  not announce every step at once.
*/
describe("a marker printed by a command", () => {
  const PROMPT_WITH_STEPS = `${MARKED_PROMPT}\n\n    ANTHILL-STEP ${RUN_ID} ${NONCE} implement\n\n    ANTHILL-STEP ${RUN_ID} ${NONCE} test`;

  function claudeWithResult(result: string, reply?: string) {
    const at = new Date().toISOString();
    const rows: unknown[] = [
      { type: "user", sessionId: "sess-cc", timestamp: at, cwd: "/tmp/scratch", message: { role: "user", content: MARKED_PROMPT } },
      {
        type: "assistant",
        sessionId: "sess-cc",
        timestamp: at,
        message: {
          role: "assistant",
          content: [
            ...(reply ? [{ type: "text", text: reply }] : []),
            { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "printf …" } },
          ],
        },
      },
      {
        type: "user",
        sessionId: "sess-cc",
        timestamp: at,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: result }] },
      },
    ];
    return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  }
  const live = () => ({ ...pending("claude-code"), detectedSessionId: "sess-cc", state: "detected_live" as const });

  it("announces the step from a Claude Code tool result", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-cc", claudeWithResult(`ANTHILL-STEP ${RUN_ID} ${NONCE} implement\n`));
    const { events } = await new ClaudeCodeObserver(dir).poll(live(), new Date().toISOString());
    expect(events.filter((event) => event.kind === "step.marker").map((event) => event.blockId)).toEqual(["implement"]);
  });

  it("counts a line in the reply and the same line printed by a command once", async () => {
    const dir = await root();
    const line = `ANTHILL-STEP ${RUN_ID} ${NONCE} implement`;
    await writeClaude(dir, "-tmp-scratch", "sess-cc", claudeWithResult(`${line}\n`, line));
    const { events } = await new ClaudeCodeObserver(dir).poll(live(), new Date().toISOString());
    expect(events.filter((event) => event.kind === "step.marker")).toHaveLength(1);
  });

  it("does not announce every step when a Claude Code tool printed the prompt", async () => {
    const dir = await root();
    await writeClaude(dir, "-tmp-scratch", "sess-cc", claudeWithResult(PROMPT_WITH_STEPS));
    const { events } = await new ClaudeCodeObserver(dir).poll(live(), new Date().toISOString());
    expect(events.filter((event) => event.kind === "step.marker")).toEqual([]);
  });

  it("does not announce every step when a Codex command printed the prompt", async () => {
    const dir = await root();
    const at = new Date().toISOString();
    const body = [
      { timestamp: at, type: "session_meta", payload: { session_id: "sess-cx", id: "sess-cx" } },
      { timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: MARKED_PROMPT }] } },
      { timestamp: at, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: PROMPT_WITH_STEPS } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeCodex(dir, "sess-cx", body);
    const run = { ...pending("codex"), detectedSessionId: "sess-cx", state: "detected_live" as const };
    const { events } = await new CodexObserver(dir).poll(run, new Date().toISOString());
    expect(events.filter((event) => event.kind === "step.marker")).toEqual([]);
  });
});

describe("a delegation's shape (ANT-163)", () => {
  it("says when a subagent was sent to the background", async () => {
    const dir = await root();
    const at = new Date().toISOString();
    const body = [
      { type: "user", sessionId: "sess-cc", timestamp: at, cwd: "/tmp/scratch", message: { role: "user", content: MARKED_PROMPT } },
      {
        type: "assistant",
        sessionId: "sess-cc",
        timestamp: at,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_bg", name: "Agent", input: { subagent_type: "developer", description: "Service A", prompt: "Start your messages with [ANTHILL svc-a]. Add shout().", run_in_background: true } },
            { type: "tool_use", id: "toolu_fg", name: "Agent", input: { subagent_type: "developer", description: "Service B" } },
          ],
        },
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeClaude(dir, "-tmp-scratch", "sess-cc", body);
    const run = { ...pending("claude-code"), detectedSessionId: "sess-cc", state: "detected_live" as const };
    const { events } = await new ClaudeCodeObserver(dir).poll(run, new Date().toISOString());
    const starts = events.filter((event) => event.kind === "subagent.start");
    expect(starts.find((event) => event.toolUseId === "toolu_bg")?.background).toBe(true);
    expect(starts.find((event) => event.toolUseId === "toolu_fg")?.background).toBeUndefined();
    // The step the session named in what it handed over.
    expect(starts.find((event) => event.toolUseId === "toolu_bg")?.stepTag).toBe("svc-a");
    expect(starts.find((event) => event.toolUseId === "toolu_fg")?.stepTag).toBeUndefined();
  });

  it("reads a Codex reply's step tag", async () => {
    const dir = await root();
    const at = new Date().toISOString();
    const body = [
      { timestamp: at, type: "session_meta", payload: { session_id: "sess-cx", id: "sess-cx" } },
      { timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: MARKED_PROMPT }] } },
      { timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "[ANTHILL test] Running the suite." }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeCodex(dir, "sess-cx", body);
    const run = { ...pending("codex"), detectedSessionId: "sess-cx", state: "detected_live" as const };
    const { events } = await new CodexObserver(dir).poll(run, new Date().toISOString());
    expect(events.find((event) => event.kind === "message")).toMatchObject({ stepTag: "test", detail: "Running the suite." });
  });
});
