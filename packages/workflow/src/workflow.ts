/**
 * The workflow's view of a workflow.
 *
 * Workflow mode reuses the canonical `Workflow` graph but reads a narrower set
 * of node config, and validates different rules than execution mode does:
 * there is no runtime per node (the harness is chosen for the whole diagram)
 * and nothing is ever executed, so the checks are about whether a readable,
 * unambiguous prompt can be produced.
 */

import {
  parseEdgeCondition,
  type HarnessTarget,
  type ValidationError,
  type ValidationResult,
  type Workflow,
  type WorkflowNode,
} from "@anthill/workflow-schema";

import { agentProfiles, agentSlug, assignedAgents, duplicateAgentProfileIds } from "./agents.js";
import { configuredHarnesses, isConfiguredFor } from "./agent-models.js";
import { describesEnough } from "./agent-description.js";
import { DEFAULT_TARGET, harnessProfile } from "./harness.js";
import {
  WORKFLOWNER_NODE_TYPES,
  agentConfig,
  approvalConfig,
  slugify,
} from "./node-config.js";
import { OUTCOME_LABELS, unconnectedOutputs } from "./outputs.js";

export {
  WORKFLOWNER_NODE_TYPES,
  agentConfig,
  approvalConfig,
  slugify,
  type WorkflowAgentConfig,
  type WorkflowApprovalConfig,
  type WorkflowNodeType,
} from "./node-config.js";

/**
 * Workflow validation codes.
 *
 * One vocabulary throughout: a block that does work is a *step*, the agent
 * carrying it out is a *role*, and a *connection* is a guarded path between
 * steps. These are planning rules — nothing here checks whether a CLI is
 * installed or a workspace is writable, which belong to the future runner.
 */
export const WORKFLOWNER_VALIDATION_CODES = {
  // Workflow-level
  NO_TARGET: "NO_TARGET",
  NO_START_BLOCK: "NO_START_BLOCK",
  MULTIPLE_START_BLOCKS: "MULTIPLE_START_BLOCKS",
  NO_END_BLOCK: "NO_END_BLOCK",
  UNSUPPORTED_BLOCK_TYPE: "UNSUPPORTED_BLOCK_TYPE",
  UNREACHABLE_BLOCK: "UNREACHABLE_BLOCK",
  DEAD_END_BLOCK: "DEAD_END_BLOCK",
  DUPLICATE_BLOCK_ID: "DUPLICATE_BLOCK_ID",
  DUPLICATE_EDGE_ID: "DUPLICATE_EDGE_ID",
  DUPLICATE_AGENT_ID: "DUPLICATE_AGENT_ID",

  // Steps
  STEP_MISSING_ACTION: "STEP_MISSING_ACTION",
  STEP_MISSING_TASK: "STEP_MISSING_TASK",
  STEP_MISSING_AGENT: "STEP_MISSING_AGENT",
  STEP_UNKNOWN_AGENT: "STEP_UNKNOWN_AGENT",

  // Agents
  //
  // There is no "two steps call this agent different names" code any more.
  // The name lives on the profile and nowhere else, so the conflict that code
  // reported can no longer be expressed.
  AGENT_MISSING_NAME: "AGENT_MISSING_NAME",
  DUPLICATE_AGENT_NAME: "DUPLICATE_AGENT_NAME",

  // Control blocks
  APPROVAL_NO_PATH: "APPROVAL_NO_PATH",
  APPROVAL_UNLABELLED_PATHS: "APPROVAL_UNLABELLED_PATHS",

  // Connections, branches and loops
  DANGLING_CONNECTION: "DANGLING_CONNECTION",
  INVALID_CONDITION: "INVALID_CONDITION",
  CONDITION_UNKNOWN_AGENT: "CONDITION_UNKNOWN_AGENT",
  BRANCH_WITHOUT_FALLBACK: "BRANCH_WITHOUT_FALLBACK",
  OUTPUT_NOT_CONNECTED: "OUTPUT_NOT_CONNECTED",
  UNBOUNDED_LOOP: "UNBOUNDED_LOOP",
  LOOP_WITHOUT_DONE_CRITERIA: "LOOP_WITHOUT_DONE_CRITERIA",
} as const;

/**
 * Advisories, reported separately from errors.
 *
 * Each is true of the workflow and none of them stops it compiling. They are the
 * difference between a workflow that works and one that reads well: a step with no
 * stated output, or no way to tell it succeeded, still generates a prompt — one
 * the agent has to guess its way through.
 */
