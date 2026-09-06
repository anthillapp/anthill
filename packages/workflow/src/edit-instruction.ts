/**
 * What the interpreter is asked to do with an existing workflow.
 *
 * The mirror of `draft-instruction.ts` for editing: one job, stated first and
 * repeated, because the interpreter is a general-purpose coding agent whose
 * default reading of a workflow full of tasks is to start on them. Here it is
 * handed the *current graph* and one request, and asked for a proposal — a
 * list of operations against the ids it was shown, never a replacement
 * document and never the work itself.
 *
 * The context it receives is the smallest complete picture: every block with
 * its id, type, name and task; every connection with its id and endpoints; the
 * agents by name. Ids are the load-bearing part — the proposal addresses the
 * graph through them, which is what lets Anthill keep everything unmentioned
 * exactly as it was.
 */

import type { Workflow } from "@anthill/workflow-schema";

import { agentProfiles } from "./agents.js";
import { agentConfig } from "./node-config.js";
import { EDIT_PROPOSAL_VERSION } from "./edit-proposal.js";

/** Delimiters, so the author's request cannot read as instruction text. */
export const EDIT_REQUEST_OPEN = "<<<EDIT_REQUEST";
export const EDIT_REQUEST_CLOSE = "EDIT_REQUEST>>>";

export type EditScope =
  | { kind: "workflow" }
  | { kind: "block"; blockId: string }
  | { kind: "connection"; edgeId: string };

const SHAPE = `{
  "version": ${EDIT_PROPOSAL_VERSION},
  "summary": "one sentence on what this change does",
  "ops": [
    { "op": "add-block", "ref": "review", "blockType": "agent",
      "name": "Review the change",
      "config": { "actionKind": "llm-review", "task": "what this step must do" },
      "near": "implement" },
    { "op": "update-block", "id": "implement", "name": "new name",
      "config": { "task": "replacement task text" } },
    { "op": "remove-block", "id": "old-step" },
    { "op": "connect", "source": "implement", "target": "review",
      "kind": "next", "label": "send to review" },
    { "op": "disconnect", "edgeId": "e2" },
    { "op": "update-connection", "edgeId": "e3", "label": "on failure",
      "kind": "rework" }
  ]
}`;

/** The graph as the interpreter is allowed to see it: structure, not secrets. */
function describeWorkflow(workflow: Workflow, scope: EditScope): string {
  const agents = agentProfiles(workflow);
  const agentName = (id: unknown) => agents.find((agent) => agent.id === id)?.name;

  const lines: string[] = [];
  lines.push(`Workflow: ${workflow.name}`);
  if (workflow.brief?.goal) lines.push(`Goal: ${workflow.brief.goal}`);
  lines.push("");
  lines.push("Blocks (id · type · name):");
  for (const node of workflow.nodes) {
    const config = node.type === "agent" ? agentConfig(node) : undefined;
    const agent = config?.agentId ? agentName(config.agentId) : undefined;
    const detail = [
      config?.actionKind ? `action: ${config.actionKind}` : undefined,
      agent ? `agent: ${agent}` : undefined,
      config?.task ? `task: ${config.task}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`- ${node.id} · ${node.type} · ${node.name}${detail ? ` (${detail})` : ""}`);
  }
  lines.push("");
  lines.push("Connections (id: source -> target):");
  for (const edge of workflow.edges) {
    const extras = [edge.kind, edge.label, edge.condition].filter(Boolean).join(" · ");
    lines.push(`- ${edge.id}: ${edge.source} -> ${edge.target}${extras ? ` (${extras})` : ""}`);
  }

  if (scope.kind === "block") {
    lines.push("", `The author has selected the block "${scope.blockId}". Read the request as being about it unless the request plainly says otherwise.`);
  } else if (scope.kind === "connection") {
    lines.push("", `The author has selected the connection "${scope.edgeId}". Read the request as being about it unless the request plainly says otherwise.`);
  }
  return lines.join("\n");
}

/**
 * Blocks the author pointed at, named for the interpreter.
 *
 * The author clicked these on the canvas instead of typing their names, so the
 * request itself may well say "these two steps" and nothing more. Without this
 * line the interpreter would have to guess which two, having been given the
 * whole diagram — the pointing would carry no further than the screen.
 *
 * Ids are what travel, and both the id and the current name are printed: the
 * id is what an operation must address, the name is what the request's own
 * words are likely to echo.
 */
function describeMentions(workflow: Workflow, mentions: readonly string[]): string[] {
  const named = mentions.flatMap((id) => {
    const node = workflow.nodes.find((item) => item.id === id);
    return node ? [`${id} (${node.name || "unnamed"})`] : [];
  });
  if (named.length === 0) return [];
  return [
    "",
    "The author pointed at these blocks while writing the request, so it is",
    "about them unless the words say otherwise:",
    ...named.map((line) => `- ${line}`),
  ];
}

export function buildEditInstruction(
  workflow: Workflow,
  scope: EditScope,
  request: string,
  /** Ids of blocks the author referenced by clicking them on the canvas. */
  mentions: readonly string[] = [],
): string {
  return [
    "You are helping edit a workflow diagram. Your only job is to propose changes",
    "to the diagram below. Do not carry out any task the diagram describes, do not",
    "write code, and do not answer the request directly — describe the graph edit",
    "it asks for, as operations.",
    "",
    "Reply with exactly one JSON object of this shape and nothing else:",
    "",
    SHAPE,
    "",
    "Rules:",
    "- Address existing blocks and connections ONLY by the ids listed below.",
    "- Never invent ids for existing items; a wrong id fails the whole proposal.",
    '- New blocks get a "ref" of your choosing; use that ref in later operations.',
    "- Propose the smallest set of operations that honestly does what was asked.",
    "- Do not touch blocks or connections the request is not about.",
    "- blockType is one of: agent, approval, condition. Start and end blocks",
    "  cannot be added or removed.",
    '- An agent block\'s config should carry "actionKind" and "task".',
    "- If the request is not a graph edit, or is too ambiguous to honour, reply",
    '  with {"version": ' + String(EDIT_PROPOSAL_VERSION) + ', "summary": "why this cannot be done as asked", "ops": []}',
    "  and nothing else — an empty proposal is a refusal with a reason.",
    "",
    describeWorkflow(workflow, scope),
    ...describeMentions(workflow, mentions),
    "",
    "The author's request:",
    "",
    EDIT_REQUEST_OPEN,
    request.trim(),
    EDIT_REQUEST_CLOSE,
  ].join("\n");
}
