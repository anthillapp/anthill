/**
 * The package as its consumers see it.
 *
 * The MCP server and the desktop main process reach for these through the
 * barrel, and a name left out of it is a compile error in another workspace
 * rather than here. One handover is walked from arriving JSON to a stored
 * revision, in the order the server will do it.
 */

import { describe, expect, it } from "vitest";

import {
  EXCHANGE_VERSION,
  checkCompleteness,
  describeState,
  readSubmission,
  revisionDigest,
} from "./index.js";

const HANDOVER = {
  exchangeVersion: EXCHANGE_VERSION,
  idempotencyKey: "handover-7",
  source: {
    harness: "claude-code",
    sessionId: "session-abc",
    taskText: "Fix the crash on startup.",
  },
  mode: "approval-gate",
  workflow: {
    id: "workflow-1",
    name: "Ship the fix",
    version: "0.1.0",
    target: "claude-code",
    brief: {
      goal: "The startup crash is fixed and covered by a test.",
      doneCriteria: ["The test suite passes."],
    },
    nodes: [
      { id: "start", type: "start", name: "Start", config: {} },
      {
        id: "step-1",
        type: "agent",
        name: "Fix it",
        config: {
          actionKind: "implement",
          task: "Find the cause of the startup crash and fix it.",
          agentId: "agent-1",
          expectedOutput: "A patch, and a test that fails without it.",
          successCriteria: ["The new test fails on the old code."],
        },
      },
      { id: "end", type: "end", name: "Done", config: {} },
    ],
    edges: [
      { id: "edge-1", source: "start", target: "step-1" },
      { id: "edge-2", source: "step-1", target: "end" },
    ],
    metadata: {
      workflow: {
        agents: [{ id: "agent-1", name: "Developer", models: { "claude-code": { id: "sonnet" } } }],
      },
    },
  },
};

describe("@anthill/workflow-exchange", () => {
  it("takes a handover from JSON to a revision worth storing", () => {
    const result = readSubmission(JSON.parse(JSON.stringify(HANDOVER)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { submission } = result;
    expect(checkCompleteness(submission.workflow, submission.source)).toEqual([]);

    const digest = revisionDigest(submission.workflow);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);

    // The same handover sent twice is the same revision, which is what makes a
    // retry idempotent rather than a second revision saying nothing new.
    const retry = readSubmission(JSON.parse(JSON.stringify(HANDOVER)));
    expect(retry.ok && revisionDigest(retry.submission.workflow)).toBe(digest);

    expect(describeState("draft", submission.mode).label).toBe("Waiting for you");
  });
});
