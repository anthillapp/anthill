/**
 * An agent's model, per coding tool.
 *
 * A profile is Anthill's, not a tool's, and the same agent may be handed to
 * Claude Code today and Codex tomorrow. Those two share no model vocabulary, so
 * one answer could not be right for both — and an answer without a tool cannot
 * be honoured or even displayed. Each tool therefore gets its own answer, and
 * neither is ever translated into the other's terms.
 *
 * Codex additionally carries a reasoning effort, because its own agent files
 * do: `model` and `model_reasoning_effort` are separate keys there, and folding
 * them into one string would make Anthill invent a syntax nobody reads.
 *
 * Three states per tool, and the second and third are both answers:
 *
 * | Shape                          | Means                                   |
 * | ------------------------------ | --------------------------------------- |
 * | key absent                     | nobody has answered for this tool       |
 * | `{ id: HARNESS_DEFAULT }`      | inherit — whatever the session decides   |
 * | `{ id: "opus" }`               | that model                              |
 *
 * "Not answered" and "answered: inherit" are not the same fact. The first is a
 * question nobody has put to anyone, which a workflow can raise; the second is
 * a decision, and raising it would be arguing with the author.
 */

import type { HarnessTarget } from "@anthill/workflow-schema";
import { HARNESS_TARGETS } from "@anthill/workflow-schema";

import { harnessProfile } from "./harness.js";

/** One tool's answer: which model, and how hard it should think. */
export type HarnessModelChoice = {
  id: string;
  /** Only meaningful where the harness has the concept. */
  reasoningEffort?: string;
};

/** What has been answered, for the tools somebody has answered for. */
export type AgentModels = Partial<Record<HarnessTarget, HarnessModelChoice>>;

/**
 * "Whatever the session decides", as a stored answer rather than an absence.
 *
 * A sentinel rather than `""`, so the stored file says what it means. It is
 * also what Codex's own precedence rules call inheriting from the parent: a
 * custom agent that omits `model` takes the spawning session's.
 */
export const HARNESS_DEFAULT = "__default__";

export function isConfiguredFor(models: AgentModels | undefined, target: HarnessTarget): boolean {
  return models !== undefined && models[target] !== undefined;
}

/** The tools somebody has answered for, in the canonical order. */
export function configuredHarnesses(models: AgentModels | undefined): HarnessTarget[] {
  return HARNESS_TARGETS.filter((target) => isConfiguredFor(models, target));
}

/**
 * The model the author actually chose, or nothing.
 *
 * `undefined` for a tool nobody answered for *and* for an answer of "inherit".
 * Both mean "do not write a model down", which is how a generated agent file
 * says "use the session's" — writing a resolved name instead would turn a
 * deliberate inherit into a pin, and pin it to whatever Anthill happened to
 * believe the default was on the day the file was written.
 */
export function explicitModelFor(
  models: AgentModels | undefined,
  target: HarnessTarget,
): string | undefined {
  const id = models?.[target]?.id?.trim();
  return !id || id === HARNESS_DEFAULT ? undefined : id;
}

/** The reasoning effort chosen for a tool, where it has the concept. */
export function reasoningEffortFor(
  models: AgentModels | undefined,
  target: HarnessTarget,
): string | undefined {
  if (!harnessProfile(target).supportsReasoningEffort) return undefined;
  const effort = models?.[target]?.reasoningEffort?.trim();
  return !effort || effort === HARNESS_DEFAULT ? undefined : effort;
}

/**
 * The model id to name for one harness, resolved.
 *
 * Always that harness's own vocabulary. A model chosen for the other tool
 * contributes nothing: carrying `opus` into a Codex run would be Anthill
 * inventing a fact about the author's setup. That the other tool was answered
 * and this one was not is a thing to *say*, which validation does, rather than
 * a thing to paper over here.
 */
export function modelFor(models: AgentModels | undefined, target: HarnessTarget): string {
  return explicitModelFor(models, target) ?? harnessProfile(target).defaultModel;
}

