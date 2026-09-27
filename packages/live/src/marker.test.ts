import { describe, expect, it } from "vitest";

import {
  MARKER_VERSION,
  CLI_NAME,
  cliInstruction,
  newNonce,
  newRunId,
  parseMarker,
  parseDoneMarker,
  parseStepMarkers,
  renderMarker,
  DONE_TOKEN,
  STEP_TOKEN,
  echoInstruction,
  stepOpening,
  textCarriesMarker,
  type RunMarker,
} from "./marker.js";

const marker: RunMarker = {
  runId: "ANT-1A2B3C4D",
  nonce: "9f8e7d",
  workflowId: "workflow-1",
  cli: "claude-code",
  promptVersion: MARKER_VERSION,
  issuedAt: "2026-08-29T10:00:00.000Z",
};

describe("the correlation marker", () => {
  it("round-trips through the text it is rendered into", () => {
    expect(parseMarker(renderMarker(marker))).toEqual(marker);
  });

  it("survives being embedded in a much longer prompt", () => {
    const prompt = `# A workflow\n\n${renderMarker(marker)}\n\nDo the work.`;
    expect(parseMarker(prompt)).toEqual(marker);
  });

  it("carries no secrets and no local paths", () => {
    const text = renderMarker(marker);
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/);

    // Only the data lines are checked: the block's own first two lines explain
    // to the reader that it holds no secrets, which would trip a naive scan.
    const fields = text
      .split("\n")
      .filter((line) => line.startsWith("anthill-"))
      .join("\n")
      .toLowerCase();
    expect(fields).not.toMatch(/api[_-]?key|token|secret|password|bearer/);
    expect(fields.split("\n")).toHaveLength(6);
  });

  it("needs both halves before it will claim a match", () => {
    expect(textCarriesMarker(renderMarker(marker), marker)).toBe(true);
    // The run id on its own is not enough: an old copied prompt in someone's
    // scrollback would otherwise match a run created today.
    expect(textCarriesMarker("anthill-run-id: ANT-1A2B3C4D", marker)).toBe(false);
    expect(textCarriesMarker("anthill-nonce: 9f8e7d", marker)).toBe(false);
  });

  /*
    ANT-79. Two substrings anywhere was the whole test, so a session that
    merely mentioned a run — a driver printing the id and nonce in a table, a
    Live Session rail pasted into another chat — became a candidate for it.
    Only the marker block as Anthill writes it counts now.
  */
  describe("recognising the marker as written, not as mentioned", () => {
    it("matches the block inside a pasted prompt, whatever surrounds it", () => {
      expect(textCarriesMarker(`Please do this.\n\n${renderMarker(marker)}\n\n# The work`, marker)).toBe(true);
    });

    it("tolerates the indentation a paste may add", () => {
      const indented = renderMarker(marker).split("\n").map((line) => `  ${line}`).join("\n");
      expect(textCarriesMarker(indented, marker)).toBe(true);
    });

    it("does not match the two values merely mentioned in prose", () => {
      expect(textCarriesMarker("… ANT-1A2B3C4D … 9f8e7d …", marker)).toBe(false);
      expect(textCarriesMarker("Run ANT-1A2B3C4D, nonce 9f8e7d, is the one to watch.", marker)).toBe(false);
    });

    it("does not match a table of the values, the shape a driver session printed", () => {
      const table = "| Run | Nonce |\n| --- | --- |\n| ANT-1A2B3C4D | 9f8e7d |";
      expect(textCarriesMarker(table, marker)).toBe(false);
    });

    it("does not match the progress commands, which carry both values on one line", () => {
      expect(textCarriesMarker("anthill step ANT-1A2B3C4D 9f8e7d implement", marker)).toBe(false);
      expect(textCarriesMarker("ANTHILL-STEP ANT-1A2B3C4D 9f8e7d implement", marker)).toBe(false);
    });

    it("does not match a block for another run or another copy", () => {
      expect(textCarriesMarker(renderMarker({ ...marker, nonce: "000000" }), marker)).toBe(false);
      expect(textCarriesMarker(renderMarker({ ...marker, runId: "ANT-99999999" }), marker)).toBe(false);
    });

    it("does not take a longer value for this one", () => {
      const longer = renderMarker(marker).replace("9f8e7d", "9f8e7d00");
      expect(textCarriesMarker(longer, marker)).toBe(false);
    });
  });

  it("mints ids that are recognisable and distinct", () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).toMatch(/^ANT-[A-Z0-9]{8}$/);
    expect(a).not.toEqual(b);
    expect(newNonce()).toMatch(/^[a-z0-9]{6}$/);
  });

  it("refuses a marker naming a CLI it does not know", () => {
    const text = renderMarker(marker).replace("anthill-cli: claude-code", "anthill-cli: nano");
    expect(parseMarker(text)).toBeUndefined();
  });
});

