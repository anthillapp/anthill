/**
 * The one test that proves the wiring.
 *
 * Everything else in this package is exercised by calling a handler directly,
 * which says nothing about whether the tools are registered, whether the
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
 *
 * It is also the only place that can see the two things a harness judges this
 * server by and a handler test cannot: the schema the tools advertise, and what
 * the process leaves behind when it stops.
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
  /** Everything the server has said on stderr, which is the only place it may. */
  stderr = "";

  private readonly pending = new Map<number, (response: Response) => void>();
  private buffer = "";
  private id = 0;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.take(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  /** Put a line on stdin as it stands, JSON-RPC or not. */
  write(line: string): void {
    this.child.stdin.write(line);
  }

  /** Close stdin and answer with the code the process ends on. */
  async end(): Promise<number | null> {
    const exited = new Promise<number | null>((resolve) => {
      this.child.on("exit", (code) => resolve(code));
    });
    this.child.stdin.end();
    return exited;
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
  it("announces every tool and the handover sequence", async () => {
    const session = await connect();

    const listed = await session.request("tools/list");
    const tools = (listed.result?.tools ?? []) as { name: string }[];

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bind_run",
      "create_workflow_draft",
      "get_ready_revision",
      "get_workflow",
      "revise_workflow",
    ]);
  }, 20_000);

  it("names the keys a call carries and asks the SDK for none of them", async () => {
    const session = await connect();

    const listed = await session.request("tools/list");
    const tools = (listed.result?.tools ?? []) as {
      name: string;
      inputSchema: {
        required?: string[];
        properties: Record<
          string,
          { type?: string; description?: string; required?: string[]; properties?: object }
        >;
      };
    }[];
    const schema = tools.find((tool) => tool.name === "create_workflow_draft")?.inputSchema;
    const bind = tools.find((tool) => tool.name === "bind_run")?.inputSchema;

    // Nothing is required and nothing on the envelope is typed, because the
    // SDK validates this schema inside the try block that turns a failure into
    // `isError: true`: whatever it refuses — a field of the wrong kind or a
    // field that never arrived — reaches the model as an apparent crash, and
    // the handler's answer for it becomes unreachable.
    expect(schema?.required ?? []).toEqual([]);
    expect(bind?.required ?? []).toEqual([]);
    expect(schema?.properties.idempotencyKey.type).toBeUndefined();
    expect(schema?.properties.mode.type).toBeUndefined();
    expect(bind?.properties.revision.type).toBeUndefined();
    expect(bind?.properties.workflowId.type).toBeUndefined();

    // What a call is actually refused without is still advertised — in the
    // descriptions, which reach the model, and in `source`'s shape, which is
    // the only place its three fields are described at all.
    expect(Object.keys(schema?.properties.source.properties ?? {})).toEqual([
      "harness",
      "sessionId",
      "taskText",
    ]);
    expect(schema?.properties.source.description).toContain("harness, sessionId and taskText");
    expect(bind?.properties.revision.description).toContain("every bind needs");
  }, 20_000);

  it("answers for a field that never arrived, rather than letting the SDK answer", async () => {
    const session = await connect();

    // Every one of these used to come back as `isError: true` with a zod
    // sentence naming `nonoptional`, which is the shape a refusal must never
    // take: the model cannot tell it from the server having fallen over, and
    // the handler that knows how to say which field is missing never ran.
    for (const [tool, args, field] of [
      ["get_workflow", {}, "workflowId"],
      ["get_ready_revision", {}, "workflowId"],
      ["bind_run", { revision: 1, digest: "0123456789abcdef", idempotencyKey: "k" }, "workflowId"],
      ["bind_run", { workflowId: "w", digest: "0123456789abcdef", idempotencyKey: "k" }, "revision"],
      [
        "create_workflow_draft",
        { idempotencyKey: "k", mode: "show-and-go", workflow: {} },
        "source",
      ],
      [
        "create_workflow_draft",
        {
          idempotencyKey: "k", mode: "show-and-go", workflow: {},
          source: { harness: "claude-code", sessionId: "session-abc" },
        },
        "source.taskText",
      ],
    ] as const) {
      const called = await session.request("tools/call", { name: tool, arguments: args });
      const result = called.result as {
        content: { type: string; text: string }[];
        structuredContent: { outcome: string; problems: { field?: string }[] };
        isError?: boolean;
      };
      const where = `${tool} ${JSON.stringify(args)}`;

      expect(called.error, where).toBeUndefined();
      expect(result.isError, where).toBeUndefined();
      expect(result.structuredContent.outcome, where).toBe("invalid");
      expect(result.structuredContent.problems.map((problem) => problem.field), where).toContain(field);
      expect(result.content[0].text, where).toContain(field);
    }
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

  it("refuses a misshapen handover as an answer rather than as a crash", async () => {
    const session = await connect();

    const called = await session.request("tools/call", {
      name: "create_workflow_draft",
      arguments: {
        idempotencyKey: 7,
        mode: "whenever-you-like",
        source: { harness: "borg", sessionId: "sess/1", taskText: "Fix it." },
        workflow: { id: "workflow-1" },
      },
    });

    const result = called.result as {
      content: { type: string; text: string }[];
      structuredContent: { outcome: string; problems: { field?: string }[] };
      isError?: boolean;
    };

    // Every one of these fields is the wrong kind of thing, and the schema
    // declares none of their types — so they reach the handler, which answers
    // with all four problems at once instead of the SDK answering with one
    // zod sentence and `isError`.
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.outcome).toBe("invalid");
    expect(result.structuredContent.problems.map((problem) => problem.field)).toEqual(
      expect.arrayContaining([
        "idempotencyKey",
        "mode",
        "source.harness",
        "source.sessionId",
      ]),
    );
  }, 20_000);

  it("refuses a malformed bind as an answer rather than as a crash", async () => {
    const session = await connect();

    // Every one of these is a value the handler has a sentence for. They used
    // to be refused by the tool's input schema instead, which the SDK
    // validates inside the try block that turns a failure into `isError`, so
    // the caller got a zod message with no `outcome` and no way to tell a
    // refusal from the server falling over.
    for (const malformed of [
      { revision: 0 }, { revision: "1" }, { revision: 1.5 },
      { digest: "" }, { idempotencyKey: "" }, { sessionId: 7 },
    ]) {
      const called = await session.request("tools/call", {
        name: "bind_run",
        arguments: {
          workflowId: "never-handed-over", revision: 1, digest: "0123456789abcdef",
          idempotencyKey: "binding", ...malformed,
        },
      });
      const result = called.result as { structuredContent: { outcome: string }; isError?: boolean };
      const where = JSON.stringify(malformed);

      expect(called.error, where).toBeUndefined();
      expect(result.isError, where).toBeUndefined();
      expect(result.structuredContent.outcome, where).toBe("invalid");
    }
  }, 20_000);

  it("says on stderr that the connection failed, and does not end as though it had not", async () => {
    const session = await connect();

    // A line the transport cannot read. Nothing is ever answered for it, so
    // the only way it can be reported is on stderr and in the exit code —
    // which is exactly why it used to go unreported.
    session.write("this is not a JSON-RPC message\n");
    const code = await session.end();

    expect(session.stderr).toContain("the connection to the harness failed");
    expect(code).not.toBe(0);
  }, 20_000);
});
