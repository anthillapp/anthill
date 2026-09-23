/**
 * Turn a diagram into something you can paste into a coding agent.
 *
 * Output is a main orchestration prompt plus, for harnesses that support them,
 * one subagent file per block. The prompt is generated from a breadth-first
 * walk of the graph so step numbering is stable and cycles are visited once.
 *
 * An important honesty note that belongs in the generated text itself: the
 * ordering, branching and loop bounds here are *instructions*, not enforcement.
 * Nothing stops the agent reading them from taking a different path. Anthill
 * cannot guarantee otherwise while its output is a prompt.
 */

import {
  parseEdgeCondition,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "@anthill/workflow-schema";

import { DEFAULT_TARGET, harnessProfile, type HarnessProfile } from "./harness.js";
import {
  explicitModelFor,
  isConfiguredFor,
  modelFor,
  reasoningEffortFor,
} from "./agent-models.js";
import { tomlTable } from "./toml.js";
import { resolveBrief, type ResolvedBrief } from "./brief.js";
import {
  agentConfig,
  approvalConfig,
  findCycles,
  validateWorkflow,
} from "./workflow.js";
import { ACTION_CATEGORY_LABELS, actionDefinition, type ActionDefinition } from "./actions.js";
import type { WorkflowAgentConfig } from "./node-config.js";
import { assignedAgents, type AgentAssignment } from "./agents.js";
import { describeAgent } from "./agent-description.js";

export type GeneratedFile = {
  /** Repository-relative path, e.g. `.claude/agents/reviewer.md`. */
  path: string;
  content: string;
};

export type CompileResult = {
  /** The text to paste into the agent. */
  prompt: string;
  /** Files to drop into the repository. Empty when the harness has no subagents. */
  files: GeneratedFile[];
  /** Things the author should know — e.g. settings the target cannot honour. */
  warnings: string[];
};

/** Thrown when the diagram is not valid enough to produce a useful prompt. */
export class WorkflowCompileError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`This diagram cannot be turned into a prompt yet:\n- ${issues.join("\n- ")}`);
    this.name = "WorkflowCompileError";
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/* Graph walk                                                          */
/* ------------------------------------------------------------------ */

type Step = {
  index: number;
  node: WorkflowNode;
};

function outgoingEdges(workflow: Workflow, nodeId: string): WorkflowEdge[] {
  return workflow.edges.filter((edge) => edge.source === nodeId);
}

/**
 * Breadth-first from the start block. Each node appears once, so a loop back to
 * an earlier block is rendered as "return to step N" rather than duplicating it.
 *
 * **This is the canonical order**, and the only one. The prompt numbers steps
 * from it, and so must anything else that numbers or lists them — see
 * `executableBlocks`.
 *
 * Deterministic for a given document: the queue takes each node's outgoing
 * edges in the order the document lists them, so a branch's arms are visited
 * in the order they were drawn. Two documents that differ only in edge order
 * are two different documents, and they compile to two different promptings.
 */
export function orderNodes(workflow: Workflow): WorkflowNode[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const start = workflow.nodes.find((node) => node.type === "start");
  if (!start) return [];

  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  const queue: string[] = [start.id];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);

    const node = byId.get(id);
    if (!node) continue;
    ordered.push(node);

    for (const edge of outgoingEdges(workflow, id)) {
      if (byId.has(edge.target)) queue.push(edge.target);
    }
  }
  return ordered;
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

/** `reviewer.decision == "approved"` → `the reviewer's decision is "approved"`. */
function describeCondition(condition: string): string {
  const parsed = parseEdgeCondition(condition);
  if (!parsed.ok) return `\`${condition}\``;

  const { rawPath, operator, value, valueType } = parsed.condition;
  const rendered = valueType === "string" ? `"${value}"` : String(value);
  const verb = operator === "==" ? "is" : "is not";
  return `\`${rawPath}\` ${verb} ${rendered}`;
}

/** YAML double-quoted scalar — safe for text containing `:`, `#`, quotes. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function indentBlock(text: string, indent: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : `${indent}${line}`))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Agent files                                                         */
/* ------------------------------------------------------------------ */

