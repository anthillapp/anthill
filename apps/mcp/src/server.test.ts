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

  it("asks for the three things it refuses a handover without", async () => {
    const session = await connect();

    const listed = await session.request("tools/list");
    const tools = (listed.result?.tools ?? []) as {
      name: string;
      inputSchema: {
        required?: string[];
        properties: Record<string, { type?: string; required?: string[] }>;
      };
    }[];
    const schema = tools.find((tool) => tool.name === "create_workflow_draft")?.inputSchema;

    // The schema a harness reads has to be the one the server enforces. These
    // three were advertised as optional while a submission missing any of them
    // was refused, which is a contract that teaches the caller the wrong thing
    // and then punishes it for having learnt.
    expect(schema?.properties.source.required).toEqual(["harness", "sessionId", "taskText"]);
    expect(schema?.required).toEqual(
      expect.arrayContaining(["idempotencyKey", "mode", "source", "workflow"]),
    );

    // And no declared types on the envelope, which is the other half of the
    // same contract: what is in these fields is judged where an answer can
    // carry the question to put to the user.
    expect(schema?.properties.idempotencyKey.type).toBeUndefined();
    expect(schema?.properties.mode.type).toBeUndefined();
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
