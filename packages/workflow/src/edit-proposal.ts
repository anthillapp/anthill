/**
 * The structured proposal an interpreter may make about an existing workflow.
 *
 * The foundation of natural-language editing (ANT-12), and deliberately not
 * the whole of it: this file is the contract, the parser, the application and
 * the diff — everything that has to be right before a single pixel of UI
 * exists, because a graph mutation that cannot be validated, previewed and
 * refused is not a feature, it is a hazard.
 *
 * The rules the shape encodes:
 *
 * - **A proposal is operations, never a replacement document.** An assistant
 *   handed the power to return a whole new workflow will sooner or later
 *   return one that quietly drops what it did not understand. Operations make
 *   every change explicit, reviewable one by one, and refusable one by one.
 * - **Existing ids are load-bearing.** An operation addresses blocks and
 *   connections by the ids the workflow already has, and applying a proposal
 *   never reissues an id it did not create. That is what keeps unrelated
 *   blocks, agent references and manual layout untouched.
 * - **Applying is pure and all-or-nothing.** The input workflow is never
 *   mutated; a proposal that fails midway leaves nothing half-done. The
 *   caller previews, the author accepts, and only then does the result become
 *   the open workflow — by the caller's hand, not this file's.
 * - **New blocks are placed, not laid out.** A new block lands beside its
 *   anchor rather than triggering a re-layout of everything the author
 *   arranged. A broader re-layout is the author's own button, not a side
 *   effect of accepting an edit.
 */

import type { Workflow, WorkflowNode, WorkflowEdge } from "@anthill/workflow-schema";
import { WorkflowSchema } from "@anthill/workflow-schema";

import { nextIdFor, rememberIds } from "./id-counter.js";

/** The version this module writes and the only one it accepts. */
export const EDIT_PROPOSAL_VERSION = 1;

export type EditOp =
  | {
      op: "add-block";
      /** The proposal's own handle for the new block, so later ops and new
       * connections can name it before it has a real id. */
      ref: string;
      blockType: "agent" | "approval" | "condition";
      name: string;
      config?: Record<string, unknown>;
      /** An existing block id (or earlier ref) the new block belongs beside. */
      near?: string;
    }
  | { op: "update-block"; id: string; name?: string; config?: Record<string, unknown> }
  | { op: "remove-block"; id: string }
  | {
      op: "connect";
      /** Existing id, or the ref of a block this proposal added. */
      source: string;
      target: string;
      kind?: "next" | "rework" | "question";
      label?: string;
      condition?: string;
    }
  | { op: "disconnect"; edgeId: string }
  | {
      op: "update-connection";
      edgeId: string;
      label?: string;
      condition?: string;
      kind?: "next" | "rework" | "question";
    };

export type EditProposal = {
  version: typeof EDIT_PROPOSAL_VERSION;
  /** One plain sentence the preview leads with. The assistant's words. */
  summary: string;
  ops: EditOp[];
  /**
   * The one thing that has to be settled before anything can be proposed.
   *
   * Ambiguity used to be folded into the refusal shape, so "split this task
   * into subagents" — which block? divided how? — came back as a decline, and
   * the author was left to guess what would have satisfied it. Worse, an
   * interpreter inclined to be helpful would pick a block and propose against
   * it, which is a guess wearing a proposal's clothes (ANT-36).
   *
   * A question is therefore its own outcome, and carries no operations: a
   * reply that asks *and* changes something has already decided the thing it
   * claims not to know, and the parser refuses it.
   */
  question?: string;
};

export type EditParseResult =
  | { ok: true; proposal: EditProposal }
  | { ok: false; error: string; raw: string };

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const OP_NAMES = new Set([
  "add-block",
  "update-block",
  "remove-block",
  "connect",
  "disconnect",
  "update-connection",
]);

const EDGE_KINDS = new Set(["next", "rework", "question"]);
const BLOCK_TYPES = new Set(["agent", "approval", "condition"]);

