/**
 * Reading a handover: what survives, what is refused, and how much is said
 * about a refusal.
 *
 * The behaviours worth pinning down are that a version from the future is
 * refused without the rest being read, and that everything else is reported
 * together — a sender told about one mistake at a time asks the user one
 * question at a time.
 */

import { describe, expect, it } from "vitest";

import { EXCHANGE_PROBLEM_CODES, EXCHANGE_VERSION } from "./contracts.js";
import { checkExchangeVersion, readSubmission } from "./submission.js";

/** The smallest thing `WorkflowSchema` accepts. Completeness is not in question here. */
function workflow(): Record<string, unknown> {
  return {
    id: "workflow-1",
    name: "Ship the fix",
    version: "0.1.0",
    nodes: [{ id: "start", type: "start", name: "Start", config: {} }],
    edges: [],
  };
}

function handover(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exchangeVersion: EXCHANGE_VERSION,
    idempotencyKey: "handover-7",
    source: {
      harness: "claude-code",
      sessionId: "session-abc",
      taskText: "Fix the crash on startup.",
    },
    mode: "approval-gate",
    workflow: workflow(),
    ...overrides,
  };
}

function codes(problems: { code: string }[]): string[] {
  return problems.map((problem) => problem.code);
}

function fields(problems: { field?: string }[]): (string | undefined)[] {
  return problems.map((problem) => problem.field);
}

describe("checkExchangeVersion", () => {
  it("accepts this build's own version", () => {
    expect(checkExchangeVersion(EXCHANGE_VERSION)).toBeUndefined();
  });

  it("refuses a version from the future, naming both numbers", () => {
    const problem = checkExchangeVersion(EXCHANGE_VERSION + 1);
    expect(problem?.code).toBe(EXCHANGE_PROBLEM_CODES.EXCHANGE_VERSION_UNSUPPORTED);
    expect(problem?.message).toContain(String(EXCHANGE_VERSION + 1));
    expect(problem?.message).toContain(String(EXCHANGE_VERSION));
  });

  it("refuses something that is not a version number at all", () => {
    expect(checkExchangeVersion(0)?.code).toBe(
      EXCHANGE_PROBLEM_CODES.EXCHANGE_VERSION_UNSUPPORTED,
    );
    expect(checkExchangeVersion(1.5)?.code).toBe(
      EXCHANGE_PROBLEM_CODES.EXCHANGE_VERSION_UNSUPPORTED,
    );
    expect(checkExchangeVersion(Number.NaN)?.code).toBe(
      EXCHANGE_PROBLEM_CODES.EXCHANGE_VERSION_UNSUPPORTED,
    );
  });

  it("puts no question to the user, because they cannot answer it", () => {
    expect(checkExchangeVersion(EXCHANGE_VERSION + 1)?.ask).toBeUndefined();
  });
});

describe("readSubmission", () => {
  it("reads a well-formed handover back unchanged", () => {
    const result = readSubmission(handover());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.submission.idempotencyKey).toBe("handover-7");
    expect(result.submission.mode).toBe("approval-gate");
    expect(result.submission.source).toEqual({
      harness: "claude-code",
      sessionId: "session-abc",
      taskText: "Fix the crash on startup.",
    });
    expect(result.submission.workflow.id).toBe("workflow-1");
    expect(result.submission.workflowId).toBeUndefined();
  });

  it("carries a workflow id through when the handover revises something", () => {
    const result = readSubmission(handover({ workflowId: "workflow-1" }));
    expect(result.ok && result.submission.workflowId).toBe("workflow-1");
  });

  it("refuses anything that is not a JSON object", () => {
    for (const value of [undefined, null, 7, "a handover", [], true]) {
      const result = readSubmission(value);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(codes(result.problems)).toEqual([
        EXCHANGE_PROBLEM_CODES.SUBMISSION_NOT_AN_OBJECT,
      ]);
    }
  });

  it("refuses a version from the future without reading anything else", () => {
    const result = readSubmission({
      exchangeVersion: EXCHANGE_VERSION + 1,
      // Every other field is wrong, and none of it is reported: the shape of a
      // submission this build does not understand is not this build's to judge.
      idempotencyKey: 12,
      source: "not an object",
      mode: "whenever",
      workflow: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.problems)).toEqual([
      EXCHANGE_PROBLEM_CODES.EXCHANGE_VERSION_UNSUPPORTED,
    ]);
  });

  it("asks for a version before anything else when none was sent", () => {
    const { exchangeVersion: _omitted, ...rest } = handover();
    const result = readSubmission(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.problems)).toEqual([EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_MISSING]);
    expect(fields(result.problems)).toEqual(["exchangeVersion"]);
  });

  it("reports every envelope problem at once", () => {
    const result = readSubmission({
      exchangeVersion: EXCHANGE_VERSION,
      idempotencyKey: "   ",
      mode: "start-immediately",
      source: { harness: "cursor", sessionId: "", taskText: 12 },
      workflow: workflow(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(fields(result.problems)).toEqual([
      "idempotencyKey",
      "mode",
      "source.harness",
      "source.sessionId",
      "source.taskText",
    ]);
  });

  it("tells an absent field apart from a wrong one", () => {
    const absent = readSubmission(handover({ mode: undefined }));
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(codes(absent.problems)).toEqual([EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_MISSING]);
    }

    const wrong = readSubmission(handover({ mode: "show and go" }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(codes(wrong.problems)).toEqual([EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_INVALID]);
    }
  });

  it("accepts both handover modes and nothing else", () => {
    expect(readSubmission(handover({ mode: "show-and-go" })).ok).toBe(true);
    expect(readSubmission(handover({ mode: "approval-gate" })).ok).toBe(true);
    expect(readSubmission(handover({ mode: "APPROVAL-GATE" })).ok).toBe(false);
  });

  it("accepts a blank task text, which is a question for the user rather than a bad shape", () => {
    const result = readSubmission(
      handover({ source: { harness: "codex", sessionId: "s", taskText: "" } }),
    );
    expect(result.ok && result.submission.source.taskText).toBe("");
  });

  it("refuses a blank workflow id rather than reading it as a new workflow", () => {
    const result = readSubmission(handover({ workflowId: "  " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(fields(result.problems)).toEqual(["workflowId"]);
  });

  it("reports every zod issue with its path into the submission", () => {
    const result = readSubmission(
      handover({
        workflow: {
          id: "",
          name: "Ship the fix",
          version: "0.1.0",
          nodes: [{ id: "a space", type: "start", name: "Start", config: {} }],
          edges: [{ id: "edge-1", source: 7, target: "start" }],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Three separate problems, not the first one and a shrug.
    expect(fields(result.problems)).toEqual([
      "workflow.id",
      "workflow.nodes.0.id",
      "workflow.edges.0.source",
    ]);
    expect(codes(result.problems).every((code) => code === EXCHANGE_PROBLEM_CODES.WORKFLOW_MALFORMED)).toBe(
      true,
    );
    // The path is in the message too, because a text block is all the model reads.
    expect(result.problems[1]?.message).toContain("nodes.0.id");
  });

  it("reports a workflow that is not an object at all against the field", () => {
    const result = readSubmission(handover({ workflow: "a workflow" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(fields(result.problems)).toEqual(["workflow"]);
  });

  it("does not let a malformed workflow hide an envelope problem", () => {
    const result = readSubmission(handover({ idempotencyKey: undefined, workflow: 7 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(fields(result.problems)).toEqual(["idempotencyKey", "workflow"]);
  });
});