/**
 * One step's detail, for the agent file.
 *
 * The same eight-field vocabulary the main prompt renders per step (see
 * `buildPrompt` below) — purpose, task, inputs, expected output, success
 * criteria, handoff — so a subagent reads the same picture of its own work
 * that the orchestrator reads about it. Constraints are handled separately by
 * the caller: they are gathered once across every stage an agent does, not
 * repeated per step. `category` is included because it is what an author sees
 * first in the inspector (`{category} · {label}`) and in the main prompt's
 * own "Action:" line — the same label everywhere a step's action is named.
 */
function renderStepDetail(config: WorkflowAgentConfig): string[] {
  const lines: string[] = [];
  if (config.purpose) lines.push("", `Purpose: ${config.purpose}`);
  if (config.task) lines.push("", config.task);
  if (config.inputs?.length) {
    lines.push("", "Inputs:", ...config.inputs.map((item) => `- ${item}`));
  }
  if (config.expectedOutput) lines.push("", `Expected output: ${config.expectedOutput}`);
  if (config.successCriteria?.length) {
    lines.push("", "This step succeeds when:", ...config.successCriteria.map((item) => `- ${item}`));
  }
  if (config.handoff) lines.push("", `Hand off: ${config.handoff}`);
  return lines;
}

function actionLabel(action: ActionDefinition): string {
  return `${ACTION_CATEGORY_LABELS[action.category]} · ${action.label}`;
}

/**
 * One file per agent profile, not per step.
 *
 * An agent assigned to three stages of the workflow is one agent doing three
 * things, so its file describes the agent and lists the stages it is
 * responsible for. Writing a file per step would fragment one agent into
 * several and lose exactly what a reusable profile is for.
 */
