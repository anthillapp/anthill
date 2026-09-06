import { describe, expect, it } from "vitest";
import type { AgentRuntime, AgentRuntimeResult } from "@anthill/runtimes";
import type { AgentResult } from "@anthill/workflow-schema";
import { adaptAgentRuntime } from "./runtime-adapter.js";
import type { RuntimeRunContext } from "./contracts.js";

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    status: "success",
    summary: "done",
    artifacts: [],
    issues: [],
    metadata: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<RuntimeRunContext> = {}): RuntimeRunContext {
  return {
    runId: "run-1",
    nodeId: "node-1",
    attempt: 1,
    workflow: { id: "wf-1", name: "wf", version: "1", nodes: [], edges: [] },
    node: {
      id: "node-1",
      type: "agent",
      name: "Developer",
      config: {},
    },
    inputs: {},
    priorResults: {},
    instructions: "implement the feature",
    ...overrides,
  };
}

describe("adaptAgentRuntime", () => {
  it("unwraps AgentRuntimeResult.result into a bare AgentResult", async () => {
    const raw: AgentRuntimeResult = {
      result: makeResult({ summary: "implemented" }),
      raw: { stdout: "ok", exitCode: 0 },
    };
    const runtime: AgentRuntime = {
      id: "codex-cli",
      displayName: "Codex CLI",
      detect: async () => ({ available: true }),
      run: async () => raw,
    };

    const port = adaptAgentRuntime(runtime);
    const result = await port.run(makeContext());

    expect(result).toEqual(raw.result);
    expect(port.id).toBe("codex-cli");
  });

  it("maps node.config.workingDirectory and node.config.role onto AgentRunContext", async () => {
    let seen: unknown;
    const runtime: AgentRuntime = {
      id: "claude-code",
      displayName: "Claude Code",
      detect: async () => ({ available: true }),
      run: async (ctx) => {
        seen = ctx;
        return { result: makeResult(), raw: {} };
      },
    };

    const port = adaptAgentRuntime(runtime);
    await port.run(
      makeContext({
        node: {
          id: "node-1",
          type: "agent",
          name: "Developer",
          config: { workingDirectory: "/repo", role: "developer" },
        },
        priorResults: { architect: makeResult({ summary: "workflow ready" }) },
      }),
    );

    expect(seen).toMatchObject({
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      workingDirectory: "/repo",
      role: "developer",
      instructions: "implement the feature",
      priorResults: { architect: { summary: "workflow ready" } },
    });
  });

  it("falls back to process.cwd() and the node name when config omits workingDirectory/role", async () => {
    let seen: { workingDirectory?: string; role?: string } | undefined;
    const runtime: AgentRuntime = {
      id: "custom",
      displayName: "Custom",
      detect: async () => ({ available: true }),
      run: async (ctx) => {
        seen = ctx;
        return { result: makeResult(), raw: {} };
      },
    };

    await adaptAgentRuntime(runtime).run(makeContext());

    expect(seen?.workingDirectory).toBe(process.cwd());
    expect(seen?.role).toBe("Developer");
  });
});
