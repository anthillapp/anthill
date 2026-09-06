/**
 * One action, however many channels wrote it down.
 *
 * ANT-48. A Claude Code session with hooks installed is described twice, and
 * every fold over the journal counted both: 21 transcript tool starts and 11
 * hook tool starts in one session became a card each, the Activity count read
 * 22 for eleven actions, and a step announced once was drawn as "pass 2".
 *
 * The rules being defended here are what stops the fix from hiding real work:
 * only records from *different* channels merge, and the merge is a union of
 * what each knew rather than a preference for one of them.
 */

import { describe, expect, it } from "vitest";

import { mergeChannels } from "./channels.js";
import type { ObservationEvent } from "./observation-event.js";

let seq = 0;
function event(
  partial: Partial<ObservationEvent> & Pick<ObservationEvent, "kind" | "title" | "channel">,
): ObservationEvent {
  seq += 1;
  return {
    runId: "ANT-1A2B3C4D",
    seq,
    at: new Date(Date.parse("2026-09-04T10:00:00.000Z") + seq * 1000).toISOString(),
    recordedAt: new Date(Date.parse("2026-09-04T10:00:00.000Z") + seq * 1000).toISOString(),
    cli: "claude-code",
    source: partial.channel.endsWith("hook") ? "hook" : "transcript",
    sessionId: "sess-1",
    ...partial,
  };
}

const HOOK = "claude-code:hook";
const SCRIPT = "claude-code:transcript";

/** The pair as it appears on disk: same tool-use id, ~100ms apart. */
function pair(id: string, when: string) {
  return [
    event({
      kind: "tool.start",
      title: "Bash",
      channel: SCRIPT,
      toolUseId: id,
      at: when,
      detail: "List existing agent files",
    }),
    event({
      kind: "tool.start",
      title: "Bash",
      channel: HOOK,
      toolUseId: id,
      at: new Date(Date.parse(when) + 88).toISOString(),
      toolName: "Bash",
    }),
  ];
}

describe("merging what two channels saw", () => {
  it("makes one action out of two records of it", () => {
    const merged = mergeChannels(pair("toolu_1", "2026-09-04T10:00:00.000Z"));
    expect(merged).toHaveLength(1);
  });

  it("keeps what each of them knew", () => {
    // The whole reason the journal keeps both: the transcript knows what the
    // call was aimed at, the hook names the tool. Neither is preferred.
    const [one] = mergeChannels(pair("toolu_1", "2026-09-04T10:00:00.000Z"));
    expect(one.detail).toBe("List existing agent files");
    expect(one.toolName).toBe("Bash");
  });

  it("says it was read from both", () => {
    const [one] = mergeChannels(pair("toolu_1", "2026-09-04T10:00:00.000Z"));
    expect(one.channel).toBe(SCRIPT);
    expect(one.alsoFrom).toEqual([HOOK]);
  });

  it("takes the earlier record's time, since that is when it happened", () => {
    const [script, hook] = pair("toolu_1", "2026-09-04T10:00:05.000Z");
    const [one] = mergeChannels([hook, script]);
    expect(one.at).toBe(script.at);
  });

  it("takes a measured duration over none at all", () => {
    const start = event({ kind: "tool.end", title: "Tool finished", channel: SCRIPT, toolUseId: "t1" });
    const measured = event({ kind: "tool.end", title: "Bash", channel: HOOK, toolUseId: "t1", durationMs: 613 });
    expect(mergeChannels([start, measured])[0].durationMs).toBe(613);
  });

  it("takes a failure recorded by either of them", () => {
    const quiet = event({ kind: "tool.end", title: "Tool finished", channel: SCRIPT, toolUseId: "t1" });
    const failed = event({ kind: "tool.end", title: "Bash", channel: HOOK, toolUseId: "t1", ok: false });
    expect(mergeChannels([quiet, failed])[0].ok).toBe(false);
  });

  it("takes a step id from whichever record carries one", () => {
    // The one field that moves the graph.
    const plain = event({ kind: "step.marker", title: "Step announced", channel: SCRIPT, detail: "implement" });
    const marked = event({
      kind: "step.marker",
      title: "Step announced",
      channel: HOOK,
      detail: "implement",
      blockId: "implement",
    });
    expect(mergeChannels([plain, marked])[0].blockId).toBe("implement");
  });

  it("pairs a prompt and a step marker, which carry no id", () => {
    const at = "2026-09-04T10:00:00.000Z";
    const merged = mergeChannels([
      event({ kind: "prompt.submit", title: "The workflow was pasted", channel: SCRIPT, at }),
      event({
        kind: "prompt.submit",
        title: "A prompt was submitted",
        channel: HOOK,
        at: new Date(Date.parse(at) + 75).toISOString(),
      }),
    ]);
    expect(merged).toHaveLength(1);
  });
});

describe("what must not be merged", () => {
  it("keeps two records from the same channel apart", () => {
    // Two of these is a harness that did the thing twice. Folding them would
    // hide work rather than reveal it.
    const first = event({ kind: "prompt.submit", title: "A prompt was submitted", channel: HOOK });
    const second = event({
      kind: "prompt.submit",
      title: "A prompt was submitted",
      channel: HOOK,
      at: new Date(Date.parse(first.at) + 400).toISOString(),
    });
    expect(mergeChannels([first, second])).toHaveLength(2);
  });

  it("keeps two calls of the same tool apart", () => {
    // Different ids: the same command run twice is two actions.
    const merged = mergeChannels([
      ...pair("toolu_1", "2026-09-04T10:00:00.000Z"),
      ...pair("toolu_2", "2026-09-04T10:00:04.000Z"),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("keeps a start and its end apart, which are two moments", () => {
    const merged = mergeChannels([
      event({ kind: "tool.start", title: "Bash", channel: SCRIPT, toolUseId: "t1" }),
      event({ kind: "tool.end", title: "Bash", channel: HOOK, toolUseId: "t1" }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("keeps unrelated prompts apart when they are far enough apart in time", () => {
    const first = event({ kind: "prompt.submit", title: "A prompt", channel: SCRIPT });
    const later = event({
      kind: "prompt.submit",
      title: "A prompt",
      channel: HOOK,
      at: new Date(Date.parse(first.at) + 60_000).toISOString(),
    });
    expect(mergeChannels([first, later])).toHaveLength(2);
  });

  it("keeps two sessions' records apart", () => {
    const merged = mergeChannels([
      event({ kind: "tool.start", title: "Bash", channel: SCRIPT, toolUseId: "t1", sessionId: "sess-1" }),
      event({ kind: "tool.start", title: "Bash", channel: HOOK, toolUseId: "t1", sessionId: "sess-2" }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("leaves a session read through one channel exactly as it was", () => {
    const only = [
      event({ kind: "prompt.submit", title: "A prompt", channel: SCRIPT }),
      event({ kind: "tool.start", title: "Bash", channel: SCRIPT, toolUseId: "t1" }),
      event({ kind: "message", title: "Message", channel: SCRIPT, detail: "Done." }),
      event({ kind: "tool.end", title: "Bash", channel: SCRIPT, toolUseId: "t1" }),
    ];
    expect(mergeChannels(only)).toEqual(only);
  });

  it("never merges the agent's own words, which only one channel has", () => {
    const merged = mergeChannels([
      event({ kind: "message", title: "Message", channel: SCRIPT, detail: "Both steps done." }),
      event({ kind: "message", title: "Message", channel: HOOK, detail: "Both steps done." }),
    ]);
    expect(merged).toHaveLength(2);
  });
});
