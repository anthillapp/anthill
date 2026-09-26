/**
 * What an agent is for, written from everything the workflow says about it.
 *
 * An agent's file used to open with the purpose of the first step it was given,
 * or — when that step had none — with "The QA Operator in this workflow." An
 * agent doing ten steps was described by one of them, and a coding agent
 * reading the file was told its name and nothing about how to work (ANT-126).
 *
 * The author's own description is always better than this, and wins when it
 * exists: the validator asks for one, and a handover refuses to proceed without
 * it. This is what the file says when nobody wrote one — assembled from every
 * step the agent owns, in the order the workflow has them, so it is specific to
 * this workflow and covers the whole of the agent's job rather than the first
 * corner of it. It invents nothing: every sentence is a field the author filled
 * in, and a field left empty produces no sentence.
 */

import type { Workflow, WorkflowNode } from "@anthill/workflow-schema";

import { actionDefinition } from "./actions.js";
import type { AgentProfile } from "./agents.js";
import { agentConfig } from "./node-config.js";

/** How many of a list are named before the rest are counted. */
const NAMED = 6;

/** Shortest description the validator accepts as guidance rather than a title. */
export const MIN_DESCRIPTION_LENGTH = 80;

/**
 * Whether an author's description is enough to guide the agent.
 *
 * A length, because that is the one thing a program can judge. Eighty
 * characters is one full sentence — below it a description is a title or a
 * role restated, and the whole point of a description is to say more than
 * the role does.
 */
export function describesEnough(description: string | undefined): boolean {
  return (description ?? "").trim().length >= MIN_DESCRIPTION_LENGTH;
}

/** The first sentence of a passage, for a list that names many things. */
function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const match = /^(.+?[.!?])(\s|$)/.exec(trimmed);
  return (match ? match[1] : trimmed).replace(/[.!?]$/, "");
}

/**
 * Items joined for prose, with the tail counted rather than listed.
 *
 * Each item loses its own full stop: the sentence they are listed in ends
 * with one, and "statuses.." is what an item keeping its own produced.
 */
function listed(items: readonly string[]): string {
  const unique = [
    ...new Set(items.map((item) => item.trim().replace(/[.!?]+$/, "")).filter(Boolean)),
  ];
  if (unique.length <= NAMED) return unique.join("; ");
  const rest = unique.length - NAMED;
  return `${unique.slice(0, NAMED).join("; ")}; and ${rest} more`;
}

/**
 * Lower-case the first letter, for a clause that follows a colon or dash.
 *
 * Only when the word is an ordinary capitalised one. "QA the tickets" opens
 * with an initialism, and "qA the tickets" is what lowering it blindly wrote.
 */
function clause(text: string): string {
  const sentence = firstSentence(text);
  return /^[A-Z][a-z]/.test(sentence)
    ? sentence.charAt(0).toLowerCase() + sentence.slice(1)
    : sentence;
}

/**
 * The description, as prose paragraphs.
 *
 * `steps` are the agent's own, in workflow order. The result is the same
 * whatever harness the file is written for: it describes the agent, not the
 * tool.
 */
export function describeAgent(
  profile: AgentProfile,
  steps: readonly WorkflowNode[],
  workflow: Workflow,
): string {
  const name = profile.name.trim() || "This agent";
  const configs = steps.map((step) => ({ step, config: agentConfig(step) }));
  const paragraphs: string[] = [];

  // Who, and for what work.
  const opening: string[] = [];
  opening.push(profile.role?.trim() ? `${name}: ${firstSentence(profile.role)}.` : `${name}.`);
  const goal = workflow.brief?.goal?.trim();
  if (goal) opening.push(`The work it belongs to: ${clause(goal)}.`);
  paragraphs.push(opening.join(" "));

  // Every step it owns, in order — the whole job, not the first corner of it.
  if (configs.length > 0) {
    const duties = configs.map(({ step, config }) => {
      const action = config.actionKind ? actionDefinition(config.actionKind) : undefined;
      const kind = action ? ` (${action.label.toLowerCase()})` : "";
      const what = config.purpose?.trim() || config.task?.trim();
      return `${step.name || "an unnamed step"}${kind}${what ? ` – ${clause(what)}` : ""}`;
    });
    paragraphs.push(
      `${configs.length === 1 ? "It carries out one step" : `It carries out ${configs.length} steps, in this order`}: ${duties.join("; ")}.`,
    );
  }

  // How it works: what it reads, what it hands back, and how it knows it is done.
  const inputs = configs.flatMap(({ config }) => config.inputs ?? []);
  const outputs = configs.flatMap(({ config }) =>
    config.expectedOutput ? [firstSentence(config.expectedOutput)] : [],
  );
  const criteria = configs.flatMap(({ config }) => config.successCriteria ?? []);
  const approach: string[] = [];
  if (inputs.length > 0) approach.push(`Before starting a step it reads: ${listed(inputs)}.`);
  if (outputs.length > 0) approach.push(`It hands back: ${listed(outputs)}.`);
  if (criteria.length > 0) approach.push(`A step of its is done when: ${listed(criteria)}.`);
  if (approach.length > 0) paragraphs.push(approach.join(" "));

  // What binds it throughout, and where the work goes afterwards.
  const constraints = [
    ...(workflow.brief?.constraints ?? []),
    ...configs.flatMap(({ config }) => config.constraints ?? []),
  ];
  const handoffs = configs.flatMap(({ config }) =>
    config.handoff ? [firstSentence(config.handoff)] : [],
  );
  const closing: string[] = [];
  if (constraints.length > 0) closing.push(`Throughout: ${listed(constraints)}.`);
  if (handoffs.length > 0) closing.push(`When a step is done it passes on: ${listed(handoffs)}.`);
  if (closing.length > 0) paragraphs.push(closing.join(" "));

  return paragraphs.join("\n\n");
}
