/**
 * Agent profiles: who does the work.
 *
 * A profile is the reusable agent. A step is one task carried out by a chosen
 * profile. Several steps may share one profile — "Developer" implements, then
 * fixes what review found — and they compile into a single agent file rather
 * than one file per step. That is what makes a one-agent, many-stage workflow
 * expressible without inventing an agent per stage.
 *
 * Identity is the `id`: opaque, assigned once, never derived from the name and
 * never rewritten. The display name lives on the profile and nowhere else, so
 * renaming an agent cannot split it in two and two steps cannot disagree about
 * what it is called. Steps hold nothing but the id.
 *
 * Storage, deliberately: profiles live in `metadata.workflow.agents`, next to
 * the workflow format version. They are a Workflow concern — the future runner
 * resolves agents from files on disk (see docs/workflow-model.md) — so keeping
 * them out of the shared schema leaves the runner's model untouched, the same
 * reasoning that keeps `pendingOutputs` in node config.
 */

import type { Workflow, WorkflowNode } from "@anthill/workflow-schema";

import { migrateModels, readAgentModels, type AgentModels } from "./agent-models.js";
import { nextIdFor, rememberIdsUnder } from "./id-counter.js";
import { agentConfig, slugify } from "./workflow.js";

export type AgentProfile = {
  /** Stable and immutable. Renaming never changes it. */
  id: string;
  /** Editable display name, e.g. "Developer". */
  name: string;
  /**
   * The model chosen for each coding tool, for the tools somebody has answered
   * for. Absent for a tool nobody has answered for, which is not the same as
   * answering "inherit the session's": see `agent-models.ts`.
   */
  models?: AgentModels;
  /**
   * A stored answer the author has to settle, kept verbatim.
   *
   * Not guessed at and not dropped. It is their own choice, and the only
   * honest thing to do with one whose meaning is ambiguous — a bare name
   * belonging to no tool, or a second answer where there is now room for one —
   * is show it back and ask.
   */
  modelNeedsReview?: string;
  /** What this agent is for, in a few words. Optional. */
  role?: string;
  /** Longer description, used as the generated file's description. Optional. */
  description?: string;
  /**
   * The global library profile this one came from, when it came from one.
   *
   * A back-reference, not the identity: `id` still says who this agent is
   * inside this workflow, and steps still point at `id` alone. This only
   * records where it came from, so the library can answer "is anything still
   * using me?" before a profile is deleted, and so a copy is recognisable as a
   * copy rather than looking like an unrelated agent that happens to share a
   * name. Editing either side does not touch the other: the workflow's copy is
   * the workflow's, which is what makes a saved workflow keep working after
   * the library changes underneath it.
   */
  libraryId?: string;
  /**
   * Reserved for settings that only mean something once a workflow can be run —
   * permissions, tool access, MCP servers. Nothing reads it today. It is
   * carried through save and load unchanged so a later build can fill it in
   * without another format break.
   */
  settings?: Record<string, unknown>;
};

const NAMESPACE = "workflow";
const KEY = "agents";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readProfile(value: unknown): AgentProfile | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  if (!id) return undefined;

  // Absent fields are left out rather than set to `undefined`: a profile is
  // written straight back on every edit, and a key carrying `undefined` reads
  // as "this field exists and is empty" everywhere downstream.
  const role = readString(value.role);
  const description = readString(value.description);
  const libraryId = readString(value.libraryId);

  // Migration happens here, on the way in, so exactly one shape reaches the
  // rest of the program. A file written in either older shape — one bare model
  // name, or a model per tool — is read into this one and written back in it,
  // and anything that cannot be settled without guessing is carried for the
  // author to settle rather than assigned to a guess.
  const stored = readAgentModels(value.models);
  const migrated = stored ? { models: stored } : migrateModels(value.models ?? value.model);

  return {
    id,
    name: typeof value.name === "string" ? value.name : "",
    ...(Object.keys(migrated.models).length > 0 ? { models: migrated.models } : {}),
    ...(migrated.needsReview ? { modelNeedsReview: migrated.needsReview } : {}),
    ...(role ? { role } : {}),
    ...(description ? { description } : {}),
    ...(libraryId ? { libraryId } : {}),
    ...(isRecord(value.settings) ? { settings: value.settings } : {}),
  };
}

