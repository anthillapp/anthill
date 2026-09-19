import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { revisionDigest } from "@anthill/workflow-exchange";
import { stampWorkflowFormat } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";
import type { ExchangeView } from "../../shared/ipc.js";
import { ExchangeHandover } from "./ExchangeHandover.js";

afterEach(cleanup);
const workflow: Workflow = stampWorkflowFormat({ id: "w", name: "Example", version: "1", nodes: [], edges: [] });
const view: ExchangeView = {
  workflowId: "w", revision: 1, digest: revisionDigest(workflow), mode: "approval-gate", state: "draft",
  source: { harness: "claude-code", sessionId: "s1", taskText: "The user's original task" }, problems: [], bindings: [],
};
function api(over: Partial<ExchangeView> = {}) {
  const methods = { exchangeRead: vi.fn(async () => ({ ...view, ...over })), exchangeReady: vi.fn(async () => ({ ok: true })) };
  (window as unknown as { anthill: unknown }).anthill = methods;
  return methods;
}

it("records approval only after the user clicks and shows provenance without a runner", async () => {
  const methods = api();
  render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);
  const button = await screen.findByRole("button", { name: "Ready for agent" });
  expect(methods.exchangeReady).not.toHaveBeenCalled();
  expect(screen.getByText("The user's original task")).toBeTruthy();
  expect(screen.getByText("Approval gate")).toBeTruthy();
  await act(async () => { fireEvent.click(button); });
  expect(methods.exchangeReady).toHaveBeenCalledWith({ path: "/tmp/workflow.json", workflowId: "w", revision: 1, digest: view.digest });
  for (const name of [/^run$/i, /^start$/i, /^attach$/i, /^watch$/i, /^listen$/i]) expect(screen.queryByRole("button", { name })).toBeNull();
});

it("cannot approve unsaved changes or a stale editor snapshot", async () => {
  const methods = api();
  const { rerender } = render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty runs={[]} />);
  expect((await screen.findByRole("button", { name: "Ready for agent" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ExchangeHandover workflow={{ ...workflow, name: "Changed" }} path="/tmp/workflow.json" dirty={false} runs={[]} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Ready for agent" }) as HTMLButtonElement).disabled).toBe(true));
  expect(methods.exchangeReady).not.toHaveBeenCalled();
});

it("labels an older binding without claiming it is running", async () => {
  api({ revision: 2, bindings: [{ runId: "run", revision: 1 }] });
  render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);
  expect(await screen.findByText("Bound to revision 1 · your edits are revision 2")).toBeTruthy();
  expect(screen.queryByText(/Running revision/)).toBeNull();
});

it("reports a failed approval and leaves the draft unapproved", async () => {
  const methods = api();
  methods.exchangeReady.mockRejectedValueOnce(new Error("Disk is full"));
  render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);
  const button = await screen.findByRole("button", { name: "Ready for agent" });
  await act(async () => { fireEvent.click(button); });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Error: Disk is full");
  expect(screen.getByText("Waiting for you")).toBeTruthy();
});
