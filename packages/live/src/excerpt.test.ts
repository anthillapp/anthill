/**
 * How much of a message Anthill is willing to keep.
 *
 * The rule is subtractive on purpose: everything that looks like the model's
 * working, somebody's file, or Anthill's own plumbing comes out, and whatever
 * is left is cut to a length that cannot become a transcript.
 */

import { describe, expect, it } from "vitest";

import { MESSAGE_EXCERPT_LIMIT, messageExcerpt } from "./excerpt.js";

const marker = { runId: "ANT-1A2B3C4D", nonce: "9f8e7d" };

describe("what the agent said, cut down", () => {
  it("keeps the sentence", () => {
    expect(messageExcerpt("Reading the note now.", marker)).toBe("Reading the note now.");
  });

  it("keeps the shape of a paragraph break", () => {
    // Which lines survive is the privacy decision; how they are joined is not.
    // Keeping the break is what lets the page show a report as a report.
    const said = messageExcerpt("First I will read it.\n\nThen I will say what it says.", marker);
    expect(said).toBe("First I will read it.\n\nThen I will say what it says.");
  });

  it("keeps a list as separate lines", () => {
    const said = messageExcerpt("Done:\n- read the note\n- checked it", marker);
    expect(said).toBe("Done:\n- read the note\n- checked it");
  });

  it("collapses a run of blank lines to one break", () => {
    const said = messageExcerpt("First.\n\n\n\nSecond.", marker);
    expect(said).toBe("First.\n\nSecond.");
  });

  it("drops fenced code, whichever fence it is", () => {
    for (const fence of ["```", "~~~"]) {
      const said = messageExcerpt(
        `Here is the command:\n${fence}bash\nexport TOKEN=hunter2\n${fence}\nThat is all.`,
        marker,
      );
      expect(said).toBe("Here is the command:\nThat is all.");
    }
  });

  it("drops the run's own markers rather than reading them back", () => {
    const said = messageExcerpt(
      `ANTHILL-STEP ${marker.runId} ${marker.nonce} implement\nOn to the tests.`,
      marker,
    );
    expect(said).toBe("On to the tests.");
  });

  it("drops the marker block Anthill put at the top of the prompt", () => {
    const said = messageExcerpt(
      `<!--\nanthill-run-id: ${marker.runId}\nanthill-nonce: ${marker.nonce}\n-->\nStarting.`,
      marker,
    );
    expect(said).toBe("Starting.");
  });

  it("says nothing when there was nothing but plumbing", () => {
    expect(messageExcerpt(`ANTHILL-STEP ${marker.runId} ${marker.nonce} implement`, marker))
      .toBeUndefined();
    expect(messageExcerpt("   \n\n  ", marker)).toBeUndefined();
    expect(messageExcerpt("```\nonly code\n```", marker)).toBeUndefined();
  });

  it("cuts a long message down, and says it cut it", () => {
    const said = messageExcerpt("word ".repeat(400), marker) as string;
    expect(said.length).toBeLessThanOrEqual(MESSAGE_EXCERPT_LIMIT + 1);
    expect(said.endsWith("…")).toBe(true);
  });

  it("never lets an unterminated fence leak the rest of a message", () => {
    // A fence the agent opened and never closed swallows everything after it,
    // which is the safe direction to fail in.
    expect(messageExcerpt("Look:\n```\nsecret\nmore secret", marker)).toBe("Look:");
  });
});

/**
 * The adversarial half: messages written to smuggle something out.
 *
 * From the In Review audit — the first cut kept up to 600 characters of
 * arbitrary prose while the page said "no transcript", which was two claims in
 * conflict. The rule now is shape-based removal: a token itself never
 * survives, however the sentence around it reads, and pasted file content
 * that never earned a fence is treated as the code it is.
 */
describe("what a message cannot carry out", () => {
  it("cuts known token shapes out of ordinary prose", () => {
    for (const [text, gone] of [
      ["Use the key sk-ant-api03-abcdefghijklmnop for auth.", "sk-ant-api03"],
      ["Push with ghp_AbCdEfGhIjKlMnOpQrStUvWx as the PAT.", "ghp_"],
      ["The bot token is xoxb-1234567890-abcdefghij.", "xoxb-"],
      ["Configured AKIAIOSFODNN7EXAMPLE as the access key id.", "AKIA"],
    ] as const) {
      const said = messageExcerpt(text, marker) as string;
      expect(said).not.toContain(gone);
      expect(said).toContain("[redacted]");
    }
  });

  it("cuts the value of an assignment that admits what it is, keeping the key", () => {
    const said = messageExcerpt("Set password=hunter2 and api_key: abc123 in the env.", marker) as string;
    expect(said).not.toContain("hunter2");
    expect(said).not.toContain("abc123");
    expect(said).toContain("password=[redacted]");
  });

  it("cuts a JWT and long key material", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    const hex = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const said = messageExcerpt(`Decoded ${jwt} and found ${hex} inside.`, marker) as string;
    expect(said).not.toContain("eyJ");
    expect(said).not.toContain("deadbeef");
  });

  it("treats indented lines as the file content they usually are", () => {
    const said = messageExcerpt(
      "Here is the config I read:\n    DB_PASSWORD=swordfish\n    host: internal.corp\nThat explains the failure.",
      marker,
    );
    expect(said).toBe("Here is the config I read:\nThat explains the failure.");
  });

  it("folds the home directory so a path stops naming the account", () => {
    const said = messageExcerpt("I wrote the report to /Users/alex/dev/apps/report.md just now.", marker);
    expect(said).toBe("I wrote the report to ~/dev/apps/report.md just now.");
  });

  it("keeps the sentence about a secret while losing the secret", () => {
    const said = messageExcerpt(
      "I found a hardcoded token=sk-live-abcdefghijklmnop in config.ts and will flag it.",
      marker,
    ) as string;
    expect(said).toContain("hardcoded");
    expect(said).toContain("config.ts");
    expect(said).not.toContain("sk-live");
  });

  it("still strips markers from a message that mixes them into prose", () => {
    const said = messageExcerpt(
      `Starting now. ANTHILL-STEP ${marker.runId} ${marker.nonce} implement is printed above.`,
      marker,
    );
    // The line carries the nonce, so the whole line goes — plumbing outranks prose.
    expect(said).toBeUndefined();
  });
});

describe("the step tag a message opens with (ANT-163)", () => {
  it("never reaches the card", () => {
    expect(messageExcerpt("[ANTHILL implement] Added negate to calc.py.", { runId: "ANT-1A2B3C4D", nonce: "9f8e7d" })).toBe(
      "Added negate to calc.py.",
    );
  });
});

describe("the invisible step tag (ANT-167, ANT-168)", () => {
  const marker = { runId: "ANT-1A2B3C4D", nonce: "9f8e7d" };

  it("never reaches the card, and leaves the Markdown whole", () => {
    expect(messageExcerpt("[//]: # (anthill:test)\n\nAdded `negate` to calc_py.", marker)).toBe("Added `negate` to calc_py.");
    expect(messageExcerpt("`[ANTHILL test]` I've added `shout` to svc_a.", marker)).toBe("I've added `shout` to svc_a.");
  });
});