/** The first JSON object in a reply, tolerating prose and fences around it. */
export function extractProposalJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function validateOp(value: unknown, index: number): { ok: true; op: EditOp } | { ok: false; error: string } {
  const at = `Operation ${index + 1}`;
  if (!isRecord(value)) return { ok: false, error: `${at} is not an object.` };
  const name = str(value.op);
  if (!name || !OP_NAMES.has(name)) {
    return { ok: false, error: `${at} has an unknown op ${JSON.stringify(value.op)}.` };
  }

  switch (name) {
    case "add-block": {
      const ref = str(value.ref);
      const blockType = str(value.blockType);
      const blockName = str(value.name);
      if (!ref) return { ok: false, error: `${at} (add-block) is missing its ref.` };
      if (!blockType || !BLOCK_TYPES.has(blockType)) {
        return { ok: false, error: `${at} (add-block) has an unsupported blockType.` };
      }
      if (!blockName) return { ok: false, error: `${at} (add-block) is missing its name.` };
      return {
        ok: true,
        op: {
          op: "add-block",
          ref,
          blockType: blockType as "agent" | "approval" | "condition",
          name: blockName,
          ...(isRecord(value.config) ? { config: value.config } : {}),
          ...(str(value.near) ? { near: str(value.near) as string } : {}),
        },
      };
    }
    case "update-block": {
      const id = str(value.id);
      if (!id) return { ok: false, error: `${at} (update-block) is missing its id.` };
      if (!str(value.name) && !isRecord(value.config)) {
        return { ok: false, error: `${at} (update-block) changes nothing.` };
      }
      return {
        ok: true,
        op: {
          op: "update-block",
          id,
          ...(str(value.name) ? { name: str(value.name) as string } : {}),
          ...(isRecord(value.config) ? { config: value.config } : {}),
        },
      };
    }
    case "remove-block": {
      const id = str(value.id);
      if (!id) return { ok: false, error: `${at} (remove-block) is missing its id.` };
      return { ok: true, op: { op: "remove-block", id } };
    }
    case "connect": {
      const source = str(value.source);
      const target = str(value.target);
      if (!source || !target) return { ok: false, error: `${at} (connect) needs a source and a target.` };
      const kind = str(value.kind);
      if (kind && !EDGE_KINDS.has(kind)) {
        return { ok: false, error: `${at} (connect) has an unsupported kind.` };
      }
      return {
        ok: true,
        op: {
          op: "connect",
          source,
          target,
          ...(kind ? { kind: kind as "next" | "rework" | "question" } : {}),
          ...(str(value.label) ? { label: str(value.label) as string } : {}),
          ...(str(value.condition) ? { condition: str(value.condition) as string } : {}),
        },
      };
    }
    case "disconnect": {
      const edgeId = str(value.edgeId);
      if (!edgeId) return { ok: false, error: `${at} (disconnect) is missing its edgeId.` };
      return { ok: true, op: { op: "disconnect", edgeId } };
    }
    case "update-connection": {
      const edgeId = str(value.edgeId);
      if (!edgeId) return { ok: false, error: `${at} (update-connection) is missing its edgeId.` };
      const kind = str(value.kind);
      if (kind && !EDGE_KINDS.has(kind)) {
        return { ok: false, error: `${at} (update-connection) has an unsupported kind.` };
      }
      return {
        ok: true,
        op: {
          op: "update-connection",
          edgeId,
          ...(kind ? { kind: kind as "next" | "rework" | "question" } : {}),
          ...(str(value.label) !== undefined ? { label: str(value.label) as string } : {}),
          ...(str(value.condition) !== undefined ? { condition: str(value.condition) as string } : {}),
        },
      };
    }
  }
  return { ok: false, error: `${at} could not be read.` };
}

export function parseEditProposal(text: string): EditParseResult {
  const json = extractProposalJson(text);
  if (!json) {
    return { ok: false, error: "No JSON object was found in the interpreter's reply.", raw: text };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: "The interpreter's reply was not valid JSON.", raw: text };
  }
  if (!isRecord(value)) return { ok: false, error: "The proposal is not an object.", raw: text };
  if (value.version !== EDIT_PROPOSAL_VERSION) {
    return {
      ok: false,
      error: `The proposal's version is ${JSON.stringify(value.version)}; this Anthill speaks version ${EDIT_PROPOSAL_VERSION}.`,
      raw: text,
    };
  }
  const summary = str(value.summary);
  if (!summary) return { ok: false, error: "The proposal has no summary.", raw: text };
  if (!Array.isArray(value.ops)) {
    return { ok: false, error: "The proposal's ops is not a list.", raw: text };
  }
  // Empty ops is not malformed — it is the contract's refusal shape: "why this
  // cannot be done as asked" in the summary, and nothing proposed. The caller
  // shows it as a decline, not an error.

  const question = str(value.question);
  // Asking and changing at once is the one combination that cannot be honest:
  // whatever it says it needs to know, it went ahead without the answer.
  if (question && Array.isArray(value.ops) && value.ops.length > 0) {
    return {
      ok: false,
      error: "The reply asks a question and proposes a change at once; it can do one or the other.",
      raw: text,
    };
  }

  const ops: EditOp[] = [];
  for (const [index, raw] of value.ops.entries()) {
    const checked = validateOp(raw, index);
    if (!checked.ok) return { ok: false, error: checked.error, raw: text };
    ops.push(checked.op);
  }
  return {
    ok: true,
    proposal: { version: EDIT_PROPOSAL_VERSION, summary, ops, ...(question ? { question } : {}) },
  };
}

