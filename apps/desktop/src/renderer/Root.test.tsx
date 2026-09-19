import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { AnthillApi } from "../shared/ipc.js";
import { Root } from "./Root.js";

vi.mock("./explain/first-run.js", () => ({ explainerDue: () => false, markExplainerSeen: vi.fn() }));
vi.mock("./LaunchWindow.js", () => ({
  LaunchWindow: ({ onNewWorkflow }: { onNewWorkflow(): void }) => <button onClick={onNewWorkflow}>New workflow</button>,
}));
vi.mock("./settings/SettingsScreen.js", () => ({ SettingsScreen: () => <div>Settings</div> }));
vi.mock("./workflow/WorkflowScreen.js", () => ({
  WorkflowScreen: ({ start, onSettings }: { start: { path?: string; deliveryId?: number }; onSettings(): void }) => {
    const [value, setValue] = useState("");
    useEffect(() => {
      (window as unknown as Record<string, unknown>).__anthillWorkflowDirty = false;
    }, []);
    return <>
      <p>{start.path ?? "Original workflow"}</p>
      <p>Delivery {start.deliveryId}</p>
      <input aria-label="Task" value={value} onChange={(event) => {
        setValue(event.target.value);
        (window as unknown as Record<string, unknown>).__anthillWorkflowDirty = true;
      }} />
      <button onClick={onSettings}>Settings</button>
    </>;
  },
}));

let receive: (path: string, id?: number) => void;
let opened: ReturnType<typeof vi.fn>;
let confirm: MockInstance<(message?: string) => boolean>;

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__anthillWorkflowDirty = false;
  opened = vi.fn(async () => undefined);
  confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  window.anthill = {
    onOpenSettings: () => () => undefined,
    onOpenWorkflow: (listener: typeof receive) => { receive = listener; return () => undefined; },
    pendingWorkflowOpen: async () => undefined,
    workflowOpened: opened,
  } as unknown as AnthillApi;
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function editing() {
  await act(async () => { render(<Root />); });
  fireEvent.click(screen.getByText("New workflow"));
  fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Do not lose this edit" } });
}

it("checks the current dirty state when a delayed handover arrives, and preserves edits on refusal", async () => {
  await editing();
  act(() => receive("/incoming.json", 7));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText("Task") as HTMLInputElement).value).toBe("Do not lose this edit");
  expect(screen.queryByText("/incoming.json")).toBeNull();
  expect(opened).toHaveBeenCalledWith("/incoming.json", 7, "declined");
});

it("commits an accepted replacement synchronously and forwards the delivery ID", async () => {
  await editing();
  confirm.mockReturnValue(true);
  act(() => {
    receive("/incoming.json", 8);
    expect(screen.getByText("/incoming.json")).toBeTruthy();
    expect((screen.getByLabelText("Task") as HTMLInputElement).value).toBe("");
  });
  expect(screen.getByText("Delivery 8")).toBeTruthy();
});

it("also protects the workflow hidden behind Settings", async () => {
  await editing();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  act(() => receive("/incoming.json", 9));
  expect(opened).toHaveBeenCalledWith("/incoming.json", 9, "declined");
  expect((screen.getByLabelText("Task") as HTMLInputElement).value).toBe("Do not lose this edit");
});

it("opens a clean launch screen without a discard question", async () => {
  await act(async () => { render(<Root />); });
  act(() => receive("/incoming.json", 10));
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByText("/incoming.json")).toBeTruthy();
});