export const WORKFLOWNER_ADVISORY_CODES = {
  WORKFLOW_NO_GOAL: "WORKFLOW_NO_GOAL",
  AGENT_NO_MODEL_FOR_TARGET: "AGENT_NO_MODEL_FOR_TARGET",
  AGENT_NO_DESCRIPTION: "AGENT_NO_DESCRIPTION",
  STEP_NO_EXPECTED_OUTPUT: "STEP_NO_EXPECTED_OUTPUT",
  STEP_NO_SUCCESS_CRITERIA: "STEP_NO_SUCCESS_CRITERIA",
} as const;

export type WorkflowAdvisoryCode =
  (typeof WORKFLOWNER_ADVISORY_CODES)[keyof typeof WORKFLOWNER_ADVISORY_CODES];

export type WorkflowValidationCode =
  (typeof WORKFLOWNER_VALIDATION_CODES)[keyof typeof WORKFLOWNER_VALIDATION_CODES];

/** Nodes reachable from `startId`, following edges forward. */
function reachableFrom(workflow: Workflow, startId: string): Set<string> {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }

  const seen = new Set<string>();
  const queue = [startId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) queue.push(next);
  }
  return seen;
}

/**
 * Groups of blocks that loop among themselves, each in the order it runs.
 *
 * Each group is a set of blocks mutually reachable from one another — a
 * developer/reviewer feedback loop comes back as one group of two. Reported as
 * groups rather than as individual nodes so the generated prompt can describe
 * each loop once instead of repeating itself per block.
 */
export function findCycles(workflow: Workflow): string[][] {
  const ids = [...new Set(workflow.nodes.map((node) => node.id))];
  const forward = new Map(ids.map((id) => [id, [] as string[]]));
  const reverse = new Map(ids.map((id) => [id, [] as string[]]));
  const selfLoops = new Set<string>();
  for (const edge of workflow.edges) {
    if (!forward.has(edge.source) || !forward.has(edge.target)) continue;
    forward.get(edge.source)!.push(edge.target);
    reverse.get(edge.target)!.push(edge.source);
    if (edge.source === edge.target) selfLoops.add(edge.source);
  }

  // Iterative Kosaraju: bounded stack usage and one visit per node/edge.
  const seen = new Set<string>();
  const finished: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stack = [{ id, next: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = forward.get(top.id)!;
      if (top.next === edges.length) {
        finished.push(top.id);
        stack.pop();
      } else {
        const next = edges[top.next++];
        if (!seen.has(next)) {
          seen.add(next);
          stack.push({ id: next, next: 0 });
        }
      }
    }
  }
  const component = new Map<string, number>();
  let count = 0;
  for (const id of finished.reverse()) {
    if (component.has(id)) continue;
    component.set(id, count);
    const stack = [id];
    while (stack.length) {
      for (const next of reverse.get(stack.pop()!)!) {
        if (!component.has(next)) {
          component.set(next, count);
          stack.push(next);
        }
      }
    }
    count += 1;
  }
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const group = component.get(id)!;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(id);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1 || selfLoops.has(group[0]))
    .map((group) => aroundTheLoop(group, forward));
}

/**
 * One loop's blocks, in the order the work goes round them.
 *
 * Kosaraju hands back a component as a set, and the blocks in it are listed
 * here in the order they were drawn. That is not the order they run in, and
 * the difference is visible: the compiled prompt names a loop by joining its
 * members — `### Implement ⇄ Review ⇄ Verify` — so a user whose three blocks
 * were not drawn in the order they happen read a heading describing a loop
 * that does not exist.
 *
 * Breadth-first from the member drawn first, following only the edges that
 * stay inside the loop. Every block in a strongly connected component is
 * reachable from every other, so this reaches all of them, and it reaches them
 * the way the work does.
 */
function aroundTheLoop(group: readonly string[], forward: Map<string, string[]>): string[] {
  const inside = new Set(group);
  const order = [group[0]];
  const seen = new Set(order);
  for (let index = 0; index < order.length; index += 1) {
    for (const next of forward.get(order[index]) ?? []) {
      if (!inside.has(next) || seen.has(next)) continue;
      seen.add(next);
      order.push(next);
    }
  }
  return order;
}

/** Node ids that sit on at least one cycle. */
export function nodesOnCycles(workflow: Workflow): Set<string> {
  return new Set(findCycles(workflow).flat());
}

/**
 * Validate a diagram for workflow mode.
 *
 * Collects every problem rather than stopping at the first, so the canvas can
 * show them all at once.
 */
