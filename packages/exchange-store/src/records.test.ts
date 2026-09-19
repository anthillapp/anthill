/**
 * Reading a record back, and refusing to.
 *
 * The store's degradation story lives here: a record is judged on its own, and
 * the two ways of failing are told apart because they mean different things to
 * whoever reads the message. "This build cannot read it" is a loss to report;
 * "a newer Anthill wrote it" is an instruction to leave it alone.
 */

import { describe, expect, it } from "vitest";

import { EXCHANGE_STORE_PROBLEM_CODES } from "./problems.js";
import {
  EXCHANGE_STORE_VERSION,
  encodeRecord,
  parseBinding,
  parseIdentity,
  parseInboxDrop,
  parseReadiness,
  parseRevision,
} from "./records.js";

const WORKFLOW = {
  id: "workflow-1",
  name: "Ship the fix",
  version: "0.1.0",
  nodes: [{ id: "start", type: "start", name: "Start", config: {} }],
  edges: [],
};

function identity(overrides: Record<string, unknown> = {}): string {
  return encodeRecord({
    workflowId: "workflow-1",
    createdAt: "2026-09-01T09:00:00.000Z",
    idempotencyKey: "handover-7",
    mode: "approval-gate",
    exchangeVersion: 1,
    source: { harness: "claude-code", sessionId: "session-abc", taskText: "Fix it." },
    ...overrides,
  });
}

function code(text: string, parse: (text: string, where: string) => { ok: boolean }): string {
  const result = parse(text, "a/record.json") as { ok: false; problem: { code: string } };
  return result.problem.code;
}

describe("the envelope", () => {
  it("round-trips a record through the version it stamps", () => {
    const read = parseIdentity(identity(), "a/identity.json");

    expect(read.ok).toBe(true);
    if (read.ok) expect(read.record.idempotencyKey).toBe("handover-7");
    expect(JSON.parse(identity()).version).toBe(EXCHANGE_STORE_VERSION);
  });

  it("refuses a record from the future rather than opening it", () => {
    const fromTheFuture = JSON.stringify({ ...JSON.parse(identity()), version: 99 });

    const read = parseIdentity(fromTheFuture, "a/identity.json");

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.problem.code).toBe(EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_TOO_NEW);
      // Both numbers, so a person reading the message knows which way to move.
      expect(read.problem.message).toContain("99");
      expect(read.problem.message).toContain(String(EXCHANGE_STORE_VERSION));
    }
  });

  it("refuses anything that is not a versioned object", () => {
    for (const text of ["", "not json", "[]", '"a string"', "{}", '{"version":"1"}']) {
      expect(code(text, parseIdentity), text).toBe(
        EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE,
      );
    }
  });
});

describe("identity", () => {
  it("will not read a handover whose mode or harness it does not know", () => {
    expect(code(identity({ mode: "whenever" }), parseIdentity)).toBe(
      EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE,
    );
    expect(
      code(
        identity({ source: { harness: "gemini", sessionId: "s", taskText: "t" } }),
        parseIdentity,
      ),
    ).toBe(EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE);
  });

  it("reads back a handover that carried no task text", () => {
    // Blank is what may have gone in: an empty task text is a completeness
    // question, not a malformed record, and a stored handover that was
    // incomplete is still a handover.
    const read = parseIdentity(
      identity({ source: { harness: "codex", sessionId: "s", taskText: "" } }),
      "a/identity.json",
    );

    expect(read.ok).toBe(true);
  });

  it("will not read a creation date that is not a date", () => {
    expect(code(identity({ createdAt: "whenever" }), parseIdentity)).toBe(
      EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE,
    );
  });
});

describe("a revision", () => {
  const record = (overrides: Record<string, unknown> = {}) =>
    encodeRecord({
      revision: 1,
      createdAt: "2026-09-01T09:00:00.000Z",
      by: "harness",
      digest: "0123456789abcdef",
      workflow: WORKFLOW,
      ...overrides,
    });

  it("comes back with the workflow it was storing", () => {
    const read = parseRevision(record(), "a/0001.json");

    expect(read.ok).toBe(true);
    if (read.ok) expect(read.record.workflow.id).toBe("workflow-1");
  });

  it("is refused when the workflow inside it is not one", () => {
    expect(code(record({ workflow: { id: "workflow-1" } }), parseRevision)).toBe(
      EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE,
    );
  });

  it("is refused when nobody wrote it and when it is numbered nonsense", () => {
    expect(code(record({ by: "somebody" }), parseRevision)).toBe(
      EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE,
    );
    expect(code(record({ revision: 0 }), parseRevision)).toBe(
      EXCHANGE_STORE_PROBLEM_CODES.STORE_RECORD_UNREADABLE,
    );
  });
});

describe("readiness, a binding and a drop", () => {
  it("read back what they wrote", () => {
    const ready = parseReadiness(
      encodeRecord({ revision: 2, at: "2026-09-01T09:00:00.000Z" }),
      "a/0002.ready",
    );
    expect(ready.ok && ready.record.revision).toBe(2);

    const binding = parseBinding(
      encodeRecord({
        runId: "ANT-11111111",
        workflowId: "workflow-1",
        revision: 2,
        nonce: "abc123",
        sessionId: "session-abc",
        at: "2026-09-01T09:00:00.000Z",
      }),
      "a/run.json",
    );
    expect(binding.ok && binding.record.sessionId).toBe("session-abc");

    const drop = parseInboxDrop(
      encodeRecord({
        kind: "display",
        key: "drop-1",
        workflowId: "workflow-1",
        revision: 2,
        at: "2026-09-01T09:00:00.000Z",
      }),
      "inbox/drop-1.json",
    );
    expect(drop.ok && drop.record.kind).toBe("display");
  });

  it("refuses a bind request that does not say which run", () => {
    const text = encodeRecord({
      kind: "bind",
      key: "drop-1",
      workflowId: "workflow-1",
      revision: 2,
      at: "2026-09-01T09:00:00.000Z",
    });

    const drop = parseInboxDrop(text, "inbox/drop-1.json");

    expect(drop.ok).toBe(false);
    if (!drop.ok) expect(drop.problem.message).toContain("which run");
  });
});
