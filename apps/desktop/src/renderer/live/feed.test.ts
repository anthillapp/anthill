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

import { buildFeed, matchesFilter, readDuration, speakersOf, toolStatus } from "./feed.js";

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
  });

  it("counts a subagent being handed its task as something said", () => {
    const said = cards.filter((card) => matchesFilter(card, "message"));
    expect(said.map((card) => card.kind)).toEqual(["agent"]);
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

/*
  ANT-241. Codex writes turn_aborted into every subagent's file when the
  session is stopped, so each one reads "Stopped by hand" a moment after the
  session does. That is the session's stop reaching it, not somebody stopping
  the subagent: its card is not a failure, and what it got through is unknown.
*/
describe("subagents stopped along with the session, in the feed", () => {
  const T = (s: number) => new Date(Date.parse("2026-10-01T00:26:40.000Z") + s * 1000).toISOString();
  const rollout = { channel: "codex:rollout", source: "rollout" as const };

  it("leaves their cards unknown, not failed", () => {
    const cards = buildFeed(
      [
        event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "tester_mod1_mod2", toolUseId: "call-a", background: true, at: T(4), ...rollout }),
        event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "tester_mod3_mod4", toolUseId: "call-b", background: true, at: T(11), ...rollout }),
        event({ kind: "notification", title: "Stopped by hand", at: T(13.6), ...rollout }),
        event({ kind: "notification", title: "Stopped by hand", parentToolUseId: "call-a", author: { kind: "subagent", name: "tester_mod1_mod2" }, at: T(13.9), ...rollout }),
        event({ kind: "notification", title: "Stopped by hand", parentToolUseId: "call-b", author: { kind: "subagent", name: "tester_mod3_mod4" }, at: T(14.2), ...rollout }),
      ],
      true,
    );
    const agents = cards.filter((card) => card.kind === "agent");
    expect(agents).toHaveLength(2);
    for (const card of agents) {
      expect(card.state).toBe("unknown");
      expect(card.detail).toBe("Stopped with the session before it handed back");
    }
  });
});

/*
  ANT-242. Two writers sent off in the background; the session's own turn
  ended while they wrote, twice, and was then stopped. Each time Claude
  Code's own helper fired a SubagentStop a moment later, naming nobody, and
  each was drawn as a completed subagent beside writers still at work.
*/
describe("Claude Code's own helper stopping after the session's turn", () => {
  const T = (s: number) => new Date(Date.parse("2026-10-01T01:08:00.000Z") + s * 1000).toISOString();
  const tx = { channel: "claude-code:transcript", source: "transcript" as const };
  const hook = { channel: "claude-code:hook", source: "hook" as const };
  const byTheme = { parentToolUseId: "thm", author: { kind: "subagent" as const, name: "Theme Writer: THEMES.md" } };
  const journal = [
    event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "general-purpose", detail: "Caption Writer: CAPTIONS.md", toolUseId: "cap", background: true, at: T(27.5), ...tx }),
    event({ kind: "tool.end", title: "Tool finished", toolUseId: "cap", background: true, at: T(28.8), ...tx }),
    event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "general-purpose", detail: "Theme Writer: THEMES.md", toolUseId: "thm", background: true, at: T(33.9), ...tx }),
    event({ kind: "tool.end", title: "Tool finished", toolUseId: "thm", background: true, at: T(35), ...tx }),
    event({ kind: "turn.end", title: "The agent finished its turn", at: T(36.6), ...tx }),
    event({ kind: "turn.end", title: "The agent finished its turn", at: T(36.7), ...hook }),
    event({ kind: "subagent.end", title: "A subagent finished", at: T(38.4), ...hook }),
    event({ kind: "prompt.submit", title: "A prompt was submitted", at: T(56), ...hook }),
    event({ kind: "turn.end", title: "The agent finished its turn", at: T(64.3), ...hook }),
    event({ kind: "subagent.end", title: "A subagent finished", at: T(66), ...hook }),
    event({ kind: "tool.start", title: "Write", toolName: "Write", toolUseId: "w1", ...byTheme, at: T(77.8), ...tx }),
    event({ kind: "tool.end", title: "Tool finished", toolUseId: "w1", ok: true, ...byTheme, at: T(78.1), ...tx }),
    event({ kind: "notification", title: "Stopped by hand", at: T(93.5), ...tx }),
    event({ kind: "subagent.end", title: "A subagent finished", at: T(95), ...hook }),
  ];

  it("draws no completed subagent while the writers are still at work", () => {
    const agents = buildFeed(journal, false).filter((card) => card.kind === "agent");
    expect(agents).toHaveLength(2);
    expect(agents.every((card) => card.state === "working")).toBe(true);
  });

  it("leaves both writers' outcome unknown once the session is over", () => {
    const agents = buildFeed(journal, true).filter((card) => card.kind === "agent");
    expect(agents.map((card) => card.state)).toEqual(["unknown", "unknown"]);
  });
});