/* ------------------------------------------------------------------ */
/* Applying                                                            */
/* ------------------------------------------------------------------ */

export type EditChange =
  | { kind: "block-added"; id: string; name: string }
  | { kind: "block-updated"; id: string; name: string }
  | { kind: "block-removed"; id: string; name: string }
  | { kind: "connected"; edgeId: string; source: string; target: string }
  | { kind: "disconnected"; edgeId: string; source: string; target: string }
  | { kind: "connection-updated"; edgeId: string };

export type EditApplyResult =
  | { ok: true; workflow: Workflow; changes: EditChange[] }
  | { ok: false; error: string };

/**
 * New ids that collide with nothing this workflow holds *or has held*.
 *
 * The lowest free number was unique among the blocks that existed and not
 * among the blocks that had existed, so deleting a block handed its id to the
 * next one created — and a block id is what a running session prints back at
 * Anthill (ANT-41). The counter the document carries is what remembers.
 */
function newId(workflow: Workflow, prefix: string, taken: Set<string>): string {
  const id = nextIdFor(workflow, prefix, taken);
  taken.add(id);
  return id;
}

const BLOCK_W = 190;
const GAP = 90;
/** Enough to clear a tall block and still read as the same column. */
const ROW = 120;

/**
 * A free spot beside `base`, working downward until nothing is in the way.
 *
 * The obvious placement — one block-width right of the anchor — is the right
 * *first guess* and a bad only guess: an anchor almost always already has a
 * successor sitting exactly there, so a proposal that adds a step "after
 * implement" dropped the new block on top of the block that followed it. On a
 * twenty-block workflow that produced a pile rather than a diagram.
 *
 * Downward rather than further right, because the slot to the right belongs to
 * whatever comes next in the sequence; a branch belongs beside its sibling.
 */
function freeSpot(
  base: { x: number; y: number },
  taken: readonly WorkflowNode[],
): { x: number; y: number } {
  const clash = (spot: { x: number; y: number }) =>
    taken.some((node) => {
      const at = node.position;
      if (!at) return false;
      return Math.abs(at.x - spot.x) < BLOCK_W && Math.abs(at.y - spot.y) < ROW;
    });

  const spot = { x: base.x + BLOCK_W + GAP, y: base.y };
  // Bounded: a workflow with more blocks than this stacked in one column is
  // not a diagram anyone is reading, and an unbounded loop is worse.
  for (let row = 0; row < 40 && clash(spot); row += 1) spot.y += ROW;
  return spot;
}

/**
 * Apply a parsed proposal to a workflow.
 *
 * Pure and all-or-nothing: the input is untouched, and the first operation
 * that cannot be honoured refuses the whole proposal with a reason. The
 * result is schema-validated before it is returned — an assistant cannot
 * hand back a workflow this app would refuse to open.
 */
