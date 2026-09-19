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

  it("shows everything in a category, with nothing folded away", () => {
    // The category already narrows the list to a handful, so a second fold
    // inside it bought nothing and cost a row that had to be understood before
    // the list could be trusted to be the list.
    renderLibrary();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "verify" } });

    for (const label of [
      "Check",
      "LLM Review",
      "Adversarial Review",
      "Run Tests",
      "Browser Check",
      "Fact Check",
      "Code Review",
      "Criteria Review",
      "Security / Privacy Review",
      "Accessibility Review",
    ]) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it("offers nothing to expand, because there is nothing held back", () => {
    renderLibrary();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "verify" } });
    expect(screen.queryByText(/less common actions?/)).toBeNull();
    expect(screen.queryByText(/Show common actions only/)).toBeNull();
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