/** Every profile in a workflow, in the order they were added. */
export function agentProfiles(workflow: Workflow): AgentProfile[] {
  const metadata = workflow.metadata;
  if (!isRecord(metadata)) return [];
  const bag = metadata[NAMESPACE];
  if (!isRecord(bag)) return [];
  const raw = bag[KEY];
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  return raw.flatMap((item) => {
    const profile = readProfile(item);
    // A duplicate id would give two profiles the same identity, and every
    // lookup would silently pick one of them.
    if (!profile || seen.has(profile.id)) return [];
    seen.add(profile.id);
    return [profile];
  });
}

export function findAgentProfile(
  workflow: Workflow,
  id: string | undefined,
): AgentProfile | undefined {
  if (!id) return undefined;
  return agentProfiles(workflow).find((profile) => profile.id === id);
}

/**
 * A fresh profile id. Opaque — the display name plays no part in it.
 *
 * Not merely unused: never used. The lowest free number gave a deleted
 * profile's id back to the next one created (ANT-49), and a profile id is
 * what every step assigned to it carries in `config.agentId`. Deleting a
 * profile a step still uses is already refused, so the document cannot be
 * left holding a dangling reference — but an id that comes back means two
 * different agents share a name across the life of one file, in the journal
 * and in anything written from it, and that is a claim nobody made.
 *
 * Counted apart from block ids, which wear the same `agent-` prefix: they are
 * separate identities in separate places, and one shared tally would renumber
 * neither honestly.
 */
export function newAgentId(workflow: Workflow, existing: readonly string[] = []): string {
  return nextIdFor(workflow, "agent", existing, PROFILE_COUNTER);
}

/** File-safe form of a profile's name, used for the generated agent file. */
export function agentSlug(profile: AgentProfile): string {
  return slugify(profile.name) || slugify(profile.id);
}

/** Write the profile list back, dropping the key entirely when it is empty. */
/** The tally profile ids are counted under, kept apart from the blocks'. */
const PROFILE_COUNTER = "agentProfile";

function withProfiles(workflow: Workflow, profiles: AgentProfile[]): Workflow {
  // Every id the document holds is remembered here rather than where one is
  // minted, so a profile that arrived with a template or a pasted file
  // occupies its number too.
  workflow = rememberIdsUnder(
    workflow,
    PROFILE_COUNTER,
    profiles.map((profile) => profile.id),
  );
  const metadata = isRecord(workflow.metadata) ? workflow.metadata : {};
  const bag = isRecord(metadata[NAMESPACE]) ? { ...(metadata[NAMESPACE] as object) } : {};
  const next = { ...bag } as Record<string, unknown>;
  if (profiles.length === 0) delete next[KEY];
  else next[KEY] = profiles;

  return { ...workflow, metadata: { ...metadata, [NAMESPACE]: next } };
}

export type AddAgentResult = { workflow: Workflow; agentId: string };

/**
 * Add a profile. The caller may seed any field; the id is assigned here so it
 * cannot be chosen from the name by mistake.
 */
export function addAgentProfile(
  workflow: Workflow,
  draft: Omit<Partial<AgentProfile>, "id"> = {},
): AddAgentResult {
  const profiles = agentProfiles(workflow);
  const agentId = newAgentId(workflow, profiles.map((profile) => profile.id));
  const profile: AgentProfile = {
    id: agentId,
    name: draft.name ?? "",
    ...(draft.models && Object.keys(draft.models).length > 0 ? { models: draft.models } : {}),
    ...(draft.modelNeedsReview ? { modelNeedsReview: draft.modelNeedsReview } : {}),
    ...(draft.role ? { role: draft.role } : {}),
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.libraryId ? { libraryId: draft.libraryId } : {}),
    ...(draft.settings ? { settings: draft.settings } : {}),
  };
  return { workflow: withProfiles(workflow, [...profiles, profile]), agentId };
}

