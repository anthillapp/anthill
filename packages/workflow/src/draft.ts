/**
 * The Workflow Draft: what a local interpreter is asked to produce.
 *
 * Deliberately *not* the workflow format. A draft is an untrusted proposal
 * that came out of a language model, and the two must not be the same type:
 * the workflow format is what Anthill persists and compiles, and nothing that
 * arrives from an interpreter is allowed to become one without being validated
 * and mapped first. Keeping them apart is what makes "never persist a
 * model-produced draft directly" enforceable rather than a rule to remember.
 *
 * Draft ids are the interpreter's own — readable strings it invents to link
 * steps together. They are local to one draft and never become profile or node
 * ids; mapping assigns real ids. So an interpreter cannot name a profile id
 * into existence, and acceptance is what mints identity.
 *
 * Pure: this module parses and validates text. Spawning the interpreter is the
 * app shell's job.
 */

import type { OutcomeKind, WorkflowBrief } from "@anthill/workflow-schema";

import { isActionKind, type ActionKind } from "./actions.js";
import { isOutcomeKind } from "./outputs.js";

/**
 * Bump when a change would make an older interpreter's output unmappable.
 *
 * The interpreter is told which version to produce and its answer is checked
 * against it, so a draft from a stale prompt is refused with a clear reason
 * rather than half-mapped.
 */
export const WORKFLOWNER_DRAFT_VERSION = 1;

export type DraftAgent = {
  /** Draft-local id the steps refer to. Never becomes a profile id. */
  id: string;
  name: string;
  /** Suggested model. Checked against the harness before it is used. */
  model?: string;
  role?: string;
  description?: string;
};

export type DraftOutput = {
  /** Draft-local step id, or the literal `"end"`. */
  to: string;
  label?: string;
  kind?: OutcomeKind;
  /** Condition in the Workflow's own grammar, e.g. `tester.decision == "failed"`. */
  condition?: string;
};

export type DraftStep = {
  id: string;
  name: string;
  /** `approval` is the human gate; everything else is work an agent does. */
  kind: "step" | "approval";
  /** Draft-local agent id. Required for a step, meaningless for a gate. */
  agent?: string;
  action?: ActionKind;
  purpose?: string;
  task?: string;
  inputs?: string[];
  expectedOutput?: string;
  successCriteria?: string[];
  constraints?: string[];
  handoff?: string;
  maxIterations?: number;
  /** The question put to the person, for an approval gate. */
  question?: string;
  outputs?: DraftOutput[];
};

/**
 * What a question is about, so it can be shown where it belongs.
 *
 * A list of questions at the end of a draft is a list nobody answers: the
 * reader has to hold each one in their head while scrolling back to find what
 * it refers to. With a locator, the question sits inside the field, the step or
 * the output it is about, and answering it is a local act.
 *
 * An unrecognised locator is not an error — the question simply shows at workflow
 * level, which is where it would have been anyway.
 */
export type DraftQuestionAbout =
  | { kind: "brief"; field: string }
  | { kind: "step"; stepId: string }
  | { kind: "output"; stepId: string; outputTo: string }
  | { kind: "workflow" };

export type DraftQuestion = {
  /** Stable within one draft, so an answer can be filed against it. */
  id: string;
  question: string;
  /** Why it matters — what the answer changes. */
  why?: string;
  about: DraftQuestionAbout;
  /** The interpreter's own alternatives, offered as quick picks. */
  options: string[];
  /** Filled in by the author, not by the interpreter. */
  answer?: string;
};

export type WorkflowDraft = {
  draftVersion: number;
  title: string;
  summary?: string;
  brief: WorkflowBrief;
  agents: DraftAgent[];
  steps: DraftStep[];
  /**
   * Everything the interpreter could not settle, in one list.
   *
   * A statement of doubt and a question are the same thing to the author —
   * both are places the workflow is not yet decided — so they are one list with one
   * treatment. A draft written by an older instruction, which separated
   * `uncertainties` from `questions`, is folded into this on the way in.
   */
  questions: DraftQuestion[];
};

/**
 * A problem that does not stop the draft being mapped.
 *
 * An unknown action or a broken step reference is better shown in the preview
 * and left for the author to fix on the canvas than used as grounds to throw
 * away a draft that is otherwise most of the way there.
 */
export type DraftWarning = { where: string; message: string };

export type DraftParseResult =
  | { ok: true; draft: WorkflowDraft; warnings: DraftWarning[] }
  | { ok: false; error: string; raw: string };

/* ------------------------------------------------------------------ */
/* Extracting the draft from whatever the interpreter said             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find the JSON object in an interpreter's reply.
 *
 * A CLI is free to say "Here is the draft:" before it and "Let me know if…"
 * after it, and both do. A fenced block wins when there is one; otherwise the
 * first balanced `{…}` is taken, counting braces rather than matching the last
 * `}` in the text so a trailing sentence containing one does not swallow it.
 * Braces inside strings are skipped, or a `task` mentioning `}` would truncate
 * the object.
 */
