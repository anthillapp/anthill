import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { AnthillApi } from "../shared/ipc.js";
import { Root } from "./Root.js";

const firstRun = vi.hoisted(() => ({ due: false, seen: 0 }));
vi.mock("./explain/first-run.js", () => ({
  onboardingDue: () => firstRun.due,
  markOnboardingSeen: () => {
    firstRun.seen += 1;
  },
}));
vi.mock("./onboarding/Onboarding.js", () => ({
  Onboarding: ({ onFinish }: { onFinish(): void }) => <button onClick={onFinish}>Skip for now</button>,
}));
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

/*
 * ANT-140: a first start lands on onboarding, once; finishing it lands on the
 * launch window and remembers that it was seen. A returning start goes straight
 * to the launch window.
 */
it("starts on onboarding the first time, and finishes on the launch window", async () => {
  firstRun.due = true;
  firstRun.seen = 0;
  try {
    await act(async () => { render(<Root />); });
    expect(screen.queryByRole("button", { name: "New workflow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(firstRun.seen).toBe(1);
    expect(screen.getByRole("button", { name: "New workflow" })).toBeTruthy();
  } finally {
    firstRun.due = false;
  }
});

it("asks for the canvas tour when onboarding finishes, and only then", async () => {
  localStorage.removeItem("anthill.canvas-tour-due");
  await act(async () => { render(<Root />); });
  expect(localStorage.getItem("anthill.canvas-tour-due")).toBeNull();
  cleanup();

  firstRun.due = true;
  try {
    await act(async () => { render(<Root />); });
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(localStorage.getItem("anthill.canvas-tour-due")).not.toBeNull();
  } finally {
    firstRun.due = false;
    localStorage.removeItem("anthill.canvas-tour-due");
  }
});

it("goes straight to the launch window once onboarding has been seen", async () => {
  await act(async () => { render(<Root />); });
  expect(screen.getByRole("button", { name: "New workflow" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
});

it("lets a handed-over workflow through onboarding, and does not show the tour again", async () => {
  firstRun.due = true;
  firstRun.seen = 0;
  try {
    await act(async () => { render(<Root />); });
    act(() => receive("/incoming.json", 11));
    expect(screen.getByText("/incoming.json")).toBeTruthy();
    expect(firstRun.seen).toBe(1);
  } finally {
    firstRun.due = false;
  }
});