export type AgentPatch = {
  name?: string;
  /**
   * The whole per-tool bag, replaced rather than merged.
   *
   * The absence of a tool's key is the message — "nobody has answered for this
   * one" — and a patch that only ever added keys could not send it. An empty
   * bag clears the lot, and clears any pending review with it.
   */
  models?: AgentModels;
  /** `undefined` clears the field. */
  role?: string | undefined;
  description?: string | undefined;
};

/**
 * Change a profile's editable fields.
 *
 * The id is not among them: it is the identity every step points at, and
 * letting it be edited is the one change that would break references.
 */
export function updateAgentProfile(
  workflow: Workflow,
  id: string,
  patch: AgentPatch,
): Workflow {
  const profiles = agentProfiles(workflow);
  if (!profiles.some((profile) => profile.id === id)) return workflow;

  return withProfiles(
    workflow,
    profiles.map((profile) => {
      if (profile.id !== id) return profile;
      const next: AgentProfile = { ...profile };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.models !== undefined) {
        // Answering the model question at all settles the migration's open
        // one, so the value awaiting review goes with it.
        delete next.modelNeedsReview;
        if (Object.keys(patch.models).length === 0) delete next.models;
        else next.models = patch.models;
      }
      for (const key of ["role", "description"] as const) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value === undefined || value.trim().length === 0) delete next[key];
        else next[key] = value;
      }
      return next;
    }),
  );
}

/**
 * Whether this workflow holds a copy of a given library profile.
 *
 * The question the library has to answer before deleting one: not "does a name
 * match" — names are editable on both sides and prove nothing — but "does any
 * profile here still point back at that id".
 */
export function usesLibraryAgent(workflow: Workflow, libraryId: string): boolean {
  return agentProfiles(workflow).some((profile) => profile.libraryId === libraryId);
}

/** The steps a profile is assigned to, in diagram order. */
export function stepsUsingAgent(workflow: Workflow, id: string): WorkflowNode[] {
  return workflow.nodes.filter(
    (node) => node.type === "agent" && agentConfig(node).agentId === id,
  );
}

/**
 * Remove a profile.
 *
 * Refuses while any step still points at it: deleting it would leave those
 * steps referencing an agent that does not exist, which is a workflow that cannot
 * be compiled and a change the author did not ask for. The caller reassigns
 * those steps first — `stepsUsingAgent` says which ones.
 */
export function removeAgentProfile(workflow: Workflow, id: string): Workflow {
  if (stepsUsingAgent(workflow, id).length > 0) return workflow;
  return withProfiles(
    workflow,
    agentProfiles(workflow).filter((profile) => profile.id !== id),
  );
}

/** Point a step at a profile. */
export function assignAgent(
  workflow: Workflow,
  nodeId: string,
  agentId: string,
): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.id === nodeId ? { ...node, config: { ...node.config, agentId } } : node,
    ),
  };
}

/** The profile a step is assigned to, if it has one that exists. */
export function agentForNode(
  workflow: Workflow,
  nodeId: string,
): AgentProfile | undefined {
  const node = workflow.nodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "agent") return undefined;
  return findAgentProfile(workflow, agentConfig(node).agentId);
}

export type AgentAssignment = {
  profile: AgentProfile;
  /** File-safe form of the display name. */
  slug: string;
  /** Steps carried out by this agent, in the order given. */
  stepIds: string[];
};

/**
 * The profiles actually used by the workflow, in the order their first step
 * appears.
 *
 * `nodeOrder` lets the caller pass the compiled step order so generated files
 * follow the same sequence as the prompt. A profile nobody uses is left out —
 * it exists in the library but has nothing to say in the output.
 */
export function assignedAgents(
  workflow: Workflow,
  nodeOrder?: readonly WorkflowNode[],
): AgentAssignment[] {
  const nodes = nodeOrder ?? workflow.nodes;
  const byId = new Map<string, AgentAssignment>();

  for (const node of nodes) {
    if (node.type !== "agent") continue;
    const profile = findAgentProfile(workflow, agentConfig(node).agentId);
    if (!profile) continue;

    const existing = byId.get(profile.id);
    if (existing) {
      existing.stepIds.push(node.id);
      continue;
    }
    byId.set(profile.id, { profile, slug: agentSlug(profile), stepIds: [node.id] });
  }

  return [...byId.values()];
}
