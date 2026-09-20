/**
 * Reading a handover: what survives, what is refused, and how much is said
 * about a refusal.
 *
 * The behaviours worth pinning down are that a version from the future is
 * refused without the rest being read, and that everything else is reported
 * together — a sender told about one mistake at a time asks the user one
 * question at a time.
 */

import { HARNESS_TARGETS } from "@anthill/workflow-schema";
import { WORKFLOW_FORMAT_VERSION } from "@anthill/workflow";
import { describe, expect, it } from "vitest";

import { EXCHANGE_PROBLEM_CODES, EXCHANGE_VERSION, SESSION_ID_MAX_LENGTH, handoverOpens } from "./contracts.js";
import {
  checkExchangeVersion,
  checkSessionId,
  readStoredWorkflowDocument,
  readSubmission,
  readWorkflowDocument,
} from "./submission.js";

/** The smallest thing `WorkflowSchema` accepts. Completeness is not in question here. */
function workflow(): Record<string, unknown> {
  return {
    id: "workflow-1",
    name: "Ship the fix",
    version: "0.1.0",
    nodes: [{ id: "start", type: "start", name: "Start", config: {} }],
    edges: [],
    metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION } },
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

describe("checkSessionId", () => {
  it("accepts what the three harnesses actually mint", () => {
    expect(checkSessionId("0f7d4c2a-9b1e-4c33-8a5f-6d2e1b7c0a94", "source.sessionId")).toBeUndefined();
    expect(checkSessionId("session-abc", "source.sessionId")).toBeUndefined();
    expect(checkSessionId("1750000000000_abc", "source.sessionId")).toBeUndefined();
  });

  it("refuses one that would not survive being written into a file name", () => {
    // Each of these comes back out of a path, or out of a line of a log, as a
    // different string than went in — which shows up as a run that never
    // matches its session rather than as a bad session id.
    for (const id of ["../../etc/passwd", "sess/1", "sess 1", "sess\n1", "sess:1", "sess.1"]) {
      const problem = checkSessionId(id, "source.sessionId");
      expect(problem?.code).toBe(EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_INVALID);
      expect(problem?.field).toBe("source.sessionId");
    }
  });

  it("refuses one longer than a file name is allowed to be", () => {
    expect(checkSessionId("a".repeat(SESSION_ID_MAX_LENGTH), "sessionId")).toBeUndefined();
    expect(checkSessionId("a".repeat(SESSION_ID_MAX_LENGTH + 1), "sessionId")?.field).toBe(
      "sessionId",
    );
  });

  it("tells an absent session id apart from a misshapen one", () => {
    expect(checkSessionId(undefined, "sessionId")?.code).toBe(
      EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_MISSING,
    );
    expect(checkSessionId(12, "sessionId")?.code).toBe(
      EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_INVALID,
    );
  });

  it("names the field it was asked about, so one message serves both doors", () => {
    expect(checkSessionId("sess/1", "sessionId")?.field).toBe("sessionId");
    expect(checkSessionId("sess/1", "source.sessionId")?.field).toBe("source.sessionId");
  });
});

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
  it.each([undefined, 0, WORKFLOW_FORMAT_VERSION - 1, WORKFLOW_FORMAT_VERSION + 1, "5"])(
    "refuses unsupported or missing workflow format %s without migrating it",
    (formatVersion) => {
      const result = readSubmission(handover({ workflow: {
        ...workflow(), metadata: { workflow: { formatVersion } },
      } }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(fields(result.problems)).toContain("workflow.metadata.workflow.formatVersion");
    },
  );

  it("refuses unknown top-level intent instead of silently stripping it", () => {
    const result = readSubmission(handover({ workflow: { ...workflow(), futureConstraint: "must not run" } }));
    expect(result.ok).toBe(false);
  });

  it("bounds depth and graph size before recursive validation", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 70; i++) deep = { nested: deep };
    for (const extra of [
      { metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION }, deep } },
      { nodes: Array.from({ length: 1001 }, (_, i) => ({ id: `n${i}`, type: "start", name: "Start", config: {} })) },
      { edges: Array.from({ length: 5001 }, (_, i) => ({ id: `e${i}`, source: "start", target: "start" })) },
    ]) {
      const result = readSubmission(handover({ workflow: { ...workflow(), ...extra } }));
      expect(result.ok).toBe(false);
    }
  });
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

  it("names every tool it would have accepted, from the list it checks against", () => {
    const result = readSubmission(
      handover({
        source: { harness: "cursor", sessionId: "session-abc", taskText: "Fix the crash." },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Derived rather than written out: a fourth tool becomes submittable by
    // being added in one place, and the sentence the sender reads follows it.
    for (const target of HARNESS_TARGETS) {
      expect(result.problems[0]?.message).toContain(`"${target}"`);
    }
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

  it("accepts the two commands, the two retired names, and nothing else", () => {
    expect(readSubmission(handover({ mode: "design" })).ok).toBe(true);
    expect(readSubmission(handover({ mode: "watch" })).ok).toBe(true);
    // Every handover already on disk carries one of these two. A value that
    // stopped parsing would make those records unreadable, for no gain.
    expect(readSubmission(handover({ mode: "show-and-go" })).ok).toBe(true);
    expect(readSubmission(handover({ mode: "approval-gate" })).ok).toBe(true);
    expect(readSubmission(handover({ mode: "APPROVAL-GATE" })).ok).toBe(false);
    expect(readSubmission(handover({ mode: "review" })).ok).toBe(false);
  });

  /*
   * The whole of what `mode` decides, in one place, so the legacy pair cannot
   * quietly start meaning something new. Only `watch` skips the canvas, and a
   * handover written before these two words existed was one the user was meant
   * to look at.
   */
  it("sends only a watch handover to the live session", () => {
    expect(handoverOpens("watch")).toBe("live");
    expect(handoverOpens("design")).toBe("editor");
    expect(handoverOpens("show-and-go")).toBe("editor");
    expect(handoverOpens("approval-gate")).toBe("editor");
  });

  it("refuses a session id it could not carry unchanged, and says which field", () => {
    const result = readSubmission(
      handover({
        source: { harness: "codex", sessionId: "sess/1", taskText: "Fix the crash." },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.problems)).toEqual([EXCHANGE_PROBLEM_CODES.SUBMISSION_FIELD_INVALID]);
    expect(fields(result.problems)).toEqual(["source.sessionId"]);
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
          metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION } },
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

describe("readStoredWorkflowDocument", () => {
  /** The same document as an older Anthill would have written it down. */
  function olderFormat(): Record<string, unknown> {
    return {
      ...workflow(),
      metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION - 1 } },
    };
  }

  it("brings a document written by the previous format up to this one", () => {
    const result = readStoredWorkflowDocument(olderFormat());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.workflow.metadata?.workflow as { formatVersion: number }).formatVersion).toBe(
      WORKFLOW_FORMAT_VERSION,
    );
  });

  it("leaves the document it was given alone", () => {
    const stored = olderFormat();
    readStoredWorkflowDocument(stored);
    expect(stored).toEqual(olderFormat());
  });

  it("still refuses a document from a format this build does not know", () => {
    const result = readStoredWorkflowDocument({
      ...workflow(),
      metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION + 1 } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(fields(result.problems)).toEqual(["workflow.metadata.workflow.formatVersion"]);
  });

  // The door a sender knocks on stays shut on an old format, because a sender
  // is still there to be told to emit the current one.
  it("is the only door an older format comes through", () => {
    expect(readWorkflowDocument(olderFormat()).ok).toBe(false);
  });
});