/**
 * Which harness a bare model name belonged to, if it can be known.
 *
 * Only the declared model tables answer this — never a guess from what is
 * installed, or from which harness is more likely. A tool whose models are
 * discovered on the machine rather than declared here cannot claim a name this
 * way, because "not in my list" would then mean "not fetched yet".
 */
export function harnessOwningModel(model: string): HarnessTarget | undefined {
  const owners = HARNESS_TARGETS.filter((target) => {
    const harness = harnessProfile(target);
    return harness.modelsAreDeclared && harness.models.some((option) => option.id === model);
  });
  return owners.length === 1 ? owners[0] : undefined;
}

export type MigratedModels = {
  models: AgentModels;
  /**
   * A stored answer the author has to settle, kept verbatim.
   *
   * A bare model name from before models were kept per tool, belonging to no
   * tool Anthill can name. Not thrown away and not guessed at: it is their own
   * choice, and only they know which tool it was for.
   */
  needsReview?: string;
};

/** Read one tool's stored answer, if that is what is there. */
export function readModelChoice(
  target: HarnessTarget,
  value: unknown,
): HarnessModelChoice | undefined {
  const harness = harnessProfile(target);
  // A bare string is the shape from the pass that stored a model per tool
  // without a reasoning effort. Read rather than rejected: it is the same
  // answer, written with one fewer field.
  const raw = typeof value === "string" ? { id: value } : value;
  if (typeof raw !== "object" || raw === null) return undefined;

  const bag = raw as { id?: unknown; reasoningEffort?: unknown };
  const id = typeof bag.id === "string" ? bag.id.trim() : "";
  if (!id) return undefined;
  // A declared list can be checked against; a discovered one cannot, because a
  // name missing from it may only mean the machine has not been asked yet. An
  // unknown discovered model is surfaced for review by the screen instead.
  if (
    harness.modelsAreDeclared &&
    id !== HARNESS_DEFAULT &&
    !harness.models.some((option) => option.id === id)
  ) {
    return undefined;
  }

  const effort =
    harness.supportsReasoningEffort && typeof bag.reasoningEffort === "string"
      ? bag.reasoningEffort.trim()
      : "";
  return effort ? { id, reasoningEffort: effort } : { id };
}

/** Read a whole stored bag, keeping only tools that exist. */
export function readAgentModels(value: unknown): AgentModels | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const bag = value as Record<string, unknown>;
  const models: AgentModels = {};
  for (const target of HARNESS_TARGETS) {
    const choice = readModelChoice(target, bag[target]);
    if (choice) models[target] = choice;
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

/**
 * A profile written in any earlier shape, in this one.
 *
 * Deterministic, and the same answer every time it runs: nothing here reads the
 * machine, the clock, or what happens to be installed. The file may live in a
 * repository and be opened on two computers, and both have to decide about it
 * identically.
 *
 * Three shapes have existed. A bare `model: "opus"`, from before models were
 * kept per tool; `models: { "claude-code": "opus" }`, the first split; and
 * `model: { target, id }`, the pass that allowed one answer in total. The last
 * of those is the only one that can lose something, and it cannot here: one
 * answer becomes one tool's answer, and the tools it says nothing about stay
 * unanswered.
 */
export function migrateModels(value: unknown): MigratedModels {
  const already = readAgentModels(value);
  if (already) return { models: already };

  // `{ target, id }` — one answer, carrying the tool it was for.
  if (typeof value === "object" && value !== null) {
    const single = value as { target?: unknown; id?: unknown };
    const target = HARNESS_TARGETS.find((item) => item === single.target);
    if (target) {
      const choice = readModelChoice(target, { id: single.id });
      if (choice) return { models: { [target]: choice } };
      return { models: {} };
    }
  }

  // Before any split: a bare name, with no record of whose it was.
  if (typeof value !== "string") return { models: {} };
  const name = value.trim();
  // Nothing chosen before is nothing chosen now. Writing a default in here
  // would turn every old profile into one that had answered the question.
  if (!name) return { models: {} };

  const owner = harnessOwningModel(name);
  if (!owner) return { models: {}, needsReview: name };
  return { models: { [owner]: { id: name } } };
}
