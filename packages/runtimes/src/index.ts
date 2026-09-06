export const PACKAGE_NAME = "@anthill/runtimes";

// Contracts (locally mirrored from @anthill/workflow-schema — see contracts.ts).
export {
  AGENT_RESULT_STATUSES,
  DEFAULT_TIMEOUT_MS,
  ISSUE_SEVERITIES,
  type AgentResult,
  type AgentResultStatus,
  type AgentRunContext,
  type AgentRuntime,
  type AgentRuntimeResult,
  type Artifact,
  type Issue,
  type IssueSeverity,
  type RuntimeDetection,
} from "./contracts.js";

// Prompt construction.
export { buildPromptEnvelope } from "./prompt-envelope.js";

// Output normalization.
export {
  coerceAgentResult,
  extractAgentResult,
  normalizeProcessOutput,
  type NormalizeOptions,
  type ProcessOutput,
} from "./normalize-output.js";

// Process plumbing (exported so adapters outside this package can reuse it).
export {
  defaultSpawn,
  runProcess,
  type ChildProcessLike,
  type ProcessOutcome,
  type ReadableLike,
  type RunProcessOptions,
  type SpawnFn,
  type SpawnOptionsLike,
  type WritableLike,
} from "./process-runner.js";
export { detectBinary, type DetectBinaryOptions } from "./detect-binary.js";

// Adapters.
export {
  CustomCommandRuntime,
  type CustomCommandRuntimeConfig,
} from "./custom-command-runtime.js";
export {
  CODEX_DEFAULT_COMMAND,
  CodexCliRuntime,
  buildCodexArgs,
  type CodexCliRuntimeConfig,
} from "./codex-cli-runtime.js";
export {
  CLAUDE_DEFAULT_COMMAND,
  ClaudeCodeRuntime,
  buildClaudeArgs,
  type ClaudeCodeRuntimeConfig,
} from "./claude-code-runtime.js";

// Honest, intentionally unimplemented ACP/MCP bridge placeholders.
export {
  ACP_NOT_IMPLEMENTED_ERROR,
  ACP_NOT_IMPLEMENTED_REASON,
  CodexAcpRuntime,
} from "./codex-acp-runtime.js";
export { ClaudeCodeAcpRuntime } from "./claude-code-acp-runtime.js";
