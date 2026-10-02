/**
 * `@anthill/workflow` — turns a diagram into a prompt you can paste into a
 * coding agent, plus the subagent files that back it.
 *
 * Pure: no filesystem, no process spawning, no execution. Writing the files out
 * is the app shell's job.
 */

export const PACKAGE_NAME = "@anthill/workflow";

export { parallelPlan, type ParallelPlan } from "./parallel.js";

export {
  DEFAULT_TARGET,
  HARNESS_PROFILES,
  harnessProfile,
  type HarnessProfile,
  type ModelOption,
} from "./harness.js";

export {
  CHECKED_PLUGIN_HARNESSES,
  PLUGIN_HARNESSES,
  PLUGIN_HARNESS_INFO,
  isCheckedPluginHarness,
  isPluginHarness,
  type CheckedPluginHarness,
  type PluginHarness,
  type PluginHarnessInfo,
} from "./plugin-harness.js";

export {
  HARNESS_DEFAULT,
  configuredHarnesses,
  explicitModelFor,
  harnessOwningModel,
  isConfiguredFor,
  migrateModels,
  modelFor,
  readAgentModels,
  readModelChoice,
  reasoningEffortFor,
  type AgentModels,
  type HarnessModelChoice,
} from "./agent-models.js";

export {
  DEFAULT_MODEL_PREFERENCES,
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  applyTier,
  readModelPreferences,
  startingModels,
  tierOf,
  visibleModelIds,
  type ModelPreferences,
  type ModelTierId,
} from "./model-preferences.js";

export { tomlMultiline, tomlString, tomlTable } from "./toml.js";

export {
  DEFAULT_CONSTRAINTS,
  DEFAULT_REPORT_SECTIONS,
  resolveBrief,
  type ResolvedBrief,
} from "./brief.js";

export {
  WORKFLOW_FORMAT_VERSION,
  checkWorkflowCompatibility,
  migrateWorkflow,
  workflowFormatVersion,
  stampWorkflowFormat,
  type WorkflowCompatibility,
  type WorkflowMigration,
} from "./format.js";

export {
  ACTION_CATEGORY_LABELS,
  ACTION_CATEGORY_ORDER,
  ACTION_KINDS,
  ACTION_LIBRARY,
  DEFAULT_ACTION_KIND,
  actionDefinition,
  isActionKind,
  paletteActions,
  type ActionCategory,
  type ActionDefinition,
  type ActionKind,
  type ActionVisibility,
} from "./actions.js";

export {
  addAgentProfile,
  agentForNode,
  agentProfiles,
  agentSlug,
  assignAgent,
  assignedAgents,
  findAgentProfile,
  newAgentId,
  removeAgentProfile,
  stepsUsingAgent,
  updateAgentProfile,
  type AddAgentResult,
  type AgentAssignment,
  type AgentPatch,
  type AgentProfile,
} from "./agents.js";

export {
  allIssues,
  issuesForEdge,
  issuesForNode,
  workflowLevelIssues,
  type IssueFix,
  type IssueSeverity,
  type WorkflowIssue,
} from "./issues.js";

export {
  WORKFLOWNER_ADVISORY_CODES,
  WORKFLOWNER_NODE_TYPES,
  WORKFLOWNER_VALIDATION_CODES,
  agentConfig,
  approvalConfig,
  slugify,
  findCycles,
  nodesOnCycles,
  workflowTarget,
  validateWorkflow,
  type WorkflowAdvisoryCode,
  type WorkflowAgentConfig,
  type WorkflowApprovalConfig,
  type WorkflowNodeType,
  type WorkflowValidationCode,
} from "./workflow.js";

export {
  DEFAULT_OUTCOME_KIND,
  OUTCOME_LABELS,
  OUTCOME_MEANINGS,
  addOutput,
  allOutputs,
  findOutput,
  SWITCHER_NOTE,
  isOutcomeKind,
  isSwitcher,
  outputsOf,
  patchOutput,
  removeOutput,
  setOutputTarget,
  switchExits,
  switcherProblem,
  unconnectedOutputs,
  type AddOutputResult,
  type BlockOutput,
  type OutputPatch,
} from "./outputs.js";

export {
  WORKFLOW_TEMPLATES,
  workflowTemplate,
  type WorkflowTemplate,
} from "./templates.js";

export {
  WorkflowCompileError,
  compile,
  executableBlocks,
  type CompileResult,
  type GeneratedFile,
} from "./compile.js";

/* What an agent is for, assembled from every step it owns when nobody wrote it
   down, and the bar an author's own description has to clear (ANT-126). */
export { MIN_DESCRIPTION_LENGTH, describeAgent, describesEnough } from "./agent-description.js";

/* Natural-language edits: an interpreter proposes, Anthill validates,
   previews, and applies only on acceptance. The contract half of ANT-12. */
export {
  EDIT_PROPOSAL_VERSION,
  applyEditProposal,
  extractProposalJson,
  parseEditProposal,
  type EditApplyResult,
  type EditChange,
  type EditOp,
  type EditParseResult,
  type EditProposal,
} from "./edit-proposal.js";
export {
  EDIT_REQUEST_CLOSE,
  EDIT_REQUEST_OPEN,
  buildEditInstruction,
  type EditScope,
} from "./edit-instruction.js";

/* Prompt-to-Workflow: a local CLI drafts, Anthill validates and maps. */
export {
  WORKFLOWNER_DRAFT_VERSION,
  extractDraftJson,
  parseDraftResponse,
  validateDraft,
  type DraftAgent,
  type DraftOutput,
  type DraftParseResult,
  type DraftQuestion,
  type DraftQuestionAbout,
  type DraftStep,
  type DraftWarning,
  type WorkflowDraft,
} from "./draft.js";

export {
  PROMPT_CLOSE,
  PROMPT_OPEN,
  buildDraftInstruction,
} from "./draft-instruction.js";

export {
  applyAnswers,
  needsClarification,
  openQuestions,
  type ApplyAnswersResult,
  type DraftAnswers,
} from "./draft-answers.js";

export {
  mapDraftToWorkflow,
  workflowSource,
  reviewDraft,
  type DraftReview,
  type DraftSource,
  type MapDraftOptions,
  type MappedDraft,
} from "./draft-mapping.js";

export { runRoot, withRunRoot } from "./run-root.js";
export { nextIdFor, rememberIds, rememberIdsUnder } from "./id-counter.js";

export {
  DEFAULT_INTERPRETER,
  INTERPRETERS,
  INTERPRETER_IDS,
  describeInterpreterCommand,
  interpreterDefinition,
  isInterpreterId,
  isSignedOutFailure,
  type InterpreterDefinition,
  type InterpreterId,
} from "./interpreters.js";
export { openSpot } from "./placement.js";
