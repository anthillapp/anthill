import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  addAgentProfile,
  agentProfiles,
  applyEditProposal,
  DEFAULT_ACTION_KIND,
  EDIT_PROPOSAL_VERSION,
  type EditOp,
} from "@anthill/workflow";
import type { HarnessTarget, Workflow } from "@anthill/workflow-schema";

/**
 * `@anthill/api` — the single import origin for the workflow lifecycle.
 *
 * This is the **create + edit half** (T-007). A driver does:
 *
 * ```ts
 * import { createWorkflow, addBlock, removeBlock, updateBlock, connect, disconnect } from "@anthill/api";
 * ```
 *
 * and never touches `@anthill/workflow` directly. The design is
 * `docs/design/api-surface.md`; the execute/status/observe/open/export half is
 * T-008 and is deliberately not here.
 *
 * What this layer is, and is not:
 *
 * - **A thin composition, not a new model.** The edit functions re-expose the
 *   existing `EditOp` union under their own names and run every one through
 *   `applyEditProposal` — validated, atomic, all-or-nothing. A bad op is
 *   rejected (thrown) and the workflow on disk is left exactly as it was.
 * - **File-backed.** A workflow is its `<name>.workflow.json` file in the
 *   workflow folder (the same store desktop Save writes). `ANTHILL_WORKFLOW_DIR`
 *   points the API at a folder; the default is `~/Documents/Anthill`, the
 *   desktop's own default.
 * - **Async, Promise-based.** Every function returns a `Promise`; a driver
 *   `await`s.
 */

/* ------------------------------------------------------------------ */
/* The spec shapes (the create half)                                    */
/* ------------------------------------------------------------------ */

/** One agent profile the workflow's steps may be assigned to. */
export type AgentSpec = {
  name: string;
  role?: string;
  description?: string;
};

/**
 * One step of the workflow, in order.
 *
 * `agent` names an entry of `spec.agents` (not an id — the ids are assigned
 * when the workflow is created, so a spec cannot guess them). Omit it for a
 * step that is not an agent's to carry (an approval, a condition).
 *
 * `task` is what the step must do — the app's validation refuses an agent
 * step without one ("an empty task produces an empty prompt"). `action` is
 * the step's action from the library; omitted, it takes the library's own
 * default (`agent-step`).
 */
export type StepSpec = {
  name: string;
  agent?: string;
  action?: string;
  task: string;
  blockType?: "agent" | "approval" | "condition";
};

/**
 * Everything `createWorkflow` needs.
 *
 * `target` is optional on the spec: a workflow without one is what the app's
 * own validation calls out ("choose which harness this targets"), and the
 * driver is the one to decide it — the API does not guess.
 */
export type WorkflowSpec = {
  goal: string;
  verification?: string;
  doneCriteria?: string[];
  agents?: AgentSpec[];
  steps: StepSpec[];
  target?: HarnessTarget;
};

/**
 * A block to add, in the shape the `add-block` `EditOp` takes. `near` names
 * an existing block (or a ref of one the same proposal added) the new block
 * belongs beside.
 */
export type BlockSpec = {
  blockType: "agent" | "approval" | "condition";
  name: string;
  config?: Record<string, unknown>;
  near?: string;
};

/* ------------------------------------------------------------------ */
/* The store: a workflow is its .workflow.json file                      */
/* ------------------------------------------------------------------ */

/**
 * Where the API keeps workflow files.
 *
 * `ANTHILL_WORKFLOW_DIR` wins (a driver — or a test — points it at a folder of
 * its own); the default is the desktop's own default workflow folder.
 */
function workflowDir(): string {
  const fromEnv = process.env.ANTHILL_WORKFLOW_DIR;
  return fromEnv ? resolve(fromEnv) : join(homedir(), "Documents", "Anthill");
}

/**
 * Load one workflow by id: the folder's `*.workflow.json` files, matched on
 * the `id` inside.
 */
