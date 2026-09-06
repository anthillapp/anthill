/**
 * Starter templates.
 *
 * Each one produces an ordinary workflow: open it, change anything, save it. They
 * are not a special mode and nothing about them is locked — their job is to
 * show the shape of a working workflow and to save the tedium of typing the same
 * scaffolding again.
 *
 * Every template compiles without validation errors as it stands, so a new user
 * can generate a prompt immediately and then edit towards their real task.
 */

import type { Workflow, WorkflowEdge, WorkflowNode } from "@anthill/workflow-schema";

import type { AgentProfile } from "./agents.js";
import { WORKFLOW_FORMAT_VERSION } from "./format.js";
import type { ActionKind } from "./actions.js";

export type WorkflowTemplate = {
  id: string;
  name: string;
  /** One line for the template picker. */
  summary: string;
  /** What this shape is good for, and when to reach for something else. */
  whenToUse: string;
  build: () => Workflow;
};

type StepSpec = {
  id: string;
  name: string;
  action: ActionKind;
  /** The agent profile this step is assigned to, by id. */
  agentId: string;
  purpose: string;
  task: string;
  expectedOutput?: string;
  successCriteria?: string[];
  handoff?: string;
  maxIterations?: number;
  x: number;
  y: number;
};

function step(spec: StepSpec): WorkflowNode {
  return {
    id: spec.id,
    type: "agent",
    name: spec.name,
    config: {
      actionKind: spec.action,
      agentId: spec.agentId,
      purpose: spec.purpose,
      task: spec.task,
      ...(spec.expectedOutput ? { expectedOutput: spec.expectedOutput } : {}),
      ...(spec.successCriteria ? { successCriteria: spec.successCriteria } : {}),
      ...(spec.handoff ? { handoff: spec.handoff } : {}),
      ...(spec.maxIterations ? { maxIterations: spec.maxIterations } : {}),
    },
    position: { x: spec.x, y: spec.y },
  };
}

const startBlock = (x = 0, y = 180): WorkflowNode => ({
  id: "start",
  type: "start",
  name: "Start",
  config: {},
  position: { x, y },
});

const endBlock = (x: number, y = 180): WorkflowNode => ({
  id: "end",
  type: "end",
  name: "Done",
  config: {},
  position: { x, y },
});

const link = (
  id: string,
  source: string,
  target: string,
  extra: Partial<WorkflowEdge> = {},
): WorkflowEdge => ({ id, source, target, ...extra });

/**
 * Every template names its agents up front, then assigns steps to them by id.
 *
 * The profiles are the workflow's agent library; a step carries only the id. So a
 * template where one agent does three things says so once, in one place, which
 * is the whole point of a reusable profile.
 */
/**
 * A workflow built from a template gets its own id, not the template's.
 *
 * Every instance used to be stamped with the template's id, which made all of
 * them the same document as far as anything keying on the id was concerned. A
 * workflow created seconds ago would then inherit the observed sessions of
 * every earlier workflow started from the same template, and the canvas would
 * announce a finished session for a run it had nothing to do with.
 *
 * The template keeps its own id — the picker and its shape glyphs are keyed by
 * it. Only the document it produces is made distinct.
 */