describe("step markers", () => {
  it("reads back every step the agent announced, in order", () => {
    const text = [
      "ANTHILL-STEP ANT-1A2B3C4D 9f8e7d implement",
      "…work…",
      "ANTHILL-STEP ANT-1A2B3C4D 9f8e7d review",
      "ANTHILL-STEP ANT-1A2B3C4D 9f8e7d implement",
    ].join("\n");
    expect(parseStepMarkers(text, marker)).toEqual(["implement", "review", "implement"]);
  });

  it("ignores a step line from a different run or a different copy", () => {
    expect(parseStepMarkers("ANTHILL-STEP ANT-OTHER 9f8e7d implement", marker)).toEqual([]);
    expect(parseStepMarkers("ANTHILL-STEP ANT-1A2B3C4D 000000 implement", marker)).toEqual([]);
  });

  it("finds the marker inside surrounding prose", () => {
    const text = "I'll start now.\n\n    ANTHILL-STEP ANT-1A2B3C4D 9f8e7d review\n\nReading the diff.";
    expect(parseStepMarkers(text, marker)).toEqual(["review"]);
  });
});

/**
 * The marker-line form of `anthill done`.
 *
 * ANT-119. A prompt reporting by printed lines could say which step it was on
 * and never that it had stopped, so the only ending Anthill could reach was
 * the one it infers from five minutes of silence — and one stale claim of
 * work from any other channel held that off for half an hour.
 */
describe("the done marker", () => {
  it("reads the agent's own word that it finished", () => {
    expect(parseDoneMarker("All steps complete.\n\n    ANTHILL-DONE ANT-1A2B3C4D 9f8e7d\n", marker)).toBe(true);
  });

  it("needs both halves, like every other marker", () => {
    expect(parseDoneMarker("ANTHILL-DONE ANT-OTHER 9f8e7d", marker)).toBe(false);
    expect(parseDoneMarker("ANTHILL-DONE ANT-1A2B3C4D 000000", marker)).toBe(false);
    expect(parseDoneMarker("ANTHILL-DONE ANT-1A2B3C4D", marker)).toBe(false);
  });

  it("is not confused by a step line, which shares the prefix", () => {
    expect(parseDoneMarker("ANTHILL-STEP ANT-1A2B3C4D 9f8e7d review", marker)).toBe(false);
  });

  it("is asked for by the printed-line instruction, with both halves", () => {
    const text = echoInstruction(marker, [{ id: "review", name: "Review" }]);
    expect(text).toContain(`${DONE_TOKEN} ${marker.runId} ${marker.nonce}`);
    // After the step ids: an ending is the last thing asked for.
    expect(text.indexOf(DONE_TOKEN)).toBeGreaterThan(text.indexOf("`review`"));
  });

  it("offers no way out, only a second way in (ANT-162)", () => {
    const text = echoInstruction(marker, [{ id: "review", name: "Review" }]);
    expect(text).not.toMatch(/ignore this section/i);
    expect(text).toMatch(/from a command's output as well as from your reply/);
    expect(text).toMatch(/never leave one to a subagent/);
  });
});

describe("the CLI instruction", () => {
  it("names the command, the run, and the nonce", () => {
    const text = cliInstruction(marker);
    expect(text).toContain(`${CLI_NAME} run ${marker.runId} ${marker.nonce}`);
    expect(text).toContain(`${CLI_NAME} step ${marker.runId} ${marker.nonce} <step-id>`);
  });

  it("names the done command, so a CLI-reported run can finish", () => {
    const text = cliInstruction(marker);
    expect(text).toContain(`${CLI_NAME} done ${marker.runId} ${marker.nonce}`);
  });

  it("lists the step ids next to the instruction, for the same reason as the marker section", () => {
    const text = cliInstruction(marker, [
      { id: "read", name: "Read the note" },
      { id: "review", name: "Review it" },
    ]);
    const instruction = text.indexOf("Use exactly these step ids");
    const ids = text.indexOf("`read` – Read the note");
    expect(instruction).toBeGreaterThan(0);
    expect(ids).toBeGreaterThan(instruction);
  });

  it("carries no secrets, no ports, and no local paths", () => {
    const text = cliInstruction(marker, [{ id: "read", name: "Read" }]);
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/);
    expect(text).not.toMatch(/api[_-]?key|token|secret|password|bearer|\b\d{4,5}\b/i);
  });

  it("says a command that cannot be run is skipped, not fatal", () => {
    expect(cliInstruction(marker)).toContain("if a command cannot\nbe run, continue without it");
  });
});

describe("a step's opening line", () => {
  it("is the step's own marker, with no word about subagents when nothing is delegated", () => {
    const lines = stepOpening(marker, { id: "review", delegated: false }).join("\n");
    expect(parseStepMarkers(lines, marker)).toEqual(["review"]);
    expect(lines).not.toMatch(/subagent/);
  });

  it("says who prints it when the step is delegated", () => {
    const lines = stepOpening(marker, { id: "review", delegated: true }).join("\n");
    expect(lines).toMatch(/Run it yourself before you hand the step to the subagent/);
  });

  it("is a command, which a harness that writes no text between tools still runs", () => {
    const lines = stepOpening(marker, { id: "review", delegated: false }).join("\n");
    expect(lines).toContain(`printf '${STEP_TOKEN} ${marker.runId} ${marker.nonce} review\\n'`);
    expect(lines).toMatch(/Your first action in this step/);
  });
});