export function extractDraftJson(text: string): string | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/g;
  for (const match of text.matchAll(fenced)) {
    const body = match[1].trim();
    if (body.startsWith("{")) return body;
  }

  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function readBrief(value: unknown): WorkflowBrief {
  if (!isRecord(value)) return {};
  const brief: WorkflowBrief = {};
  const goal = readString(value.goal);
  const context = readString(value.context);
  const verification = readString(value.verification);
  const finalAction = readString(value.finalAction);
  if (goal) brief.goal = goal;
  if (context) brief.context = context;
  if (verification) brief.verification = verification;
  if (finalAction) brief.finalAction = finalAction;

  const assumptions = readStringList(value.assumptions);
  const doneCriteria = readStringList(value.doneCriteria);
  const constraints = readStringList(value.constraints);
  const prohibited = readStringList(value.prohibitedActions);
  const report = readStringList(value.report);
  if (assumptions) brief.assumptions = assumptions;
  if (doneCriteria) brief.doneCriteria = doneCriteria;
  if (constraints) brief.constraints = constraints;
  if (prohibited) brief.prohibitedActions = prohibited;
  if (report) brief.report = report;
  return brief;
}

function readAgents(value: unknown, warn: (warning: DraftWarning) => void): DraftAgent[] {
  if (!Array.isArray(value)) return [];
  const agents: DraftAgent[] = [];
  const seen = new Set<string>();

  value.forEach((item, index) => {
    const where = `agents[${index}]`;
    if (!isRecord(item)) {
      warn({ where, message: "Not an object; ignored." });
      return;
    }
    const id = readString(item.id);
    if (!id) {
      warn({ where, message: "No id, so no step can refer to it; ignored." });
      return;
    }
    if (seen.has(id)) {
      warn({ where, message: `Two agents share the id "${id}"; the later one was ignored.` });
      return;
    }
    seen.add(id);

    const agent: DraftAgent = { id, name: readString(item.name) ?? id };
    const model = readString(item.model);
    const role = readString(item.role);
    const description = readString(item.description);
    if (model) agent.model = model;
    if (role) agent.role = role;
    if (description) agent.description = description;
    agents.push(agent);
  });
  return agents;
}

function readOutputs(
  value: unknown,
  where: string,
  warn: (warning: DraftWarning) => void,
): DraftOutput[] {
  if (!Array.isArray(value)) return [];
  const outputs: DraftOutput[] = [];

  value.forEach((item, index) => {
    const at = `${where}.outputs[${index}]`;
    if (!isRecord(item)) {
      warn({ where: at, message: "Not an object; ignored." });
      return;
    }
    const to = readString(item.to);
    if (!to) {
      warn({ where: at, message: "No target, so it leads nowhere; ignored." });
      return;
    }
    const output: DraftOutput = { to };
    const label = readString(item.label);
    const condition = readString(item.condition);
    if (label) output.label = label;
    if (condition) output.condition = condition;

    if (item.kind !== undefined) {
      if (isOutcomeKind(item.kind)) output.kind = item.kind;
      else warn({ where: at, message: `"${String(item.kind)}" is not an outcome kind; treated as "next".` });
    }
    outputs.push(output);
  });
  return outputs;
}

function readSteps(
  value: unknown,
  warn: (warning: DraftWarning) => void,
): DraftStep[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const steps: DraftStep[] = [];
  const seen = new Set<string>();

  value.forEach((item, index) => {
    const where = `steps[${index}]`;
    if (!isRecord(item)) {
      warn({ where, message: "Not an object; ignored." });
      return;
    }
    const id = readString(item.id);
    if (!id) {
      warn({ where, message: "No id, so nothing can connect to it; ignored." });
      return;
    }
    if (seen.has(id)) {
      warn({ where, message: `Two steps share the id "${id}"; the later one was ignored.` });
      return;
    }
    seen.add(id);

    const kind = item.kind === "approval" ? "approval" : "step";
    const step: DraftStep = { id, name: readString(item.name) ?? id, kind };

    const agent = readString(item.agent);
    const purpose = readString(item.purpose);
    const task = readString(item.task);
    const expectedOutput = readString(item.expectedOutput);
    const handoff = readString(item.handoff);
    const question = readString(item.question);
    if (agent) step.agent = agent;
    if (purpose) step.purpose = purpose;
    if (task) step.task = task;
    if (expectedOutput) step.expectedOutput = expectedOutput;
    if (handoff) step.handoff = handoff;
    if (question) step.question = question;

    const inputs = readStringList(item.inputs);
    const successCriteria = readStringList(item.successCriteria);
    const constraints = readStringList(item.constraints);
    if (inputs) step.inputs = inputs;
    if (successCriteria) step.successCriteria = successCriteria;
    if (constraints) step.constraints = constraints;

    if (item.action !== undefined) {
      if (isActionKind(item.action)) step.action = item.action;
      else {
        warn({
          where,
          message: `"${String(item.action)}" is not an action Anthill has; the step was left without one.`,
        });
      }
    }

    if (item.maxIterations !== undefined) {
      const limit = Number(item.maxIterations);
      if (Number.isInteger(limit) && limit > 0) step.maxIterations = limit;
      else {
        warn({ where, message: `"${String(item.maxIterations)}" is not a pass limit; ignored.` });
      }
    }

    const outputs = readOutputs(item.outputs, where, warn);
    if (outputs.length > 0) step.outputs = outputs;
    steps.push(step);
  });

  return steps.length > 0 ? steps : undefined;
}

