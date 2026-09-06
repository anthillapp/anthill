/**
 * Minimal dev harness for eyeballing the builder in a browser.
 * Not part of the published package: `npm run dev --workspace=@anthill/builder`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";

import { WorkflowBuilder } from "../src/WorkflowBuilder";
import type { Workflow } from "../src/contracts";

const sample: Workflow = {
  id: "review-loop",
  name: "Review loop",
  version: "0.1.0",
  nodes: [
    {
      id: "start-1",
      type: "start",
      name: "Start",
      config: {},
      position: { x: 0, y: 120 },
    },
    {
      id: "agent-1",
      type: "agent",
      name: "Developer",
      config: {
        role: "developer",
        runtime: "claude-code",
        instructions: "Implement the requested change.",
      },
      position: { x: 200, y: 120 },
    },
    {
      id: "approval-1",
      type: "approval",
      name: "Human review",
      config: { prompt: "Ship it?" },
      position: { x: 420, y: 120 },
    },
    {
      id: "end-1",
      type: "end",
      name: "End",
      config: {},
      position: { x: 640, y: 120 },
    },
  ],
  edges: [
    { id: "edge-1", source: "start-1", target: "agent-1" },
    { id: "edge-2", source: "agent-1", target: "approval-1" },
    {
      id: "edge-3",
      source: "approval-1",
      target: "end-1",
      label: "approved",
    },
    {
      id: "edge-4",
      source: "approval-1",
      target: "agent-1",
      label: "changes requested",
    },
  ],
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkflowBuilder initialWorkflow={sample} />
  </StrictMode>,
);
