/**
 * Turning a validated draft into an ordinary workflow.
 *
 * This is the only door between a draft and a workflow, and it mints every id
 * itself: agent profiles get real `agent-N` ids and blocks get real node ids,
 * with the draft's own ids used only to resolve references while mapping. An
 * interpreter therefore cannot name an identity into existence, and a workflow
 * created from a prompt is indistinguishable from one built by hand — the
 * canvas, the inspectors and validation all work on it unchanged.
 *
 * What comes out is an ordinary editable workflow, not a special mode. The one
 * trace left behind is the prompt it came from, kept in Workflow metadata so the
 * author can see later what they actually asked for.
 */

import type {
  WorkflowBrief,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from "@anthill/workflow-schema";

import {
  addAgentProfile,
  agentProfiles,
  agentSlug,
  type AgentProfile,
} from "./agents.js";
import { WORKFLOW_FORMAT_VERSION } from "./format.js";
import { harnessProfile, type HarnessProfile } from "./harness.js";
import type { InterpreterId } from "./interpreters.js";
import type { DraftQuestion, DraftWarning, WorkflowDraft } from "./draft.js";
import { validateWorkflow } from "./workflow.js";
import type { ValidationResult } from "@anthill/workflow-schema";

export type DraftSource = {
  kind: "prompt";
  /** The author's prompt, whole and unedited. */
  prompt: string;
  interpreter: InterpreterId;
  /** The exact command that was run, so the record matches what happened. */
  command: string;
  draftedAt: string;
  draftVersion: number;
  /**
   * What the interpreter could not settle, with whatever the author answered.
   *
   * Kept with the workflow rather than only shown once: months later, "why is this
   * step shaped like this" is answered by what was asked and what was said back.
   */
  questions: DraftQuestion[];
};

export type MapDraftOptions = {
  prompt: string;
  interpreter: InterpreterId;
  command: string;
  /** Harness the workflow targets. Decides which suggested models are usable. */
  target?: Workflow["target"];
  /** Injectable so mapping stays pure and its output is testable. */
  now?: () => Date;
};

export type MappedDraft = {
  workflow: Workflow;
  /** Everything the mapping had to fudge, for the preview to show. */
  warnings: DraftWarning[];
};

/* ------------------------------------------------------------------ */

/** Blocks laid out in reading order, wrapping so a long workflow stays on screen. */
const COLUMNS = 4;
const COLUMN_WIDTH = 280;
const ROW_HEIGHT = 220;

function positionAt(index: number): { x: number; y: number } {
  return {
    x: 40 + (index % COLUMNS) * COLUMN_WIDTH,
    y: 40 + Math.floor(index / COLUMNS) * ROW_HEIGHT,
  };
}

/**
 * Suggested models are checked against the harness rather than trusted.
 *
 * An interpreter naming a model the target does not have would put a value
 * into the generated agent file that the harness then rejects, and the author
 * would find out at the far end. Unknown models are dropped and reported.
 */
function usableModel(
  model: string | undefined,
  harness: HarnessProfile,
  where: string,
  warn: (warning: DraftWarning) => void,
): string | undefined {
  if (!model) return undefined;
  if (harness.models.some((option) => option.id === model)) return model;
  warn({
    where,
    message: `${harness.displayName} has no model called "${model}", so the agent uses the default.`,
  });
  return undefined;
}

/**
 * Rewrite a condition to name the agent the way the Workflow does.
 *
 * A condition's first segment is the agent whose result the branch reads, and
 * the Workflow matches it against the agent's slug. An interpreter, asked for a
 * condition, reliably writes a word that means something — `reviewer`, `qa`,
 * `test` — rather than the slug of an agent it declared, and every such
 * condition then fails validation for a reason the author did not cause.
 *
 * Draft ids are the draft's own namespace and mapping already translates them
 * everywhere else; conditions were the one place it did not. So the first
 * segment is looked up as a draft agent id and replaced with that agent's real
 * slug. A segment matching nothing is left exactly as written — inventing a
 * target would be worse than reporting an honest problem.
 */
function rewriteCondition(
  condition: string,
  slugOfDraftId: Map<string, string>,
): { condition: string; changed: boolean } {
  const match = /^([A-Za-z0-9_-]+)(\..*)$/.exec(condition.trim());
  if (!match) return { condition, changed: false };

  const [, head, rest] = match;
  const slug = slugOfDraftId.get(head) ?? slugOfDraftId.get(head.toLowerCase());
  if (!slug || slug === head) return { condition, changed: false };
  return { condition: `${slug}${rest}`, changed: true };
}

function briefFrom(draft: WorkflowDraft): WorkflowBrief {
  // Copied rather than referenced: the brief becomes the author's to edit, and
  // it should not share structure with the draft they may want to compare to.
  return JSON.parse(JSON.stringify(draft.brief)) as WorkflowBrief;
}

/**
 * Map a validated draft onto a workflow.
 *
 * Nothing here can fail: anything that does not resolve becomes a warning and
 * a gap in the workflow, which the Workflow's own validation then reports against
 * the block it belongs to. That is deliberate — an author looking at a workflow
 * with three problems on it is better placed than one looking at a refusal.
 */
export function mapDraftToWorkflow(
  draft: WorkflowDraft,
  options: MapDraftOptions,
): MappedDraft {
  const warnings: DraftWarning[] = [];
  const warn = (warning: DraftWarning) => warnings.push(warning);
  const target = options.target ?? "claude-code";
  const harness = harnessProfile(target);
  const now = (options.now ?? (() => new Date()))();

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];

  const startId = "start";
  const endId = "end";
  nodes.push({ id: startId, type: "start", name: "Start", config: {}, position: positionAt(0) });

  /* --- agents: draft ids in, real profile ids out --- */

  let shell: Workflow = {
    id: `workflow-${now.getTime()}`,
    name: draft.title,
    ...(draft.summary ? { description: draft.summary } : {}),
    version: "0.1.0",
    target,
    brief: briefFrom(draft),
    nodes: [],
    edges: [],
  };

  const profileIdOf = new Map<string, string>();
  // Draft agent id -> the slug a condition has to use to name that agent.
  const slugOfDraftId = new Map<string, string>();
  for (const agent of draft.agents) {
    const where = `agent "${agent.id}"`;
    // A draft is proposed for one harness, so the model it names is that
    // harness's — recorded under it rather than as a choice for both.
    const proposed = usableModel(agent.model, harness, where, warn);
    const created = addAgentProfile(shell, {
      name: agent.name,
      ...(proposed ? { models: { [harness.target]: { id: proposed } } } : {}),
      ...(agent.role ? { role: agent.role } : {}),
      ...(agent.description ? { description: agent.description } : {}),
    });
    shell = created.workflow;
    profileIdOf.set(agent.id, created.agentId);
    slugOfDraftId.set(agent.id, agentSlug({ id: created.agentId, name: agent.name }));
  }

  /* --- blocks: one per draft step, in the order given --- */

  const nodeIdOf = new Map<string, string>();
  draft.steps.forEach((step, index) => {
    const nodeId = `n${index + 1}`;
    nodeIdOf.set(step.id, nodeId);

    if (step.kind === "approval") {
      nodes.push({
        id: nodeId,
        type: "approval",
        name: step.name,
        config: step.question ? { prompt: step.question } : { prompt: "" },
        position: positionAt(index + 1),
      });
      return;
    }

    const agentId = step.agent ? profileIdOf.get(step.agent) : undefined;
    if (step.agent && !agentId) {
      warn({
        where: `step "${step.id}"`,
        message: `It names an agent "${step.agent}" that was not in the draft's agent list, so the step has none. Assign one on the canvas.`,
      });
    } else if (!step.agent) {
      warn({
        where: `step "${step.id}"`,
        message: "No agent was suggested for this step. Assign one on the canvas.",
      });
    }

    // A step with no action is the second most common gap in a draft, and the
    // library has a name for "work, unspecified": the general-purpose building
    // step. Defaulting to it and saying so leaves an author with a workflow to
    // adjust rather than a list of steps to repair one at a time.
    let action = step.action;
    if (!action) {
      action = "agent-step";
      warn({
        where: `step "${step.id}"`,
        message:
          "No action was chosen for it, so it was set to Agent Step — the general-purpose one. Change it if another fits better.",
      });
    }

    nodes.push({
      id: nodeId,
      type: "agent",
      name: step.name,
      position: positionAt(index + 1),
      config: {
        actionKind: action,
        ...(agentId ? { agentId } : {}),
        ...(step.purpose ? { purpose: step.purpose } : {}),
        ...(step.task ? { task: step.task } : {}),
        ...(step.inputs ? { inputs: step.inputs } : {}),
        ...(step.expectedOutput ? { expectedOutput: step.expectedOutput } : {}),
        ...(step.successCriteria ? { successCriteria: step.successCriteria } : {}),
        ...(step.constraints ? { constraints: step.constraints } : {}),
        ...(step.handoff ? { handoff: step.handoff } : {}),
        ...(step.maxIterations ? { maxIterations: step.maxIterations } : {}),
      },
    });
  });

  nodes.push({
    id: endId,
    type: "end",
    name: "Done",
    config: {},
    position: positionAt(draft.steps.length + 1),
  });

  /* --- connections --- */

  // The workflow has to start somewhere, and the draft's first step is where.
  const firstNodeId = nodeIdOf.get(draft.steps[0].id) as string;
  edges.push({ id: "out-start", source: startId, target: firstNodeId });

  let outputNumber = 0;
  const pendingByNode = new Map<string, Record<string, unknown>[]>();

  for (const step of draft.steps) {
    const source = nodeIdOf.get(step.id) as string;
    const outputs = step.outputs ?? [];

    if (outputs.length === 0) {
      warn({
        where: `step "${step.id}"`,
        message: "Nothing follows it. Connect it onward, or to the End block.",
      });
      continue;
    }

    for (const output of outputs) {
      outputNumber += 1;
      const id = `out-${outputNumber}`;
      const targetId =
        output.to === "end" || output.to === endId ? endId : nodeIdOf.get(output.to);

      if (!targetId) {
        // An output pointing at a step that is not in the draft becomes an
        // unconnected output rather than being dropped: the author can see the
        // interpreter meant something to follow, and where it thought it went.
        warn({
          where: `step "${step.id}"`,
          message: `Its "${output.label ?? output.kind ?? "next"}" output points at "${output.to}", which is not a step in this draft. Left unconnected.`,
        });
        pendingByNode.set(source, [
          ...(pendingByNode.get(source) ?? []),
          {
            id,
            ...(output.kind ? { kind: output.kind } : {}),
            ...(output.label ? { label: output.label } : {}),
            ...(output.condition ? { condition: output.condition } : {}),
          },
        ]);
        continue;
      }

      if (targetId === source) {
        // A step that repeats is a real shape, but Anthill draws a loop as a
        // path back from a later block, and the canvas will not let an author
        // connect a block to itself either. Saying what to do instead is more
        // use than a silent drop.
        warn({
          where: `step "${step.id}"`,
          message:
            "It pointed one of its outputs back at itself to mean “repeat”. Anthill draws a loop as a path back from a later step — add one, or set a pass limit and describe the repetition in the task.",
        });
        outputNumber -= 1;
        continue;
      }

      let condition = output.condition;
      if (condition) {
        const rewritten = rewriteCondition(condition, slugOfDraftId);
        condition = rewritten.condition;
        if (rewritten.changed) {
          warn({
            where: `step "${step.id}"`,
            message: `Its condition named the agent by draft id; rewritten to "${condition}" so the branch reads the right agent.`,
          });
        }
      }

      edges.push({
        id,
        source,
        target: targetId,
        ...(output.kind ? { kind: output.kind } : {}),
        ...(output.label ? { label: output.label } : {}),
        ...(condition ? { condition } : {}),
      });
    }
  }

  const withPending = nodes.map((node) => {
    const pending = pendingByNode.get(node.id);
    return pending ? { ...node, config: { ...node.config, pendingOutputs: pending } } : node;
  });

  const source: DraftSource = {
    kind: "prompt",
    prompt: options.prompt,
    interpreter: options.interpreter,
    command: options.command,
    draftedAt: now.toISOString(),
    draftVersion: draft.draftVersion,
    questions: draft.questions,
  };

  const workflow = {
    ...((shell.metadata?.workflow as Record<string, unknown>) ?? {}),
    formatVersion: WORKFLOW_FORMAT_VERSION,
    source,
  };

  return {
    workflow: {
      ...shell,
      nodes: withPending,
      edges,
      metadata: { ...shell.metadata, workflow },
    },
    warnings,
  };
}

