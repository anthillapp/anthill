/**
 * Taking an agent out of the global library and into a workflow.
 *
 * ANT-17. The rail offers the profiles you have already written elsewhere, and
 * what it adds is a *copy*: the workflow is a file that has to keep meaning the
 * same thing after the library changes underneath it, is deleted, or is opened
 * on a machine that never had it. So the copy gets its own id, and carries a
 * `libraryId` back-reference — which is the only thing that lets the library
 * answer "is anything still using this" before a profile is deleted.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentProfiles } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";

import type { GlobalAgentProfile } from "../../shared/ipc.js";

import { AgentRail } from "./AgentLibrary.js";

const base: Workflow = {
  id: "w",
  name: "W",
  version: "1",
  target: "claude-code",
  nodes: [],
  edges: [],
  metadata: { workflow: { formatVersion: 4, agents: [] } },
};

function library(profiles: GlobalAgentProfile[]) {
  (window as unknown as { anthill: unknown }).anthill = {
    agentsList: vi.fn(async () => profiles),
  };
}

const reviewer: GlobalAgentProfile = {
  id: "lib-1",
  name: "Reviewer",
  models: { "claude-code": { id: "sonnet" } },
  role: "Reviews the work",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

function renderRail(workflow: Workflow, onChange: (next: Workflow) => void = () => undefined) {
  render(
    <AgentRail workflow={workflow} onChange={onChange} onSelect={() => undefined} />,
  );
}

describe("the workflow rail and the global library", () => {
  it("offers the library profiles this workflow does not have yet", async () => {
    library([reviewer]);
    renderRail(base);

    expect(await screen.findByText("From your library")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
  });

  it("adds a copy the workflow owns, pointing back at where it came from", async () => {
    library([reviewer]);
    let saved: Workflow | undefined;
    renderRail(base, (next) => {
      saved = next;
    });
    fireEvent.click(await screen.findByText("Reviewer"));

    const profiles = agentProfiles(saved!);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("Reviewer");
    expect(profiles[0].role).toBe("Reviews the work");
    // Its own identity inside this workflow…
    expect(profiles[0].id).toBe("agent-1");
    // …and a note of where the copy came from.
    expect(profiles[0].libraryId).toBe("lib-1");
  });

  it("stops offering one the workflow has already taken", async () => {
    library([reviewer]);
    const held: Workflow = {
      ...base,
      metadata: {
        workflow: {
          formatVersion: 4,
          agents: [{ id: "agent-1", name: "Renamed here", libraryId: "lib-1" }],
        },
      },
    };
    renderRail(held);

    await waitFor(() => expect(screen.queryByText("From your library")).toBeNull());
    // The workflow's own copy is still listed, under whatever it is called here.
    expect(screen.getByText("Renamed here")).toBeTruthy();
  });

  it("says the copy is the workflow's own, so editing it is not editing the library", async () => {
    library([reviewer]);
    renderRail(base);
    expect(await screen.findByText(/does not change the library/)).toBeTruthy();
  });

  it("keeps working when the library cannot be read", async () => {
    (window as unknown as { anthill: unknown }).anthill = {
      agentsList: vi.fn(async () => {
        throw new Error("no");
      }),
    };
    renderRail(base);

    // The workflow's own agents are in the file and do not depend on this.
    expect(await screen.findByText(/No agents yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New agent" })).toBeTruthy();
  });
});
