/**
 * The numbers a summary may claim.
 *
 * Two strengths of claim, and the tests police the line between them: time
 * comes from exact markers and is span arithmetic; tokens are the harness's
 * recordings, summed as recorded at session level and attributed per step
 * only where a recording fell inside an announced span. Nothing is divided,
 * estimated, or defaulted to zero.
 */

import { describe, expect, it } from "vitest";

import type { AttributedEvent } from "./live-session.js";
import { sessionMetrics, timeByAgent } from "./metrics.js";

const T0 = Date.parse("2026-08-29T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

let seq = 0;
function event(partial: Partial<AttributedEvent> & Pick<AttributedEvent, "kind">): AttributedEvent {
  seq += 1;
  return {
    runId: "ANT-1A2B3C4D",
    seq,
    at: at(seq * 1000),
    recordedAt: at(seq * 1000),
    cli: "claude-code",
    source: "transcript",
    channel: "claude-code:transcript",
    sessionId: "sess-1",
    title: "Something",
    mapping: { confidence: "unmapped", how: "nothing in the record names a step" },
    ...partial,
  } as AttributedEvent;
}

function step(blockId: string, when: number): AttributedEvent {
  return event({
    kind: "step.marker",
    title: "Step announced",
    blockId,
    at: at(when),
    mapping: { blockId, confidence: "exact", how: "the agent announced this step" },
  });
}

function usage(tokens: { in: number; out: number }, when: number, blockId?: string): AttributedEvent {
  return event({
    kind: "usage",
    title: "Token usage recorded",
    tokens,
    at: at(when),
    mapping: blockId
      ? { blockId, confidence: "likely", how: "inside the step the agent announced" }
      : { confidence: "unmapped", how: "nothing in the record names a step" },
  });
}

describe("time from exact markers", () => {
  it("runs each span from its announcement to the next", () => {
    const metrics = sessionMetrics([step("plan", 0), step("build", 60_000), step("check", 180_000)]);
    expect(metrics.spans[0]).toMatchObject({ blockId: "plan", durationMs: 60_000 });
    expect(metrics.spans[1]).toMatchObject({ blockId: "build", durationMs: 120_000 });
  });

  it("leaves the last span open while nothing has ended it", () => {
    const metrics = sessionMetrics([step("plan", 0), step("build", 60_000)]);
    expect(metrics.spans[1].endedAt).toBeUndefined();
    expect(metrics.spans[1].durationMs).toBeUndefined();
  });

  it("ends the last span at the settle, once there is one", () => {
    const metrics = sessionMetrics([step("plan", 0)], at(90_000));
    expect(metrics.spans[0].durationMs).toBe(90_000);
  });

  it("counts a loop as passes of the same step, each with its own span", () => {
    const metrics = sessionMetrics([
      step("build", 0),
      step("check", 60_000),
      step("build", 120_000),
      step("check", 200_000),
    ]);
    expect(metrics.passesByBlock.get("build")).toBe(2);
    expect(metrics.spans.filter((span) => span.blockId === "build").map((s) => s.pass)).toEqual([
      1, 2,
    ]);
    // Total announced time for the step sums its finished passes.
    expect(metrics.timeByBlock.get("build")).toBe(60_000 + 80_000);
  });

  it("takes nothing from a marker for a step outside the workflow", () => {
    const stray = event({
      kind: "step.marker",
      title: "Step announced",
      blockId: "nonsense",
      at: at(5_000),
      mapping: { confidence: "unmapped", how: "not a step in this workflow" },
    });
    expect(sessionMetrics([stray]).spans).toEqual([]);
  });
});

describe("tokens from the harness's recordings", () => {
  it("sums the session total exactly as recorded", () => {
    const metrics = sessionMetrics([
      usage({ in: 1000, out: 50 }, 1_000),
      usage({ in: 2000, out: 150 }, 2_000),
    ]);
    expect(metrics.tokensRecorded).toEqual({ in: 3000, out: 200 });
  });

  it("has no total at all when nothing was recorded — unavailable, not zero", () => {
    const metrics = sessionMetrics([step("plan", 0)]);
    expect(metrics.tokensRecorded).toBeUndefined();
  });

  it("attributes to a step only what fell inside its announced span", () => {
    const metrics = sessionMetrics([
      step("plan", 0),
      usage({ in: 500, out: 20 }, 10_000, "plan"),
      usage({ in: 900, out: 70 }, 20_000),
    ]);
    expect(metrics.tokensLikelyByBlock.get("plan")).toEqual({ in: 500, out: 20 });
    expect(metrics.tokensUnattributed).toEqual({ in: 900, out: 70 });
    // And the total is the sum of both, never a division of either.
    expect(metrics.tokensRecorded).toEqual({ in: 1400, out: 90 });
  });

  it("splits a looped step's tokens by pass, and the passes sum to the step", () => {
    const metrics = sessionMetrics([
      step("test", 0),
      usage({ in: 100, out: 10 }, 1_000, "test"),
      step("fix", 2_000),
      usage({ in: 50, out: 5 }, 3_000, "fix"),
      step("test", 4_000),
      usage({ in: 300, out: 30 }, 5_000, "test"),
      usage({ in: 1, out: 1 }, 6_000, "test"),
    ]);
    const passes = metrics.spans.filter((span) => span.blockId === "test").map((span) => span.tokens);
    expect(passes).toEqual([{ in: 100, out: 10 }, { in: 301, out: 31 }]);
    expect(metrics.tokensLikelyByBlock.get("test")).toEqual({ in: 401, out: 41 });
  });

  it("gives a pass with no recording no tokens at all, rather than zero", () => {
    const metrics = sessionMetrics([step("plan", 0), step("build", 1_000)]);
    expect(metrics.spans.every((span) => span.tokens === undefined)).toBe(true);
  });

  it("carries a recording made before a step's first announcement into its first pass", () => {
    const metrics = sessionMetrics([usage({ in: 7, out: 3 }, 0, "plan"), step("plan", 1_000)]);
    expect(metrics.spans[0].tokens).toEqual({ in: 7, out: 3 });
    expect(metrics.tokensLikelyByBlock.get("plan")).toEqual({ in: 7, out: 3 });
  });
});

describe("time per agent", () => {
  it("sums finished spans through the caller's own mapping", () => {
    const metrics = sessionMetrics(
      [step("plan", 0), step("build", 60_000), step("check", 100_000)],
      at(160_000),
    );
    const agents = timeByAgent(metrics, (blockId) =>
      blockId === "check" ? "Reviewer" : "Developer",
    );
    expect(agents.get("Developer")).toBe(100_000);
    expect(agents.get("Reviewer")).toBe(60_000);
  });

  it("assigns nothing for an open span or an agentless step", () => {
    const metrics = sessionMetrics([step("plan", 0)]);
    expect(timeByAgent(metrics, () => "Developer").size).toBe(0);
  });
});
