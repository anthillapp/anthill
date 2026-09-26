/**
 * The canvas tour over stand-ins for the real controls (ANT-141).
 *
 * jsdom lays nothing out, so each anchor is given a rect by hand — which is
 * also exactly how the tests say "this control is there" or "this one is
 * off-screen". The rules checked: a missing or hidden control is skipped in
 * the direction of travel, the last hint follows the toolbar, focus lands on
 * Next, Escape closes, and focus goes back to the control pointed at.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasTour } from "./CanvasTour.js";
import { CANVAS_TOUR, askForTour, markTourSeen, tourDue } from "./tour-steps.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
});

type Anchor = { tour: string; rect?: [number, number, number, number]; kind?: string; label?: string };

/** A screen with these controls, each laid out where the test says. */
function screenWith(anchors: Anchor[]) {
  render(
    <div>
      {anchors.map((anchor) => (
        <button
          key={anchor.tour + (anchor.kind ?? "")}
          data-tour={anchor.tour}
          {...(anchor.kind ? { "data-tour-kind": anchor.kind } : {})}
          ref={(node) => {
            if (!node) return;
            const [x, y, w, h] = anchor.rect ?? [0, 0, 0, 0];
            node.getBoundingClientRect = () =>
              ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;
          }}
        >
          {anchor.label ?? anchor.tour}
        </button>
      ))}
    </div>,
  );
}

const everything: Anchor[] = [
  { tour: "library", rect: [0, 60, 240, 600] },
  { tour: "block", rect: [400, 300, 150, 70] },
  { tour: "inspector", rect: [760, 60, 264, 700] },
  { tour: "lib-agents", rect: [120, 60, 100, 30] },
  { tour: "describe", rect: [420, 700, 160, 34] },
  { tour: "next-step", rect: [900, 10, 90, 30], kind: "prompt", label: "Prompt" },
];

async function start(onClose = vi.fn()) {
  render(<CanvasTour steps={CANVAS_TOUR} onClose={onClose} />);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  return onClose;
}

const title = () => document.querySelector(".tour-card .title")?.textContent;

describe("the six hints", () => {
  it("walks the real controls in order, and ends on Done", async () => {
    screenWith(everything);
    const onClose = await start();
    const seen: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      seen.push(title() ?? "");
      fireEvent.click(screen.getByRole("button", { name: step === 5 ? "Done" : "Next" }));
    }
    expect(seen).toEqual(["Block library", "Block", "Selected block", "Agents", "Describe a change", "Prompt"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ends a handed-over workflow on Save, the step its session is waiting for", async () => {
    screenWith([{ tour: "next-step", rect: [900, 10, 60, 30], kind: "save", label: "Save" }]);
    await start();
    expect(title()).toBe("Save");
    expect(screen.getByText(/tell the coding session that handed it over to go/)).toBeTruthy();
  });

  it("skips a control that is missing or not half on screen, in both directions", async () => {
    screenWith([
      { tour: "library", rect: [0, 60, 240, 600] },
      { tour: "block", rect: [2000, 300, 150, 70] }, // off-screen
      { tour: "describe", rect: [420, 700, 160, 34] },
    ]);
    await start();
    expect(title()).toBe("Block library");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(title()).toBe("Describe a change");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(title()).toBe("Block library");
  });

  it("points at a block its canvas actually shows, not one clipped under a panel", async () => {
    const at = (x: number, y: number, w: number, h: number) =>
      (node: HTMLElement | null) => {
        if (node) node.getBoundingClientRect = () => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;
      };
    render(
      <div ref={at(250, 40, 500, 700)} style={{ overflow: "hidden" }}>
        {/* Inside the window, but left of the canvas: under the rail. */}
        <div data-tour="block" id="hidden-block" ref={at(80, 300, 150, 70)} />
        <div data-tour="block" id="shown-block" ref={at(400, 300, 150, 70)} />
      </div>,
    );
    await start();
    expect(title()).toBe("Block");
    const ring = document.querySelector(".tour-ring") as HTMLElement;
    expect(ring.style.left).toBe("396px");
  });

  it("closes without a word when nothing it could point at is on screen", async () => {
    screenWith([]);
    const onClose = await start();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onClose).toHaveBeenCalled();
    expect(document.querySelector(".tour-card")).toBeNull();
  });
});

describe("keyboard and screen readers", () => {
  it("puts focus on Next, by its marker, at every step", async () => {
    screenWith(everything);
    await start();
    expect(document.activeElement?.textContent).toBe("Next");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(document.activeElement?.hasAttribute("data-tour-next")).toBe(true);
  });

  it("closes on Escape and returns focus to the control it was pointing at", async () => {
    screenWith(everything);
    const onClose = await start();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("data-tour")).toBe("library");
  });

  it("is a non-modal dialog that reads the hint and names its target", async () => {
    screenWith(everything);
    await start();
    const card = screen.getByRole("dialog");
    expect(card.getAttribute("aria-modal")).toBe("false");
    const text = document.getElementById(card.getAttribute("aria-labelledby")!)!;
    expect(text.getAttribute("aria-live")).toBe("polite");
    expect(text.textContent).toContain("Blocks are steps.");
    expect(text.textContent).toContain("Highlighted: Block library");
  });

  it("can be skipped from any step", async () => {
    screenWith(everything);
    const onClose = await start();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("when it is due", () => {
  it("is due only once asked for, and seen once finished or skipped", () => {
    markTourSeen();
    expect(tourDue()).toBe(false);
    askForTour();
    expect(tourDue()).toBe(true);
    markTourSeen();
    expect(tourDue()).toBe(false);
  });
});
