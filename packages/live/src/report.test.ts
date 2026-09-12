import { describe, expect, it } from "vitest";

import { isReportFor, parseReportLine, reportLine } from "./report.js";

const marker = { runId: "ANT-1A2B3C4D", nonce: "9f8e7d" };

describe("harness reports", () => {
  it("round-trips a run report through the line format", () => {
    const report = { kind: "run" as const, runId: marker.runId, nonce: marker.nonce, at: "2026-08-29T10:00:00.000Z" };
    expect(parseReportLine(reportLine(report))).toEqual(report);
  });

  it("round-trips a step report through the line format", () => {
    const report = { kind: "step" as const, runId: marker.runId, nonce: marker.nonce, stepId: "read", at: "2026-08-29T10:01:00.000Z" };
    expect(parseReportLine(reportLine(report))).toEqual(report);
  });

  it("drops a half-written line", () => {
    expect(parseReportLine('{"kind":"step","runId":"ANT-1A2B3C4D"')).toBeUndefined();
  });

  it("drops a line from some other tool", () => {
    expect(parseReportLine(JSON.stringify({ kind: "hook", sessionId: "abc" }))).toBeUndefined();
  });

  it("drops a line missing the fields the observer needs", () => {
    expect(parseReportLine(JSON.stringify({ kind: "step", runId: marker.runId, nonce: marker.nonce, at: "" }))).toBeUndefined();
    expect(parseReportLine(JSON.stringify({ kind: "step", runId: marker.runId, nonce: marker.nonce, stepId: "", at: "2026-08-29T10:01:00.000Z" }))).toBeUndefined();
    expect(parseReportLine(JSON.stringify({ kind: "step", nonce: marker.nonce, stepId: "read", at: "2026-08-29T10:01:00.000Z" }))).toBeUndefined();
    expect(parseReportLine("42")).toBeUndefined();
    expect(parseReportLine('"a string"')).toBeUndefined();
  });

  it("drops a line whose at is not a parseable date (the evidence fold would throw on it)", () => {
    expect(parseReportLine(JSON.stringify({ kind: "step", runId: marker.runId, nonce: marker.nonce, stepId: "read", at: "not-a-date" }))).toBeUndefined();
    expect(parseReportLine(JSON.stringify({ kind: "run", runId: marker.runId, nonce: marker.nonce, at: "yesterday" }))).toBeUndefined();
  });

  it("needs both halves of the marker before it will claim a report", () => {
    const report = { kind: "step" as const, runId: marker.runId, nonce: "000000", stepId: "read", at: "2026-08-29T10:01:00.000Z" };
    expect(isReportFor(report, marker)).toBe(false);
    const other = { kind: "step" as const, runId: "ANT-99999999", nonce: marker.nonce, stepId: "read", at: "2026-08-29T10:01:00.000Z" };
    expect(isReportFor(other, marker)).toBe(false);
    expect(isReportFor({ kind: "run", runId: marker.runId, nonce: marker.nonce, at: "2026-08-29T10:00:00.000Z" }, marker)).toBe(true);
  });
});
