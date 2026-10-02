/**
 * The VS Code observer, against chat files written the way VS Code writes them
 * (src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts): an
 * operation log of set, push and delete entries over one initial snapshot.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { createPendingRun, isAnthillTool, type PendingRun } from "@anthill/live";

import { VSCodeObserver, replayChatLog } from "./vscode.js";

const RUN_ID = "ANT-1A2B3C4D";
const NONCE = "9f8e7d";
const CHAT = "24a7ba39-82a1-42e0-97d2-1b6b3710b3ac";
const MARKED = `<!-- Anthill run marker.\nanthill-run-id: ${RUN_ID}\nanthill-nonce: ${NONCE}\n-->\n\nRead the note.`;

/** A moment a little after the run was created, so events count as this run's. */
const T = Date.now();

function run(bound?: string, resolved?: string): PendingRun {
  const made = createPendingRun({
    anthillRunId: RUN_ID,
    correlationNonce: NONCE,
    selectedCli: "vscode",
    promptVersion: "1",
    bootstrapPromptHash: "abcd1234",
    now: new Date(T - 5_000).toISOString(),
  });
  return bound
    ? { ...made, exchange: { revision: 1, digest: "d", sessionId: bound, ...(resolved ? { resolvedSessionId: resolved } : {}) } }
    : made;
}

type Line = Record<string, unknown>;

const snapshot = (requests: unknown[] = []): Line => ({
  kind: 0,
  v: { version: 3, creationDate: T - 1_000, sessionId: CHAT, requests, pendingRequests: [] },
});
const request = (text: string, at: number, extra: Record<string, unknown> = {}) => ({
  requestId: `request_${at}`,
  timestamp: at,
  message: { text, parts: [] },
  response: [],
  responseTimestamp: at + 5,
  modelState: { value: 0 },
  ...extra,
});
const markdown = (value: string) => ({ value, supportThemeIcons: false });
const terminal = (command: string, exitCode?: number, at?: number) => ({
  kind: "toolInvocationSerialized",
  toolId: "run_in_terminal",
  toolCallId: `call_${command.length}`,
  isConfirmed: { type: 1 },
  isComplete: true,
  toolSpecificData: {
    kind: "terminal",
    commandLine: { original: command },
    ...(exitCode !== undefined ? { terminalCommandState: { exitCode, timestamp: at ?? T, duration: 10 } } : {}),
  },
});

async function userDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "anthill-vscode-"));
}

