import { describe, expect, it } from "vitest";
import { ClaudeCodeAcpRuntime } from "./claude-code-acp-runtime.js";
import { CodexAcpRuntime } from "./codex-acp-runtime.js";
import type { AgentRunContext, AgentRuntime } from "./contracts.js";

const ctx: AgentRunContext = {
  runId: "run-1",
  nodeId: "node-1",
  attempt: 1,
  workingDirectory: "/tmp/anthill-workspace",
  instructions: "Do the thing.",
  role: "Doer",
};

const placeholders: Array<[string, AgentRuntime]> = [
  ["CodexAcpRuntime", new CodexAcpRuntime()],
  ["ClaudeCodeAcpRuntime", new ClaudeCodeAcpRuntime()],
];

describe.each(placeholders)("%s (intentionally unimplemented)", (_name, runtime) => {
  it("has a stable id and display name", () => {
    expect(runtime.id).toMatch(/-acp$/);
    expect(runtime.displayName).toContain("ACP/MCP bridge");
  });

  it("detects as unavailable with an honest reason", async () => {
    await expect(runtime.detect()).resolves.toEqual({
      available: false,
      reason: "ACP/MCP bridge not yet implemented",
    });
  });

  it("throws rather than fabricating a result", async () => {
    await expect(runtime.run(ctx)).rejects.toThrow(
      "ACP/MCP bridge runtime is not yet implemented",
    );
  });
});
