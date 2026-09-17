/**
 * The drafting panel, where the geometry meets the stylesheet.
 *
 * `draft-preview.test.ts` holds the arithmetic: an edge lands on a port, the
 * blocks do not overlap, the order is right. None of that survives contact with
 * a stylesheet that disagrees, and a stylesheet cannot be type-checked — so the
 * three couplings that a rename or a tidy-up would quietly break are asserted
 * here against the real file:
 *
 * - blocks are placed from the same table the edges are drawn from, so the two
 *   cannot drift the way they did when one was CSS pixels and the other was
 *   path data typed by hand;
 * - the keyframe offsets the ordering rule is stated in terms of are the ones
 *   the keyframes actually use;
 * - motion off leaves the panel complete and still, shimmer included.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  EDGE_DRAWN_AT,
  EDGE_FADED_AT,
  LOOP_SECONDS,
  NODE_VISIBLE_AT,
  PREVIEW_EDGES,
  PREVIEW_NODES,
  PREVIEW_SIZE,
} from "./draft-preview.js";
import { DraftingPanel } from "./PromptToWorkflowSheet.js";

// Vitest runs from the desktop package, so the sheet is found from there.
const css = readFileSync(resolve("src/renderer/styles.css"), "utf8");

/** The stop at which a keyframe block first reaches a value, as a fraction. */
function holdsUntil(name: string, property: string): number {
  const block = css.slice(css.indexOf(`@keyframes ${name} {`));
  // The block ends at the first closing brace in column one; the braces before
  // it belong to its own stops.
  const body = block.slice(0, block.indexOf("\n}"));
  const stops = [...body.matchAll(/([\d.]+)%(?:,\s*([\d.]+)%)?\s*\{([^}]*)\}/g)];
  const match = stops.find((stop) => stop[3].includes(property));
  if (!match) throw new Error(`no ${property} in @keyframes ${name}`);
  // `14%, 92% { opacity: 1 }` arrives at 14 and holds to 92, and it is the
  // arrival that the ordering rule is stated in terms of.
  return Number(match[1]) / 100;
}

describe("the drafting panel", () => {
  it("places every block where the geometry says, in the panel's own space", () => {
    render(<DraftingPanel />);
    const panel = document.querySelector(".drafting-graph") as HTMLElement;

    const drawn = [...panel.querySelectorAll<HTMLElement>(".anim-node")];
    expect(drawn).toHaveLength(PREVIEW_NODES.length);

    drawn.forEach((element, at) => {
      const node = PREVIEW_NODES[at];
      expect(element.style.left).toBe(`${node.x}px`);
      expect(element.style.top).toBe(`${node.y}px`);
      expect(element.style.width).toBe(`${node.w}px`);
      expect(element.style.height).toBe(`${node.h}px`);
      expect(element.style.animationDelay).toBe(`${node.delay}s`);
    });

    // The SVG shares that space as its viewBox, which is what makes one set of
    // coordinates enough for both.
    const svg = panel.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${PREVIEW_SIZE.width} ${PREVIEW_SIZE.height}`);
  });

  it("names the blocks it is not guessing, and only those", () => {
    render(<DraftingPanel />);
    const panel = document.querySelector(".drafting-graph") as HTMLElement;
    expect(panel.textContent).toBe("StartDone");
  });

  it("gives every connection an arrowhead, and a pattern only where it fades", () => {
    render(<DraftingPanel />);
    const paths = [...document.querySelectorAll<SVGPathElement>(".anim-edge")];
    expect(paths).toHaveLength(PREVIEW_EDGES.length);

    paths.forEach((path, at) => {
      const edge = PREVIEW_EDGES[at];
      expect(path.getAttribute("marker-end")).toBe(`url(#draft-arrow-${edge.tone})`);
      expect(path.classList).toContain(`is-${edge.stroke}`);
      // A dash measured against a path declared one unit long is a solid line,
      // so only a drawn connection is normalised.
      expect(path.getAttribute("pathLength")).toBe(edge.stroke === "solid" ? "1" : null);
      expect(document.querySelector(`#draft-arrow-${edge.tone}`)).toBeTruthy();
    });
  });

  it("is decoration, and says so", () => {
    render(<DraftingPanel />);
    const panel = document.querySelector(".drafting-graph") as HTMLElement;
    expect(panel.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the ordering rule's keyframe offsets true to the stylesheet", () => {
    // These four numbers are why a delay is not the moment a thing is seen. If
    // the keyframes move and the constants do not, the ordering test in
    // draft-preview.test.ts is checking a fiction.
    expect(holdsUntil("node-in", "opacity: 1")).toBeCloseTo(NODE_VISIBLE_AT, 5);
    expect(holdsUntil("edge-in", "stroke-dashoffset: 0")).toBeCloseTo(EDGE_DRAWN_AT, 5);
    expect(holdsUntil("edge-fade", "opacity: 1")).toBeCloseTo(EDGE_FADED_AT, 5);
    // And they are all one loop, which is the other half of the arithmetic.
    expect(css).toContain(`animation: node-in ${LOOP_SECONDS}s`);
    expect(css).toContain(`animation: edge-in ${LOOP_SECONDS}s`);
  });

  it("stands still and complete when motion is unwelcome", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const selector of [".anim-node", ".anim-edge", ".anim-sweep", ".sk"]) {
      expect(reduced).toContain(`.drafting-graph ${selector}`);
    }
  });
});
