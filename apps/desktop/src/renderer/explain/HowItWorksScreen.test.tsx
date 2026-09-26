/**
 * What the explainer is allowed to claim.
 *
 * Two ways in, side by side, and a picture of whichever is chosen. Most of
 * these are assertions about honesty rather than layout: the screen says the
 * agent runs the work and Anthill shows it, and a progress bar with a
 * percentage or a control that reached a session would quietly contradict
 * that — so they are checked here rather than trusted to survive an edit.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HowItWorksScreen } from "./HowItWorksScreen.js";

afterEach(cleanup);

const show = () => {
  const props = { onBack: vi.fn(), onCreate: vi.fn(), onFromSession: vi.fn() };
  render(<HowItWorksScreen {...props} />);
  return props;
};

const card = (name: string) => screen.getByRole("group", { name });

describe("the two paths", () => {
  it("offers the coding session first, recommended, and designing here second", () => {
    show();
    const cards = screen.getAllByRole("group").filter((node) => node.classList.contains("how-path"));
    expect(cards.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Start in your coding session",
      "Design in Anthill",
    ]);
    expect(within(cards[0]).getByText("Recommended")).toBeTruthy();
    expect(within(cards[1]).getByText("Copy Prompt")).toBeTruthy();
  });

  it("starts on the session path, drawn live under the session's prompt", () => {
    show();
    expect(card("Start in your coding session").getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Anthill follows the work")).toBeTruthy();
    expect(screen.getByText("/anthill:workflow")).toBeTruthy();
    expect(screen.getByText("working · 0:42")).toBeTruthy();
  });

  it("switches the picture when the other card is chosen, and says which in words", () => {
    show();
    fireEvent.click(card("Design in Anthill"));
    expect(card("Design in Anthill").getAttribute("aria-current")).toBe("true");
    expect(card("Start in your coding session").getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("Design on the canvas")).toBeTruthy();
    expect(screen.getByText("Copy prompt")).toBeTruthy();
    expect(screen.queryByText("working · 0:42")).toBeNull();
  });

  it("chooses a card from the keyboard too", () => {
    show();
    fireEvent.focus(screen.getByRole("button", { name: "Create a workflow" }));
    expect(card("Design in Anthill").getAttribute("aria-current")).toBe("true");
  });

  it("never draws a working step as a measured percentage", () => {
    show();
    // Indeterminate: Anthill reads records and cannot know how far along a step is.
    expect(document.querySelector(".ex-progress .live-bar")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+%/);
  });
});

describe("where each path goes", () => {
  it("sets up the plugin, creates a workflow, or goes back", () => {
    const { onBack, onCreate, onFromSession } = show();
    fireEvent.click(screen.getByRole("button", { name: "Set up the plugin" }));
    expect(onFromSession).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create a workflow" }));
    expect(onCreate).toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Back" })[0]);
    expect(onBack).toHaveBeenCalled();
  });

  it("offers no control that could reach a session", () => {
    show();
    const actions = [...document.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim());
    expect(actions).toEqual(["←", "Set up the plugin", "Create a workflow", "Back"]);
  });

  it("says who runs the work", () => {
    show();
    expect(screen.getByText(/Your coding agent runs the work\./)).toBeTruthy();
  });
});
