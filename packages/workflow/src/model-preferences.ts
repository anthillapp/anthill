/**
 * The author's own say about models, kept on this machine (ANT-135).
 *
 * Three things, all of them preferences about *choosing* a model rather than
 * facts about any workflow:
 *
 * - **Hidden models.** A tool may offer a dozen models and an author uses two.
 *   The rest can be kept out of the pickers so they stay short.
 * - **A starting answer per tool.** What a new agent is given for each tool
 *   before anyone edits it.
 * - **Tiers.** *Fast*, *Strong* and *Deep reasoning*, each meaning one model
 *   per tool — so one choice answers for every tool at once.
 *
 * None of this goes into a workflow file, and that is the design rather than an
 * omission. An agent's models are stored per tool, explicitly, and resolved
 * with nothing read from the machine (see `agent-models.ts`): the file may live
 * in a repository and be opened on two computers, and both have to decide
 * about it identically. A file that said "strong" would decide differently on
 * every machine that mapped "strong" differently. So a tier is applied, not
 * stored: choosing one writes that tier's model into every tool's slot on the
 * agent, and the file says exactly what it said before — which model, per tool.
 * The tier an agent is on is read back by comparison, never kept.
 *
 * That is also what makes a workflow portable between tools. Today an agent
 * answered for Claude Code has nothing to say to Codex; one put on a tier has
 * an answer for every tool the tier maps.
 */

import type { HarnessTarget } from "@anthill/workflow-schema";
import { HARNESS_TARGETS } from "@anthill/workflow-schema";

import { readModelChoice, type AgentModels, type HarnessModelChoice } from "./agent-models.js";

export const MODEL_TIERS = ["fast", "strong", "deep"] as const;
export type ModelTierId = (typeof MODEL_TIERS)[number];

/** How each tier is named and explained wherever it is offered. */
export const MODEL_TIER_LABELS: Record<ModelTierId, { label: string; hint: string }> = {
  fast: { label: "Fast", hint: "Quick, cheap steps: reading, listing, simple edits." },
  strong: { label: "Strong", hint: "The everyday choice for real work." },
  deep: { label: "Deep reasoning", hint: "Hard problems: design, debugging, review." },
};

export type ModelPreferences = {
  /** Per tool, the model ids kept out of the agent pickers. */
  hidden: Partial<Record<HarnessTarget, string[]>>;
  /** Per tool, the answer a new agent starts with. Absent: a new agent starts unanswered. */
  defaults: Partial<Record<HarnessTarget, HarnessModelChoice>>;
  /** Per tier, per tool, the model that tier means there. */
  tiers: Record<ModelTierId, Partial<Record<HarnessTarget, HarnessModelChoice>>>;
};

/**
 * What an author who has said nothing gets.
 *
 * Tiers come mapped for Claude Code only. Its models are declared, so the
 * mapping is a fact about names that exist; Codex's and pi's are discovered
 * on the machine, and mapping a tier to one of them from here would be
 * guessing at a list this package has never seen. Those wait for the author.
 *
 * No hidden models and no starting answers: a new agent keeps starting the way
 * it does today until someone says otherwise.
 */
export const DEFAULT_MODEL_PREFERENCES: ModelPreferences = {
  hidden: {},
  defaults: {},
  tiers: {
    fast: { "claude-code": { id: "haiku" } },
    strong: { "claude-code": { id: "sonnet" } },
    deep: { "claude-code": { id: "opus" } },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One per-tool bag of choices, keeping only tools and answers that exist. */
function readChoices(value: unknown): Partial<Record<HarnessTarget, HarnessModelChoice>> {
  const out: Partial<Record<HarnessTarget, HarnessModelChoice>> = {};
  if (!isRecord(value)) return out;
  for (const target of HARNESS_TARGETS) {
    const choice = readModelChoice(target, value[target]);
    if (choice) out[target] = choice;
  }
  return out;
}

/**
 * Stored preferences, whatever shape they arrived in.
 *
 * Forgiving by field, because this is a preferences file and the worst it can
 * do is forget a preference: a damaged part is dropped and the rest is kept,
 * and a tier nobody wrote keeps its default rather than becoming empty.
 */
export function readModelPreferences(value: unknown): ModelPreferences {
  const bag = isRecord(value) ? value : {};

  const hidden: ModelPreferences["hidden"] = {};
  if (isRecord(bag.hidden)) {
    for (const target of HARNESS_TARGETS) {
      const list = bag.hidden[target];
      if (!Array.isArray(list)) continue;
      const ids = [...new Set(list.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim()))];
      if (ids.length > 0) hidden[target] = ids;
    }
  }

  const tiers = { ...DEFAULT_MODEL_PREFERENCES.tiers };
  if (isRecord(bag.tiers)) {
    for (const tier of MODEL_TIERS) {
      // A tier that was written at all is taken as written, even when it is
      // empty: clearing a default mapping is an answer too.
      if (tier in bag.tiers) tiers[tier] = readChoices(bag.tiers[tier]);
    }
  }

  return { hidden, defaults: readChoices(bag.defaults), tiers };
}

/**
 * The models a picker should offer for one tool.
 *
 * The hidden ones are left out — except the one already chosen. A picker that
 * cannot show the stored answer reads as though there were none, and the next
 * edit would quietly replace it.
 */
export function visibleModelIds(
  ids: readonly string[],
  target: HarnessTarget,
  preferences: ModelPreferences,
  chosen?: string,
): string[] {
  const hidden = new Set(preferences.hidden[target] ?? []);
  return ids.filter((id) => !hidden.has(id) || id === chosen);
}

/**
 * The same agent, put on a tier.
 *
 * Every tool the tier maps gets that tier's model, replacing whatever it had.
 * A tool the tier says nothing about keeps its own answer: the tier has no
 * opinion there, and wiping it would lose a choice the author made by hand.
 */
export function applyTier(models: AgentModels | undefined, tier: ModelTierId, preferences: ModelPreferences): AgentModels {
  return { ...(models ?? {}), ...preferences.tiers[tier] };
}

/**
 * The tier an agent is on, read back rather than stored.
 *
 * An agent is on a tier when every tool the tier maps holds exactly that
 * tier's model. Checked in the tiers' own order, so an agent that matches two
 * identical mappings is reported on the first. A tier that maps nothing
 * matches nothing: "on a tier that says nothing" is not a thing to report.
 */
export function tierOf(models: AgentModels | undefined, preferences: ModelPreferences): ModelTierId | undefined {
  for (const tier of MODEL_TIERS) {
    const mapping = Object.entries(preferences.tiers[tier]) as [HarnessTarget, HarnessModelChoice][];
    if (mapping.length === 0) continue;
    const matches = mapping.every(([target, choice]) => {
      const held = models?.[target];
      return held !== undefined && held.id === choice.id && (held.reasoningEffort ?? "") === (choice.reasoningEffort ?? "");
    });
    if (matches) return tier;
  }
  return undefined;
}

/**
 * What a new agent starts with.
 *
 * The author's starting answers, per tool. Nothing when they have given none,
 * which keeps a new agent exactly as unanswered as it was before this existed.
 */
export function startingModels(preferences: ModelPreferences): AgentModels | undefined {
  const models = { ...preferences.defaults };
  return Object.keys(models).length > 0 ? models : undefined;
}
