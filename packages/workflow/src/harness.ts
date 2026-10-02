/**
 * What each supported harness offers.
 *
 * The target is chosen once per diagram and decides which models the block
 * editor lists and where generated agent files are written. Keeping this in one
 * table means adding a harness is a data change, not a code change.
 */

import type { HarnessTarget } from "@anthill/workflow-schema";

export type ModelOption = {
  /** Value written into the generated agent file's `model` field. */
  id: string;
  label: string;
  /** Shown under the label in the picker. */
  hint?: string;
};

export type HarnessProfile = {
  target: HarnessTarget;
  displayName: string;
  /**
   * The models this table knows about.
   *
   * Empty for a harness whose models are discovered on the machine rather than
   * declared here — see `modelsAreDeclared`. A pure package cannot read the
   * author's disk, and a hand-kept copy of somebody else's model list is stale
   * the day it is written.
   */
  models: ModelOption[];
  /**
   * Whether `models` is the whole truth.
   *
   * When false, a name missing from it means "this table does not know", never
   * "that model does not exist" — so nothing may reject a stored answer on the
   * strength of it, and nothing may attribute a bare name to this harness.
   */
  modelsAreDeclared: boolean;
  /** Model used when a block does not choose one. */
  defaultModel: string;
  /** Whether this harness has a separate reasoning-effort setting. */
  supportsReasoningEffort: boolean;
  /**
   * Directory, relative to the repository root, that generated agent files go
   * into. `undefined` means the harness has no subagent concept, so blocks are
   * inlined into the prompt instead of becoming files.
   */
  agentDir?: string;
  /** How an agent file is written. Each harness reads its own format. */
  agentFileFormat?: "markdown" | "toml";
  /** False when per-block models cannot be honoured — the UI must say so. */
  supportsPerAgentModel: boolean;
  /**
   * Whether Anthill installs Live hooks for this harness. Without them it
   * reads only the session records the harness writes for itself, which needs
   * nothing installed.
   */
  liveHooks: boolean;
};

const CLAUDE_CODE: HarnessProfile = {
  target: "claude-code",
  displayName: "Claude Code",
  models: [
    // Claude Code's own aliases, the same words `claude --model` takes; the
    // CLI resolves each to the current model of that name (ANT-68).
    { id: "fable", label: "Fable", hint: "Most capable, for the hardest steps" },
    { id: "opus", label: "Opus", hint: "Deepest reasoning, slowest" },
    { id: "sonnet", label: "Sonnet", hint: "Balanced – a good default" },
    { id: "haiku", label: "Haiku", hint: "Fastest, for simple steps" },
    { id: "inherit", label: "Inherit", hint: "Use the main session's model" },
  ],
  modelsAreDeclared: true,
  defaultModel: "sonnet",
  supportsReasoningEffort: false,
  agentDir: ".claude/agents",
  agentFileFormat: "markdown",
  supportsPerAgentModel: true,
  liveHooks: true,
};

/**
 * Codex, with project-scoped custom agents.
 *
 * This entry used to say Codex had no subagent concept and no per-agent model,
 * so every block was inlined into one prompt and the model picker was disabled.
 * That was a fact about Anthill, not about Codex: local Codex reads custom
 * agents from `.codex/agents/*.toml`, and each one may set its own `model` and
 * `model_reasoning_effort` or inherit them from the session that spawned it.
 *
 * Its models are *discovered*, not declared. Codex maintains its own catalogue
 * on the machine, and a copy pasted into this table would be a guess about
 * somebody else's product that goes stale on their release schedule — so the
 * list stays empty here and the app reads the real one. Nothing may treat a
 * name missing from an empty list as a name that does not exist.
 */
const CODEX: HarnessProfile = {
  target: "codex",
  displayName: "OpenAI Codex CLI",
  models: [],
  modelsAreDeclared: false,
  // What a Codex agent file that names no model gets: the model of the session
  // that spawned it. Anthill cannot know what that is, and says so rather than
  // naming one.
  defaultModel: "the session's model",
  supportsReasoningEffort: true,
  agentDir: ".codex/agents",
  agentFileFormat: "toml",
  supportsPerAgentModel: true,
  liveHooks: true,
};

/**
 * pi, the pi.dev coding agent.
 *
 * Its models are *discovered*, not declared: pi maintains its own catalogue on
 * the machine (`pi --list-models`), and a copy pasted into this table would be
 * a guess about somebody else's product that goes stale on their release
 * schedule — so the list stays empty here and the app reads the real one.
 *
 * pi has no subagent-file concept the way Claude Code (`.claude/agents/*.md`)
 * and Codex (`.codex/agents/*.toml`) do: it extends the model with skills,
 * prompt templates and pi packages rather than per-agent model files. So blocks
 * are inlined into the prompt and the per-agent model is not honoured, the same
 * way it was before Codex's agent files were found.
 *
 * It does have a separate reasoning-effort setting (`--thinking <level>`), so
 * that flag is offered.
 */
const PI: HarnessProfile = {
  target: "pi",
  displayName: "Pi",
  models: [],
  modelsAreDeclared: false,
  // What a pi invocation that names no model gets: the model of the session
  // that spawned it. Anthill cannot know what that is, and says so rather than
  // naming one.
  defaultModel: "the session's model",
  supportsReasoningEffort: true,
  supportsPerAgentModel: false,
  // pi's hooks are TypeScript extensions it loads itself; there is no config to write.
  liveHooks: false,
};

/**
 * VS Code's own agents: Copilot agent mode, and the Copilot CLI harness it can
 * run in its place.
 *
 * Models are the user's to pick in VS Code's model picker, from whatever their
 * Copilot plan and their own keys offer, and nothing on disk lists them for
 * Anthill to read — so none is declared here, and a step runs on the model of
 * the session.
 *
 * VS Code does have custom agents (`.github/agents/*.agent.md`, each with an
 * optional `model`), but this first version inlines blocks into the prompt, as
 * for pi, and does not honour a per-agent model. Saying so is better than
 * writing files whose model VS Code may resolve to something nobody chose.
 */
const VSCODE: HarnessProfile = {
  target: "vscode",
  displayName: "VS Code",
  models: [],
  modelsAreDeclared: false,
  defaultModel: "the session's model",
  supportsReasoningEffort: false,
  supportsPerAgentModel: false,
  // `~/.copilot/hooks/anthill.json`, which VS Code's agent reads by default.
  liveHooks: true,
};

export const HARNESS_PROFILES: Record<HarnessTarget, HarnessProfile> = {
  "claude-code": CLAUDE_CODE,
  codex: CODEX,
  pi: PI,
  vscode: VSCODE,
};

export function harnessProfile(target: HarnessTarget): HarnessProfile {
  return HARNESS_PROFILES[target];
}

/** The default target for a new diagram. */
export const DEFAULT_TARGET: HarnessTarget = "claude-code";
