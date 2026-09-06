/**
 * The feed fold, which is where the honesty of the panel is decided.
 *
 * Two things are worth testing hard. A tool call must be one card that
 * updates, not two rows the reader has to pair by eye. And a call that started
 * and never reported finishing must come out as `unknown` once the session is
 * over — not `failed`, because nothing recorded a failure, and not still
 * `working`, because nothing is working any more.
 */

import { describe, expect, it } from "vitest";

import type { AttributedEvent } from "@anthill/live";

import { buildFeed, matchesFilter, readDuration } from "./feed.js";

let seq = 0;
function event(partial: Partial<AttributedEvent> & Pick<AttributedEvent, "kind">): AttributedEvent {
  seq += 1;
  return {
    runId: "ANT-1A2B3C4D",
    seq,
    at: new Date(Date.parse("2026-08-31T10:00:00.000Z") + seq * 1000).toISOString(),
    recordedAt: new Date(Date.parse("2026-08-31T10:00:00.000Z") + seq * 1000).toISOString(),
    cli: "claude-code",
    source: "transcript",
    channel: "claude-code:transcript",
    sessionId: "sess-1",
    title: "Something",
    mapping: { confidence: "unmapped", how: "nothing in the record names a step" },
    ...partial,
  } as AttributedEvent;
}