async function loadWorkflow(id: string): Promise<Workflow> {
  let entries: string[];
  try {
    entries = await readdir(workflowDir());
  } catch {
    throw new Error(`No workflow folder at ${workflowDir()} — create a workflow first.`);
  }
  for (const name of entries.sort()) {
    if (!name.endsWith(".workflow.json")) continue;
    try {
      const workflow = JSON.parse(await readFile(join(workflowDir(), name), "utf8")) as Workflow;
      if (workflow.id === id) return workflow;
    } catch {
      /* a file that cannot be read is not the one asked for */
    }
  }
  throw new Error(`No workflow with id "${id}" in ${workflowDir()}.`);
}

/**
 * Save a workflow whole.
 *
 * A file that already holds this id keeps its name (the desktop's own rule:
 * a rename changes the title inside, not the filename); a workflow with no
 * file yet gets one named for it.
 */
async function saveWorkflow(workflow: Workflow): Promise<void> {
  const dir = workflowDir();
  await mkdir(dir, { recursive: true });
  const existing = await findFileFor(dir, workflow.id);
  const name = existing ?? `${slug(workflow.name)}.workflow.json`;
  await writeFile(join(dir, name), JSON.stringify(workflow, null, 2) + "\n", "utf8");
}

async function findFileFor(dir: string, id: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  for (const name of entries.sort()) {
    if (!name.endsWith(".workflow.json")) continue;
    try {
      if ((JSON.parse(await readFile(join(dir, name), "utf8")) as Workflow).id === id) return name;
    } catch {
      /* not readable, not the one */
    }
  }
  return undefined;
}

function slug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workflow";
}

/* ------------------------------------------------------------------ */
/* Create                                                                */
/* ------------------------------------------------------------------ */

/**
 * Create a workflow from a spec and save it.
 *
 * The shape is the app's own: a Start, one block per step in order, an End,
 * connected in a line; the spec's agents become the workflow's agent profiles
 * (ids assigned here — a step names an agent by the spec's name, and the
 * assignment is resolved to the id that was issued). Returns the created
 * `Workflow`, with its `id`.
 */
export async function createWorkflow(spec: WorkflowSpec): Promise<Workflow> {
  if (spec.steps.length === 0) {
    throw new Error("A workflow needs at least one step.");
  }

  let workflow: Workflow = {
    id: `wf-${slug(spec.goal)}`,
    name: spec.goal.length > 40 ? `${spec.goal.slice(0, 40)}…` : spec.goal,
    version: "0.1.0",
    ...(spec.target ? { target: spec.target } : {}),
    brief: {
      goal: spec.goal,
      ...(spec.verification ? { verification: spec.verification } : {}),
      ...(spec.doneCriteria && spec.doneCriteria.length > 0 ? { doneCriteria: spec.doneCriteria } : {}),
    },
    nodes: [],
    edges: [],
  };

  // Agents first: their ids are assigned here, and a step's `agent` names the
  // spec's entry, not the id it will get.
  const agentIdByName = new Map<string, string>();
  for (const agent of spec.agents ?? []) {
    const { workflow: next, agentId } = addAgentProfile(workflow, {
      name: agent.name,
      ...(agent.role ? { role: agent.role } : {}),
      ...(agent.description ? { description: agent.description } : {}),
    });
    workflow = next;
    agentIdByName.set(agent.name, agentId);
  }

  const nodes: Workflow["nodes"] = [
    { id: "start-1", type: "start", name: "Start", config: {}, position: { x: 0, y: 140 } },
  ];
  const edges: Workflow["edges"] = [];
  let previous = "start-1";
  spec.steps.forEach((step, index) => {
    const id = `step-${index + 1}`;
    if (step.agent && !agentIdByName.has(step.agent)) {
      throw new Error(`Step "${step.name}" names an agent "${step.agent}" the spec does not define.`);
    }
    const type = step.blockType ?? "agent";
    const config: Record<string, unknown> = {};
    const agentId = step.agent ? agentIdByName.get(step.agent) : undefined;
    if (agentId) config.agentId = agentId;
    if (type === "agent") {
      // An agent step is validated on its action and its task; the spec's
      // `action` takes the library's own default when omitted.
      config.actionKind = step.action ?? DEFAULT_ACTION_KIND;
      config.task = step.task;
    }
    nodes.push({
      id,
      type,
      name: step.name,
      config,
      position: { x: 210 * (index + 1), y: 140 },
    });
    edges.push({ id: `e-${previous}-${id}`, source: previous, target: id });
    previous = id;
  });
  nodes.push({ id: "end-1", type: "end", name: "Done", config: {}, position: { x: 210 * (spec.steps.length + 1), y: 140 } });
  edges.push({ id: `e-${previous}-end-1`, source: previous, target: "end-1" });

  workflow = { ...workflow, nodes, edges };
  await saveWorkflow(workflow);
  return workflow;
}