export function applyEditProposal(workflow: Workflow, proposal: EditProposal): EditApplyResult {
  const nodes = workflow.nodes.map((node) => ({ ...node }));
  const edges = workflow.edges.map((edge) => ({ ...edge }));
  const changes: EditChange[] = [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  /** The proposal's refs, resolved to the real ids this application issued. */
  const refs = new Map<string, string>();

  const resolve = (idOrRef: string): string | undefined =>
    refs.get(idOrRef) ?? (nodeIds.has(idOrRef) ? idOrRef : undefined);

  const nodeById = (id: string): WorkflowNode | undefined => nodes.find((node) => node.id === id);

  for (const op of proposal.ops) {
    switch (op.op) {
      case "add-block": {
        if (refs.has(op.ref) || nodeIds.has(op.ref)) {
          return { ok: false, error: `The proposal reuses the ref "${op.ref}".` };
        }
        const id = newId(workflow, `${op.blockType}-block`, nodeIds);
        refs.set(op.ref, id);

        // Beside its anchor, not a re-layout: the author's arrangement is
        // theirs, and a new block landing nearby is enough to be findable.
        const anchor = op.near ? nodeById(resolve(op.near) ?? "") : undefined;
        const base = anchor?.position ?? furthestRight(nodes);
        const position = freeSpot({ x: base?.x ?? 0, y: base?.y ?? 0 }, nodes);

        const node: WorkflowNode = {
          id,
          type: op.blockType,
          name: op.name,
          config: op.config ?? (op.blockType === "agent" ? { actionKind: "agent-step" } : {}),
          position,
        };
        nodes.push(node);
        changes.push({ kind: "block-added", id, name: op.name });
        break;
      }

      case "update-block": {
        const node = nodeById(op.id);
        if (!node) return { ok: false, error: `There is no block "${op.id}" to update.` };
        if (op.name) node.name = op.name;
        if (op.config) node.config = { ...node.config, ...op.config };
        changes.push({ kind: "block-updated", id: node.id, name: node.name });
        break;
      }

      case "remove-block": {
        const node = nodeById(op.id);
        if (!node) return { ok: false, error: `There is no block "${op.id}" to remove.` };
        if (node.type === "start" || node.type === "end") {
          return { ok: false, error: `The ${node.type} block cannot be removed.` };
        }
        nodes.splice(nodes.indexOf(node), 1);
        nodeIds.delete(node.id);
        // Its connections go with it; each removal is its own visible change.
        for (const edge of [...edges]) {
          if (edge.source === node.id || edge.target === node.id) {
            edges.splice(edges.indexOf(edge), 1);
            changes.push({
              kind: "disconnected",
              edgeId: edge.id,
              source: edge.source,
              target: edge.target,
            });
          }
        }
        changes.push({ kind: "block-removed", id: node.id, name: node.name });
        break;
      }

      case "connect": {
        const source = resolve(op.source);
        const target = resolve(op.target);
        if (!source) return { ok: false, error: `Connect names an unknown source "${op.source}".` };
        if (!target) return { ok: false, error: `Connect names an unknown target "${op.target}".` };
        const id = newId(workflow, "edge", edgeIds);
        const edge: WorkflowEdge = {
          id,
          source,
          target,
          ...(op.kind ? { kind: op.kind } : {}),
          ...(op.label ? { label: op.label } : {}),
          ...(op.condition ? { condition: op.condition } : {}),
        };
        edges.push(edge);
        changes.push({ kind: "connected", edgeId: id, source, target });
        break;
      }

      case "disconnect": {
        const edge = edges.find((item) => item.id === op.edgeId);
        if (!edge) return { ok: false, error: `There is no connection "${op.edgeId}" to remove.` };
        edges.splice(edges.indexOf(edge), 1);
        changes.push({
          kind: "disconnected",
          edgeId: edge.id,
          source: edge.source,
          target: edge.target,
        });
        break;
      }

      case "update-connection": {
        const edge = edges.find((item) => item.id === op.edgeId);
        if (!edge) return { ok: false, error: `There is no connection "${op.edgeId}" to update.` };
        if (op.kind) edge.kind = op.kind;
        if (op.label !== undefined) edge.label = op.label;
        if (op.condition !== undefined) edge.condition = op.condition;
        changes.push({ kind: "connection-updated", edgeId: edge.id });
        break;
      }
    }
  }

  // Every id this application issued is remembered, so a block the author
  // deletes afterwards does not hand its number back out.
  const next: Workflow = rememberIds(
    { ...workflow, nodes, edges },
    ...nodes.map((node) => node.id),
    ...edges.map((edge) => edge.id),
  );

  // Structural validation only, on purpose. The runner-era semantic checks
  // (reachability, per-node completeness) would refuse most honest
  // incremental edits — a block added now and wired by the author next is a
  // normal authoring state, and the canvas's own Problems system is where
  // such gaps belong after acceptance, as the issue itself specifies. What
  // may not pass here is a workflow the schema would refuse to open at all.
  const parsed = WorkflowSchema.safeParse(next);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: `The proposed workflow would not be valid: ${first?.message ?? "schema violation"} at ${first?.path.join(".") ?? "?"}`,
    };
  }
  return { ok: true, workflow: next, changes };
}

function furthestRight(nodes: readonly WorkflowNode[]): { x: number; y: number } | undefined {
  let best: { x: number; y: number } | undefined;
  for (const node of nodes) {
    if (!node.position) continue;
    if (!best || node.position.x > best.x) best = node.position;
  }
  return best;
}
