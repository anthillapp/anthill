/**
 * Deciding which workflow block an observed event belongs to — and saying how.
 *
 * Anthill is not driving the session, so it has no privileged knowledge of
 * where the work has got to. Every mapping below is therefore evidence of a
 * different strength, and the strength travels with the mapping so the page can
 * draw them differently. Three tiers, and nothing between them:
 *
 * - `exact` — the agent printed an Anthill step marker naming this block. This
 *   is the only tier allowed to move a block's run state, because it is the
 *   only one where something outside Anthill actually said so.
 * - `likely` — the record names an agent that belongs to exactly one block, or
 *   the event fell inside a step the agent had announced. Useful, and labelled
 *   as an inference everywhere it appears.
 * - `unmapped` — nothing lined up. Shown as session-level activity rather than
 *   quietly attached to whichever block happens to be current.
 *
 * The last rule is the important one. Attaching unmapped work to the active
 * block would make the graph look better and be wrong, and a workflow diagram that
 * is confidently wrong is worse than one that admits a gap.
 */

import type { Workflow } from "@anthill/workflow-schema";
import { agentProfiles, agentSlug, agentConfig } from "@anthill/workflow";

import type { ObservationEvent } from "./observation-event.js";

export type MappingConfidence = "exact" | "likely" | "unmapped";

export type BlockMapping = {
  blockId?: string;
  confidence: MappingConfidence;
  /** Plain words for why, shown under the event. Never omitted. */
  how: string;
};

/** The blocks a run could be on, and the agent names that point at them. */
export type WorkflowIndex = {
  blocks: { id: string; name: string; agentSlug?: string; agentName?: string }[];
  /** Agent slug -> the blocks that use it. Only a single owner can attribute. */
  byAgent: Map<string, string[]>;
};

export function buildWorkflowIndex(workflow: Workflow): WorkflowIndex {
  const profiles = new Map(agentProfiles(workflow).map((p) => [p.id, p]));
  const blocks = workflow.nodes
    .filter((node) => node.type !== "start" && node.type !== "end")
    .map((node) => {
      const profile = agentConfig(node).agentId
        ? profiles.get(agentConfig(node).agentId as string)
        : undefined;
      return {
        id: node.id,
        name: node.name,
        ...(profile ? { agentSlug: agentSlug(profile), agentName: profile.name } : {}),
      };
    });

  const byAgent = new Map<string, string[]>();
  for (const block of blocks) {
    if (!block.agentSlug) continue;
    byAgent.set(block.agentSlug, [...(byAgent.get(block.agentSlug) ?? []), block.id]);
  }
  return { blocks, byAgent };
}

/** Loosely comparable form of an agent name, so "Test Runner" matches `test-runner`. */
function normalizeAgent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Attribute one event.
 *
 * `announced` is the block the agent last said it was on, or undefined if it
 * has never said. It is passed in rather than tracked here so the function
 * stays pure and a replay attributes exactly as the live pass did.
 */
export function attribute(
  event: ObservationEvent,
  index: WorkflowIndex,
  announced: string | undefined,
): BlockMapping {
  // The agent said so. Nothing outranks that, and nothing else may produce it.
  if (event.kind === "step.marker" && event.blockId) {
    const known = index.blocks.some((block) => block.id === event.blockId);
    return known
      ? { blockId: event.blockId, confidence: "exact", how: "the agent announced this step" }
      : { confidence: "unmapped", how: `the agent announced "${event.blockId}", which is not a step in this workflow` };
  }

  // A named agent, when exactly one block uses it. Two blocks sharing an agent
  // is not evidence for either of them.
  if (event.agentName) {
    const wanted = normalizeAgent(event.agentName);
    const owners = index.byAgent.get(wanted);
    if (owners?.length === 1) {
      return { blockId: owners[0], confidence: "likely", how: `${event.agentName} – mapped by agent name` };
    }
    if (owners && owners.length > 1) {
      return {
        confidence: "unmapped",
        how: `${event.agentName} carries out ${owners.length} steps, so this could be any of them`,
      };
    }
  }

  // Inside a step the agent announced. The step boundary is exact; that this
  // particular event belongs to it is an inference, and is labelled as one.
  if (announced) {
    const block = index.blocks.find((item) => item.id === announced);
    if (block) {
      return { blockId: announced, confidence: "likely", how: `inside the step the agent announced` };
    }
  }

  return { confidence: "unmapped", how: "nothing in the record names a step" };
}