describe("folding the journal into cards", () => {
  it("makes one card of a tool call, not one per record", () => {
    const cards = buildFeed(
      [
        event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1", title: "Bash" }),
        event({ kind: "tool.end", toolUseId: "t1", title: "Tool finished", ok: true }),
      ],
      false,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("Bash");
    expect(cards[0].state).toBe("done");
    expect(cards[0].events).toEqual(["tool.start", "tool.end"]);
  });

  it("carries the duration the record gave, and works one out when it did not", () => {
    const given = buildFeed(
      [
        event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" }),
        event({ kind: "tool.end", toolUseId: "t1", durationMs: 4200 }),
      ],
      false,
    );
    expect(given[0].durationMs).toBe(4200);

    const worked = buildFeed(
      [
        event({ kind: "tool.start", toolName: "Bash", toolUseId: "t2" }),
        event({ kind: "tool.end", toolUseId: "t2" }),
      ],
      false,
    );
    expect(worked[0].durationMs).toBe(1000);
  });

  it("calls a call that never reported finishing unknown, once the session is over", () => {
    const open = [event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" })];
    expect(buildFeed(open, false)[0].state).toBe("working");
    expect(buildFeed(open, true)[0].state).toBe("unknown");
  });

  it("does not call an unfinished call failed — nothing recorded a failure", () => {
    const cards = buildFeed([event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" })], true);
    expect(cards[0].state).not.toBe("failed");
  });

  it("marks a call failed only when the record says it failed", () => {
    const cards = buildFeed(
      [
        event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" }),
        event({ kind: "tool.end", toolUseId: "t1", ok: false }),
      ],
      false,
    );
    expect(cards[0].state).toBe("failed");
  });

  it("keeps an end whose start was never read, rather than dropping it", () => {
    // Anthill began reading mid-session. The call still happened.
    const cards = buildFeed([event({ kind: "tool.end", toolUseId: "t9", title: "Tool finished" })], false);
    expect(cards).toHaveLength(1);
    expect(cards[0].events).toEqual(["tool.end"]);
  });

  it("lets a closing record name the step when the opening one could not", () => {
    const cards = buildFeed(
      [
        event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" }),
        event({
          kind: "tool.end",
          toolUseId: "t1",
          mapping: { blockId: "test", confidence: "likely", how: "inside the step the agent announced" },
        }),
      ],
      false,
    );
    expect(cards[0].blockId).toBe("test");
    expect(cards[0].confidence).toBe("likely");
  });

  it("sorts each record into the kind that decides how it is drawn", () => {
    const cards = buildFeed(
      [
        event({ kind: "session.start" }),
        event({ kind: "subagent.start", agentName: "Tester", toolUseId: "a1" }),
        event({ kind: "tool.start", toolName: "Read", toolUseId: "t1" }),
        event({ kind: "notification", title: "Waiting for you" }),
      ],
      false,
    );
    expect(cards.map((card) => card.kind)).toEqual(["session", "agent", "tool", "message"]);
  });
});

describe("the filters", () => {
  const cards = buildFeed(
    [
      event({ kind: "session.start" }),
      event({ kind: "tool.start", toolName: "Read", toolUseId: "t1" }),
      event({
        kind: "subagent.start",
        agentName: "Tester",
        toolUseId: "a1",
        mapping: { blockId: "test", confidence: "exact", how: "the agent announced this step" },
      }),
    ],
    false,
  );

  it("passes everything under All", () => {
    expect(cards.filter((card) => matchesFilter(card, "all"))).toHaveLength(3);
  });

  it("selects by kind", () => {
    expect(cards.filter((card) => matchesFilter(card, "tool"))).toHaveLength(1);
    expect(cards.filter((card) => matchesFilter(card, "agent"))).toHaveLength(1);
  });

  it("selects what could not be tied to a step, whatever kind it is", () => {
    const unmapped = cards.filter((card) => matchesFilter(card, "unmapped"));
    expect(unmapped.every((card) => card.confidence === "unmapped")).toBe(true);
    expect(unmapped).toHaveLength(2);
  });
});

describe("reading a duration back", () => {
  it("keeps the unit a person would use", () => {
    expect(readDuration(420)).toBe("420ms");
    expect(readDuration(4200)).toBe("4.2s");
    expect(readDuration(95_000)).toBe("1m 35s");
  });

  it("says nothing rather than something wrong when there is no duration", () => {
    expect(readDuration(undefined)).toBe("");
    expect(readDuration(-1)).toBe("");
  });
});

/**
 * The Messages filter, and why it was empty.
 *
 * ANT-16. Only `notification` counted as a message, and neither transcript
 * writes one — a notification reaches Anthill through hooks, on Claude Code
 * only. So a session could talk all the way through a workflow and the tab
 * meant for its words stayed blank.
 */
describe("what counts as a message", () => {
  const said = () =>
    event({
      kind: "message",
      title: "The agent wrote",
      detail: "I have read the note and will start on the first step now.",
    });

  it("puts what the agent said under Messages", () => {
    const [card] = buildFeed([said()], false);
    expect(card.kind).toBe("message");
    expect(matchesFilter(card, "message")).toBe(true);
    expect(card.detail).toContain("read the note");
  });

  it("keeps a permission prompt there too", () => {
    const [card] = buildFeed([event({ kind: "notification", title: "Waiting for you" })], false);
    expect(card.kind).toBe("message");
  });

  it("does not also count it as a tool", () => {
    const cards = buildFeed(
      [said(), event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1", title: "Bash" })],
      false,
    );
    expect(cards.filter((card) => card.kind === "message")).toHaveLength(1);
    expect(cards.filter((card) => card.kind === "tool")).toHaveLength(1);
  });

  it("is a moment, not a span, so it never sits waiting for an end", () => {
    const [card] = buildFeed([said()], true);
    expect(card.state).toBe("done");
  });

  it("stays session activity when nothing tied it to a step", () => {
    const [card] = buildFeed([said()], false);
    expect(card.confidence).toBe("unmapped");
    expect(matchesFilter(card, "unmapped")).toBe(true);
  });

  it("takes a step association when the record had one", () => {
    const [card] = buildFeed(
      [
        {
          ...said(),
          mapping: { blockId: "implement", confidence: "likely", how: "inside the announced step" },
        },
      ],
      false,
    );
    expect(card.blockId).toBe("implement");
    expect(card.confidence).toBe("likely");
  });
});

/**
 * Who a message card says wrote it.
 *
 * ANT-24. "The agent wrote" was the same heading on every message, so a
 * workflow with a coordinator and three specialists produced a column that
 * told the reader nothing. Identity now comes from the record or not at all.
 */
describe("who wrote it", () => {
  const said = (author?: AttributedEvent["author"]) =>
    event({
      kind: "message",
      title: "Message",
      detail: "On to the tests.",
      ...(author ? { author } : {}),
    });

  it("names the root session as the main agent", () => {
    const [card] = buildFeed([said({ kind: "main" })], false);
    expect(card.title).toBe("Main agent");
  });

  it("names a subagent the record named", () => {
    const [card] = buildFeed([said({ kind: "subagent", name: "Reviewer" })], false);
    expect(card.title).toBe("Reviewer");
  });

  it("still says subagent for one the record did not name", () => {
    // What is unknown is the name, not the fact that it is a subagent, and
    // calling this the main agent would be a different claim.
    const [card] = buildFeed([said({ kind: "subagent" })], false);
    expect(card.title).toBe("Subagent");
  });

  it("reads a record silent about authorship as the main agent", () => {
    // ANT-28. Being a subagent is the special case and the one the observers
    // positively identify, so no marker means the session's own message —
    // including every event written before `author` existed, which the journal
    // still holds for 24 hours.
    const [card] = buildFeed([said()], false);
    expect(card.title).toBe("Main agent");
  });

  it("never borrows the step the message was attributed to", () => {
    // Attribution answers "which step", authorship answers "who". A message
    // sitting inside an announced step tells you nothing about its author.
    const inStep: AttributedEvent = {
      ...said(),
      mapping: { blockId: "implement", confidence: "likely", how: "inside the announced step" },
    };
    const [card] = buildFeed([inStep], false);
    expect(card.title).toBe("Main agent");
    // And the step association is still there, separately.
    expect(card.blockId).toBe("implement");
  });

  it("leaves a tool card's title alone", () => {
    const [card] = buildFeed(
      [event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1", title: "Bash" })],
      false,
    );
    expect(card.title).toBe("Bash");
  });
});
