/**
 * A blank workflow: just the two control blocks, connected.
 *
 * The starter shapes live in `@anthill/workflow`'s template library. This is
 * only what "Blank workflow" produces — a workflow that is already structurally sound
 * so the first thing the author sees is not a list of errors.
 */

import type { Workflow } from "@anthill/workflow-schema";
import { WORKFLOW_FORMAT_VERSION } from "@anthill/workflow";

export function blankWorkflow(): Workflow {
  return {
    id: `workflow-${Date.now()}`,
    name: "Untitled workflow",
    version: "0.1.0",
    target: "claude-code",
    metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION, agents: [] } },
    brief: {},
    nodes: [
      { id: "start", type: "start", name: "Start", config: {}, position: { x: 0, y: 160 } },
      { id: "end", type: "end", name: "Done", config: {}, position: { x: 320, y: 160 } },
    ],
    edges: [{ id: "e1", source: "start", target: "end" }],
  };
}
