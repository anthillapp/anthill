import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";
import { Panel } from "./Panel.js";

afterEach(cleanup);

describe("Panel", () => {
  it("renders children", () => {
    render(<Panel>body content</Panel>);
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("renders the title as a heading and names the region with it", () => {
    render(<Panel title="Validation">no issues</Panel>);

    expect(screen.getByRole("heading", { name: "Validation" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Validation" })).toBeInTheDocument();
  });

  it("renders no header when neither title nor actions are given", () => {
    const { container } = render(<Panel>body</Panel>);
    expect(container.querySelector(".anthill-panel__header")).toBeNull();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("renders interactive header actions", async () => {
    const onClick = vi.fn();
    render(
      <Panel title="Properties" actions={<Button onClick={onClick}>Reset</Button>}>
        body
      </Panel>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("forwards extra props to the section element", () => {
    const { container } = render(
      <Panel data-testid="props-panel" className="custom">
        body
      </Panel>,
    );

    const section = screen.getByTestId("props-panel");
    expect(section.tagName).toBe("SECTION");
    expect(section).toHaveClass("custom");
    expect(container.querySelector(".anthill-panel__body")).not.toBeNull();
  });
});
