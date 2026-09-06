import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextField } from "./TextField.js";

afterEach(cleanup);

describe("TextField", () => {
  it("associates the label with the input", () => {
    render(<TextField label="Workflow name" />);
    expect(screen.getByLabelText("Workflow name")).toBeInstanceOf(HTMLInputElement);
  });

  it("accepts typed input and reports each change", async () => {
    const onChange = vi.fn();
    render(<TextField label="Workflow name" onChange={onChange} />);

    const input = screen.getByLabelText("Workflow name");
    await userEvent.type(input, "abc");

    expect(input).toHaveValue("abc");
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("renders helper text and describes the input with it", () => {
    render(<TextField label="Timeout" helperText="Seconds before the step aborts" />);

    const input = screen.getByLabelText("Timeout");
    expect(input).toHaveAccessibleDescription("Seconds before the step aborts");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("shows the error text and sets aria-invalid when error is passed", () => {
    render(<TextField label="Timeout" helperText="A hint" error="Must be a number" />);

    const input = screen.getByLabelText("Timeout");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Must be a number");
    expect(input).toHaveAccessibleDescription("Must be a number");
    // The error replaces the helper text rather than stacking with it.
    expect(screen.queryByText("A hint")).not.toBeInTheDocument();
  });

  it("keeps the label accessible when visually hidden", () => {
    render(<TextField label="Search" hideLabel placeholder="Search" />);
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
  });

  it("generates unique ids for multiple fields", () => {
    render(
      <>
        <TextField label="First" />
        <TextField label="Second" />
      </>,
    );

    const first = screen.getByLabelText("First");
    const second = screen.getByLabelText("Second");
    expect(first.id).not.toEqual(second.id);
  });
});
