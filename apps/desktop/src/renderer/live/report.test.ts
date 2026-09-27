/**
 * The report's derivations on their own: what counts as reached, how figures
 * are written, and that nothing missing becomes a zero.
 */

import { describe, expect, it } from "vitest";
import type { Workflow } from "@anthill/workflow-schema";
import type { LiveSessionView, SessionMetrics } from "@anthill/live";

import { compact, endStateOf, lastWords, outcomeOf, sessionUsage, tokenLine } from "./report.js";

const workflow = {
  id: "w",
  name: "W",
  version: "1",
  nodes: [
    { id: "start", type: "start", name: "Start", config: {} },
    { id: "a", type: "agent", name: "Build", config: { agentId: "dev" } },
    { id: "b", type: "agent", name: "Check", config: { agentId: "qa" } },
    { id: "end", type: "end", name: "Done", config: {} },
  ],
  edges: [],
  metadata: { workflow: { formatVersion: 4, agents: [{ id: "dev", name: "Developer" }, { id: "qa", name: "Tester" }] } },
} as unknown as Workflow;

const view = (states: Record<string, LiveSessionView["blocks"][string]["state"]>): LiveSessionView => ({
  blocks: Object.fromEntries(
    Object.entries(states).map(([id, state]) => [id, { state, confidence: "exact", passes: state === "queued" ? 0 : 1 }]),
  ),
  activeBlockIds: [],
  spans: [],
  detours: [],
  events: [],
  unmappedCount: 0,
  startedAt: "2026-08-29T10:00:00.000Z",
  empty: false,
});

const metrics = (over: Partial<SessionMetrics> = {}): SessionMetrics => ({
  spans: [{ blockId: "a", pass: 1, startedAt: "2026-08-29T10:00:00.000Z", endedAt: "2026-08-29T10:02:00.000Z", durationMs: 120_000 }],
  passesByBlock: new Map([["a", 1]]),
  timeByBlock: new Map([["a", 120_000]]),
  tokensLikelyByBlock: new Map(),
  ...over,
});

describe("usage by block and agent", () => {
  it("leaves a step never reached, and its agent, without figures", () => {
    const usage = sessionUsage(workflow, view({ a: "done", b: "queued" }), metrics(), "2026-08-29T10:03:00.000Z");
    expect(usage.blocks.find((block) => block.blockId === "b")).toMatchObject({ outcome: "notReached", passes: [] });
    expect(usage.blocks.find((block) => block.blockId === "b")?.durationMs).toBeUndefined();
    expect(usage.agents.map((agent) => agent.name)).toEqual(["Developer"]);
    expect(usage.durationMs).toBe(180_000);
  });

  it("has no token figure where nothing was recorded", () => {
    const usage = sessionUsage(workflow, view({ a: "done", b: "queued" }), metrics(), undefined);
    expect(usage.blocks[0].tokens).toBeUndefined();
    expect(usage.agents[0].tokens).toBeUndefined();
    expect(usage.durationMs).toBeUndefined();
  });
});

describe("words and figures", () => {
  it("reads end states from the run", () => {
    expect(endStateOf({ state: "completed" } as never)).toBe("completed");
    expect(endStateOf({ state: "observation_lost" } as never)).toBe("lost");
    expect(endStateOf({ state: "detected_live" } as never)).toBeUndefined();
    expect(outcomeOf("queued")).toBe("notReached");
    expect(outcomeOf("needsYou")).toBe("waiting");
  });

  it("writes figures compactly, marks presumed ones, and never writes a missing one as 0", () => {
    expect(compact(860)).toBe("860");
    expect(compact(1_240)).toBe("1.2k");
    expect(compact(61_400)).toBe("61k");
    expect(tokenLine({ in: 61_400, out: 900 }, true)).toBe("~61k in · ~900 out");
    expect(tokenLine(undefined, true)).toBe("no token data");
  });
});

/*
  ANT-158. The quote was headed "Codex asked" whenever any step was amber —
  including a step left amber only because a turn ended with nothing after
  it, where nothing was asked at all.
*/
describe("the last words' heading", () => {
  const said = (waitReason?: "asked" | "yielded"): LiveSessionView => ({
    ...view({ a: "done", b: waitReason ? "needsYou" : "done" }),
    blocks: {
      a: { state: "done", confidence: "exact", passes: 1 },
      b: waitReason
        ? { state: "needsYou", confidence: "exact", passes: 1, waitReason }
        : { state: "done", confidence: "exact", passes: 1 },
    },
    events: [
      {
        runId: "r", seq: 1, at: "2026-08-29T10:02:00.000Z", recordedAt: "2026-08-29T10:02:00.000Z",
        cli: "codex", source: "rollout", channel: "codex:rollout", kind: "message", title: "Message",
        detail: "Implemented and tested.", author: { kind: "main" }, mapping: { confidence: "unmapped" },
      },
    ] as unknown as LiveSessionView["events"],
  });

  it("asks only when the CLI recorded a request", () => {
    expect(lastWords(said("asked"), "completed")?.asksUser).toBe(true);
  });

  it("only says, when a step is amber because a turn ended", () => {
    expect(lastWords(said("yielded"), "completed")?.asksUser).toBe(false);
  });

  it("only says, when the run finished", () => {
    expect(lastWords(said(), "completed")?.asksUser).toBe(false);
  });
});
