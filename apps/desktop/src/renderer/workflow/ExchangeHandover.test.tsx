import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { describeState, revisionDigest } from "@anthill/workflow-exchange";
import type { HandoverMode, RevisionState } from "@anthill/workflow-exchange";
import { stampWorkflowFormat } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";
import type { ExchangeReadyResult, ExchangeView } from "../../shared/ipc.js";
import { ExchangeHandover } from "./ExchangeHandover.js";

afterEach(cleanup);
const workflow: Workflow = stampWorkflowFormat({ id: "w", name: "Example", version: "1", nodes: [], edges: [] });
const view: ExchangeView = {
  workflowId: "w", revision: 1, digest: revisionDigest(workflow), mode: "approval-gate", state: "draft",
  source: { harness: "claude-code", sessionId: "s1", taskText: "The user's original task" }, problems: [], bindings: [],
};
function api(over: Partial<ExchangeView> = {}) {
  const methods = {
    exchangeRead: vi.fn(async () => ({ ...view, ...over })),
    exchangeReady: vi.fn(async (): Promise<ExchangeReadyResult> => ({ ok: true })),
    exchangeRevoke: vi.fn(async (): Promise<ExchangeReadyResult> => ({ ok: true })),
  };
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

/*
 * The app and the MCP server read the same `describeState`, and the server
 * reads the next-step sentence out to the harness. The app dropping it meant
 * the person was told the name of a state and the agent was told what to do
 * about it.
 */
it("says what to do next in every state, in the same words the harness is given", async () => {
  for (const mode of ["approval-gate", "show-and-go"] as const satisfies readonly HandoverMode[]) {
    for (const state of ["draft", "ready_for_agent", "bound"] as const satisfies readonly RevisionState[]) {
      api({ mode, state });
      render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);
      const next = describeState(state, mode).next!;
      expect(next).toBeTruthy();
      expect(await screen.findByText(next)).toBeTruthy();
      cleanup();
    }
  }
});

/* Provenance is where somebody reads the original task, not where they look
   before deciding whether pressing a button starts an agent. */
it("says Anthill starts nothing where the button is, not inside the provenance disclosure", async () => {
  api();
  render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);
  const sentence = await screen.findByText(/Anthill does not start or control the external session/);
  expect(sentence.closest("details")).toBeNull();
});

/*
 * Approving revision 1 and then editing leaves the head at revision 2 with
 * nothing approving it — and revision 1 still approved, still what a new bind
 * takes. The panel said "waiting for you" and stopped there.
 */
it("says an approval left on an earlier revision is still the one an agent may take", async () => {
  api({ revision: 2, state: "draft", approved: { revision: 1, at: "2026-09-18T09:00:00.000Z", withdrawable: true } });
  render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);
  const standing = await screen.findByText(/Revision 1 is still approved/);
  expect(standing.textContent).toBe(
    `Revision 1 is still approved, from ${new Date("2026-09-18T09:00:00.000Z").toLocaleString()}, ` +
      "so it — not revision 2 — is the one an agent may take. Approving this revision replaces that approval.",
  );
});

/*
 * Seeing the standing approval and being unable to take it back left the user
 * one way out of a decision they had changed their mind about: approve
 * something newer. The control says what it does — and, because withdrawing
 * an approval is the sort of thing somebody presses expecting an agent to
 * stop, what it does not.
 */
it("withdraws a standing approval, and says the bound run keeps going", async () => {
  const methods = api({ revision: 2, state: "draft", approved: { revision: 1, withdrawable: true } });
  render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);

  const button = await screen.findByRole("button", { name: "Withdraw approval of revision 1" });
  expect(screen.getByText(/keeps running and keeps reporting; withdrawing does not stop it/)).toBeTruthy();
  for (const name of [/stop/i, /cancel/i, /abort/i]) expect(screen.queryByRole("button", { name })).toBeNull();
  await act(async () => { fireEvent.click(button); });

  expect(methods.exchangeRevoke).toHaveBeenCalledWith({ path: "/tmp/workflow.json", workflowId: "w", revision: 1 });
});

it("offers no withdrawal where withdrawing would change nothing", async () => {
  // Show-and-go hands over the head revision whatever is approved, so a
  // control here would promise an effect it does not have.
  api({ mode: "show-and-go", revision: 2, state: "ready_for_agent", approved: { revision: 1, withdrawable: false } });
  render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);
  await screen.findByText(/Revision 1 is still approved/);
  expect(screen.queryByRole("button", { name: /Withdraw/ })).toBeNull();
});

it("reports a refused withdrawal and leaves the approval standing", async () => {
  const methods = api({ revision: 2, state: "draft", approved: { revision: 1, withdrawable: true } });
  methods.exchangeRevoke.mockResolvedValueOnce({ ok: false, error: "The approval changed." });
  render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);
  const button = await screen.findByRole("button", { name: "Withdraw approval of revision 1" });
  await act(async () => { fireEvent.click(button); });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The approval changed.");
  expect(screen.getByText(/Revision 1 is still approved/)).toBeTruthy();
});

it("does not repeat the approval on the revision that carries it", async () => {
  api({ revision: 1, state: "ready_for_agent", approved: { revision: 1, withdrawable: true } });
  render(<ExchangeHandover workflow={workflow} path="/tmp/workflow.json" dirty={false} runs={[]} />);
  await screen.findByText("Approved");
  expect(screen.queryByText(/still approved/)).toBeNull();
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
