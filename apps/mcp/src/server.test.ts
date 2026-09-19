/**
 * The one test that proves the wiring.
 *
 * Everything else in this package is exercised by calling a handler directly,
 * which says nothing about whether the four tools are registered, whether the
 * built file starts when Node is pointed at it, or whether what comes out of its
 * stdout is JSON-RPC. Those are exactly the things that break silently — a
 * server whose tools never registered answers `tools/list` with an empty array
 * and looks perfectly healthy.
 *
 * So this spawns the built server as a harness would, writes newline-delimited
 * JSON-RPC at its stdin by hand, and reads what comes back. The messages are
 * hand-written rather than sent through the SDK's own client on purpose: a
 * client from the same package as the server would agree with it about a wire
 * format neither of them had got right.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_FORMAT_VERSION } from "@anthill/workflow-exchange";

/** The compiled server, which is what a harness is configured to run. */
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

type Response = { id: number; result?: Record<string, unknown>; error?: { message: string } };

/** A harness's half of the conversation: write a line, wait for the line with that id. */
class Session {
  private readonly pending = new Map<number, (response: Response) => void>();
  private buffer = "";
  private id = 0;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.take(chunk));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Response> {
    const id = (this.id += 1);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private take(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;

      // Anything unparseable on this stream means something in the server
      // wrote to stdout, which the transport owns. It is worth failing loudly
      // on, because the symptom otherwise is a protocol error far from here.
      const message = JSON.parse(line) as Response;
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    }
  }
}

const started: ChildProcessWithoutNullStreams[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) child.kill();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function connect(): Promise<Session> {
  const dataDir = await mkdtemp(join(tmpdir(), "anthill-mcp-e2e-"));
  roots.push(dataDir);

  const child = spawn(process.execPath, [SERVER, "--data-dir", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  started.push(child);

  const session = new Session(child);
  const initialized = await session.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "anthill-mcp-test", version: "0" },
  });
  expect(initialized.error).toBeUndefined();
  session.notify("notifications/initialized");
  return session;
}

describe("the built server over stdio", () => {
  it("creates, retrieves and idempotently binds the exact draft over JSON-RPC", async () => {
    const session = await connect();
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await session.request("tools/call", { name, arguments: args });
      expect(response.error).toBeUndefined();
      const result = response.result as {
        isError?: boolean;
        structuredContent: Record<string, unknown>;
        content: { type: string; text: string }[];
      };
      expect(result.isError).toBeUndefined();
      return result;
    };
    const workflow = {
      id: "stdio-workflow", name: "Verify handover", version: "1", target: "claude-code",
      brief: { goal: "Read the sample file", doneCriteria: ["Report the exact text"] },
      metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION,
        agents: [{ id: "reader", name: "Reader", models: { "claude-code": { id: "sonnet" } } }] } },
      nodes: [
        { id: "start", type: "start", name: "Start", config: {} },
        { id: "read", type: "agent", name: "Read", config: {
          agentId: "reader", actionKind: "agent-step", task: "Read sample.txt without changing it.",
          expectedOutput: "The file text", successCriteria: ["No writes"] } },
        { id: "end", type: "end", name: "End", config: {} },
      ],
      edges: [{ id: "a", source: "start", target: "read" }, { id: "b", source: "read", target: "end" }],
    };
    const draft = await call("create_workflow_draft", {
      idempotencyKey: "draft", mode: "show-and-go", workflow,
      source: { harness: "claude-code", sessionId: "local-session", taskText: "Read sample.txt" },
    });
    expect(draft.structuredContent).toMatchObject({ outcome: "created", displayed: false, displayRequested: true });
    const ready = await call("get_ready_revision", { workflowId: workflow.id });
    expect(ready.structuredContent.outcome).toBe("ready");
    const workflowText = ready.content[0].text.split("\n").find((line) => line.startsWith("{"));
    expect(JSON.parse(workflowText!)).toEqual(workflow);
    const request = { workflowId: workflow.id, revision: ready.structuredContent.revision,
      digest: ready.structuredContent.digest, idempotencyKey: "binding" };
    const first = await call("bind_run", request);
    const retry = await call("bind_run", request);
    expect(first.structuredContent).toMatchObject({ outcome: "bound", registered: false, registrationRequested: true });
    expect(retry.structuredContent).toMatchObject({ outcome: "already_bound",
      runId: first.structuredContent.runId, nonce: first.structuredContent.nonce, revision: 1 });
    const status = await call("get_workflow", { workflowId: workflow.id });
    expect(status.structuredContent.bindings).toHaveLength(1);
  }, 20_000);
  it("announces the four tools and the handover sequence", async () => {
    const session = await connect();

    const listed = await session.request("tools/list");
    const tools = (listed.result?.tools ?? []) as { name: string }[];

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bind_run",
      "create_workflow_draft",
      "get_ready_revision",
      "get_workflow",
    ]);
  }, 20_000);

  it("answers a tool call with prose and an outcome, over the wire", async () => {
    const session = await connect();

    const called = await session.request("tools/call", {
      name: "get_workflow",
      arguments: { workflowId: "never-handed-over" },
    });

    const result = called.result as {
      content: { type: string; text: string }[];
      structuredContent: { outcome: string };
      isError?: boolean;
    };

    // A workflow that is not there is an answer, not a fault: the model has to
    // be able to tell this apart from the server having fallen over.
    expect(called.error).toBeUndefined();
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.outcome).toBe("not_found");
    expect(result.content[0].text).toContain("never-handed-over");
  }, 20_000);
});