/*
  ANT-245. The helper's stop also came right after a writer's call, where the
  timing rule took it for the writer finishing: "Theme Writer — Completed"
  beside two writers still at work (run ANT-7QB269JF), "Developer (mod3–mod5)
  — Completed" a quarter of a minute before either developer handed back
  (run ANT-A5B8869B). Timings are the journals'.
*/
describe("Claude Code's helper stopping right after a writer's call", () => {
  const T = (time: string) => `2026-10-01T${time}Z`;
  const tx = { channel: "claude-code:transcript", source: "transcript" as const };
  const hook = { channel: "claude-code:hook", source: "hook" as const };

  it("draws no completed subagent after the Theme Writer's Write (ANT-7QB269JF)", () => {
    const byTheme = { parentToolUseId: "o7Dmfr", author: { kind: "subagent" as const, name: "Theme Writer: THEMES.md" } };
    const journal = [
      event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "general-purpose", detail: "Caption Writer: CAPTIONS.md", toolUseId: "cqzGHo", background: true, at: T("02:35:23.034"), ...tx }),
      event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "general-purpose", detail: "Theme Writer: THEMES.md", toolUseId: "o7Dmfr", background: true, at: T("02:35:25.965"), ...tx }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "cqzGHo", background: true, at: T("02:35:29.502"), ...tx }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "o7Dmfr", background: true, at: T("02:35:29.504"), ...tx }),
      event({ kind: "prompt.submit", title: "A prompt was submitted", at: T("02:36:39.840"), ...hook }),
      event({ kind: "turn.end", title: "The agent finished its turn", at: T("02:36:42.279"), ...tx }),
      event({ kind: "turn.end", title: "The agent finished its turn", at: T("02:36:43.292"), ...hook }),
      event({ kind: "tool.start", title: "Write", toolName: "Write", toolUseId: "3TM2RW", detail: "THEMES.md", ...byTheme, at: T("02:36:44.098"), ...tx }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "3TM2RW", ok: true, ...byTheme, at: T("02:36:44.383"), ...tx }),
      event({ kind: "subagent.end", title: "A subagent finished", at: T("02:36:44.853"), ...hook }),
    ];
    const cards = buildFeed(journal, false);
    expect(cards.filter((card) => card.events.includes("subagent.end"))).toEqual([]);
    const agents = cards.filter((card) => card.kind === "agent");
    expect(agents.map((card) => card.state)).toEqual(["working", "working"]);
  });

  it("draws no completed developer before either hands back (ANT-A5B8869B)", () => {
    const by = (call: string) => ({ parentToolUseId: call, author: { kind: "subagent" as const } });
    const journal = [
      event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "developer-mod1-mod2", toolUseId: "J47Djf", background: true, at: T("02:44:11.977"), ...tx }),
      event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "developer-mod3-mod5", toolUseId: "hACRY9", background: true, at: T("02:44:15.918"), ...tx }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "hACRY9", background: true, at: T("02:44:16.549"), ...tx }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "J47Djf", background: true, at: T("02:44:16.551"), ...tx }),
      event({ kind: "turn.end", title: "The agent finished its turn", at: T("02:44:18.881"), ...tx }),
      event({ kind: "turn.end", title: "The agent finished its turn", at: T("02:44:19.963"), ...hook }),
      event({ kind: "tool.start", title: "Bash", toolName: "Bash", toolUseId: "Uyt7R2", ...by("J47Djf"), at: T("02:44:20.711"), ...tx }),
      event({ kind: "message", title: "Message", detail: "The standalone sleep was blocked", ...by("hACRY9"), at: T("02:44:20.868"), ...tx }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "Uyt7R2", ...by("J47Djf"), at: T("02:44:21.247"), ...tx }),
      event({ kind: "tool.start", title: "Bash", toolName: "Bash", toolUseId: "vPc3KQ", ...by("hACRY9"), at: T("02:44:21.388"), ...tx }),
      event({ kind: "tool.end", title: "Tool finished", toolUseId: "vPc3KQ", ...by("hACRY9"), at: T("02:44:21.878"), ...tx }),
      event({ kind: "subagent.end", title: "A subagent finished", at: T("02:44:22.547"), ...hook }),
      event({ kind: "message", title: "Message", detail: "The 120-second wait is running", ...by("hACRY9"), at: T("02:44:22.969"), ...tx }),
    ];
    const cards = buildFeed(journal, false);
    expect(cards.filter((card) => card.events.includes("subagent.end"))).toEqual([]);
    expect(cards.filter((card) => card.kind === "agent").map((card) => card.state)).toEqual(["working", "working"]);
  });
});

