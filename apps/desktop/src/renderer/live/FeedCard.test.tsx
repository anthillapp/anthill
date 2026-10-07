/**
 * How much of a message a card shows before it asks.
 *
 * ANT-30. The clamp exists to save a scroll; at 168 characters it cut a final
 * report a sentence or two in, so the common case was expanding every card and
 * the clamp cost a click instead. The number is a judgement about reading and
 * may change again — what has to hold at any number is that the cut lands
 * where every opened Markdown marker is closed, so raising the limit can never
 * put raw `**` back on screen.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FeedCardView } from "./FeedCard.js";
import { MESSAGE_CLAMP, isLongToolInput, type FeedCard } from "./feed.js";

afterEach(cleanup);

function message(detail: string): FeedCard {
  return {
    id: 1,
    kind: "message",
    state: "done",
    title: "Main agent",
    at: "2026-09-01T22:30:14.000Z",
    confidence: "unmapped",
    how: "not tied to a step",
    channels: ["claude-code:transcript"],
    events: ["message"],
    detail,
  };
}

/**
 * Prose of a given length, so a case is about the limit and not about wording.
 * It ends in a distinctive word, so "was the end shown" is answerable — filler
 * that repeats cannot tell a tail from a head.
 */
const TAIL = "PARTHIAN";
const words = (length: number) =>
  `${"word ".repeat(Math.ceil(length / 5)).slice(0, Math.max(0, length - TAIL.length))}${TAIL}`;

const cli = { label: "Claude Code", logo: "none" };

/** The bubble keeps its own expanded state, the way the panel does for it. */
function Expandable({ card }: { card: FeedCard }) {
  const [expanded, setExpanded] = useState(false);
  return <FeedCardView card={card} cli={cli} expanded={expanded} onExpand={() => setExpanded((on) => !on)} />;
}

const show = (detail: string) => render(<Expandable card={message(detail)} />);

