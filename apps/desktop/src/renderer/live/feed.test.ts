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

  it("does not call an unfinished call failed – nothing recorded a failure", () => {
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

/*
  ANT-60. A call whose end never arrived said "Running…" for the rest of the
  session — the ANT-45 report showed seven Bash commands running at once. The
  trigger is a record, not a duration: the main agent does not end a turn
  while one of its calls is still out.
*/
describe("a call whose end never arrived", () => {
  const turnEnd = (partial: Partial<AttributedEvent> = {}) =>
    event({ kind: "turn.end", title: "The agent finished its turn", ...partial });

  it("is no longer called working once the session's turn has ended", () => {
    const cards = buildFeed(
      [event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1", channel: "claude-code:hook" }), turnEnd()],
      false,
    );
    expect(cards[0].state).toBe("unknown");
  });

  it("says unknown, not failed – nothing recorded a failure", () => {
    const cards = buildFeed([event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" }), turnEnd()], false);
    expect(cards[0].state).not.toBe("failed");
    expect(cards[0].state).toBe("unknown");
  });

  it("still settles if its end turns up after the turn", () => {
    // A background delegate's call can outlive the turn around it.
    const cards = buildFeed(
      [
        event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" }),
        turnEnd(),
        event({ kind: "tool.end", toolUseId: "t1", title: "Tool finished", ok: true }),
      ],
      false,
    );
    expect(cards[0].state).toBe("done");
  });

  it("stays working while the turn is still going", () => {
    const cards = buildFeed([event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" })], false);
    expect(cards[0].state).toBe("working");
  });

  it("is not closed by a delegate's turn ending", () => {
    const cards = buildFeed(
      [
        event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" }),
        turnEnd({ author: { kind: "subagent", name: "Tester" } }),
      ],
      false,
    );
    expect(cards[0].state).toBe("working");
  });

  it("is not closed by another session's turn ending", () => {
    const cards = buildFeed(
      [event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" }), turnEnd({ sessionId: "sess-2" })],
      false,
    );
    expect(cards[0].state).toBe("working");
  });

  it("leaves a call that did pair exactly as it was", () => {
    const cards = buildFeed(
      [
        event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" }),
        event({ kind: "tool.end", toolUseId: "t1", title: "Tool finished", ok: false }),
        turnEnd(),
      ],
      false,
    );
    expect(cards[0].state).toBe("failed");
  });

  it("leaves an agent card to its own end – a delegate can outlive the turn that sent it", () => {
    const cards = buildFeed(
      [event({ kind: "subagent.start", agentName: "Tester", toolUseId: "a1" }), turnEnd()],
      false,
    );
    expect(cards[0].state).toBe("working");
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
    // A session picked up again later: hours and days, not thousands of minutes.
    expect(readDuration(2 * 3_600_000 + 5 * 60_000 + 7_000)).toBe("2h 5m");
    expect(readDuration(89 * 3_600_000 + 31 * 60_000)).toBe("3d 17h");
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

/*
  ANT-173. Every dispatch card stayed "Running…" after the session finished,
  and each subagent was drawn twice — once running, once completed from the
  hooks' SubagentStop. The hooks' PreToolUse for the same Agent call took the
  pairing key from the dispatch card, so the end closed that one instead.
*/
describe("a subagent's dispatch card", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-27T18:13:00.000Z") + s * 1000).toISOString();
  const tx = { channel: "claude-code:transcript", source: "transcript" as const };
  const hook = { channel: "claude-code:hook", source: "hook" as const };

  it("closes on its end however many channels opened it, and is drawn once", () => {
    const cards = buildFeed(
      [
        event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "reviewer", toolUseId: "call-r", at: T(59.6), ...tx }),
        event({ kind: "tool.start", title: "Agent", toolName: "Agent", toolUseId: "call-r", at: T(59.7), ...hook }),
        event({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "call-r", author: { kind: "subagent", name: "Review" }, at: T(90.6), ...tx }),
        event({ kind: "subagent.end", title: "A subagent finished", at: T(90.7), ...hook }),
        event({ kind: "tool.end", title: "Agent", toolName: "Agent", toolUseId: "call-r", at: T(90.9), ...hook }),
      ],
      true,
    );
    const agents = cards.filter((card) => card.kind === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ state: "done", agentName: "reviewer" });
    expect(agents[0].durationMs).toBeGreaterThan(30_000);
    expect(cards.some((card) => card.kind === "tool" && card.toolUseId === "call-r")).toBe(false);
    expect(cards.some((card) => card.state === "working")).toBe(false);
  });

  it("stays running past a background launch receipt, and finishes when the subagent's turn ends", () => {
    const journal = [
      event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "specialist-a", toolUseId: "call-a", at: T(0), ...tx }),
      event({ kind: "tool.start", title: "Agent", toolName: "Agent", toolUseId: "call-a", at: T(0.1), ...hook }),
      event({ kind: "tool.end", title: "Agent", toolName: "Agent", toolUseId: "call-a", at: T(0.3), ...hook }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "call-a", background: true, at: T(0.35), ...tx }),
    ];
    const running = buildFeed(journal, false).filter((card) => card.kind === "agent");
    expect(running).toHaveLength(1);
    expect(running[0].state).toBe("working");

    const finished = buildFeed(
      [
        ...journal,
        event({ kind: "turn.end", title: "The agent finished its turn", parentToolUseId: "call-a", author: { kind: "subagent" }, at: T(27), ...tx }),
        event({ kind: "subagent.end", title: "A subagent finished", at: T(27.1), ...hook }),
      ],
      true,
    ).filter((card) => card.kind === "agent");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ state: "done", durationMs: 27_000 });
  });

  it("keeps a SubagentStop it cannot tie to anything as a card of its own", () => {
    const cards = buildFeed([event({ kind: "subagent.end", title: "A subagent finished", at: T(1), ...hook })], true);
    expect(cards).toHaveLength(1);
  });
});

/* ANT-190: a subagent stopped by hand is not drawn as completed. */
describe("a subagent stopped by hand, in the feed", () => {
  const T = (s: number) => new Date(Date.parse("2026-09-27T23:25:00.000Z") + s * 1000).toISOString();
  const tx = { channel: "claude-code:transcript", source: "transcript" as const };
  const hook = { channel: "claude-code:hook", source: "hook" as const };

  it("fails its dispatch card, and the SubagentStop after it is not a completion", () => {
    const cards = buildFeed(
      [
        event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "developer-mod3-mod5", toolUseId: "call-b", at: T(0), ...tx }),
        event({ kind: "tool.end", title: "Tool finished", toolUseId: "call-b", background: true, at: T(0.2), ...tx }),
        event({ kind: "notification", title: "Stopped by hand", parentToolUseId: "call-b", author: { kind: "subagent" }, at: T(48.7), ...tx }),
        event({ kind: "subagent.end", title: "A subagent finished", at: T(48.9), ...hook }),
      ],
      false,
    );
    const agents = cards.filter((card) => card.kind === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ state: "failed", detail: "Stopped by hand before it handed back" });
    expect(cards.some((card) => card.state === "done" && card.kind === "agent")).toBe(false);
  });
});
