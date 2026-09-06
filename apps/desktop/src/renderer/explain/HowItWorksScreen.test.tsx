/**
 * What the explainer is allowed to claim.
 *
 * Most of these are assertions about honesty rather than layout: the screen
 * exists to say Anthill does not run the session, and every one of the things
 * that could quietly contradict that — a pill parked on the CLI window, a
 * progress bar with a percentage, a missing "you start it" — is checked here
 * rather than trusted to survive the next edit.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HowItWorksScreen } from "./HowItWorksScreen.js";
import { EXPLAIN_STEPS } from "./steps.js";

afterEach(cleanup);

const show = (over: { onBack?: () => void; onCreate?: () => void } = {}) => {
  const onBack = vi.fn();
  const onCreate = vi.fn();
  render(<HowItWorksScreen onBack={over.onBack ?? onBack} onCreate={over.onCreate ?? onCreate} />);
  return { onBack, onCreate };
};

describe("the three steps", () => {
  it("reads its copy from one place, in both panes", () => {
    // Two copies of the same prose means editing the wrong one is a silent
    // no-op, which is what happened while this was being designed.
    show();
    for (const step of EXPLAIN_STEPS) {
      expect(screen.getByText(step.title)).toBeTruthy();
      expect(screen.getByText(step.body)).toBeTruthy();
    }
    const dots = screen.getAllByRole("button", { name: /^Step \d: / });
    expect(dots.map((dot) => dot.getAttribute("aria-label"))).toEqual(
      EXPLAIN_STEPS.map((step, index) => `Step ${index + 1}: ${step.title}`),
    );
  });

  it("starts on the first step, and says which is current in words", () => {
    show();
    const current = document.querySelectorAll('[aria-current="step"]');
    // The row and the dot, both — the colour is the visual half of that fact,
    // never the only half.
    expect(current).toHaveLength(2);
    expect(current[1].textContent).toContain(EXPLAIN_STEPS[0].title);
  });

  it("switches from the row and from the dot alike", () => {
    show();
    // The row, not the dot: both switch, and both are checked below.
    fireEvent.click(screen.getAllByRole("button", { name: /Hand it over/ })[0]);
    expect(
      [...document.querySelectorAll('[aria-current="step"]')].some((node) =>
        (node.textContent ?? "").includes("Hand it over"),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Step 3: Watch it run" }));
    expect(
      [...document.querySelectorAll('[aria-current="step"]')].some((node) =>
        (node.textContent ?? "").includes("Watch it run"),
      ),
    ).toBe(true);
  });

  it("does not advance on its own", async () => {
    vi.useFakeTimers();
    try {
      show();
      vi.advanceTimersByTime(30_000);
      expect(
        [...document.querySelectorAll('[aria-current="step"]')].some((node) =>
          (node.textContent ?? "").includes(EXPLAIN_STEPS[0].title),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what each scene must not stop saying", () => {
  it("ends the handover on the person who starts it", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Step 2: Hand it over" }));
    expect(screen.getByText("you start it")).toBeTruthy();
  });

  it("lets the copied pill leave rather than parking it on the CLI window", () => {
    // A pill that arrives and stays reads as "started", which is the one thing
    // this screen exists to deny. The fade is in the animation, so what is
    // checked here is that the pill is the animated one.
    show();
    fireEvent.click(screen.getByRole("button", { name: "Step 2: Hand it over" }));
    expect(document.querySelector(".ex-copied.ex-fly")).toBeTruthy();
  });

  it("shows a step Anthill could not draw a conclusion about", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Step 3: Watch it run" }));
    expect(screen.getByText("not reached")).toBeTruthy();
    expect(screen.getByText("done · 1m 29s")).toBeTruthy();
    expect(screen.getByText("working · 0:42")).toBeTruthy();
  });

  it("keeps the progress bar indeterminate, with no percentage anywhere", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Step 3: Watch it run" }));
    expect(document.querySelector(".ex-progress .live-bar")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+\s?%/);
  });

  it("fades no card, whatever state it is in", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Step 3: Watch it run" }));
    for (const card of document.querySelectorAll(".ex-card")) {
      expect((card as HTMLElement).style.opacity).toBe("");
    }
  });

  it("shows the other CLI each time the pill has been delivered", () => {
    // Anthill hands over to two tools and the copy beside the picture says
    // both; drawing one of them for ever made the illustration narrower than
    // the sentence next to it. The swap rides the pill's loop, because that
    // is what a reader sitting on this step actually watches happen.
    show();
    const cliName = () => document.querySelector(".ex-cli-head")?.textContent?.trim();
    const delivered = () => fireEvent.animationIteration(document.querySelector(".ex-fly") as Element);

    fireEvent.click(screen.getByRole("button", { name: "Step 2: Hand it over" }));
    expect(cliName()).toBe("Claude Code");

    delivered();
    expect(cliName()).toBe("Codex");

    delivered();
    expect(cliName()).toBe("Claude Code");
  });

  it("swaps between flights, never under one", () => {
    // `animationiteration` fires at the end of a cycle, when the pill has
    // faded and nothing is travelling: the window changes identity between
    // deliveries rather than mid-flight.
    show();
    fireEvent.click(screen.getByRole("button", { name: "Step 2: Hand it over" }));
    const pill = document.querySelector(".ex-fly") as Element;
    expect(pill.textContent?.trim()).toBe("Copied");

    // Starting a flight is not delivering one.
    fireEvent.animationStart(pill);
    expect(document.querySelector(".ex-cli-head")?.textContent?.trim()).toBe("Claude Code");
  });

  it("replays a scene from the start when the step comes back", () => {
    // Each scene mounts fresh, which is what makes the entrance run again
    // without any timers.
    show();
    const first = document.querySelector(".ex-card");
    fireEvent.click(screen.getByRole("button", { name: "Step 2: Hand it over" }));
    fireEvent.click(screen.getByRole("button", { name: "Step 1: Design the workflow" }));
    expect(document.querySelector(".ex-card")).not.toBe(first);
  });
});

describe("the boundary", () => {
  it("says both halves of what Anthill does not do", () => {
    show();
    expect(screen.getByText(/never starts, stops, answers or steers an agent/)).toBeTruthy();
    // The sentence most likely to be cut as redundant, and the one that stops
    // a reader believing Anthill enforces the diagram they drew.
    expect(screen.getByText(/not things it can enforce/)).toBeTruthy();
  });

  it("offers no control that could reach a session", () => {
    // The step rows quote the words themselves — "which step is working",
    // "Watch it run" — so what is checked is the set of things a button
    // actually is, not whether those words appear anywhere on screen.
    show();
    const actions = [...document.querySelectorAll("button")]
      .map((button) => (button.textContent ?? "").trim())
      // The step rows carry their whole paragraph; the dots carry nothing.
      .filter((label) => label.length > 0 && label.length < 24);
    expect(actions).toEqual(["←", "Create a workflow", "Back"]);
  });
});

describe("leaving", () => {
  it("goes back, and goes on to a workflow", () => {
    const { onBack, onCreate } = show();
    fireEvent.click(screen.getAllByRole("button", { name: "Back" })[0]);
    expect(onBack).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create a workflow" }));
    expect(onCreate).toHaveBeenCalled();
  });
});