describe("clamping a message card", () => {
  it("shows a short message whole, with nothing to press", () => {
    show("Both steps completed successfully.");
    expect(screen.getByText(/Both steps completed successfully/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("shows a message the old limit would have cut", () => {
    // The case this issue is about: between 168 and 336, so it used to be
    // clamped and now is not.
    show(words(300));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(document.querySelector(".msg-markup")?.textContent).toContain(TAIL);
  });

  it("still clamps a message past the new limit", () => {
    show(words(600));
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
  });

  it("opens and closes on the same control", () => {
    show(words(600));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(document.querySelector(".msg-markup")?.textContent).toContain(TAIL);

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(document.querySelector(".msg-markup")?.textContent).not.toContain(TAIL);
  });

  it("cuts where the markup closes, whatever the limit is", () => {
    // The property the number cannot break: a cut inside `**bold**` renders
    // the markers literally, putting back on screen what the renderer exists
    // to take off it.
    const detail = `${words(MESSAGE_CLAMP - 4)} **emphasised at the boundary** and then a great deal more text.`;
    show(detail);
    const shown = document.querySelector(".msg-markup")?.textContent ?? "";
    expect(shown).not.toContain("**");
  });
});

/**
 * That the one motion in the feed is pointed at something that exists.
 *
 * The arrival animation spent a redesign attached to `.live-feed-row`, a class
 * from the log-line design the cards replaced. Nothing rendered it, so nothing
 * animated, and nothing failed — the feature was gone and every test still
 * passed. A stylesheet cannot be type-checked, so the pairing is asserted
 * here: whatever class the card puts on a new arrival must be the class the
 * keyframes are hung on.
 */
describe("the arrival animation's selector", () => {
  // Vitest runs from the desktop package, so the sheet is found from there.
  const css = readFileSync(resolve("src/renderer/styles.css"), "utf8");

  it("names the class the card actually renders", () => {
    render(<FeedCardView card={{ ...message("Landed."), kind: "tool" }} cli={cli} isNew />);
    const card = document.querySelector(".feed-card") as HTMLElement;
    const marker = [...card.classList].find((name) => name !== "feed-card" && name.includes("new"));
    expect(marker).toBeTruthy();
    expect(css).toContain(`.feed-card.${marker} {`);
  });

  it("turns off under reduced motion, along with the working glyph", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".feed-card.event-new");
    expect(reduced).toContain(".feed-glyph.state-working");
  });
});

describe("a divider for steps announced together (ANT-296)", () => {
  const divider = (steps: string[], repeated?: boolean): FeedCard => ({
    id: 7,
    kind: "session",
    state: "done",
    title: steps.length > 1 ? "Steps announced together" : "Step announced",
    at: "2026-10-07T04:27:17.118Z",
    detail: steps[0],
    blockId: steps[0],
    confidence: "exact",
    how: "the agent announced this step",
    channels: ["anthill:report"],
    events: steps.map(() => "step.marker"),
    steps,
    ...(repeated ? { repeated } : {}),
  });

  it("names every step by its block name, and says it came again", () => {
    render(
      <FeedCardView
        cli={cli}
        card={divider(["fix", "test", "review"], true)}
        stepNames={["Fix count_words", "Run the tests", "Review the change"]}
      />,
    );
    expect(screen.getByText("Steps announced together")).toBeTruthy();
    expect(document.querySelector(".feed-divider span")?.textContent).toMatch(
      /^Fix count_words, Run the tests, Review the change · reported again · /,
    );
  });

  it("keeps a lone step's divider as it was", () => {
    render(
      <FeedCardView
        cli={cli}
        card={divider(["fix"])}
        block={{ name: "Fix count_words", color: "#000" }}
        stepNames={["Fix count_words"]}
      />,
    );
    expect(screen.getByText("Step announced")).toBeTruthy();
    expect(document.querySelector(".feed-divider span")?.textContent).toMatch(/^Fix count_words · /);
    expect(document.querySelector(".feed-divider span")?.textContent).not.toContain("reported again");
  });
});

/** A tool call as the panel holds it, with its own expanded state. */
function ToolCard({ title = "Bash", detail }: { title?: string; detail?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { detail: _none, ...bare } = message("");
  const card: FeedCard = { ...bare, kind: "tool", title, ...(detail === undefined ? {} : { detail }) };
  return <FeedCardView card={card} cli={cli} expanded={expanded} onExpand={() => setExpanded((on) => !on)} />;
}

const input = () => document.querySelector(".feed-tool-task");

describe("a tool call's input", () => {
  it("is a line of its own, never beside the tool name", () => {
    render(<ToolCard title="mcp__plugin_anthill_exchange__run_workflow" detail="ANT-1" />);
    expect(input()?.parentElement?.classList.contains("feed-tool")).toBe(true);
    expect(document.querySelector(".feed-tool-row .feed-tool-task")).toBeNull();
    // The name may be cut on screen; the tooltip still has all of it.
    expect(document.querySelector(".feed-tool-chip")?.getAttribute("title")).toBe(
      "mcp__plugin_anthill_exchange__run_workflow",
    );
  });

  it("shows a short one-liner with nothing to press", () => {
    render(<ToolCard detail="npm test" />);
    expect(input()?.textContent).toBe("npm test");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("has no input row when the call had no input", () => {
    render(<ToolCard title="SubagentHandback" />);
    expect(input()).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("offers Show more past 180 characters on one line", () => {
    render(<ToolCard detail={`cat ${"/very/long/absolute/path".repeat(8)}`} />);
    expect(input()?.classList.contains("is-clamped")).toBe(true);
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
  });

  it("collapses a script into one paragraph and opens it with its lines", () => {
    const script = "python3 - <<'EOF'\nimport os\nprint(os.getcwd())\nEOF";
    render(<ToolCard detail={script} />);
    expect(input()?.textContent).toBe("python3 - <<'EOF' import os print(os.getcwd()) EOF");

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(input()?.textContent).toBe(script);
    expect(input()?.classList.contains("is-full")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(input()?.classList.contains("is-clamped")).toBe(true);
  });
});

describe("telling a long tool input", () => {
  it("counts the flattened length and the raw lines", () => {
    expect(isLongToolInput("a".repeat(180))).toBe(false);
    expect(isLongToolInput("a".repeat(181))).toBe(true);
    expect(isLongToolInput("a\nb\nc")).toBe(false);
    expect(isLongToolInput("a\nb\nc\nd")).toBe(true);
    // Indentation is not length: it goes when the input is flattened.
    expect(isLongToolInput(`x${" ".repeat(400)}y`)).toBe(false);
  });
});
