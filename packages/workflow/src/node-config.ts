/**
 * Reading a block's workflow config.
 *
 * Separate from `workflow.ts` so that both validation and the agent-profile model
 * can read a step's config without importing each other: validation needs the
 * profiles to check a step's reference, and the profiles need the config to
 * find which steps point at them.
 */

import { isActionKind, type ActionKind } from "./actions.js";
import type { WorkflowNode } from "@anthill/workflow-schema";

/**
 * Node types a workflow diagram may contain.
 *
 * `approval` is the human approval gate — a control block, not an action, which
 * is why it is a node type rather than an entry in the action library.
 */
export const WORKFLOWNER_NODE_TYPES = ["start", "agent", "approval", "end"] as const;
export type WorkflowNodeType = (typeof WORKFLOWNER_NODE_TYPES)[number];

/**
 * Config the block editor writes onto an `agent` node.
 *
 * The block's `name` is the step's name. Who carries it out is `agentId`, a
 * reference to a profile stored on the workflow — several steps may share one
 * profile and compile into a single agent file. The step holds the reference
 * and nothing else: no name, no model. Those live on the profile, so renaming
 * an agent cannot split it and two steps cannot disagree about what it is.
 */
export type WorkflowAgentConfig = {
  /** Which library action this step performs. */
  actionKind?: ActionKind;
  /** The agent profile carrying out this step. See `agents.ts`. */
  agentId?: string;
  /** Why this step exists, in one line. */
  purpose?: string;
  /** What this step must do. */
  task?: string;
  /** What the step needs before it can start. */
  inputs?: string[];
  /** What the step must produce. */
  expectedOutput?: string;
  /** How to tell this step succeeded. */
  successCriteria?: string[];
  /** Limits that apply to this step only; workflow-wide ones live in the brief. */
  constraints?: string[];
  /** What to pass on, and to whom, when this step finishes. */
  handoff?: string;
  /** Required when the block sits on a loop: how many passes are allowed. */
  maxIterations?: number;
};

/** Config the block editor writes onto an `approval` node. */
export type WorkflowApprovalConfig = {
  /** The question put to the person approving. */
  prompt?: string;
};

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringList(
  config: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = config[key];
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Read an `agent` node's workflow config defensively. */
export function agentConfig(node: WorkflowNode): WorkflowAgentConfig {
  const config = node.config as Record<string, unknown>;
  const maxIterations =
    typeof config.maxIterations === "number" && Number.isFinite(config.maxIterations)
      ? config.maxIterations
      : undefined;

  return {
    actionKind: isActionKind(config.actionKind) ? config.actionKind : undefined,
    agentId: readString(config, "agentId"),
    purpose: readString(config, "purpose"),
    task: readString(config, "task"),
    inputs: readStringList(config, "inputs"),
    expectedOutput: readString(config, "expectedOutput"),
    successCriteria: readStringList(config, "successCriteria"),
    constraints: readStringList(config, "constraints"),
    handoff: readString(config, "handoff"),
    maxIterations,
  };
}

/** Read an `approval` node's workflow config defensively. */
export function approvalConfig(node: WorkflowNode): WorkflowApprovalConfig {
  return { prompt: readString(node.config as Record<string, unknown>, "prompt") };
}

/**
 * Turn a name into an identifier: lowercase, non-alphanumerics collapsed to
 * single hyphens, trimmed. "Code Reviewer!" becomes "code-reviewer". Empty when
 * nothing usable remains, which validation reports.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
