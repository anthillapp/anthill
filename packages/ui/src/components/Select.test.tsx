import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "./Select.js";
import type { SelectOption } from "./Select.js";

afterEach(cleanup);

const options: SelectOption[] = [
  { value: "codex", label: "Codex CLI" },
  { value: "claude", label: "Claude Code" },
  { value: "gemini", label: "Gemini CLI", disabled: true },
];

describe("Select", () => {
  it("associates the label with the control and renders every option", () => {
    render(<Select label="Runtime" options={options} value="codex" onChange={() => {}} />);

    const select = screen.getByLabelText("Runtime");
    expect(select).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(select).toHaveValue("codex");
  });

  it("calls onChange with the selected value, not the event", async () => {
    const onChange = vi.fn();
    render(<Select label="Runtime" options={options} value="codex" onChange={onChange} />);

    await userEvent.selectOptions(screen.getByLabelText("Runtime"), "claude");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("claude");
  });

  it("works as a controlled component", async () => {
    function Harness() {
      const [value, setValue] = useState("codex");
      return <Select label="Runtime" options={options} value={value} onChange={setValue} />;
    }
    render(<Harness />);

    const select = screen.getByLabelText("Runtime");
    await userEvent.selectOptions(select, "claude");
    expect(select).toHaveValue("claude");
  });

  it("renders a disabled placeholder when asked", () => {
    render(
      <Select
        label="Runtime"
        options={options}
        value=""
        placeholder="Choose a runtime"
        onChange={() => {}}
      />,
    );

    const placeholder = screen.getByRole("option", { name: "Choose a runtime" });
    expect(placeholder).toBeDisabled();
    expect(screen.getByLabelText("Runtime")).toHaveValue("");
  });

  it("marks disabled options as disabled", () => {
    render(<Select label="Runtime" options={options} value="codex" onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Gemini CLI" })).toBeDisabled();
  });

  it("shows the error text and sets aria-invalid", () => {
    render(
      <Select
        label="Runtime"
        options={options}
        value=""
        placeholder="Choose a runtime"
        error="Pick a runtime"
        onChange={() => {}}
      />,
    );

    const select = screen.getByLabelText("Runtime");
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a runtime");
  });
});