function newId(template: string): string {
  return `${template}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function workflow(
  id: string,
  name: string,
  description: string,
  brief: Workflow["brief"],
  agents: AgentProfile[],
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Workflow {
  return {
    id: newId(id),
    name,
    description,
    version: "0.1.0",
    target: "claude-code",
    metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION, agents } },
    brief,
    nodes,
    edges,
  };
}

/* ------------------------------------------------------------------ */

const oneAgentSolve = (): Workflow =>
  workflow(
    "one-agent-solve",
    "One agent solves it",
    "A single agent works through the task in stages, checking its own work before finishing.",
    {
      goal: "Describe what should be true when this is done.",
      doneCriteria: ["The task is complete and verified."],
      finalAction: "Report what changed and how it was checked.",
    },
    [
      { id: "agent-solver", name: "Solver" },
    ],
    [
      startBlock(),
      step({
        id: "understand",
        name: "Understand the task",
        action: "clarify-requirements",
        agentId: "agent-solver",
        purpose: "Settle what is actually being asked before starting",
        task: "Read the request and the relevant code. List anything ambiguous and resolve it. Stop and ask if something cannot be resolved.",
        expectedOutput: "A short statement of the task with no ambiguity left.",
        x: 200,
        y: 180,
      }),
      step({
        id: "do",
        name: "Do the work",
        action: "agent-step",
        agentId: "agent-solver",
        purpose: "Carry out the task",
        task: "Make the change. Keep the diff as small as the goal allows.",
        expectedOutput: "The change, and a note on what was done and why.",
        x: 430,
        y: 180,
      }),
      step({
        id: "check",
        name: "Check the work",
        action: "check",
        agentId: "agent-solver",
        purpose: "Confirm the work meets the done criteria before reporting",
        task: "Check the change against the done criteria. Fix anything that falls short before finishing.",
        expectedOutput: "A pass or fail against each done criterion, with evidence.",
        maxIterations: 3,
        x: 660,
        y: 180,
      }),
      endBlock(900),
    ],
    [
      link("e1", "start", "understand"),
      link("e2", "understand", "do"),
      link("e3", "do", "check"),
      link("e4", "check", "end"),
    ],
  );

const brainstormToWorkflow = (): Workflow =>
  workflow(
    "brainstorm-to-workflow",
    "Brainstorm to approved workflow",
    "Open up options for a vague idea, agree on one, then break it into work packages.",
    {
      goal: "Turn a rough idea into a workflow a person has approved.",
      doneCriteria: ["A person has approved one approach.", "The approach is broken into work packages."],
      finalAction: "Present the approved workflow and its work packages.",
    },
    [
      { id: "agent-analyst", name: "Analyst" },
    ],
    [
      startBlock(),
      step({
        id: "brainstorm",
        name: "Explore options",
        action: "brainstorm",
        agentId: "agent-analyst",
        purpose: "Turn a vague idea into concrete options",
        task: "Produce several genuinely different options for the idea. For each, give its cost, its risk, and what it rules out.",
        expectedOutput: "Two or more distinct options with trade-offs.",
        maxIterations: 3,
        x: 200,
        y: 180,
      }),
      step({
        id: "clarify",
        name: "Clarify requirements",
        action: "clarify-requirements",
        agentId: "agent-analyst",
        purpose: "Resolve what is still ambiguous about the favoured option",
        task: "For the option you recommend, list what is still unclear and resolve what you can. Mark anything that needs a human decision.",
        expectedOutput: "A recommendation with open questions marked.",
        maxIterations: 3,
        x: 430,
        y: 180,
      }),
      {
        id: "approve",
        type: "approval",
        name: "Approve the approach",
        config: { prompt: "Is this the approach to take?" },
        position: { x: 660, y: 180 },
      },
      step({
        id: "decompose",
        name: "Break it down",
        action: "decompose",
        agentId: "agent-analyst",
        purpose: "Split the approved approach into work packages",
        task: "Split the approved approach into ordered work packages. Each one needs its own done condition.",
        expectedOutput: "An ordered list of work packages.",
        x: 890,
        y: 180,
      }),
      step({
        id: "deliver",
        name: "Deliver the workflow",
        action: "final-action",
        agentId: "agent-analyst",
        purpose: "Hand over the approved workflow and its work packages",
        task: "Present the approved approach and the work packages it was broken into.",
        expectedOutput: "The approved workflow and its work packages, ready to hand off.",
        x: 1120,
        y: 180,
      }),
      endBlock(1350),
    ],
    [
      link("e1", "start", "brainstorm"),
      link("e2", "brainstorm", "clarify"),
      link("e3", "clarify", "approve"),
      link("e4", "approve", "decompose", { label: "approved" }),
      link("e5", "approve", "brainstorm", {
        label: "try again",
        kind: "rework",
        sourceHandle: "bottom",
        targetHandle: "bottom",
      }),
      link("e6", "decompose", "deliver"),
      link("e7", "deliver", "end"),
    ],
  );

const implementTestFix = (): Workflow =>
  workflow(
    "implement-test-fix",
    "Implement, test, fix",
    "Build the change, run the tests, and loop back on failure until the suite is green.",
    {
      goal: "Land the change with the test suite green.",
      doneCriteria: ["The test suite passes.", "The change does what was asked and nothing more."],
      finalAction: "Report what changed, what the tests said, and anything still risky.",
    },
    [
      { id: "agent-dev", name: "Developer" },
      { id: "agent-tester", name: "Tester" },
    ],
    [
      startBlock(),
      step({
        id: "implement",
        name: "Implement",
        action: "implement",
        agentId: "agent-dev",
        purpose: "Make the change",
        task: "Implement the change. Keep the diff as small as the goal allows.",
        expectedOutput: "The change and a note on what was done.",
        handoff: "Hand the diff to the tester.",
        maxIterations: 4,
        x: 210,
        y: 180,
      }),
      step({
        id: "test",
        name: "Run tests",
        action: "run-tests",
        agentId: "agent-tester",
        purpose: "Find out whether the change actually works",
        task: "Run the project's test suite. Report the real result, including the names of any failures.",
        expectedOutput: 'The command output and a decision — "passed" or "failed".',
        successCriteria: ["The reported result matches the command output."],
        maxIterations: 4,
        x: 450,
        y: 180,
      }),
      step({
        id: "fix",
        name: "Fix failures",
        action: "implement",
        agentId: "agent-dev",
        purpose: "Address what the tests found",
        task: "Fix the failing tests. Find the cause before changing anything, and do not weaken a test to make it pass.",
        expectedOutput: "The updated change and an explanation of each failure's cause.",
        maxIterations: 4,
        x: 330,
        y: 350,
      }),
      endBlock(700),
    ],
    [
      link("e1", "start", "implement"),
      link("e2", "implement", "test"),
      link("e3", "test", "fix", {
        condition: 'tester.decision == "failed"',
        label: "tests failed",
        kind: "rework",
        sourceHandle: "bottom",
        targetHandle: "right",
      }),
      link("e4", "fix", "test", {
        label: "re-run",
        kind: "next",
        sourceHandle: "top",
        targetHandle: "bottom",
      }),
      link("e5", "test", "end", { label: "tests passed" }),
    ],
  );

const consultReviewDecide = (): Workflow =>
  workflow(
    "consult-adversarial-decide",
    "Consult, challenge, decide",
    "Get a recommendation, attack it deliberately, then decide with a person.",
    {
      goal: "Reach a decision that has survived being argued against.",
      doneCriteria: [
        "A recommendation exists with its trade-offs stated.",
        "The recommendation has been challenged, not just confirmed.",
        "A person has made the final call.",
      ],
      finalAction: "Record the decision and the reasoning behind it.",
    },
    [
      { id: "agent-advisor", name: "Advisor" },
      { id: "agent-critic", name: "Critic" },
    ],
    [
      startBlock(),
      step({
        id: "research",
        name: "Research the options",
        action: "research",
        agentId: "agent-advisor",
        purpose: "Ground the recommendation in what is actually known, not assumption",
        task: "Gather the information the recommendation will depend on before proposing one.",
        expectedOutput: "Findings organized by question, with where each one came from.",
        x: 210,
        y: 180,
      }),
      step({
        id: "consult",
        name: "Get a recommendation",
        action: "llm-consult",
        agentId: "agent-advisor",
        purpose: "Produce a recommendation with its reasoning",
        task: "Recommend an approach. State the trade-offs and what you are assuming.",
        expectedOutput: "A recommendation with trade-offs and assumptions.",
        maxIterations: 3,
        x: 440,
        y: 180,
      }),
      step({
        id: "challenge",
        name: "Argue against it",
        action: "adversarial-review",
        agentId: "agent-critic",
        purpose: "Find where the recommendation fails",
        task: "Try to break the recommendation. Give concrete scenarios where it fails, each with the conditions that trigger it. Do not agree in place of scrutiny.",
        expectedOutput: "Failure scenarios, or a statement that none were found and why.",
        successCriteria: ["Each finding names the conditions that produce the failure."],
        maxIterations: 3,
        x: 670,
        y: 180,
      }),
      {
        id: "decide",
        type: "approval",
        name: "Decide",
        config: { prompt: "Given the recommendation and the objections, which way do we go?" },
        position: { x: 920, y: 180 },
      },
      step({
        id: "present",
        name: "Present the recommendation",
        action: "present-recommendation",
        agentId: "agent-advisor",
        purpose: "State the decided recommendation as a decision record",
        task: "Present the decided recommendation: what was chosen, its trade-offs, and what was ruled out.",
        expectedOutput: "A decision record: the recommendation, its trade-offs, and what was ruled out.",
        x: 1150,
        y: 180,
      }),
      endBlock(1380),
    ],
    [
      link("e1", "start", "research"),
      link("e2", "research", "consult"),
      link("e3", "consult", "challenge"),
      link("e4", "challenge", "decide"),
      link("e5", "decide", "present", { label: "decided" }),
      link("e6", "decide", "consult", {
        label: "needs another option",
        kind: "rework",
        sourceHandle: "bottom",
        targetHandle: "bottom",
      }),
      link("e7", "present", "end"),
    ],
  );

const multiAgentCoordination = (): Workflow =>
  workflow(
    "multi-agent-coordination",
    "Multi-agent coordination",
    "A coordinator splits the work, specialists do their parts, then the result is integrated and reviewed.",
    {
      goal: "Deliver work that was split across several agents and put back together.",
      doneCriteria: [
        "Every work package is complete.",
        "The integrated result works as a whole, not only in parts.",
        "The reviewer has no outstanding issues.",
      ],
      constraints: [
        "Stay on this task. Do not switch to unrelated work.",
        "Make the smallest reasonable change. Do not refactor beyond what the goal requires.",
        "Do not make a check pass without fixing the underlying issue.",
        "Each specialist works only on its own package.",
      ],
      finalAction: "Report the integrated result and what each specialist contributed.",
    },
    [
      { id: "agent-coordinator", name: "Coordinator" },
      { id: "agent-specialist-a", name: "Specialist A" },
      { id: "agent-specialist-b", name: "Specialist B" },
      { id: "agent-reviewer", name: "Reviewer" },
    ],
    [
      startBlock(0, 240),
      step({
        id: "coordinate",
        name: "Split the work",
        action: "decompose",
        agentId: "agent-coordinator",
        purpose: "Divide the work into packages that can be done independently",
        task: "Split the work into packages that do not depend on each other's unfinished state. Say what each package must return.",
        expectedOutput: "One package per specialist, each with its own done condition.",
        handoff: "Give each package to the specialist responsible for that area.",
        x: 200,
        y: 240,
      }),
      step({
        id: "area-a",
        name: "Build area A",
        action: "agent-step",
        agentId: "agent-specialist-a",
        purpose: "Deliver the first work package",
        task: "Implement your package. Do not touch areas belonging to another package.",
        expectedOutput: "The change for this package, and what it returns to the coordinator.",
        x: 440,
        y: 120,
      }),
      step({
        id: "area-b",
        name: "Build area B",
        action: "agent-step",
        agentId: "agent-specialist-b",
        purpose: "Deliver the second work package",
        task: "Implement your package. Do not touch areas belonging to another package.",
        expectedOutput: "The change for this package, and what it returns to the coordinator.",
        x: 440,
        y: 360,
      }),
      step({
        id: "integrate",
        name: "Integrate",
        action: "agent-step",
        agentId: "agent-coordinator",
        purpose: "Put the packages together and make them work as one",
        task: "Combine the packages. Resolve conflicts between them and confirm the whole works, not only each part.",
        expectedOutput: "The combined result and a note on anything that had to be reconciled.",
        maxIterations: 3,
        x: 690,
        y: 240,
      }),
      step({
        id: "review",
        name: "Review the whole",
        action: "criteria-review",
        agentId: "agent-reviewer",
        purpose: "Check the integrated result against the done criteria",
        task: 'Compare the combined result against the done criteria, one by one. Reply with decision "approved", or "changes_requested" with specific gaps.',
        expectedOutput: 'A decision — "approved" or "changes_requested" — with each criterion addressed.',
        maxIterations: 3,
        x: 930,
        y: 240,
      }),
      endBlock(1170, 240),
    ],
    [
      link("e1", "start", "coordinate"),
      link("e2", "coordinate", "area-a", { label: "package A" }),
      link("e3", "coordinate", "area-b", { label: "package B" }),
      link("e4", "area-a", "integrate"),
      link("e5", "area-b", "integrate"),
      link("e6", "integrate", "review"),
      link("e7", "review", "integrate", {
        condition: 'reviewer.decision == "changes_requested"',
        label: "changes requested",
        kind: "rework",
        sourceHandle: "bottom",
        targetHandle: "bottom",
      }),
      link("e8", "review", "end", { label: "approved" }),
    ],
  );

/**
 * Research's fifth shape: draft an artifact, review it, revise it until the
 * review has nothing left to raise, then check it against the acceptance
 * criteria before delivering it. Buildable only once Generate Artifact,
 * Transform / Rewrite and Criteria Review exist in the catalog.
 */
const artifactImprovement = (): Workflow =>
  workflow(
    "artifact-improvement",
    "Artifact improvement",
    "Draft an artifact, revise it against review feedback until nothing is left to raise, then check it against the acceptance criteria before delivering it.",
    {
      goal: "Deliver an artifact that has been reviewed and revised, not just produced once.",
      doneCriteria: [
        "The reviewer has nothing left to raise.",
        "The artifact meets every acceptance criterion.",
      ],
      finalAction: "Deliver the finished artifact.",
    },
    [
      { id: "agent-author", name: "Author" },
      { id: "agent-reviewer", name: "Reviewer" },
    ],
    [
      startBlock(),
      step({
        id: "generate",
        name: "Draft the artifact",
        action: "generate-artifact",
        agentId: "agent-author",
        purpose: "Produce a first draft to react to",
        task: "Produce a draft of the artifact the goal describes.",
        expectedOutput: "A complete first draft.",
        x: 210,
        y: 180,
      }),
      step({
        id: "review",
        name: "Review the draft",
        action: "llm-review",
        agentId: "agent-reviewer",
        purpose: "Find what still needs to change before this is acceptance-ready",
        task: 'Review the draft for correctness, clarity and completeness. Reply with decision "approved", or "changes_requested" with specific issues.',
        expectedOutput: 'A decision — "approved" or "changes_requested" — with specific issues.',
        maxIterations: 4,
        x: 440,
        y: 180,
      }),
      step({
        id: "rewrite",
        name: "Revise the draft",
        action: "transform-rewrite",
        agentId: "agent-author",
        purpose: "Address what the review found",
        task: "Revise the draft to address every issue the review raised, without losing what already worked.",
        expectedOutput: "The revised draft.",
        maxIterations: 4,
        x: 330,
        y: 350,
      }),
      step({
        id: "criteria",
        name: "Check against criteria",
        action: "criteria-review",
        agentId: "agent-reviewer",
        purpose: "Confirm the approved draft actually meets the acceptance criteria",
        task: "Compare the approved draft against the acceptance criteria, one by one.",
        expectedOutput: "A pass/fail against each acceptance criterion.",
        x: 670,
        y: 180,
      }),
      step({
        id: "deliver",
        name: "Deliver",
        action: "final-action",
        agentId: "agent-author",
        purpose: "Hand over the finished artifact",
        task: "Deliver the finished artifact together with a short report of how it was reviewed.",
        expectedOutput: "The delivered artifact and the closing report.",
        x: 900,
        y: 180,
      }),
      endBlock(1130),
    ],
    [
      link("e1", "start", "generate"),
      link("e2", "generate", "review"),
      link("e3", "review", "rewrite", {
        condition: 'reviewer.decision == "changes_requested"',
        label: "changes requested",
        kind: "rework",
        sourceHandle: "bottom",
        targetHandle: "right",
      }),
      link("e4", "rewrite", "review", {
        label: "re-review",
        kind: "next",
        sourceHandle: "top",
        targetHandle: "bottom",
      }),
      link("e5", "review", "criteria", { label: "approved" }),
      link("e6", "criteria", "deliver"),
      link("e7", "deliver", "end"),
    ],
  );

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "one-agent-solve",
    name: "One agent solves it",
    summary: "One agent, several stages, checking its own work",
    whenToUse:
      "The task is small enough for one agent and does not need a second opinion.",
    build: oneAgentSolve,
  },
  {
    id: "brainstorm-to-workflow",
    name: "Brainstorm to approved workflow",
    summary: "Open up options, agree on one, break it down",
    whenToUse: "The idea is still vague and someone must approve the direction.",
    build: brainstormToWorkflow,
  },
  {
    id: "implement-test-fix",
    name: "Implement, test, fix",
    summary: "Build, run tests, loop back on failure",
    whenToUse: "The work has a real test suite that decides whether it is done.",
    build: implementTestFix,
  },
  {
    id: "consult-adversarial-decide",
    name: "Consult, challenge, decide",
    summary: "Recommend, attack the recommendation, then decide",
    whenToUse:
      "The decision matters more than the speed, and agreement is not the same as being right.",
    build: consultReviewDecide,
  },
  {
    id: "multi-agent-coordination",
    name: "Multi-agent coordination",
    summary: "Split work across specialists, then integrate and review",
    whenToUse:
      "The work has separable areas and one agent doing all of it would lose track.",
    build: multiAgentCoordination,
  },
  {
    id: "artifact-improvement",
    name: "Artifact improvement",
    summary: "Draft, review, revise until nothing is left to raise, then deliver",
    whenToUse:
      "The output is a single artifact — a document, a design, a report — and getting it right matters more than getting it fast.",
    build: artifactImprovement,
  },
];

export function workflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((template) => template.id === id);
}