/**
 * Check a parsed object against the draft schema.
 *
 * Fails only on what makes a draft unmappable — the wrong version, or no steps
 * at all. Everything else that is wrong becomes a warning the preview shows,
 * because a draft that is nine tenths right is worth more to the author than a
 * refusal, and the Workflow's own validation catches the gaps once it is on the
 * canvas.
 */
/** Where a question says it belongs. Unrecognised shapes fall back to the workflow. */
function readAbout(value: unknown): DraftQuestionAbout {
  if (!isRecord(value)) return { kind: "workflow" };
  const kind = value.kind;
  if (kind === "brief") {
    const field = readString(value.field);
    return field ? { kind: "brief", field } : { kind: "workflow" };
  }
  if (kind === "step") {
    const stepId = readString(value.stepId);
    return stepId ? { kind: "step", stepId } : { kind: "workflow" };
  }
  if (kind === "output") {
    const stepId = readString(value.stepId);
    const outputTo = readString(value.outputTo);
    return stepId && outputTo ? { kind: "output", stepId, outputTo } : { kind: "workflow" };
  }
  return { kind: "workflow" };
}

/**
 * Read the open questions, whichever way the interpreter expressed them.
 *
 * The current shape is a list of objects. An older instruction produced two
 * lists of plain strings — `uncertainties` and `questions` — and those still
 * arrive from a stale prompt or a model that ignored the shape; they are folded
 * in as questions with no alternatives rather than dropped, because a draft
 * that says what it is unsure about is more use than one that quietly does not.
 */
function readQuestions(value: Record<string, unknown>): DraftQuestion[] {
  const questions: DraftQuestion[] = [];
  const taken = new Set<string>();
  const idFor = (proposed: string | undefined) => {
    let id = proposed && !taken.has(proposed) ? proposed : `q${questions.length + 1}`;
    while (taken.has(id)) id = `${id}x`;
    taken.add(id);
    return id;
  };

  if (Array.isArray(value.questions)) {
    for (const item of value.questions) {
      if (typeof item === "string") {
        const text = item.trim();
        if (text) {
          questions.push({ id: idFor(undefined), question: text, about: { kind: "workflow" }, options: [] });
        }
        continue;
      }
      if (!isRecord(item)) continue;
      const question = readString(item.question) ?? readString(item.text);
      if (!question) continue;
      const why = readString(item.why);
      questions.push({
        id: idFor(readString(item.id)),
        question,
        ...(why ? { why } : {}),
        about: readAbout(item.about),
        options: readStringList(item.options) ?? [],
      });
    }
  }

  // The older shape, kept readable so a stale draft still opens.
  for (const item of readStringList(value.uncertainties) ?? []) {
    questions.push({ id: idFor(undefined), question: item, about: { kind: "workflow" }, options: [] });
  }

  return questions;
}

export function validateDraft(value: unknown): DraftParseResult {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (!isRecord(value)) {
    return { ok: false, error: "The interpreter's reply was not a JSON object.", raw };
  }

  const version = value.draftVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return {
      ok: false,
      error: `The reply has no "draftVersion", so there is no way to tell what shape it is meant to be.`,
      raw,
    };
  }
  if (version !== WORKFLOWNER_DRAFT_VERSION) {
    return {
      ok: false,
      error: `The reply is draft version ${version}; this build understands ${WORKFLOWNER_DRAFT_VERSION}.`,
      raw,
    };
  }

  const warnings: DraftWarning[] = [];
  const warn = (warning: DraftWarning) => warnings.push(warning);

  const steps = readSteps(value.steps, warn);
  if (!steps) {
    return {
      ok: false,
      error: "The reply contains no usable steps, so there is no workflow in it.",
      raw,
    };
  }

  const agents = readAgents(value.agents, warn);

  return {
    ok: true,
    warnings,
    draft: {
      draftVersion: version,
      title: readString(value.title) ?? "Untitled workflow",
      ...(readString(value.summary) ? { summary: readString(value.summary) as string } : {}),
      brief: readBrief(value.brief),
      agents,
      steps,
      questions: readQuestions(value),
    },
  };
}

/** Pull a draft out of an interpreter's raw reply and check it. */
export function parseDraftResponse(text: string): DraftParseResult {
  const json = extractDraftJson(text);
  if (!json) {
    return {
      ok: false,
      error: "No JSON object was found in the interpreter's reply.",
      raw: text,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      error: `The JSON in the reply could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      raw: text,
    };
  }

  const result = validateDraft(parsed);
  // Report the whole reply, not the extracted fragment: the author debugging a
  // bad draft needs to see what the interpreter actually said.
  return result.ok ? result : { ...result, raw: text };
}
