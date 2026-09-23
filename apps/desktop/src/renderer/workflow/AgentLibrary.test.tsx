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

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAgentProfile, agentProfiles, type AgentProfile } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";

import type { CodexModelCatalog, GlobalAgentProfile } from "../../shared/ipc.js";

import { AgentEditor, AgentRail } from "./AgentLibrary.js";

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

/*
  ANT-127. The workflow's own agent editor listed the models from the harness
  table — which is empty for Codex on purpose, because Codex's are discovered
  on the machine — so a Codex workflow offered "Default" and nothing else. The
  global library had the discovered catalogue the whole time; this editor has
  to read the same one, by the same rules.
*/
describe("the workflow agent editor and a discovered catalogue", () => {
  const codexBase: Workflow = { ...base, target: "codex" };

  const catalogue: CodexModelCatalog = {
    models: [
      {
        id: "gpt-5-codex",
        label: "GPT-5 Codex",
        efforts: [{ id: "low" }, { id: "medium" }, { id: "high", hint: "slowest" }],
        defaultEffort: "medium",
      },
      { id: "gpt-5-mini", label: "GPT-5 mini", efforts: [] },
    ],
    fetchedAt: "2026-09-20T10:00:00.000Z",
    agentSupport: "supported",
  };

  function bridge(codex: CodexModelCatalog | undefined | (() => Promise<never>)) {
    (window as unknown as { anthill: unknown }).anthill = {
      agentsList: vi.fn(async () => []),
      codexModels: typeof codex === "function" ? vi.fn(codex) : vi.fn(async () => codex),
      piModels: vi.fn(async () => undefined),
    };
  }

  function withAgent(workflow: Workflow, models?: AgentProfile["models"]) {
    const { workflow: next, agentId } = addAgentProfile(workflow, {
      name: "Operator",
      ...(models ? { models } : {}),
    });
    return { workflow: next, agentId };
  }

  function renderEditor(
    workflow: Workflow,
    agentId: string,
    onChange: (next: Workflow) => void = () => undefined,
  ) {
    const profile = agentProfiles(workflow).find((item) => item.id === agentId) as AgentProfile;
    render(
      <AgentEditor
        workflow={workflow}
        profile={profile}
        onChange={onChange}
        onSelect={() => undefined}
        onSelectStep={() => undefined}
      />,
    );
  }

  const modelPicker = () => screen.getByLabelText("Model") as HTMLSelectElement;
  const labelsOf = (select: HTMLSelectElement) =>
    Array.from(select.options).map((option) => option.textContent ?? "");

  it("lists the models Codex discovered, with Default still first", async () => {
    bridge(catalogue);
    const { workflow, agentId } = withAgent(codexBase);
    renderEditor(workflow, agentId);

    await waitFor(() => expect(within(modelPicker()).getByText(/GPT-5 Codex/)).toBeTruthy());
    const labels = labelsOf(modelPicker());
    expect(labels[0]).toMatch(/^Default/);
    expect(labels).toContain("GPT-5 mini");
  });

  it("writes the chosen Codex model into the workflow", async () => {
    bridge(catalogue);
    const { workflow, agentId } = withAgent(codexBase);
    let saved: Workflow | undefined;
    renderEditor(workflow, agentId, (next) => {
      saved = next;
    });
    await waitFor(() => expect(within(modelPicker()).getByText(/GPT-5 Codex/)).toBeTruthy());

    fireEvent.change(modelPicker(), { target: { value: "gpt-5-codex" } });
    expect(agentProfiles(saved as Workflow)[0].models?.codex).toEqual({ id: "gpt-5-codex" });
  });

  it("offers reasoning effort for a model that has it, and keeps the choice", async () => {
    bridge(catalogue);
    const { workflow, agentId } = withAgent(codexBase, { codex: { id: "gpt-5-codex" } });
    let saved: Workflow | undefined;
    renderEditor(workflow, agentId, (next) => {
      saved = next;
    });

    const effort = (await screen.findByLabelText("Reasoning effort")) as HTMLSelectElement;
    expect(Array.from(effort.options).map((option) => option.value)).toEqual([
      "__default__",
      "low",
      "medium",
      "high",
    ]);
    fireEvent.change(effort, { target: { value: "high" } });
    expect(agentProfiles(saved as Workflow)[0].models?.codex).toEqual({
      id: "gpt-5-codex",
      reasoningEffort: "high",
    });
  });

  it("offers no reasoning effort for a model without it", async () => {
    bridge(catalogue);
    const { workflow, agentId } = withAgent(codexBase, { codex: { id: "gpt-5-mini" } });
    renderEditor(workflow, agentId);
    await waitFor(() => expect(within(modelPicker()).getByText(/GPT-5 mini/)).toBeTruthy());
    expect(screen.queryByLabelText("Reasoning effort")).toBeNull();
  });

  it("clears the model on Default, so the agent file names none", async () => {
    bridge(catalogue);
    const { workflow, agentId } = withAgent(codexBase, {
      codex: { id: "gpt-5-codex", reasoningEffort: "high" },
    });
    let saved: Workflow | undefined;
    renderEditor(workflow, agentId, (next) => {
      saved = next;
    });
    await waitFor(() => expect(within(modelPicker()).getByText(/GPT-5 Codex/)).toBeTruthy());

    fireEvent.change(modelPicker(), { target: { value: "" } });
    expect(agentProfiles(saved as Workflow)[0].models?.codex).toBeUndefined();
  });

  it("keeps a stored model Codex no longer offers, and says so", async () => {
    bridge(catalogue);
    const { workflow, agentId } = withAgent(codexBase, { codex: { id: "o3-retired" } });
    renderEditor(workflow, agentId);

    await waitFor(() => expect(within(modelPicker()).getByText(/GPT-5 Codex/)).toBeTruthy());
    expect(modelPicker().value).toBe("o3-retired");
    expect(within(modelPicker()).getByText(/o3-retired — no longer offered/)).toBeTruthy();
    expect(screen.getByText(/no longer offers/)).toBeTruthy();
  });

  it("says when the catalogue could not be read, rather than offering nothing", async () => {
    bridge(undefined);
    const { workflow, agentId } = withAgent(codexBase);
    renderEditor(workflow, agentId);

    expect(await screen.findByText(/has not been given .*model list/)).toBeTruthy();
    // Default is still an answer; the picker is not left empty.
    expect(labelsOf(modelPicker())[0]).toMatch(/^Default/);
  });

  it("survives the bridge failing outright", async () => {
    bridge(async () => {
      throw new Error("no bridge");
    });
    const { workflow, agentId } = withAgent(codexBase);
    renderEditor(workflow, agentId);
    expect(await screen.findByText(/has not been given .*model list/)).toBeTruthy();
  });

  it("leaves Claude Code with its declared models", async () => {
    bridge(catalogue);
    const { workflow, agentId } = withAgent(base);
    renderEditor(workflow, agentId);
    const labels = labelsOf(modelPicker());
    expect(labels.some((label) => label.startsWith("Sonnet"))).toBe(true);
    expect(labels.some((label) => label.includes("GPT-5"))).toBe(false);
    expect(screen.queryByLabelText("Reasoning effort")).toBeNull();
  });

  it("names the file in the harness's own format", async () => {
    bridge(catalogue);
    const { workflow, agentId } = withAgent(codexBase);
    renderEditor(workflow, agentId);
    expect(screen.getByText(/\.codex\/agents\/operator\.toml/)).toBeTruthy();
  });
});
