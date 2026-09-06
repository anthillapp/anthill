/**
 * The workflow document format version.
 *
 * Stored under `metadata.workflow` rather than as a field on `Workflow`, so a
 * Workflow-only concern stays out of the shared schema the future runner also
 * uses.
 *
 * The point of stamping it now is that the next format change is a deliberate
 * break: a workflow written by a newer Workflow must fail to open with a clear
 * message instead of loading with fields silently missing. Workflows written before
 * versioning existed have no stamp and are reported as legacy.
 */

import type { Workflow } from "@anthill/workflow-schema";

/**
 * Everything here takes `unknown` rather than `Workflow` on purpose. The
 * compatibility check has to run on the raw parsed JSON, before schema parsing:
 * a workflow from a newer build may not satisfy this build's schema at all, and a
 * generic "invalid workflow" error would hide the real reason it cannot be
 * opened.
 */

/**
 * Bump when a change makes older workflows unreadable without migration.
 *
 * 2 — steps carry an action and a role (`actionKind`, `roleId`, `roleName`)
 *     instead of the block name doubling as the agent's identity, and
 *     `description` became `purpose`. A version 1 workflow loads with steps that
 *     have no action and no role, which validation reports per block.
 * 3 — agents became reusable profiles stored on the workflow. A step points at one
 *     by `agentId` and carries nothing else about it; the name and model that
 *     used to be repeated on every step (`roleName`, `model`) live on the
 *     profile. `migrateWorkflow` upgrades a version 2 workflow automatically, so this
 *     break costs the author nothing.
 * 4 — a workflow drafted from a prompt keeps its open questions as answerable
 *     objects — each with an id, what it is about, the alternatives offered and
 *     the author's answer — rather than as two lists of anonymous strings.
 *     Upgraded automatically; the old strings become questions nobody answered.
 * 5 — the document is a workflow in the code as well as on screen. Its own
 *     metadata moved from `metadata.workflow` to `metadata.workflow`, and the
 *     `plan-decompose` action became `decompose` — the word "plan" was the
 *     verb there, and the step is named for what it does. Both are rewritten
 *     automatically; nothing is lost and nothing needs re-saving by hand.
 */
export const WORKFLOW_FORMAT_VERSION = 5;

const NAMESPACE = "workflow";

/**
 * Where a workflow's own metadata lived before version 5.
 *
 * Read from, never written to. Every file saved before this rename has its
 * agents and its format version under this key, so a reader that only knew the
 * new one would see an unversioned workflow with no agents — which is exactly
 * how a rename destroys someone's work without erroring.
 */
const LEGACY_NAMESPACE = "planner";

type WorkflowMetadata = { formatVersion?: number };

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function workflowMetadata(workflow: unknown): WorkflowMetadata {
  if (!isRecord(workflow)) return {};
  const metadata = workflow.metadata;
  if (!isRecord(metadata)) return {};
  const bag = metadata[NAMESPACE] ?? metadata[LEGACY_NAMESPACE];
  return isRecord(bag) ? (bag as WorkflowMetadata) : {};
}

/** The format a workflow was written with, or `undefined` if it predates versioning. */
export function workflowFormatVersion(workflow: unknown): number | undefined {
  const version = workflowMetadata(workflow).formatVersion;
  return typeof version === "number" && Number.isInteger(version) ? version : undefined;
}

