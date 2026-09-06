/**
 * The default palette must stay compact as the catalog grows: only the
 * MVP-palette actions show per category out of the box, the rest sit behind
 * either "Show N more" or a search — never both hidden and unsearchable.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BlockLibrary, totalBlockCount } from "./BlockLibrary.js";

function renderLibrary() {
  const onAdd = vi.fn();
  render(<BlockLibrary custom={[]} onAddCustom={() => undefined} onAdd={onAdd} />);
  return { onAdd };
}

describe("the block library's default palette", () => {
  it("shows the four MVP controls, including Condition, on load", () => {
    renderLibrary();
    expect(screen.getByText("Start")).toBeDefined();
    expect(screen.getByText("Approval Gate")).toBeDefined();
    expect(screen.getByText("Condition")).toBeDefined();
    expect(screen.getByText("End")).toBeDefined();
  });

  it("shows only palette-tier actions in a category by default", () => {
    renderLibrary();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "verify" } });

    // Palette-tier Verify actions.
    expect(screen.getByText("Check")).toBeDefined();
    expect(screen.getByText("LLM Review")).toBeDefined();
    expect(screen.getByText("Adversarial Review")).toBeDefined();
    expect(screen.getByText("Run Tests")).toBeDefined();
    expect(screen.getByText("Browser Check")).toBeDefined();

    // Library-tier Verify actions must not be in the default list.
    expect(screen.queryByText("Fact Check")).toBeNull();
    expect(screen.queryByText("Code Review")).toBeNull();
    expect(screen.queryByText("Criteria Review")).toBeNull();
    expect(screen.queryByText("Security / Privacy Review")).toBeNull();
    expect(screen.queryByText("Accessibility Review")).toBeNull();
  });

  it("reveals the rest of the category through \"Show N more\"", () => {
    renderLibrary();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "verify" } });

    expect(screen.queryByText("Fact Check")).toBeNull();
    fireEvent.click(screen.getByText(/Show \d+ less common actions?/));
    expect(screen.getByText("Fact Check")).toBeDefined();
    expect(screen.getByText("Code Review")).toBeDefined();
  });

  it("reaches a library-tier action through search without expanding anything", () => {
    renderLibrary();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "understand" } });
    expect(screen.queryByText("Fact Check")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Find a block in any category"), {
      target: { value: "fact check" },
    });
    expect(screen.getByText("Fact Check")).toBeDefined();
  });

  it("adds a Condition block with two outputs to seed, not one", () => {
    const { onAdd } = renderLibrary();
    fireEvent.click(screen.getByText("Condition"));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Condition", actionKind: "check", seedOutputs: 2 }),
    );
  });
});

describe("totalBlockCount", () => {
  it("counts the whole catalog, not a constant, and grows with custom blocks", () => {
    const withoutCustom = totalBlockCount([]);
    const withCustom = totalBlockCount([{ label: "Mine", summary: "..." }]);
    expect(withCustom).toBe(withoutCustom + 1);
    // 29 actions + Start, Approval Gate, Condition, End.
    expect(withoutCustom).toBe(29 + 4);
  });
});
