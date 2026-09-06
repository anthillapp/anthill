import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";

afterEach(cleanup);

describe("Button", () => {
  it("calls onClick when activated with the mouse", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run</Button>);

    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is keyboard operable (tab to focus, Enter to activate)", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run</Button>);

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Run" })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("blocks interaction while loading and marks itself busy", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("button-spinner")).toBeInTheDocument();

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Run
      </Button>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders no spinner when not loading", () => {
    render(<Button>Run</Button>);
    expect(screen.queryByTestId("button-spinner")).not.toBeInTheDocument();
  });

  it("applies variant and size classes and defaults to type=button", () => {
    render(
      <Button variant="danger" size="sm">
        Delete
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toHaveClass("anthill-button--danger");
    expect(button).toHaveClass("anthill-button--sm");
    expect(button).toHaveAttribute("type", "button");
  });

  it("forwards standard button props and a ref", () => {
    let node: HTMLButtonElement | null = null;
    render(
      <Button
        ref={(el) => {
          node = el;
        }}
        type="submit"
        aria-label="Submit form"
      />,
    );

    expect(node).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByRole("button", { name: "Submit form" })).toHaveAttribute("type", "submit");
  });
});