/* ANT-245: a SubagentStop naming the subagent that stopped, by its agent id. */
describe("a SubagentStop that names its subagent, in the feed", () => {
  const T = (s: number) => new Date(Date.parse("2026-10-01T05:00:00.000Z") + s * 1000).toISOString();
  const tx = { channel: "claude-code:transcript", source: "transcript" as const };
  const hook = { channel: "claude-code:hook", source: "hook" as const };
  const byA = { parentToolUseId: "call-a", agentId: "agent-a", author: { kind: "subagent" as const } };
  const byB = { parentToolUseId: "call-b", agentId: "agent-b", author: { kind: "subagent" as const } };
  const journal = [
    event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "writer-a", toolUseId: "call-a", background: true, at: T(0), ...tx }),
    event({ kind: "tool.end", title: "Tool finished", toolUseId: "call-a", background: true, at: T(0.2), ...tx }),
    event({ kind: "subagent.start", title: "Delegated to a subagent", agentName: "writer-b", toolUseId: "call-b", background: true, at: T(1), ...tx }),
    event({ kind: "tool.end", title: "Tool finished", toolUseId: "call-b", background: true, at: T(1.2), ...tx }),
    event({ kind: "message", title: "Message", detail: "Writing.", ...byA, at: T(5) }),
    event({ kind: "message", title: "Message", detail: "Writing.", ...byB, at: T(30) }),
  ];

  it("finishes that subagent's card, and draws no other", () => {
    // A's last message was written without a stop reason: only the hook says
    // it stopped, and it says which — though B spoke more recently.
    const cards = buildFeed(
      [...journal, event({ kind: "subagent.end", title: "A subagent finished", agentId: "agent-a", at: T(30.5), ...hook })],
      false,
    );
    expect(cards.filter((card) => card.kind === "agent").map((card) => [card.agentName, card.state])).toEqual([
      ["writer-a", "done"],
      ["writer-b", "working"],
    ]);
    expect(cards.filter((card) => card.kind !== "agent" && card.events.includes("subagent.end"))).toEqual([]);
  });

  /*
    M5 of the 0.8.8-next QA: where subagents hand back, one sent off on its own
    ended a turn to wait on a background command and was drawn Completed
    while it still worked.
  */
  it("keeps a card working until its subagent hands back, where subagents do", () => {
    const handback = (who: typeof byA, s: number) =>
      event({ kind: "tool.start", title: "SubagentHandback", toolName: "SubagentHandback", toolUseId: `hb-${who.agentId}`, ...who, at: T(s), ...tx });
    const paused = [
      ...journal,
      event({ kind: "turn.end", title: "The agent finished its turn", ...byA, at: T(31), ...tx }),
      event({ kind: "subagent.end", title: "A subagent finished", agentId: "agent-a", at: T(31.2), ...hook }),
      handback(byB, 32),
    ];
    const agents = (cards: ReturnType<typeof buildFeed>) =>
      cards.filter((card) => card.kind === "agent").map((card) => [card.agentName, card.state]);
    expect(agents(buildFeed(paused, false))).toEqual([
      ["writer-a", "working"],
      ["writer-b", "done"],
    ]);
    expect(agents(buildFeed([...paused, handback(byA, 60)], false))).toEqual([
      ["writer-a", "done"],
      ["writer-b", "done"],
    ]);
  });

  it("draws nothing for one naming an agent the session never started", () => {
    const cards = buildFeed(
      [...journal, event({ kind: "subagent.end", title: "A subagent finished", agentId: "helper-1", at: T(30.5), ...hook })],
      false,
    );
    expect(cards.filter((card) => card.events.includes("subagent.end"))).toEqual([]);
    expect(cards.filter((card) => card.kind === "agent").map((card) => card.state)).toEqual(["working", "working"]);
  });
});