/** Stamp the current format onto a workflow. Call this on save. */
export function stampWorkflowFormat(workflow: Workflow): Workflow {
  return {
    ...workflow,
    metadata: {
      ...workflow.metadata,
      [NAMESPACE]: {
        ...workflowMetadata(workflow),
        formatVersion: WORKFLOW_FORMAT_VERSION,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

export type WorkflowMigration = {
  /** The upgraded document, or the original when there was nothing to do. */
  workflow: unknown;
  /** What changed, for the app to show the author. Empty when nothing did. */
  notes: string[];
};

/**
 * Turn the roles repeated across a version 2 workflow's steps into agent profiles.
 *
 * The old `roleId` was already a stable identity, so it is kept as the profile
 * id: every step's reference stays valid and nothing has to be rewritten
 * except the key it is stored under. The name and model, which used to be
 * copied onto every step sharing a role, are collected onto the profile — the
 * first non-empty one wins, which is what `collectRoles` did when reading them.
 */
function upgradeTwoToThree(workflow: Record<string, unknown>): WorkflowMigration {
  const nodes = isArray(workflow.nodes) ? workflow.nodes : [];
  const profiles: { id: string; name: string; model?: string }[] = [];
  const byId = new Map<string, { id: string; name: string; model?: string }>();

  const nextNodes = nodes.map((node) => {
    if (!isRecord(node) || node.type !== "agent") return node;
    const config = isRecord(node.config) ? { ...node.config } : {};
    const roleId = typeof config.roleId === "string" ? config.roleId : undefined;
    const roleName = typeof config.roleName === "string" ? config.roleName.trim() : "";
    const model = typeof config.model === "string" ? config.model.trim() : "";

    delete config.roleId;
    delete config.roleName;
    delete config.model;
    if (!roleId) return { ...node, config };

    const existing = byId.get(roleId);
    if (existing) {
      if (!existing.name && roleName) existing.name = roleName;
      if (!existing.model && model) existing.model = model;
    } else {
      const profile = { id: roleId, name: roleName, ...(model ? { model } : {}) };
      byId.set(roleId, profile);
      profiles.push(profile);
    }

    return { ...node, config: { ...config, agentId: roleId } };
  });

  const metadata = isRecord(workflow.metadata) ? workflow.metadata : {};
  const bag = isRecord(metadata[NAMESPACE]) ? (metadata[NAMESPACE] as object) : {};

  const notes =
    profiles.length === 0
      ? []
      : [
          `Upgraded from workflow format 2. The ${profiles.length} role${
            profiles.length === 1 ? "" : "s"
          } in this workflow ${profiles.length === 1 ? "is" : "are"} now ${
            profiles.length === 1 ? "an agent profile" : "agent profiles"
          } you can edit in the Agents tab.`,
        ];

  return {
    workflow: {
      ...workflow,
      nodes: nextNodes,
      metadata: {
        ...metadata,
        [NAMESPACE]: { ...bag, formatVersion: 3, agents: profiles },
      },
    },
    notes,
  };
}

/**
 * Turn a version 3 workflow's loose question strings into answerable questions.
 *
 * Version 3 recorded what the interpreter was unsure about as two lists of
 * plain strings, which is enough to show and nothing else: no way to say what a
 * question is about, and nowhere to put an answer. They become question objects
 * with a workflow-level locator and no answer, which is exactly what they were —
 * open questions, still open.
 */
function upgradeThreeToFour(workflow: Record<string, unknown>): WorkflowMigration {
  const metadata = isRecord(workflow.metadata) ? workflow.metadata : {};
  const bag = (
    isRecord(metadata[NAMESPACE]) ? { ...(metadata[NAMESPACE] as object) } : {}
  ) as Record<string, unknown>;
  const source = isRecord(bag.source) ? { ...bag.source } : undefined;

  const notes: string[] = [];
  if (source) {
    const strings = [
      ...(isArray(source.uncertainties) ? source.uncertainties : []),
      ...(isArray(source.questions) ? source.questions : []),
    ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);

    if (strings.length > 0) {
      source.questions = strings.map((question, index) => ({
        id: `q${index + 1}`,
        question,
        about: { kind: "workflow" },
        options: [],
      }));
      notes.push(
        `Upgraded from workflow format 3. The ${strings.length} open question${
          strings.length === 1 ? "" : "s"
        } this workflow was drafted with ${
          strings.length === 1 ? "is" : "are"
        } now answerable in the brief.`,
      );
    } else {
      source.questions = [];
    }
    delete source.uncertainties;
    bag.source = source;
  }

  return {
    workflow: {
      ...workflow,
      metadata: { ...metadata, [NAMESPACE]: { ...bag, formatVersion: 4 } },
    },
    notes,
  };
}

/**
 * Version 4 to 5: the metadata namespace and one action id.
 *
 * `metadata.workflow` becomes `metadata.workflow`, and the old key is removed
 * rather than left as a second copy that later drifts. The `plan-decompose`
 * action becomes `decompose`, which is what the step actually does — "plan"
 * there was the verb, and the rename is the reason this version exists.
 */
/**
 * Action ids that changed with the rename, old to new.
 *
 * `plan-decompose` carried the old word; "plan" there was the verb, and the
 * step is now named for what it does. `release-publish-plan` briefly became
 * `release-publish-workflow`, which read as "publish the workflow" — it is
 * about a release, not about this document.
 */
const RENAMED_ACTIONS: Record<string, { kind: string; label: string }> = {
  "plan-decompose": { kind: "decompose", label: "Decompose" },
  "release-publish-plan": { kind: "release-publish", label: "Release / Publish" },
  "release-publish-workflow": { kind: "release-publish", label: "Release / Publish" },
};

function upgradeFourToFive(workflow: Record<string, unknown>): WorkflowMigration {
  const metadata = isRecord(workflow.metadata) ? { ...workflow.metadata } : {};
  const bag = isRecord(metadata[LEGACY_NAMESPACE])
    ? { ...(metadata[LEGACY_NAMESPACE] as Record<string, unknown>) }
    : isRecord(metadata[NAMESPACE])
      ? { ...(metadata[NAMESPACE] as Record<string, unknown>) }
      : {};
  delete metadata[LEGACY_NAMESPACE];

  const notes: string[] = [];
  const nodes = isArray(workflow.nodes)
    ? workflow.nodes.map((node) => {
        if (!isRecord(node) || !isRecord(node.config)) return node;
        const renamed = RENAMED_ACTIONS[node.config.actionKind as string];
        if (!renamed) return node;
        notes.push(`"${String(node.name ?? node.id)}" now uses the ${renamed.label} action.`);
        return { ...node, config: { ...node.config, actionKind: renamed.kind } };
      })
    : workflow.nodes;

  return {
    workflow: {
      ...workflow,
      nodes,
      metadata: { ...metadata, [NAMESPACE]: { ...bag, formatVersion: 5 } },
    },
    notes,
  };
}

/**
 * Bring a workflow up to the current format where this build knows how.
 *
 * Runs on the raw parsed JSON, before schema parsing, for the same reason the
 * compatibility check does. A workflow it cannot upgrade — one written before
 * versioning, or by a newer build — comes back untouched, and
 * `checkWorkflowCompatibility` is what decides whether to open it anyway.
 */
export function migrateWorkflow(workflow: unknown): WorkflowMigration {
  if (!isRecord(workflow)) return { workflow, notes: [] };

  // Applied in order, so a version 2 workflow arrives at the current format in one
  // call rather than needing to be opened and saved once per step.
  let current: unknown = workflow;
  const notes: string[] = [];
  for (const [from, upgrade] of [
    [2, upgradeTwoToThree],
    [3, upgradeThreeToFour],
    [4, upgradeFourToFive],
  ] as const) {
    if (workflowFormatVersion(current) !== from) continue;
    const step = upgrade(current as Record<string, unknown>);
    current = step.workflow;
    notes.push(...step.notes);
  }

  return { workflow: current, notes };
}

/* ------------------------------------------------------------------ */
/* Compatibility                                                       */
/* ------------------------------------------------------------------ */

export type WorkflowCompatibility =
  | { ok: true; version: number }
  /** Written before versioning, or by an older Workflow. */
  | { ok: false; reason: "legacy"; version?: number; message: string }
  /** Written by a newer Workflow than this one. */
  | { ok: false; reason: "too-new"; version: number; message: string };

/**
 * Decide whether this Workflow can open a workflow.
 *
 * A workflow from the future is refused outright — loading it would drop whatever
 * this build does not understand and then save the loss back over the file.
 */
export function checkWorkflowCompatibility(workflow: unknown): WorkflowCompatibility {
  const version = workflowFormatVersion(workflow);

  if (version === undefined) {
    return {
      ok: false,
      reason: "legacy",
      message:
        "This workflow was saved before workflow versioning existed. Open it, check every block, and save it again to bring it up to date.",
    };
  }

  if (version > WORKFLOW_FORMAT_VERSION) {
    return {
      ok: false,
      reason: "too-new",
      version,
      message: `This workflow was saved by a newer version of Anthill (workflow format ${version}; this build understands ${WORKFLOW_FORMAT_VERSION}). Update Anthill to open it — opening it here would discard the parts this build does not understand.`,
    };
  }

  if (version < WORKFLOW_FORMAT_VERSION) {
    return {
      ok: false,
      reason: "legacy",
      version,
      message: `This workflow uses workflow format ${version}; this build writes ${WORKFLOW_FORMAT_VERSION}. Open it, check every block, and save it again to bring it up to date.`,
    };
  }

  return { ok: true, version };
}