async function writeChat(dir: string, lines: Line[], hash = "abc123", folder = "/Users/me/shop"): Promise<string> {
  const storage = join(dir, "workspaceStorage", hash);
  await mkdir(join(storage, "chatSessions"), { recursive: true });
  await writeFile(join(storage, "workspace.json"), JSON.stringify({ folder: pathToFileURL(folder).href }));
  const path = join(storage, "chatSessions", `${CHAT}.jsonl`);
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

const kinds = (result: { events: { kind: string }[] }) => result.events.map((event) => event.kind);

describe("replaying VS Code's operation log", () => {
  it("sets, pushes with a cut, and deletes", () => {
    const text = [
      snapshot(),
      { kind: 2, k: ["requests"], v: [request("hi", 1)] },
      { kind: 2, k: ["requests", 0, "response"], v: [markdown("a"), markdown("b")] },
      { kind: 2, k: ["requests", 0, "response"], i: 1, v: [markdown("B")] },
      { kind: 1, k: ["requests", 0, "modelState"], v: { value: 1, completedAt: 9 } },
      { kind: 3, k: ["requests", 0, "responseTimestamp"] },
    ].map((line) => JSON.stringify(line)).join("\n");
    const chat = replayChatLog(text) as { requests: Record<string, unknown>[] };
    expect(chat.requests[0]!.response).toEqual([markdown("a"), markdown("B")]);
    expect(chat.requests[0]!.modelState).toEqual({ value: 1, completedAt: 9 });
    expect(chat.requests[0]!.responseTimestamp).toBeUndefined();
  });

  it("reads the flat file VS Code writes when the log is off, and skips a half-written line", () => {
    expect(replayChatLog(JSON.stringify({ sessionId: CHAT, requests: [] }))).toMatchObject({ sessionId: CHAT });
    const text = `${JSON.stringify(snapshot())}\n{"kind":2,"k":["requ`;
    expect(replayChatLog(text)).toMatchObject({ sessionId: CHAT, requests: [] });
  });
});

describe("the VS Code observer", () => {
  it("finds a pasted prompt by its marker and follows the chat", async () => {
    const dir = await userDir();
    await writeChat(dir, [
      snapshot([request("Something earlier", T - 600_000, { modelState: { value: 1, completedAt: T - 590_000 } })]),
      { kind: 2, k: ["requests"], v: [request(MARKED, T)] },
      { kind: 2, k: ["requests", 1, "response"], v: [markdown("Reading the note now."), terminal("npm test", 0, T + 2_000), markdown("Half a sen")] },
    ]);
    const observer = new VSCodeObserver(dir, join(dir, "copilot"));

    const first = await observer.poll(run(), new Date(T + 3_000).toISOString());
    expect(first.evidence).toContainEqual(
      expect.objectContaining({ kind: "match", sessionId: CHAT, confidence: "strong", channel: "vscode:chat", cwd: "/Users/me/shop" }),
    );
    // In flight as of the last save.
    expect(first.evidence).toContainEqual(expect.objectContaining({ kind: "working", sessionId: CHAT }));
    // The earlier request is someone else's work; the last markdown is still being written.
    expect(kinds(first)).toEqual(["prompt.submit", "message", "tool.start", "tool.end"]);
    expect(first.events.find((event) => event.kind === "message")?.detail).toBe("Reading the note now.");
    expect(first.events.every((event) => event.cli === "vscode" && event.source === "chat")).toBe(true);
  });

  it("reads a part once something follows it, and the turn ending, without repeating anything", async () => {
    const dir = await userDir();
    const lines: Line[] = [
      snapshot([request(MARKED, T)]),
      { kind: 2, k: ["requests", 0, "response"], v: [markdown("Half a sen")] },
    ];
    const path = await writeChat(dir, lines);
    const observer = new VSCodeObserver(dir, join(dir, "copilot"));
    const r = run();
    expect(kinds(await observer.poll(r, new Date(T + 1_000).toISOString()))).toEqual(["prompt.submit"]);

    lines.push(
      { kind: 2, k: ["requests", 0, "response"], i: 0, v: [markdown(`Half a sentence, then done.\n\nANTHILL-STEP ${RUN_ID} ${NONCE} n2`)] },
      { kind: 1, k: ["requests", 0, "modelState"], v: { value: 1, completedAt: T + 20_000 } },
    );
    await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const second = await observer.poll({ ...r, detectedSessionId: CHAT }, new Date(T + 21_000).toISOString());
    expect(kinds(second)).toEqual(["step.marker", "message", "turn.end"]);
    expect(second.events[0]).toMatchObject({ blockId: "n2" });
    expect(second.evidence).toContainEqual(expect.objectContaining({ kind: "activity", sessionId: CHAT }));

    // VS Code compacts the log into one snapshot. Same chat, nothing new.
    const compacted = replayChatLog(lines.map((line) => JSON.stringify(line)).join("\n"));
    await writeFile(path, `${JSON.stringify({ kind: 0, v: compacted })}\n`);
    const third = await observer.poll({ ...r, detectedSessionId: CHAT }, new Date(T + 22_000).toISOString());
    expect(third.events).toEqual([]);
  });

  it("calls a finished chat done only after it has been quiet", async () => {
    const dir = await userDir();
    await writeChat(dir, [snapshot([request(MARKED, T, { modelState: { value: 1, completedAt: T + 1_000 } })])]);
    const observer = new VSCodeObserver(dir, join(dir, "copilot"));
    const r = { ...run(), detectedSessionId: CHAT };
    expect((await observer.poll(r, new Date(T + 60_000).toISOString())).evidence.map((item) => item.kind)).not.toContain("completed");
    expect((await observer.poll(r, new Date(T + 7 * 60_000).toISOString())).evidence.map((item) => item.kind)).toContain("completed");
  });

  it.each([
    [{ value: 2, completedAt: T + 1_000 }, "interrupted"],
    [{ value: 3, completedAt: T + 1_000 }, "failed"],
    [{ value: 4 }, "awaiting"],
  ])("says what the last request's state %o means", async (modelState, kind) => {
    const dir = await userDir();
    await writeChat(dir, [
      snapshot([request(MARKED, T, { modelState, result: { errorDetails: { message: "Rate limited." } } })]),
    ]);
    const evidence = (await new VSCodeObserver(dir, join(dir, "copilot")).poll(run(), new Date(T + 2_000).toISOString())).evidence;
    expect(evidence).toContainEqual(expect.objectContaining({ kind, sessionId: CHAT }));
    if (kind === "failed") expect(evidence).toContainEqual(expect.objectContaining({ detail: "Rate limited." }));
  });

  it("finds a plugin handover's chat by the run's nonce, and follows it once the service has resolved it", async () => {
    const dir = await userDir();
    const bound = "vscode-0f7d4c2a-9b1e-4c33-8a5f-6d2e1b7c0a94";
    await writeChat(dir, [
      snapshot([request("/anthill:workflow watch fix the crash", T)]),
      {
        kind: 2,
        k: ["requests", 0, "response"],
        v: [
          markdown("Composing the workflow."),
          { kind: "toolInvocationSerialized", toolId: "mcp_anthill_bind_run", toolCallId: "call_bind", isConfirmed: { type: 1 }, resultDetails: { output: [{ type: "embed", isText: true, value: `runId ${RUN_ID} nonce ${NONCE}` }], isError: false } },
          terminal(`anthill run ${RUN_ID} ${NONCE}`, 0, T + 1_000),
          terminal("npm test", 1, T + 2_000),
          markdown("Tests fail; fixing."),
        ],
      },
    ]);
    const observer = new VSCodeObserver(dir, join(dir, "copilot"));
    // Under the id the plugin made, no chat is that one yet.
    expect(await observer.poll(run(bound), new Date(T + 3_000).toISOString())).toEqual({ events: [], evidence: [] });
    expect(await observer.locate(run(bound))).toBe(CHAT);

    const result = await new VSCodeObserver(dir, join(dir, "copilot")).poll(run(bound, CHAT), new Date(T + 3_000).toISOString());
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: "match", sessionId: CHAT }));
    expect(result.events.every((event) => event.sessionId === CHAT)).toBe(true);
    // From the bind on; the composing before it is not the run.
    expect(result.events.map((event) => [event.kind, event.toolName])).toEqual([
      ["tool.start", "mcp_anthill_bind_run"],
      ["tool.end", undefined],
      ["tool.start", "run_in_terminal"],
      ["tool.end", undefined],
      ["tool.start", "run_in_terminal"],
      ["tool.end", undefined],
    ]);
    expect(result.events.filter((event) => event.kind === "tool.end").map((event) => event.ok)).toEqual([true, true, false]);
  });

  it("does not take a pasted marker for a bound run, nor a nonce for a pasted one", async () => {
    const dir = await userDir();
    await writeChat(dir, [snapshot([request(MARKED, T)])]);
    expect(await new VSCodeObserver(dir, join(dir, "copilot")).locate(run("vscode-x"))).toBeUndefined();
    expect((await new VSCodeObserver(dir, join(dir, "copilot")).poll(run("vscode-x", CHAT), new Date(T + 1_000).toISOString())).evidence).toEqual([]);
  });

  it("follows one chat saved under two workspace folders as one", async () => {
    const dir = await userDir();
    const lines = [snapshot([request(MARKED, T)])];
    await writeChat(dir, lines, "first");
    await writeChat(dir, lines, "second");
    const evidence = (await new VSCodeObserver(dir, join(dir, "copilot")).poll(run(), new Date(T + 1_000).toISOString())).evidence;
    expect(evidence.map((item) => item.kind)).not.toContain("ambiguous");
    expect(evidence).toContainEqual(expect.objectContaining({ kind: "match", sessionId: CHAT }));
  });

  it("never reads the model's thinking", async () => {
    const dir = await userDir();
    await writeChat(dir, [
      snapshot([request(MARKED, T, { modelState: { value: 1, completedAt: T + 1_000 } })]),
      { kind: 2, k: ["requests", 0, "response"], v: [{ kind: "thinking", value: `ANTHILL-STEP ${RUN_ID} ${NONCE} n9 secret plan` }] },
    ]);
    const result = await new VSCodeObserver(dir, join(dir, "copilot")).poll(run(), new Date(T + 2_000).toISOString());
    expect(kinds(result)).toEqual(["prompt.submit", "turn.end"]);
  });

  it("has nothing to say before VS Code has saved a chat", async () => {
    const result = await new VSCodeObserver(join(await userDir(), "nowhere"), join(await userDir(), "nowhere")).poll(run(), new Date(T).toISOString());
    expect(result).toEqual({ events: [], evidence: [] });
  });
});

