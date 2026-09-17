import { describe, expect, it } from "vitest";

import {
  MARKER_VERSION,
  CLI_NAME,
  cliInstruction,
  newNonce,
  newRunId,
  parseMarker,
  parseStepMarkers,
  renderMarker,
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
    expect(textCarriesMarker("… ANT-1A2B3C4D … 9f8e7d …", marker)).toBe(true);
    // The run id on its own is not enough: an old copied prompt in someone's
    // scrollback would otherwise match a run created today.
    expect(textCarriesMarker("… ANT-1A2B3C4D …", marker)).toBe(false);
    expect(textCarriesMarker("… 9f8e7d …", marker)).toBe(false);
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
    const ids = text.indexOf("`read` — Read the note");
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