/**
 * Who acted (ANT-268).
 *
 * The header of every item names who did it. Only what the record says counts:
 * a delegate's work carries the call that started it, and nothing is handed to
 * whichever subagent happened to be at work nearby.
 */
describe("who each item is from", () => {
  const profiles: Record<string, string> = { test: "Tester" };
  const profileOf = (blockId: string | undefined) => (blockId ? profiles[blockId] : undefined);
  const tested = { blockId: "test", confidence: "exact" as const, how: "the agent announced this step" };

  it("signs a subagent's own calls and words with the subagent", () => {
    const cards = buildFeed(
      [
        event({ kind: "subagent.start", agentName: "general-purpose", toolUseId: "a1", mapping: tested }),
        event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1", parentToolUseId: "a1" }),
        event({ kind: "message", detail: "3 failed.", parentToolUseId: "a1", author: { kind: "subagent" } }),
      ],
      false,
    );
    const speakers = speakersOf(cards, profileOf);
    for (const card of cards) expect(speakers.get(card.id)).toEqual({ kind: "agent", name: "Tester" });
  });

  it("names a subagent by the runtime's word when no block gives a profile", () => {
    const cards = buildFeed([event({ kind: "subagent.start", agentName: "general-purpose", toolUseId: "a1" })], false);
    expect(speakersOf(cards, profileOf).get(cards[0].id)).toEqual({ kind: "agent", name: "general-purpose" });
  });

  it("leaves everything else with the session's own agent, whatever block it was in", () => {
    const cards = buildFeed(
      [
        event({ kind: "subagent.start", agentName: "general-purpose", toolUseId: "a1", mapping: tested }),
        // In the same block, while the subagent works, but not from it.
        event({ kind: "tool.start", toolName: "Read", toolUseId: "t2", mapping: tested }),
        event({ kind: "message", detail: "Three tests fail.", author: { kind: "main" } }),
      ],
      false,
    );
    const speakers = speakersOf(cards, profileOf);
    expect(speakers.get(cards[1].id)).toEqual({ kind: "orchestrator" });
    expect(speakers.get(cards[2].id)).toEqual({ kind: "orchestrator" });
  });

  it("keeps a subagent the record signed but named nowhere a subagent", () => {
    const cards = buildFeed([event({ kind: "message", detail: "Done.", author: { kind: "subagent" } })], false);
    expect(speakersOf(cards, profileOf).get(cards[0].id)).toEqual({ kind: "agent", name: "Subagent" });
  });
});

describe("a tool call's status in its row", () => {
  it("reads as a duration once done, and never as Running after the session ended", () => {
    expect(toolStatus({ state: "done", durationMs: 300 })).toBe("300ms");
    expect(toolStatus({ state: "done" })).toBe("Done");
    expect(toolStatus({ state: "failed", durationMs: 900 })).toBe("Failed · 900ms");
    expect(toolStatus({ state: "working" })).toBe("Running");
    expect(toolStatus({ state: "unknown" })).toBe("No result");

    // Settled: a call still open when the session ends is no longer running.
    const [card] = buildFeed([event({ kind: "tool.start", toolName: "Bash", toolUseId: "t1" })], true);
    expect(toolStatus(card)).toBe("No result");
  });
});
