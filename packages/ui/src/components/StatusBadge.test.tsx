import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge.js";
import type { BadgeTone } from "./StatusBadge.js";

afterEach(cleanup);

describe("StatusBadge", () => {
  it("renders whatever status string it is given", () => {
    render(<StatusBadge status="awaiting approval" tone="warning" />);
    expect(screen.getByText("awaiting approval")).toBeInTheDocument();
  });

  it("defaults to the neutral tone", () => {
    render(<StatusBadge status="draft" />);
    expect(screen.getByText("draft")).toHaveAttribute("data-tone", "neutral");
  });

  it("applies a class and data attribute per tone", () => {
    const tones: BadgeTone[] = ["neutral", "info", "success", "warning", "danger"];

    for (const tone of tones) {
      cleanup();
      render(<StatusBadge status={tone} tone={tone} />);
      const badge = screen.getByText(tone);
      expect(badge).toHaveClass(`anthill-badge--${tone}`);
      expect(badge).toHaveAttribute("data-tone", tone);
    }
  });

  it("keeps the status readable without relying on colour alone", () => {
    render(<StatusBadge status="failed" tone="danger" />);
    // The text content itself carries the meaning.
    expect(screen.getByText("failed")).toHaveTextContent("failed");
  });

  it("forwards extra props such as title and test ids", () => {
    render(<StatusBadge status="running" tone="info" title="Started 2m ago" data-testid="badge" />);
    expect(screen.getByTestId("badge")).toHaveAttribute("title", "Started 2m ago");
  });
});