describe("Anthill's own tools, as VS Code names them", () => {
  it("are recognised so they do not count as work", () => {
    expect(isAnthillTool("mcp_anthill_bind_run")).toBe(true);
    expect(isAnthillTool("mcp_anthill2_get_workflow")).toBe(true);
    expect(isAnthillTool("mcp_github_create_issue")).toBe(false);
    expect(isAnthillTool("run_in_terminal")).toBe(false);
  });
});

/*
  VS Code 1.140 runs an Agent-mode chat in the Agent Host's Copilot harness by
  default, and the record is the Copilot CLI's own:
  ~/.copilot/session-state/<id>/events.jsonl, written as it happens. These
  lines follow a real session's shape.
*/
describe("the VS Code observer, on the Copilot harness's session state", () => {
  const SESSION = "5de3f494-9449-4832-8043-d1219850b9c3";
  const at = (ms: number) => new Date(T + ms).toISOString();
  const line = (type: string, data: Record<string, unknown>, ms: number) =>
    JSON.stringify({ type, data, id: `${type}-${ms}`, timestamp: at(ms), parentId: null });

  async function copilotSession(root: string, lines: string[]): Promise<string> {
    const dir = join(root, SESSION);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspace.yaml"), `id: ${SESSION}\ncwd: /Users/me/shop\nclient_name: vscode-agent-host\n`);
    const path = join(dir, "events.jsonl");
    await writeFile(path, lines.join("\n") + "\n");
    return path;
  }

  it("finds a pasted prompt by its marker and follows the session as it is written", async () => {
    const dir = await userDir();
    const root = join(dir, "copilot");
    await copilotSession(root, [
      line("session.start", { sessionId: SESSION, context: { cwd: "/Users/me/shop" } }, 0),
      line("user.message", { content: MARKED }, 10),
      line("assistant.turn_start", { turnId: "0" }, 20),
      line("assistant.message", {
        content: `Reading the note.\n\nANTHILL-STEP ${RUN_ID} ${NONCE} n1`,
        reasoningOpaque: "SECRET_REASONING",
        encryptedContent: "SECRET_REASONING",
      }, 30),
      line("tool.execution_start", { toolCallId: "call_1", toolName: "bash", arguments: { command: "cat note.txt" } }, 40),
    ]);
    const observer = new VSCodeObserver(join(dir, "nowhere"), root);

    const first = await observer.poll(run(), at(50));
    expect(first.evidence).toContainEqual(expect.objectContaining({ kind: "match", sessionId: SESSION, channel: "vscode:copilot", cwd: "/Users/me/shop" }));
    expect(first.evidence).toContainEqual(expect.objectContaining({ kind: "working", sessionId: SESSION }));
    expect(kinds(first)).toEqual(["prompt.submit", "step.marker", "message", "tool.start"]);
    expect(JSON.stringify(first)).not.toContain("SECRET_REASONING");
    expect(JSON.stringify(first)).not.toContain("cat note.txt");
  });

  it("says when the person is being asked, and calls a finished session done only after it is quiet", async () => {
    const dir = await userDir();
    const root = join(dir, "copilot");
    const path = await copilotSession(root, [
      line("user.message", { content: MARKED }, 0),
      line("assistant.turn_start", { turnId: "0" }, 10),
      line("permission.requested", { requestId: "p1" }, 20),
    ]);
    const observer = new VSCodeObserver(join(dir, "nowhere"), root);
    const r = run();
    expect((await observer.poll(r, at(30))).evidence).toContainEqual(expect.objectContaining({ kind: "awaiting", sessionId: SESSION }));

    await writeFile(path, [
      line("user.message", { content: MARKED }, 0),
      line("assistant.turn_start", { turnId: "0" }, 10),
      line("permission.requested", { requestId: "p1" }, 20),
      line("permission.completed", { requestId: "p1" }, 25),
      line("tool.execution_start", { toolCallId: "c1", toolName: "bash" }, 26),
      line("tool.execution_complete", { toolCallId: "c1", success: false }, 27),
      line("assistant.turn_end", { turnId: "0" }, 28),
    ].join("\n") + "\n");
    const seen = { ...r, detectedSessionId: SESSION };
    const second = await observer.poll(seen, at(40));
    expect(second.events.filter((event) => event.kind === "tool.end").map((event) => event.ok)).toEqual([false]);
    expect(second.evidence.map((item) => item.kind)).not.toContain("completed");
    expect((await observer.poll(seen, at(7 * 60_000))).evidence.map((item) => item.kind)).toContain("completed");
  });

  it("finds a plugin handover's session by the run's nonce, and follows it once resolved", async () => {
    const dir = await userDir();
    const root = join(dir, "copilot");
    await copilotSession(root, [
      line("user.message", { content: "/anthill:workflow watch fix it" }, 0),
      line("tool.execution_start", { toolCallId: "c0", toolName: "bash", arguments: { command: "ls" } }, 5),
      line("tool.execution_start", { toolCallId: "c1", toolName: "bash", arguments: { command: `anthill run ${RUN_ID} ${NONCE}` } }, 10),
      line("tool.execution_complete", { toolCallId: "c1", success: true }, 11),
    ]);
    const observer = new VSCodeObserver(join(dir, "nowhere"), root);
    const bound = "vscode-0f7d4c2a-9b1e-4c33-8a5f-6d2e1b7c0a94";
    expect(await observer.poll(run(bound), at(20))).toEqual({ events: [], evidence: [] });
    expect(await observer.locate(run(bound))).toBe(SESSION);

    const followed = await new VSCodeObserver(join(dir, "nowhere"), root).poll(run(bound, SESSION), at(20));
    expect(followed.evidence).toContainEqual(expect.objectContaining({ kind: "match", sessionId: SESSION }));
    // From the bind on: the earlier `ls` is not this run's.
    expect(followed.events.map((event) => [event.kind, event.toolUseId])).toEqual([["tool.start", "c1"], ["tool.end", "c1"]]);
  });
});
