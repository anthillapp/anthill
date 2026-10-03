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
import { findCycles, validateWorkflow } from "./workflow.js";
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
 * How an agent reference is looked up, whatever form it arrives in.
 *
 * A draft names the same agent three ways in one document — declared as
 * `"id": "qa-agent"`, referenced from a step as `"agent": "QA Agent"`, and
 * written into a condition as `qa_agent.decision` — because it is prose from a
 * language model, not a database. Matching those exactly meant the second and
 * third found nothing, and the step or the condition silently lost its agent.
 * Case and the separators are therefore not part of the identity here.
 */
function lookupKey(reference: string): string {
  return reference.trim().toLowerCase().replace(/[\s_-]+/g, "-");
}

/**
 * A display name for an agent the draft referred to but never described.
 *
 * The reference is all there is to go on, so it is all that is used: no role,
 * no description and no model are invented to go with it. `qa-agent` becomes
 * "Qa Agent" rather than "QA Agent" — expanding an acronym would be a guess
 * about the author's own vocabulary, and the name is theirs to correct in one
 * click, while a wrong expansion is something they first have to notice.
 */
function agentNameFrom(reference: string): string {
  const words = reference
    .trim()
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0].toUpperCase() + word.slice(1));
  return words.length > 0 ? words.join(" ") : reference.trim();
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
  const slug = slugOfDraftId.get(lookupKey(head));
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
  // Draft agent reference -> the slug a condition has to use to name that agent.
  const slugOfDraftId = new Map<string, string>();

  /**
   * File a profile under every reference that should reach it.
   *
   * First writer wins per key, and the caller registers ids before names, so a
   * declared id can never be shadowed by another agent's display name.
   */
  const remember = (agentId: string, name: string, references: readonly (string | undefined)[]) => {
    const slug = agentSlug({ id: agentId, name });
    for (const reference of references) {
      const key = reference ? lookupKey(reference) : "";
      if (!key || profileIdOf.has(key)) continue;
      profileIdOf.set(key, agentId);
      slugOfDraftId.set(key, slug);
    }
  };

  const declared = draft.agents.map((agent) => {
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
    return { agent, agentId: created.agentId };
  });

  // Two passes: every declared id, then every display name. An agent's own id
  // is what the draft says it is, and must outrank a name that happens to
  // collide with it.
  for (const { agent, agentId } of declared) remember(agentId, agent.name, [agent.id]);
  for (const { agent, agentId } of declared) remember(agentId, agent.name, [agent.name]);

  /**
   * The profile a step's `agent` refers to, creating one if nothing does.
   *
   * A draft that names "developer", "reviewer" and "researcher" on its steps
   * and forgets to describe them in `agents` used to produce a workflow with no
   * profiles at all and not one step assigned (ANT-66) — the author had to
   * read the diagram, work out who was meant to do what, add each agent by
   * hand and then assign every step. The reference is the interpreter saying
   * plainly that this step is carried out by someone, and that someone is the
   * same across every step naming them, which is a profile and its assignments.
   *
   * Minting one here rather than refusing keeps that intent. What it must not
   * do is pretend to know more than the reference: the profile gets a name and
   * nothing else, and the warning says it was inferred so the author can check
   * it against the prompt they wrote.
   */
  const resolveAgent = (reference: string, where: string): string => {
    const existing = profileIdOf.get(lookupKey(reference));
    if (existing) return existing;

    const name = agentNameFrom(reference);
    const created = addAgentProfile(shell, { name });
    shell = created.workflow;
    remember(created.agentId, name, [reference, name]);
    warn({
      where,
      message: `It is carried out by "${reference}", which the draft never described, so an agent called "${name}" was created for it. Check its name and model in the Agents rail.`,
    });
    return created.agentId;
  };

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

    const agentId = step.agent
      ? resolveAgent(step.agent, `step "${step.id}"`)
      : undefined;
    if (!step.agent) {
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
          "No action was chosen for it, so it was set to Agent Step – the general-purpose one. Change it if another fits better.",
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
            "It pointed one of its outputs back at itself to mean “repeat”. Anthill draws a loop as a path back from a later step – add one, or set a pass limit and describe the repetition in the task.",
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

  /*
    A step nothing leads into starts with the workflow, beside the first one.

    The draft has no Start of its own: its first step is where the work begins,
    so work that begins with two checks side by side could only put one of
    them first and leave the other with no way in — unreachable, and Prompt
    blocked until the author found the missing connection (ANT-185). The
    instruction now says an unreferenced step starts with the first; this is
    that rule, and the warning says it was applied so a step that was simply
    forgotten is noticed.
  */
  const entered = new Set(edges.map((edge) => edge.target));
  for (const step of draft.steps.slice(1)) {
    const nodeId = nodeIdOf.get(step.id) as string;
    if (entered.has(nodeId)) continue;
    edges.push({ id: `out-start-${nodeId}`, source: startId, target: nodeId });
    warn({
      where: `step "${step.id}"`,
      message:
        "Nothing led into it, so it starts with the workflow, at the same time as the first step. If it belongs after another step, connect it there instead.",
    });
  }

  /*
    A step on a loop with no pass limit takes the loop's limit.

    The instruction asks for "maxIterations" on every step of a loop, and an
    interpreter that sets it on four of five has said what the bound is and
    forgotten to repeat it. Left alone, the draft opens with an error on the one
    step it missed (ANT-262). The largest limit already on that loop is the one
    the interpreter chose, so it is copied rather than invented, and a loop with
    no limit anywhere is left for the author to decide.
  */
  const limitFor = new Map<string, number>();
  const draftIdOf = new Map([...nodeIdOf].map(([draftId, nodeId]) => [nodeId, draftId]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const group of findCycles({ ...shell, nodes, edges })) {
    const limits = group
      .map((id) => (nodeById.get(id)?.config as { maxIterations?: number } | undefined)?.maxIterations)
      .filter((limit): limit is number => typeof limit === "number");
    if (limits.length === 0) continue;
    const limit = Math.max(...limits);
    for (const id of group) {
      const node = nodeById.get(id);
      if (node?.type !== "agent") continue;
      if ((node.config as { maxIterations?: number }).maxIterations !== undefined) continue;
      limitFor.set(id, limit);
      warn({
        where: `step "${draftIdOf.get(id) ?? id}"`,
        message: `It is on a loop but had no pass limit; it takes the loop's limit of ${String(limit)}.`,
      });
    }
  }

  const withPending = nodes.map((node) => {
    const pending = pendingByNode.get(node.id);
    const limit = limitFor.get(node.id);
    if (!pending && limit === undefined) return node;
    return {
      ...node,
      config: {
        ...node.config,
        ...(limit !== undefined ? { maxIterations: limit } : {}),
        ...(pending ? { pendingOutputs: pending } : {}),
      },
    };
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