function buildAgentFile(
  assignment: AgentAssignment,
  workflow: Workflow,
  harness: HarnessProfile,
): GeneratedFile | undefined {
  if (!harness.agentDir) return undefined;

  const { profile, slug } = assignment;
  const steps = assignment.stepIds
    .map((id) => workflow.nodes.find((node) => node.id === id))
    .filter((node): node is WorkflowNode => node !== undefined);

  // The profile's own description is what the author wrote about the agent, so
  // it outranks one assembled from its steps. But the assembled one covers
  // every step the agent owns; what used to stand here — the first step's
  // purpose, or "The X in this workflow." — described one corner of the job
  // or none of it (ANT-126).
  const description = profile.description?.trim() || describeAgent(profile, steps, workflow);
  // The harness being compiled for, and only its own vocabulary. A profile
  // configured for the other one contributes nothing here — carrying `opus`
  // into a Codex run would be Anthill inventing a fact about the author's
  // setup, which is exactly what the per-harness split exists to stop.
  const model = modelFor(profile.models, harness.target);
  /** What the author actually chose, which is not the same as the resolved id. */
  const chosen = explicitModelFor(profile.models, harness.target);
  const effort = reasoningEffortFor(profile.models, harness.target);

  const body: string[] = [`You are the ${profile.name}.`];
  if (profile.role?.trim()) body.push("", profile.role.trim());
  if (profile.description?.trim()) body.push("", profile.description.trim());

  if (steps.length === 1) {
    const config = agentConfig(steps[0]);
    const action = config.actionKind ? actionDefinition(config.actionKind) : undefined;
    if (action) body.push("", `Action: ${actionLabel(action)} — ${action.summary}.`);
    body.push(...renderStepDetail(config));
  } else {
    body.push(
      "",
      "You are responsible for these stages of the workflow. The orchestrating prompt",
      "says which one you are being asked for.",
    );
    for (const step of steps) {
      const config = agentConfig(step);
      const action = config.actionKind ? actionDefinition(config.actionKind) : undefined;
      body.push("", `## ${step.name} (${action ? actionLabel(action) : "Step"})`);
      body.push(...renderStepDetail(config));
    }
  }

  const constraints = [
    ...new Set(steps.flatMap((step) => agentConfig(step).constraints ?? [])),
  ];
  if (constraints.length > 0) {
    body.push("", "## Constraints", "", ...constraints.map((item) => `- ${item}`));
  }

  const instructions = body.join("\n").trim();

  /*
   * Each harness reads its own format, and neither generator is a dressed-up
   * version of the other. Claude Code reads Markdown with YAML front matter;
   * Codex reads a TOML table whose keys are its own. Sharing a writer between
   * them would mean one of the two is being written in a shape it does not
   * document.
   */
  if (harness.agentFileFormat === "toml") {
    const content = `${tomlTable([
      { key: "name", value: slug },
      { key: "description", value: description },
      { key: "developer_instructions", value: instructions, multiline: true },
      // Omitted rather than resolved when the author chose to inherit: a
      // Codex agent file with no `model` takes the spawning session's, and
      // writing a name instead would pin it to whatever Anthill believed the
      // default was on the day the file was written.
      chosen ? { key: "model", value: chosen } : undefined,
      effort ? { key: "model_reasoning_effort", value: effort } : undefined,
    ])}\n`;
    return { path: `${harness.agentDir}/${slug}.toml`, content };
  }

  const content = [
    "---",
    `name: ${slug}`,
    `description: ${yamlString(description)}`,
    `model: ${model}`,
    "---",
    "",
    instructions,
    "",
  ].join("\n");

  return { path: `${harness.agentDir}/${slug}.md`, content };
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

function renderTransitions(
  workflow: Workflow,
  node: WorkflowNode,
  stepNumbers: Map<string, number>,
): string[] {
  const edges = outgoingEdges(workflow, node.id);
  if (edges.length === 0) return [];

  const byId = new Map(workflow.nodes.map((item) => [item.id, item]));

  const describeTarget = (edge: WorkflowEdge): string => {
    const target = byId.get(edge.target);
    if (!target) return "an unknown block";
    if (target.type === "end") return `stop — the workflow is complete (${target.name})`;

    // The outcome kind carries meaning the target alone does not: sending work
    // back is a different instruction from moving on to the next step, even
    // when both point at the same block.
    if (edge.kind === "rework") {
      const limit = agentConfig(target).maxIterations;
      const bound = limit === undefined ? "" : `, at most ${limit} passes in total`;
      const step = stepNumbers.get(target.id);
      const where = step === undefined ? target.name : `step ${step} (${target.name})`;
      return `send the work back to ${where} to be redone${bound}`;
    }
    if (edge.kind === "question") {
      const step = stepNumbers.get(target.id);
      const where = step === undefined ? target.name : `step ${step} (${target.name})`;
      return `put the question to ${where} and wait for the answer`;
    }
    if (edge.kind === "stop") {
      const step = stepNumbers.get(target.id);
      const where = step === undefined ? target.name : `step ${step} (${target.name})`;
      return `stop this path at ${where}`;
    }

    const step = stepNumbers.get(target.id);
    const where = step === undefined ? target.name : `step ${step} (${target.name})`;
    const isLoopBack =
      step !== undefined && step <= (stepNumbers.get(node.id) ?? Number.MAX_SAFE_INTEGER);

    if (isLoopBack) {
      const limit = agentConfig(target).maxIterations;
      const bound = limit === undefined ? "" : `, at most ${limit} passes in total`;
      return `go back to ${where}${bound}`;
    }
    return `continue to ${where}`;
  };

  // A single unconditional edge is the common case — render it as one line.
  if (edges.length === 1 && edges[0].condition === undefined) {
    return [`Then ${describeTarget(edges[0])}.`];
  }

  const lines = ["Then:"];
  for (const edge of edges) {
    const label = edge.label ? ` (${edge.label})` : "";
    if (edge.condition === undefined) {
      lines.push(`- otherwise${label}, ${describeTarget(edge)}.`);
    } else {
      lines.push(`- if ${describeCondition(edge.condition)}${label}, ${describeTarget(edge)}.`);
    }
  }
  return lines;
}

function bulletList(
  heading: string,
  items: readonly string[],
  level: "##" | "###" = "##",
): string {
  return [`${level} ${heading}`, "", ...items.map((item) => `- ${item}`)].join("\n");
}

function paragraph(heading: string, body: string, level: "##" | "###" = "##"): string {
  return [`${level} ${heading}`, "", body].join("\n");
}

/**
 * Everything that applies to the whole workflow, in one block at the top.
 *
 * Kept together — rather than scattered between the steps and the closing
 * rules — because these are the terms the work is judged by, and a constraint
 * buried under the last step is a constraint nobody reads. Constraints and
 * prohibited actions in particular used to sit at the bottom among the
 * mechanical rules.
 */
function buildSharedContext(brief: ResolvedBrief): string {
  const parts: string[] = [
    "## Shared context",
    "",
    "This section applies to every step below.",
  ];

  if (brief.goal) parts.push("", paragraph("Goal", brief.goal, "###"));
  if (brief.context) parts.push("", paragraph("Project context", brief.context, "###"));
  if (brief.assumptions.length > 0) {
    parts.push("", bulletList("Assumptions", brief.assumptions, "###"));
  }
  if (brief.doneCriteria.length > 0) {
    parts.push("", bulletList("Done criteria", brief.doneCriteria, "###"));
  }
  if (brief.verification) {
    parts.push("", paragraph("Verification", brief.verification, "###"));
  }
  if (brief.constraints.length > 0) {
    parts.push("", bulletList("Constraints", brief.constraints, "###"));
  }
  if (brief.prohibitedActions.length > 0) {
    parts.push("", bulletList("Do not", brief.prohibitedActions, "###"));
  }

  return parts.join("\n");
}

/**
 * Describe each feedback loop as a cycle of work rather than as a jump.
 *
 * The steps section already says which branch goes where; what it cannot say is
 * how to behave while going around. This is the shape that actually works:
 * find the cause, make the smallest fix, verify it, verify it independently,
 * then judge against the done criteria — not against whether the loop feels
 * finished.
 */
function renderLoops(
  workflow: Workflow,
  brief: ResolvedBrief,
  nameOf: (nodeId: string) => string,
): string | undefined {
  const cycles = findCycles(workflow);
  if (cycles.length === 0) return undefined;

  const agentOfStep = new Map<string, string>();
  for (const assignment of assignedAgents(workflow)) {
    for (const stepId of assignment.stepIds) {
      agentOfStep.set(stepId, assignment.profile.name);
    }
  }

  // "Implement ⇄ Review" says which steps loop but not who is doing them, and
  // a step name and an agent name are easy to confuse. Name both.
  const describeStep = (nodeId: string): string => {
    const step = nameOf(nodeId);
    const agent = agentOfStep.get(nodeId);
    return agent ? `${step} (${agent})` : step;
  };

  const sections = ["## Loops"];
  for (const cycle of cycles) {
    const names = cycle.map(describeStep);
    const limits = cycle
      .map((id) => agentConfig(workflow.nodes.find((node) => node.id === id) as WorkflowNode))
      .map((config) => config.maxIterations)
      .filter((value): value is number => typeof value === "number");
    const limit = limits.length > 0 ? Math.min(...limits) : undefined;

    sections.push("");
    sections.push(`### ${names.join(" ⇄ ")}`);
    sections.push("");
    sections.push("Each time round this loop:");
    sections.push("");
    sections.push("1. Investigate what is actually wrong before changing anything.");
    sections.push("2. Make the smallest reasonable fix.");
    sections.push("3. Verify it locally.");
    sections.push(
      "4. Verify it independently — do not rely only on the check written alongside the fix.",
    );
    sections.push(
      "5. Evaluate against the done criteria above. If they are not met, go round again.",
    );

    if (limit !== undefined) {
      sections.push("");
      sections.push(
        `Stop after at most ${limit} passes. Reaching that limit is a result to report, not a reason to declare the work finished.`,
      );
    }
  }

  if (brief.doneCriteria.length === 0) {
    sections.push("");
    sections.push(
      "> No done criteria were given, so the loop has no defined exit. Add them.",
    );
  }

  return sections.join("\n");
}

function buildPrompt(
  workflow: Workflow,
  harness: HarnessProfile,
  ordered: WorkflowNode[],
): string {
  // Start and end are structural; everything else is a numbered step.
  const stepNumbers = new Map<string, number>();
  ordered
    .filter((node) => node.type === "agent" || node.type === "approval")
    .forEach((node, index) => stepNumbers.set(node.id, index + 1));

  const brief = resolveBrief(workflow);
  const nameOf = (nodeId: string) =>
    workflow.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;

  const sections: string[] = [];

  sections.push(`# ${workflow.name || "Workflow"}`);
  if (workflow.description?.trim()) sections.push(workflow.description.trim());

  sections.push(
    [
      "> **How to read this workflow.** Anthill generated it from a diagram; Anthill does",
      "> not run it. The ordering, conditions, branches and limits below are",
      "> instructions for you as the external harness, not behaviour Anthill enforces.",
      "> Nothing stops you departing from them, so follow them deliberately and say so",
      "> when you cannot.",
    ].join("\n"),
  );

  sections.push(buildSharedContext(brief));

  const usesSubagents = Boolean(harness.agentDir);
  sections.push(
    usesSubagents
      ? [
          "You are orchestrating a workflow that was designed as a diagram in Anthill.",
          "",
          `Each step below names a subagent defined in \`${harness.agentDir}/\`. Delegate the step's`,
          "work to that subagent rather than doing it yourself, then use its result to decide",
          "which step comes next.",
        ].join("\n")
      : [
          "You are carrying out a workflow that was designed as a diagram in Anthill.",
          "",
          "Each step below names the agent that carries it out. Take on those agents one at",
          "a time, in the order given, and use each step's result to decide which step comes",
          "next.",
        ].join("\n"),
  );

  const agents = assignedAgents(workflow, ordered);
  if (agents.length > 0) {
    const roster = agents.map(({ profile, slug, stepIds }) => {
      const model = modelFor(profile.models, harness.target);
  /** What the author actually chose, which is not the same as the resolved id. */
  const chosen = explicitModelFor(profile.models, harness.target);
  const effort = reasoningEffortFor(profile.models, harness.target);
      const modelNote = harness.supportsPerAgentModel ? ` — model: ${model}` : "";
      const stepCount = stepIds.length > 1 ? ` — ${stepIds.length} steps` : "";
      const role = profile.role?.trim() ? ` — ${profile.role.trim()}` : "";
      return `- \`${slug}\` (${profile.name})${role}${stepCount}${modelNote}`;
    });
    sections.push(
      [
        "## Agents",
        "",
        ...roster,
        "",
        "An agent that appears at several steps is the same agent returning to the work,",
        "not a new one each time.",
      ].join("\n"),
    );
  }

  const agentOf = new Map<string, AgentAssignment>();
  for (const assignment of agents) {
    for (const stepId of assignment.stepIds) agentOf.set(stepId, assignment);
  }

  const steps: string[] = ["## Steps"];
  ordered.forEach((node) => {
    if (node.type !== "agent" && node.type !== "approval") return;
    const step = stepNumbers.get(node.id) as number;

    if (node.type === "approval") {
      const prompt = approvalConfig(node).prompt;
      steps.push("");
      steps.push(`### ${step}. ${node.name} — stop and ask a human`);
      steps.push("");
      steps.push(
        prompt
          ? `Ask: ${prompt}`
          : "Ask the person running this workflow whether to continue.",
      );
      steps.push("");
      steps.push("Do not decide this yourself and do not continue until they answer.");

      const transitions = renderTransitions(workflow, node, stepNumbers);
      if (transitions.length > 0) {
        steps.push("");
        steps.push(...transitions);
      }
      return;
    }

    const config = agentConfig(node);
    const assignment = agentOf.get(node.id);
    const action = config.actionKind ? actionDefinition(config.actionKind) : undefined;

    steps.push("");
    const heading = assignment
      ? usesSubagents
        ? `### ${step}. ${node.name} — delegate to the \`${assignment.slug}\` subagent`
        : `### ${step}. ${node.name} — act as ${assignment.profile.name}`
      : `### ${step}. ${node.name}`;
    steps.push(heading);

    if (action) {
      steps.push("");
      // "Action: {label}" stays a literal prefix — category is appended after
      // the summary, in the same place and words the inspector uses
      // (`{category} · {label}`), rather than inserted before the label.
      steps.push(`Action: ${action.label} — ${action.summary} (${ACTION_CATEGORY_LABELS[action.category]}).`);
    }
    if (config.purpose) {
      steps.push("");
      steps.push(`Purpose: ${config.purpose}`);
    }

    if (config.task) {
      steps.push("", "Task:", "", indentBlock(config.task, "> "));
    }
    if (config.inputs?.length) {
      steps.push("", "Inputs:", "", ...config.inputs.map((item) => `- ${item}`));
    }
    if (config.expectedOutput) {
      steps.push("", `Expected output: ${config.expectedOutput}`);
    }
    if (config.successCriteria?.length) {
      steps.push(
        "",
        "This step succeeds when:",
        "",
        ...config.successCriteria.map((item) => `- ${item}`),
      );
    }
    if (config.constraints?.length) {
      steps.push(
        "",
        "For this step only:",
        "",
        ...config.constraints.map((item) => `- ${item}`),
      );
    }
    if (config.handoff) {
      steps.push("", `Hand off: ${config.handoff}`);
    }

    const transitions = renderTransitions(workflow, node, stepNumbers);
    if (transitions.length > 0) {
      steps.push("");
      steps.push(...transitions);
    }
  });
  sections.push(steps.join("\n"));

  const loops = renderLoops(workflow, brief, nameOf);
  if (loops) sections.push(loops);

  // Mechanical rules only. The workflow's own constraints live in the shared
  // context at the top, where they are read before the work starts.
  sections.push(
    [
      "## Rules",
      "",
      "- Follow the steps in the order given; do not skip ahead.",
      "- After each step, state which branch you are taking and why.",
      "- If a step's result is ambiguous, ask rather than guessing which branch to take.",
      "- The constraints in the shared context apply throughout, not only to the step being worked on.",
    ].join("\n"),
  );

  if (brief.finalAction) {
    sections.push(paragraph("Final action", brief.finalAction));
  }

  sections.push(bulletList("Report at the end", brief.report));

  return `${sections.join("\n\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Compile a diagram into a prompt plus agent files.
 *
 * Throws `WorkflowCompileError` when the diagram is not valid — callers should run
 * `validateWorkflow` first and keep the generate action disabled until it passes.
 */
export function compile(workflow: Workflow): CompileResult {
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    throw new WorkflowCompileError(validation.errors.map((error) => error.message));
  }

  const harness = harnessProfile(workflow.target ?? DEFAULT_TARGET);
  const ordered = orderNodes(workflow);
  const agents = assignedAgents(workflow, ordered);

  const files: GeneratedFile[] = [];
  for (const assignment of agents) {
    const file = buildAgentFile(assignment, workflow, harness);
    if (file) files.push(file);
  }

  const warnings: string[] = [];
  if (!harness.supportsPerAgentModel) {
    const chosen = agents.filter(({ profile }) => isConfiguredFor(profile.models, harness.target));
    if (chosen.length > 0) {
      warnings.push(
        `${harness.displayName} has no per-agent model selection, so the models chosen for ${chosen.length} agent(s) are not applied.`,
      );
    }
  }
  if (!harness.agentDir) {
    warnings.push(
      `${harness.displayName} has no subagent files, so every step is inlined into the prompt instead.`,
    );
  }

  return { prompt: buildPrompt(workflow, harness, ordered), files, warnings };
}

/**
 * The blocks a session is told to work through, in the order it is told to.
 *
 * `start` and `end` are the graph's own bookends rather than work, so they are
 * not steps and are not announced.
 *
 * This exists because two places disagreed. The compiled prompt numbered steps
 * by this walk, and the marker instructions listed them in `workflow.nodes`
 * array order — which is creation order, and a graph is very often not drawn
 * in the order it runs. Both carried the block id, so nothing was ever wrong
 * about *which* block a report named; what differed was the sequence the
 * agent was reading, so "step 1" in the prompt and the first entry in the list
 * it was told to report against could be two different blocks (ANT-101).
 */
export function executableBlocks(workflow: Workflow): WorkflowNode[] {
  return orderNodes(workflow).filter((node) => node.type !== "start" && node.type !== "end");
}