/** The prompt a workflow was drafted from, if it was drafted from one. */
export function workflowSource(workflow: Workflow): DraftSource | undefined {
  const bag = workflow.metadata?.workflow;
  if (typeof bag !== "object" || bag === null) return undefined;
  const source = (bag as Record<string, unknown>).source;
  if (typeof source !== "object" || source === null) return undefined;
  const record = source as Record<string, unknown>;
  return record.kind === "prompt" && typeof record.prompt === "string"
    ? (record as DraftSource)
    : undefined;
}

export type DraftReview = {
  draft: WorkflowDraft;
  workflow: Workflow;
  /** The profiles as they will actually exist, with their real ids. */
  agents: AgentProfile[];
  /** Everything parsing and mapping had to fudge. */
  warnings: DraftWarning[];
  /** Ordinary Workflow validation of the mapped workflow. */
  validation: ValidationResult;
};

/**
 * Everything the preview needs, in one shape.
 *
 * The workflow is mapped but not persisted or opened — this is what the author is
 * shown *before* deciding, which is the whole point of the preview step.
 */
export function reviewDraft(
  draft: WorkflowDraft,
  parseWarnings: readonly DraftWarning[],
  options: MapDraftOptions,
): DraftReview {
  const { workflow, warnings } = mapDraftToWorkflow(draft, options);
  return {
    draft,
    workflow,
    agents: agentProfiles(workflow),
    warnings: [...parseWarnings, ...warnings],
    validation: validateWorkflow(workflow),
  };
}