export function validateWorkflow(workflow: Workflow): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const push = (
    code: WorkflowValidationCode,
    message: string,
    extra: { nodeId?: string; edgeId?: string } = {},
  ) => {
    errors.push({ code, message, ...extra });
  };
  const advise = (
    code: WorkflowAdvisoryCode,
    message: string,
    extra: { nodeId?: string; edgeId?: string } = {},
  ) => {
    warnings.push({ code, message, ...extra });
  };

  if (!workflow.target) {
    push(
      WORKFLOWNER_VALIDATION_CODES.NO_TARGET,
      "Choose which harness this diagram targets before generating a prompt.",
    );
  }

  const ids = new Set(workflow.nodes.map((node) => node.id));

  const profiles = agentProfiles(workflow);
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const [items, code, label] of [
    [workflow.nodes, WORKFLOWNER_VALIDATION_CODES.DUPLICATE_BLOCK_ID, "Block"],
    [workflow.edges, WORKFLOWNER_VALIDATION_CODES.DUPLICATE_EDGE_ID, "Connection"],
  ] as const) {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) push(code, `${label} id ${item.id} is used more than once.`);
      seen.add(item.id);
    }
  }
  for (const id of duplicateAgentProfileIds(workflow)) {
    push(WORKFLOWNER_VALIDATION_CODES.DUPLICATE_AGENT_ID, `Agent id ${id} is used more than once.`);
  }

  // Slugs of every agent, for checking what branch conditions read from. Taken
  // from the library rather than from what is assigned, so a condition written
  // before its step is not reported as reading from nobody.
  const agentSlugs = new Set(
    profiles.map((profile) => agentSlug(profile)).filter((slug) => slug.length > 0),
  );

  for (const edge of workflow.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      push(
        WORKFLOWNER_VALIDATION_CODES.DANGLING_CONNECTION,
        "This connection points at a block that no longer exists.",
        { edgeId: edge.id },
      );
    }
    if (edge.condition !== undefined) {
      const parsed = parseEdgeCondition(edge.condition);
      if (!parsed.ok) {
        push(
          WORKFLOWNER_VALIDATION_CODES.INVALID_CONDITION,
          `Condition is not valid: ${parsed.error}`,
          { edgeId: edge.id },
        );
      } else {
        // The first segment names the role whose result the branch reads.
        // Renaming a role silently orphans conditions written against the old
        // name, and the branch then reads a result nobody produces.
        const [source] = parsed.condition.path;
        if (source && !agentSlugs.has(source)) {
          push(
            WORKFLOWNER_VALIDATION_CODES.CONDITION_UNKNOWN_AGENT,
            `This condition reads a result from "${source}", but no agent in the workflow is called that.`,
            { edgeId: edge.id },
          );
        }
      }
    }
  }

  for (const node of workflow.nodes) {
    if (!(WORKFLOWNER_NODE_TYPES as readonly string[]).includes(node.type)) {
      push(
        WORKFLOWNER_VALIDATION_CODES.UNSUPPORTED_BLOCK_TYPE,
        `Workflow diagrams support only ${WORKFLOWNER_NODE_TYPES.join(", ")} blocks; "${node.type}" is not one of them.`,
        { nodeId: node.id },
      );
    }
  }

  const startNodes = workflow.nodes.filter((node) => node.type === "start");
  if (startNodes.length === 0) {
    push(WORKFLOWNER_VALIDATION_CODES.NO_START_BLOCK, "The diagram needs a Start block.");
  } else if (startNodes.length > 1) {
    for (const node of startNodes.slice(1)) {
      push(
        WORKFLOWNER_VALIDATION_CODES.MULTIPLE_START_BLOCKS,
        "Only one Start block is allowed.",
        { nodeId: node.id },
      );
    }
  }

  if (!workflow.nodes.some((node) => node.type === "end")) {
    push(
      WORKFLOWNER_VALIDATION_CODES.NO_END_BLOCK,
      "The diagram needs an End block so the prompt knows when to stop.",
    );
  }

  if (startNodes.length > 0) {
    const reachable = reachableFrom(workflow, startNodes[0].id);
    for (const node of workflow.nodes) {
      if (!reachable.has(node.id)) {
        push(
          WORKFLOWNER_VALIDATION_CODES.UNREACHABLE_BLOCK,
          "Nothing connects to this block, so it will never run.",
          { nodeId: node.id },
        );
      }
    }
  }

  const looping = nodesOnCycles(workflow);

  // A loop needs something to test against. An attempt limit only says when to
  // give up, which is not the same as knowing when the work is finished — and
  // an agent with no definition of done will happily loop until the counter
  // runs out.
  const doneCriteria = (workflow.brief?.doneCriteria ?? []).filter(
    (item) => item.trim().length > 0,
  );
  if (looping.size > 0 && doneCriteria.length === 0) {
    push(
      WORKFLOWNER_VALIDATION_CODES.LOOP_WITHOUT_DONE_CRITERIA,
      "This diagram loops, so the brief needs done criteria – otherwise nothing defines when the loop should stop.",
    );
  }

  for (const { nodeId, output } of unconnectedOutputs(workflow)) {
    const name = output.label.trim() || OUTCOME_LABELS[output.kind].toLowerCase();
    push(
      WORKFLOWNER_VALIDATION_CODES.OUTPUT_NOT_CONNECTED,
      `The "${name}" output does not lead anywhere yet. Connect it to a block, or remove it.`,
      { nodeId },
    );
  }

  // Every block except `end` must lead somewhere, or the workflow stops with no
  // statement that it is finished.
  for (const node of workflow.nodes) {
    if (node.type === "end") continue;
    if (!(WORKFLOWNER_NODE_TYPES as readonly string[]).includes(node.type)) continue;
    const leadsSomewhere = workflow.edges.some(
      (edge) => edge.source === node.id && ids.has(edge.target),
    );
    if (!leadsSomewhere && node.type !== "approval") {
      push(
        WORKFLOWNER_VALIDATION_CODES.DEAD_END_BLOCK,
        "Nothing follows this block. Connect it onward, or end the workflow with an End block.",
        { nodeId: node.id },
      );
    }
  }

  // A branch whose conditions can all be false leaves the reader with no
  // instruction. Every branching block needs one path with no condition.
  for (const node of workflow.nodes) {
    const outgoing = workflow.edges.filter(
      (edge) => edge.source === node.id && ids.has(edge.target),
    );
    if (outgoing.length < 2) continue;
    if (outgoing.every((edge) => edge.condition !== undefined)) {
      push(
        WORKFLOWNER_VALIDATION_CODES.BRANCH_WITHOUT_FALLBACK,
        "Every path out of this block is conditional, so nothing says what to do when none of them match. Leave one connection unconditional.",
        { nodeId: node.id },
      );
    }
  }

  for (const node of workflow.nodes) {
    if (node.type === "approval") {
      const outgoing = workflow.edges.filter((edge) => edge.source === node.id);
      if (outgoing.length === 0) {
        push(
          WORKFLOWNER_VALIDATION_CODES.APPROVAL_NO_PATH,
          "An approval gate needs at least one outgoing connection, or the workflow stops here whatever the answer.",
          { nodeId: node.id },
        );
      } else if (
        outgoing.length > 1 &&
        outgoing.some((edge) => !edge.label?.trim() && !edge.condition)
      ) {
        push(
          WORKFLOWNER_VALIDATION_CODES.APPROVAL_UNLABELLED_PATHS,
          "Label each path out of an approval gate with the answer it follows, for example “approved” and “rejected”.",
          { nodeId: node.id },
        );
      }
      continue;
    }

    if (node.type !== "agent") continue;
    const config = agentConfig(node);

    if (!config.actionKind) {
      push(
        WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_ACTION,
        "Choose what this step does – pick an action from the library.",
        { nodeId: node.id },
      );
    }

    if (!config.task) {
      push(
        WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK,
        "Describe what this step must do – an empty task produces an empty prompt.",
        { nodeId: node.id },
      );
    }

    if (!config.agentId) {
      push(
        WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_AGENT,
        "Assign this step to an agent – the agent is who carries it out.",
        { nodeId: node.id },
      );
    } else if (!profilesById.has(config.agentId)) {
      // The agent this step points at is not in the workflow's library. Reported
      // against the step, because the step is what has to be reassigned.
      push(
        WORKFLOWNER_VALIDATION_CODES.STEP_UNKNOWN_AGENT,
        `This step is assigned to an agent that is not in this workflow (${config.agentId}). Pick one from the Agents tab.`,
        { nodeId: node.id },
      );
    }

    if (config.actionKind && !config.expectedOutput) {
      advise(
        WORKFLOWNER_ADVISORY_CODES.STEP_NO_EXPECTED_OUTPUT,
        "This step does not say what it must produce, so the agent has to decide for itself when it is done here.",
        { nodeId: node.id },
      );
    }
    if (config.actionKind && !config.successCriteria?.length) {
      advise(
        WORKFLOWNER_ADVISORY_CODES.STEP_NO_SUCCESS_CRITERIA,
        "Nothing says how to tell this step succeeded, so nothing can check it.",
        { nodeId: node.id },
      );
    }

    if (looping.has(node.id) && config.maxIterations === undefined) {
      push(
        WORKFLOWNER_VALIDATION_CODES.UNBOUNDED_LOOP,
        "This block is part of a loop. Set a maximum number of passes so the prompt can bound it.",
        { nodeId: node.id },
      );
    }
  }

  // Agents are checked once each, not once per step that uses them: one badly
  // named agent is one problem however many steps share it.
  //
  // Only the assigned ones are checked. An agent nobody has been given yet
  // generates no file and appears in no roster, so nothing about it can be
  // wrong — reporting a half-filled library entry would be an error the author
  // cannot act on without abandoning what they were doing.
  const slugOwners = new Map<string, string>();
  // The tool this workflow is going to be handed to, which is the only one an
  // agent's configuration has to answer for here.
  const target = workflow.target ?? DEFAULT_TARGET;
  const harness = harnessProfile(target);
  for (const { profile, slug, stepIds } of assignedAgents(workflow)) {
    // Reported against a step that uses the agent, so the problem list can take
    // the author somewhere they can act.
    const where = { nodeId: stepIds[0] };

    if (slugify(profile.name).length === 0) {
      push(
        WORKFLOWNER_VALIDATION_CODES.AGENT_MISSING_NAME,
        "The agent doing this step has no name. Give it one containing letters or numbers – it becomes the generated file name.",
        where,
      );
      continue;
    }

    /*
     * An agent with no answer for the tool this workflow targets.
     *
     * An advisory rather than an error: the tool's own default is a real thing
     * to compile with, and refusing to compile would be a harder claim than the
     * facts support. But it is said, because with both tools connectable and a
     * real picker for each, "nobody has answered for this one" is a gap the
     * author can close in a click — and the alternative to saying it is
     * borrowing the other tool's model, which Anthill will not do.
     *
     * An explicit "inherit the session's" counts as answered. It is a decision,
     * and raising it would be arguing with the author.
     */
    if (!isConfiguredFor(profile.models, target)) {
      const elsewhere = configuredHarnesses(profile.models)
        .map((id) => harnessProfile(id).displayName)
        .join(" and ");
      advise(
        WORKFLOWNER_ADVISORY_CODES.AGENT_NO_MODEL_FOR_TARGET,
        elsewhere
          ? `${profile.name} has a model chosen for ${elsewhere} but none for ${harness.displayName}, so this workflow uses ${harness.displayName}'s default. The ${elsewhere} choice is not carried over.`
          : `No model is chosen for ${profile.name} on ${harness.displayName}, so this workflow uses ${harness.displayName}'s default.`,
        where,
      );
    }

    /*
     * An agent with no description, or one too short to be one.
     *
     * The description is the operating guidance the agent's file opens with:
     * what it is for, how it should approach the steps it owns, what it hands
     * back and how it knows it is done. A role is a title; a description is
     * the job. An agent doing ten steps with an empty description was handed
     * a name and left to guess the rest (ANT-126). An advisory rather than an
     * error, because the compiler can assemble a description from the steps —
     * but that is a fallback, not the thing itself, and a handover refuses to
     * proceed on an advisory, so the author is asked.
     */
    if (!describesEnough(profile.description)) {
      advise(
        WORKFLOWNER_ADVISORY_CODES.AGENT_NO_DESCRIPTION,
        profile.description?.trim()
          ? `${profile.name}'s description is too short to guide its work. Say what it is for, how it should approach its ${stepIds.length === 1 ? "step" : `${stepIds.length} steps`}, what it hands back and how it knows it is done.`
          : `${profile.name} has no description. Its agent file would open with nothing about how it should work across its ${stepIds.length === 1 ? "step" : `${stepIds.length} steps`}.`,
        where,
      );
    }

    const owner = slugOwners.get(slug);
    if (owner !== undefined && owner !== profile.id) {
      push(
        WORKFLOWNER_VALIDATION_CODES.DUPLICATE_AGENT_NAME,
        `Two agents are named "${profile.name}". They would overwrite each other's generated file, so give one of them a different name.`,
        where,
      );
    } else {
      slugOwners.set(slug, profile.id);
    }
  }

  if (!workflow.brief?.goal?.trim()) {
    advise(
      WORKFLOWNER_ADVISORY_CODES.WORKFLOW_NO_GOAL,
      "The brief has no goal, so the generated prompt never states what success looks like.",
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Convenience: the harness a workflow targets, or `undefined` if unset. */
export function workflowTarget(workflow: Workflow): HarnessTarget | undefined {
  return workflow.target;
}
