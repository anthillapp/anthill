import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";
import { Tooltip } from "./Tooltip.js";

afterEach(cleanup);

describe("Tooltip", () => {
  it("is hidden until the trigger is interacted with", () => {
    render(
      <Tooltip label="Runs the workflow">
        <Button>Run</Button>
      </Tooltip>,
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows the label on keyboard focus and hides it on blur", async () => {
    render(
      <Tooltip label="Runs the workflow">
        <Button>Run</Button>
      </Tooltip>,
    );

    await userEvent.tab();
    const trigger = screen.getByRole("button", { name: "Run" });
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Runs the workflow");
    expect(trigger).toHaveAccessibleDescription("Runs the workflow");

    await userEvent.tab();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows the label on hover and hides it on unhover", async () => {
    render(
      <Tooltip label="Runs the workflow">
        <Button>Run</Button>
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Run" });
    await userEvent.hover(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await userEvent.unhover(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("dismisses on Escape while the trigger keeps focus", async () => {
    render(
      <Tooltip label="Runs the workflow">
        <Button>Run</Button>
      </Tooltip>,
    );

    await userEvent.tab();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toHaveFocus();
  });

  it("preserves the child's own handlers and describedby", async () => {
    const onFocus = vi.fn();
    const onClick = vi.fn();
    render(
      <>
        <span id="external">external description</span>
        <Tooltip label="Runs the workflow">
          <button aria-describedby="external" onFocus={onFocus} onClick={onClick}>
            Run
          </button>
        </Tooltip>
      </>,
    );

    const trigger = screen.getByRole("button", { name: "Run" });
    await userEvent.click(trigger);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute("aria-describedby")).toContain("external");
  });

  it("positions the bubble according to the placement prop", async () => {
    render(
      <Tooltip label="Runs the workflow" placement="bottom">
        <Button>Run</Button>
      </Tooltip>,
    );

    await userEvent.tab();
    expect(screen.getByRole("tooltip")).toHaveClass("anthill-tooltip__bubble--bottom");
  });
});
