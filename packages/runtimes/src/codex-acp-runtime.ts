import type {
  AgentRunContext,
  AgentRuntime,
  AgentRuntimeResult,
  RuntimeDetection,
} from "./contracts.js";

export const ACP_NOT_IMPLEMENTED_REASON = "ACP/MCP bridge not yet implemented";
export const ACP_NOT_IMPLEMENTED_ERROR = "ACP/MCP bridge runtime is not yet implemented";

/**
 * INTENTIONALLY UNIMPLEMENTED.
 *
 * Anthill will eventually talk to Codex over an ACP/MCP bridge instead of
 * shelling out to the CLI, which would give it streaming progress, tool-call
 * visibility and structured results. No ACP/MCP client exists in this codebase
 * yet, so this class is an honest placeholder: `detect()` always reports the
 * runtime as unavailable and `run()` throws.
 *
 * Do not add a fake success path here. When a real client lands, implement it
 * against that client and delete this comment.
 */
export class CodexAcpRuntime implements AgentRuntime {
  readonly id = "codex-acp";
  readonly displayName = "OpenAI Codex (ACP/MCP bridge)";

  async detect(): Promise<RuntimeDetection> {
    return { available: false, reason: ACP_NOT_IMPLEMENTED_REASON };
  }

  async run(_context: AgentRunContext, _signal?: AbortSignal): Promise<AgentRuntimeResult> {
    throw new Error(ACP_NOT_IMPLEMENTED_ERROR);
  }
}