/* ------------------------------------------------------------------ */
/* Edit — the existing EditOp union, re-exposed under its own names      */
/* ------------------------------------------------------------------ */

/**
 * Apply one op to the workflow `id` names, save the result, and return it.
 *
 * The op goes through `applyEditProposal` — the same validated, atomic path
 * the desktop's edit assistant uses. A rejected op throws (with the
 * application's own reason) and the file is left exactly as it was.
 */
async function edit(id: string, op: EditOp, summary: string): Promise<Workflow> {
  const workflow = await loadWorkflow(id);
  const result = applyEditProposal(workflow, {
    version: EDIT_PROPOSAL_VERSION,
    summary,
    ops: [op],
  });
  if (!result.ok) throw new Error(result.error);
  await saveWorkflow(result.workflow);
  return result.workflow;
}

/** Add a block. Re-exposes the `add-block` `EditOp`. */
export function addBlock(id: string, block: BlockSpec): Promise<Workflow> {
  return edit(
    id,
    {
      op: "add-block",
      // A single-op proposal: one fresh ref, colliding with nothing.
      ref: "new",
      blockType: block.blockType,
      name: block.name,
      ...(block.config ? { config: block.config } : {}),
      ...(block.near ? { near: block.near } : {}),
    },
    `Add a ${block.blockType} block, "${block.name}".`,
  );
}

/** Remove a block. Re-exposes the `remove-block` `EditOp`. */
export function removeBlock(id: string, blockId: string): Promise<Workflow> {
  return edit(id, { op: "remove-block", id: blockId }, `Remove the block "${blockId}".`);
}

/**
 * Update a block. Re-exposes the `update-block` `EditOp`.
 *
 * Only the fields passed are set: omit `name` and the original name is kept,
 * omit `config` and the original config is kept.
 */
export function updateBlock(
  id: string,
  blockId: string,
  changes: { name?: string; config?: Record<string, unknown> },
): Promise<Workflow> {
  return edit(
    id,
    {
      op: "update-block",
      id: blockId,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.config !== undefined ? { config: changes.config } : {}),
    },
    changes.name !== undefined ? `Rename the block "${blockId}" to "${changes.name}".` : `Update the block "${blockId}".`,
  );
}

/** Connect two blocks. Re-exposes the `connect` `EditOp`. */
export function connect(
  id: string,
  source: string,
  target: string,
  kind?: "next" | "rework" | "question" | "switch",
): Promise<Workflow> {
  return edit(
    id,
    { op: "connect", source, target, ...(kind ? { kind } : {}) },
    `Connect "${source}" to "${target}"${kind ? ` as ${kind}` : ""}.`,
  );
}

/** Disconnect an edge. Re-exposes the `disconnect` `EditOp`. */
export function disconnect(id: string, edgeId: string): Promise<Workflow> {
  return edit(id, { op: "disconnect", edgeId }, `Disconnect the edge "${edgeId}".`);
}

/**
 * The agent profiles a workflow carries, by id — so a driver can assign a
 * block to an agent by the id the workflow issued, without reaching into
 * `@anthill/workflow` for it.
 */
export async function agents(id: string): Promise<{ id: string; name: string }[]> {
  const workflow = await loadWorkflow(id);
  return agentProfiles(workflow).map((profile) => ({ id: profile.id, name: profile.name }));
}
