import {
  ACP_NOT_IMPLEMENTED_ERROR,
  ACP_NOT_IMPLEMENTED_REASON,
} from "./codex-acp-runtime.js";
import type {
  AgentRunContext,
  AgentRuntime,
  AgentRuntimeResult,
  RuntimeDetection,
} from "./contracts.js";

/**
 * INTENTIONALLY UNIMPLEMENTED.
 *
 * The Claude Code counterpart of `CodexAcpRuntime`. Anthill will eventually
 * drive Claude Code over an ACP/MCP bridge rather than the CLI, but no
 * ACP/MCP client is available here yet, so `detect()` reports the runtime as
 * unavailable and `run()` throws.
 *
 * Do not add a fake success path here. When a real client lands, implement it
 * against that client and delete this comment.
 */
export class ClaudeCodeAcpRuntime implements AgentRuntime {
  readonly id = "claude-code-acp";
  readonly displayName = "Claude Code (ACP/MCP bridge)";

  async detect(): Promise<RuntimeDetection> {
    return { available: false, reason: ACP_NOT_IMPLEMENTED_REASON };
  }

  async run(_context: AgentRunContext, _signal?: AbortSignal): Promise<AgentRuntimeResult> {
    throw new Error(ACP_NOT_IMPLEMENTED_ERROR);
  }
}
