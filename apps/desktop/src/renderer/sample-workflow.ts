/**
 * The workflow the app opens with, so a fresh install has something runnable
 * instead of an empty canvas. It is the MVP success-criteria shape from
 * `docs/mvp.md`: implement -> review -> loop back on changes requested.
 *
 * `runtime` values must match the ids exposed by `@anthill/runtimes`
 * (`claude-code-cli`, `codex-cli`).
 */

import type { Workflow } from "@anthill/workflow-schema";

export const SAMPLE_WORKFLOW: Workflow = {
  id: "review-loop",
  name: "Review loop",
  version: "0.1.0",
  description: "Implement a change, review it, and loop back until approved.",
  nodes: [
    {
      id: "start-1",
      type: "start",
      name: "Start",
      config: {},
      position: { x: 0, y: 140 },
    },
    {
      id: "developer",
      type: "agent",
      name: "Developer",
      config: {
        role: "developer",
        runtime: "claude-code-cli",
        instructions:
          "Read the repository and make the smallest change that adds a README section describing the project. Report what you changed.",
        retryPolicy: { maxAttempts: 3 },
      },
      position: { x: 190, y: 140 },
    },
    {
      id: "reviewer",
      type: "agent",
      name: "Reviewer",
      config: {
        role: "reviewer",
        runtime: "claude-code-cli",
        instructions:
          'Review the change in the working tree. Reply with decision "approved" if it is good, or "changes_requested" with concrete issues if not.',
        retryPolicy: { maxAttempts: 3 },
      },
      position: { x: 400, y: 140 },
    },
    {
      id: "human-review",
      type: "approval",
      name: "Human review",
      config: { prompt: "Ship this change?" },
      position: { x: 620, y: 140 },
    },
    {
      id: "end-1",
      type: "end",
      name: "Done",
      config: {},
      position: { x: 840, y: 140 },
    },
  ],
  edges: [
    { id: "e-start", source: "start-1", target: "developer" },
    { id: "e-dev-review", source: "developer", target: "reviewer" },
    {
      id: "e-changes",
      source: "reviewer",
      target: "developer",
      condition: 'reviewer.decision == "changes_requested"',
      label: "changes requested",
    },
    {
      id: "e-approved",
      source: "reviewer",
      target: "human-review",
      condition: 'reviewer.decision != "changes_requested"',
      label: "looks good",
    },
    {
      id: "e-shipped",
      source: "human-review",
      target: "end-1",
      label: "approved",
    },
    {
      id: "e-rejected",
      source: "human-review",
      target: "developer",
      label: "rejected",
    },
  ],
};
