/**
 * The agent library, on the launch window.
 *
 * ANT-17, and the properties the screen still has to hold: a profile can be
 * written, renamed, copied and deleted with no workflow anywhere; identity is
 * the issued id and survives every rename; every state the list can be in —
 * loading, empty, filtered to nothing, failing — says something rather than
 * showing a blank box; and deleting a profile a workflow copied says what that
 * costs before it happens.
 *
 * Editing is a draft with an explicit Save, so the property that matters most
 * here is that no way out of the editor loses one: closing it, opening another
 * profile, and switching to Workflows all ask first.
 *
 * It renders the whole launch window rather than a list component, because the
 * two halves are the feature: the list is on the right, the editor replaces the
 * intro on the left, and a rename has to land in both from one reply.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexModelCatalog,
  GlobalAgentInput,
  GlobalAgentProfile,
  InterpreterInfo,
  RecentWorkflow,
} from "../../shared/ipc.js";

import { LaunchWindow } from "../LaunchWindow.js";

function profile(over: Partial<GlobalAgentProfile> = {}): GlobalAgentProfile {
  return {
    id: "agent-1",
    name: "Reviewer",
    role: "Reviews the work",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

function workflow(over: Partial<RecentWorkflow> = {}): RecentWorkflow {
  return {
    path: "/tmp/a.workflow.json",
    displayPath: "~/a.workflow.json",
    name: "Nightly review",
    meta: "4 blocks · 1 agent",
    modifiedAt: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

/** A machine with all three coding tools installed. pi's sign-in cannot be
    read non-interactively, so its `signedIn` is absent and Anthill counts it
    as connected rather than holding it back. */
function bothConnected(): InterpreterInfo[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      command: "claude …",
      boundary: "",
      available: true,
      signedIn: true,
      version: "2.1.0",
    },
    {
      id: "codex",
      label: "OpenAI Codex CLI",
      command: "codex …",
      boundary: "",
      available: true,
      signedIn: true,
      version: "0.9.0",
    },
    {
      id: "pi",
      label: "Pi",
      command: "pi -p --no-tools",
      boundary: "",
      available: true,
      version: "0.85.1",
    },
  ];
}

/** A machine with neither, which is the state this feature exists for. */
function neitherConnected(): InterpreterInfo[] {
  return bothConnected().map((item) => ({
    id: item.id,
    label: item.label,
    command: item.command,
    boundary: item.boundary,
    available: false,
    reason: `${item.label} was not found on your PATH.`,
  }));
}

/** A library that behaves like the real store: ids issued here, edits land. */
/** What Codex's own catalogue looks like, as this machine's file has it. */
function codexCatalog(
  agentSupport: CodexModelCatalog["agentSupport"] = "supported",
): CodexModelCatalog {
  return {
    agentSupport,
    fetchedAt: "2026-09-05T22:53:12.445Z",
    models: [
      {
        id: "gpt-6-astra",
        label: "GPT-6-Astra",
        efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }],
        defaultEffort: "low",
      },
      { id: "gpt-5.5", label: "GPT-5.5", efforts: [{ id: "low" }, { id: "high" }] },
    ],
  };
}

function stub(
  initial: GlobalAgentProfile[],
  workflows: RecentWorkflow[] = [],
  tools: InterpreterInfo[] = bothConnected(),
  // `null` rather than `undefined`, because an explicit `undefined` argument
  // takes the default and this test needs to say "there is no catalogue".
  catalog: CodexModelCatalog | null = codexCatalog(),
) {
  let held = [...initial];
  let issued = initial.length;
  const api = {
    listRecentPlans: vi.fn(async () => workflows),
    forgetRecentWorkflow: vi.fn(async () => undefined),
    liveSnapshot: vi.fn(async () => ({ runs: [], capabilities: [] })),
    onLiveSnapshot: vi.fn(() => () => undefined),
    liveEvents: vi.fn(async () => []),
    agentsList: vi.fn(async () => held),
    detectInterpreters: vi.fn(async () => tools),
    codexModels: vi.fn(async () => catalog ?? undefined),
    piModels: vi.fn(async () => undefined),
    signInToInterpreter: vi.fn(async () => ({ ok: true })),
    agentsCreate: vi.fn(async (input: GlobalAgentInput) => {
      issued += 1;
      const made: GlobalAgentProfile = {
        id: `agent-${issued}`,
        // Kept as given, the way the real store now is: a trailing space is
        // part of the name, not noise.
        name: input.name,
        ...(input.models ? { models: input.models } : {}),
        createdAt: "2026-09-01T11:00:00.000Z",
        updatedAt: "2026-09-01T11:00:00.000Z",
      };
      held = [made, ...held];
      return made;
    }),
    agentsUpdate: vi.fn(async (id: string, input: Partial<GlobalAgentInput>) => {
      const current = held.find((item) => item.id === id);
      if (!current) return undefined;
      const next: GlobalAgentProfile = { ...current };
      if (input.name !== undefined) next.name = input.name;
      // Same contract as the real store: the bag is replaced, not merged,
      // because the absence of a tool's key is the message.
      if (input.models !== undefined) {
        if (Object.keys(input.models).length === 0) delete next.models;
        else next.models = input.models;
      }
      // And for the rest, `undefined` is "not mentioned".
      for (const key of ["role", "description"] as const) {
        const value = input[key];
        if (value === undefined) continue;
        if (value.trim().length === 0) delete next[key];
        else next[key] = value;
      }
      held = held.map((item) => (item.id === id ? next : item));
      return next;
    }),
    agentsDuplicate: vi.fn(async (id: string) => {
      const source = held.find((item) => item.id === id);
      if (!source) return undefined;
      issued += 1;
      const copy: GlobalAgentProfile = {
        ...source,
        id: `agent-${issued}`,
        name: `${source.name} (copy)`,
        starter: false,
      };
      held = [copy, ...held];
      return copy;
    }),
    agentsRemove: vi.fn(async (id: string) => {
      const before = held.length;
      held = held.filter((item) => item.id !== id);
      return held.length !== before;
    }),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return { api, held: () => held };
}

/** Render the launch window and switch to the agents tab. */
async function openAgents() {
  render(
    <LaunchWindow
      onNewWorkflow={() => undefined}
      onFromPrompt={() => undefined}
      onOpen={() => undefined}
      onExplain={() => undefined}
      onFromSession={() => undefined} onWelcomeTour={() => undefined} onShowTips={() => undefined}
      onSettings={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Agents\b/ }));
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

describe("browsing the agent library", () => {
  it("lists what is there, with what each agent is for", async () => {
    stub([
      profile({ description: "Reviews the work" }),
      profile({ id: "agent-2", name: "Builder", description: "Writes the code" }),
    ]);
    await openAgents();

    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Builder")).toBeTruthy();
    expect(screen.getByText("Writes the code")).toBeTruthy();
  });

  /* An author scanning for something to reuse is asking a different question
     from one checking what they already wrote. */
  it("keeps what Anthill ships apart from what you wrote", async () => {
    stub([profile(), profile({ id: "agent-s", name: "Architect", starter: true })]);
    await openAgents();
    await screen.findByText("Reviewer");

    expect(screen.getByText("Yours")).toBeTruthy();
    expect(screen.getByText("Ready-made")).toBeTruthy();
  });

  it("says it is looking before it says there is nothing", async () => {
    stub([]);
    await openAgents();
    expect(screen.getByText(/Looking for your agents/)).toBeTruthy();
    expect(await screen.findByText(/No agents of your own yet/)).toBeTruthy();
  });

  it("filters on name, role and model", async () => {
    stub([
      profile(),
      profile({ id: "agent-2", name: "Builder", description: "Writes the code" }),
    ]);
    await openAgents();
    await screen.findByText("Reviewer");

    fireEvent.change(screen.getByLabelText("Filter agents"), { target: { value: "writes" } });
    expect(screen.queryByText("Reviewer")).toBeNull();
    expect(screen.getByText("Builder")).toBeTruthy();
  });

  it("says so rather than showing an empty list when a filter matches nothing", async () => {
    stub([profile()]);
    await openAgents();
    await screen.findByText("Reviewer");

    fireEvent.change(screen.getByLabelText("Filter agents"), { target: { value: "zzz" } });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it("reports a library it could not read, and changes nothing", async () => {
    const { api } = stub([]);
    api.agentsList.mockRejectedValueOnce(new Error("no"));
    await openAgents();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/Nothing was changed/)).toBeTruthy();
  });

  /* An "in no workflow" pill on every row made the most repeated words on
     screen the ones saying nothing. Absence is the group heading's job. */
  it("states usage only where there is usage", async () => {
    stub([profile(), profile({ id: "agent-2", name: "Builder" })], [
      workflow({ libraryAgentIds: ["agent-1"] }),
    ]);
    await openAgents();
    await screen.findByText("Reviewer");

    expect(screen.getByText("In 1 workflow")).toBeTruthy();
    expect(screen.queryByText(/no workflow/i)).toBeNull();
  });

  /* One button, so nothing nested can trap a keyboard, and no trailing
     "Edit"/"Use" label advertising an action a span cannot perform. */
  it("makes the whole row the only control on it", async () => {
    stub([profile()]);
    await openAgents();
    const row = (await screen.findByText("Reviewer")).closest("button");

    expect(row).toBeTruthy();
    expect(row!.querySelectorAll("button, a, input")).toHaveLength(0);
    expect(within(row!).queryByText(/^(Edit|Use)$/)).toBeNull();
  });
});

describe("writing an agent", () => {
  it("creates one and opens it, with no workflow anywhere", async () => {
    const { api } = stub([]);
    await openAgents();
    await screen.findByText(/No agents of your own yet/);

    fireEvent.click(screen.getByRole("button", { name: "+ New agent" }));

    await waitFor(() => expect(api.agentsCreate).toHaveBeenCalled());
    // The new profile's own form is open, empty and ready to be named.
    expect((await screen.findByPlaceholderText("e.g. Developer")) as HTMLInputElement).toHaveProperty(
      "value",
      "",
    );
    expect(screen.getByText(/reads as “Unnamed agent”/)).toBeTruthy();
    // Naming it is the only thing left to do, so the cursor is already there.
    expect(document.activeElement).toBe(screen.getByPlaceholderText("e.g. Developer"));
  });

  it("says an unnamed profile needs a name, in the list as well", async () => {
    stub([profile({ name: "" })]);
    await openAgents();

    expect(await screen.findByText("Unnamed agent")).toBeTruthy();
    expect(screen.getByText("needs a name")).toBeTruthy();
  });

  it("does not steal the cursor when an existing agent is opened", async () => {
    stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    expect(document.activeElement).not.toBe(screen.getByPlaceholderText("e.g. Developer"));
  });

  /* The editor takes the intro's place rather than a modal's: choosing between
     profiles is most of the work here, so the list has to stay visible. */
  it("opens the editor in place of the intro, with the list still there", async () => {
    stub([profile()]);
    await openAgents();
    expect(screen.getByText(`Version ${__ANTHILL_VERSION__} · local-first`)).toBeTruthy();

    fireEvent.click(await screen.findByText("Reviewer"));

    expect(screen.queryByText(`Version ${__ANTHILL_VERSION__} · local-first`)).toBeNull();
    expect(screen.getByText("Agent profile")).toBeTruthy();
    expect(screen.getAllByText("Reviewer").length).toBe(2);
  });

  it("leaves no half-open profile behind when the tab changes", async () => {
    stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.click(screen.getByRole("button", { name: /^Workflows\b/ }));
    expect(screen.queryByText("Agent profile")).toBeNull();
    expect(screen.getByText(`Version ${__ANTHILL_VERSION__} · local-first`)).toBeTruthy();
  });

  it("holds a rename until Save, then keeps the id", async () => {
    const { api, held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Careful Reviewer" } });

    // Typed but not written: the list still answers "what have I got".
    expect(api.agentsUpdate).not.toHaveBeenCalled();
    expect(held()[0].name).toBe("Reviewer");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(held()[0].name).toBe("Careful Reviewer"));
    expect(held()[0].id).toBe("agent-1");
    // And now the list says it too — the row and the editor's own heading.
    await waitFor(() => expect(screen.getAllByText("Careful Reviewer").length).toBe(2));
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  /*
   * The regression for the trim-on-save bug: a space typed at the end of the
   * name is part of the name, so it is kept rather than trimmed on the way
   * in — through typing, through save, and in the stored value.
   */
  it("keeps a trailing space typed into the name, through save", async () => {
    const { held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    // Type "Dev " character by character, the way an author would, starting
    // from an empty field.
    const nameField = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(nameField, { target: { value: "" } });
    for (const char of "Dev ") {
      fireEvent.change(nameField, { target: { value: nameField.value + char } });
    }
    // The space survives to the next render — it is part of the name, not
    // noise, so the field still shows it.
    expect(nameField).toHaveProperty("value", "Dev ");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // And it survives the save: the stored value is kept as given, so the
    // field re-binds to it with the space still there.
    await waitFor(() => expect(held()[0].name).toBe("Dev "));
    expect(nameField).toHaveProperty("value", "Dev ");
  });

  /* The button is also the answer to "is there anything of mine not written?",
     which is what having no Save button failed to give anyone. */
  it("offers nothing to press until there is something to write", async () => {
    stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Careful" } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);

    // Typed back to what is stored is not an edit, whatever route it took.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Reviewer" } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("saves on ⌘S, because a form with a Save button is saved that way", async () => {
    const { held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Careful" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "s", metaKey: true });

    await waitFor(() => expect(held()[0].name).toBe("Careful"));
  });

  /*
   * The bug this was written for: every edit used to send all four fields,
   * with `undefined` in the ones nobody touched. A key with no value survives
   * IPC intact, so the store read four fields as mentioned and cleared three —
   * choosing a model wiped the role and what the agent was for.
   */
  it("changes the one field that was edited and leaves the rest alone", async () => {
    const { api, held } = stub([
      profile({ role: "Full-stack implementation", description: "Implements the change." }),
    ]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.change(await screen.findByLabelText("Claude Code model for this agent"), {
      target: { value: "opus" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(held()[0].models).toEqual({ "claude-code": { id: "opus" } }));
    expect(held()[0].role).toBe("Full-stack implementation");
    expect(held()[0].description).toBe("Implements the change.");
    // And nothing the author did not touch was even mentioned.
    expect(Object.keys(api.agentsUpdate.mock.calls[0][1])).toEqual(["models"]);
  });

  /*
   * What stands in for the Save button that is deliberately not here. Silence
   * reads as "nothing happened" to anyone who has ever lost a form.
   */
  it("says nothing about saving until something has been saved", async () => {
    stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Careful" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("says so when a save did not reach the file, and keeps the draft", async () => {
    const { api, held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    api.agentsUpdate.mockRejectedValueOnce(new Error("no"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Careful" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Not saved")).toBeTruthy();
    expect(held()[0].name).toBe("Reviewer");
    // The typing is still on screen, and still pressable — a failed write must
    // not also be the thing that loses the text.
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Careful");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
  });

  it("starts over on the next profile opened", async () => {
    stub([profile(), profile({ id: "agent-2", name: "Builder" })]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Careful" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");

    fireEvent.click(screen.getByText("Builder"));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("clears a field rather than storing it empty", async () => {
    const { held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.change(screen.getByLabelText("Role — optional"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // "role" gone, not "role: ''" — an empty string answers yes to every
    // downstream check for whether a role was given.
    await waitFor(() => expect("role" in held()[0]).toBe(false));
  });

  it("says the identity it will keep", async () => {
    stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    expect(screen.getByText(/Identity: agent-1/)).toBeTruthy();
    expect(screen.getByText(/Renaming is safe/)).toBeTruthy();
  });

  it("duplicates into a new identity and opens the copy", async () => {
    const { api, held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));

    await waitFor(() => expect(api.agentsDuplicate).toHaveBeenCalledWith("agent-1"));
    expect(held()).toHaveLength(2);
    expect(await screen.findByDisplayValue("Reviewer (copy)")).toBeTruthy();
    expect(screen.getByText(/Identity: agent-2/)).toBeTruthy();
  });
});

/**
 * The design this replaced, kept as a test because it is an easy one to
 * re-introduce: clicking a ready-made profile used to *copy* it into Yours and
 * open the copy — two rows named Architect after one click, and an original
 * nobody could ever correct.
 */
describe("a ready-made profile", () => {
  it("opens and edits like any other, and is not copied on click", async () => {
    const { api, held } = stub([profile({ id: "agent-s", name: "Architect", starter: true })]);
    await openAgents();

    fireEvent.click(await screen.findByText("Architect"));

    expect(api.agentsDuplicate).not.toHaveBeenCalled();
    expect(api.agentsCreate).not.toHaveBeenCalled();
    expect(held()).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Planner" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held()[0].name).toBe("Planner"));
    expect(held()[0].id).toBe("agent-s");
  });
});

/**
 * The cost of having a Save button, paid down.
 *
 * Live saving could not lose anything; a draft can, so each of the three ways
 * out of the editor has to ask. These are the tests that keep a fourth way
 * from being added quietly.
 */
describe("leaving an agent with unsaved changes", () => {
  async function editing() {
    const kept = stub([profile(), profile({ id: "agent-2", name: "Builder" })]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Careful" } });
    return kept;
  }

  it("asks before closing the editor, and keeps everything while it asks", async () => {
    await editing();

    fireEvent.click(screen.getByRole("button", { name: "Close the agent" }));

    expect(screen.getByRole("group", { name: "Unsaved changes" })).toBeTruthy();
    // Still open, still typed: the question is not itself a way to lose it.
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Careful");
  });

  it("asks before opening another profile", async () => {
    await editing();
    fireEvent.click(screen.getByText("Builder"));
    expect(screen.getByRole("group", { name: "Unsaved changes" })).toBeTruthy();
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Careful");
  });

  it("asks before leaving for the workflows", async () => {
    await editing();
    fireEvent.click(screen.getByRole("button", { name: /^Workflows\b/ }));
    expect(screen.getByRole("group", { name: "Unsaved changes" })).toBeTruthy();
  });

  it("goes on where it was going, once the draft is saved", async () => {
    const { held } = await editing();

    fireEvent.click(screen.getByText("Builder"));
    fireEvent.click(within(screen.getByRole("group", { name: "Unsaved changes" })).getByText("Save"));

    await waitFor(() => expect(held()[0].name).toBe("Careful"));
    // And it arrives: the profile that was clicked is the one now open.
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveProperty("value", "Builder"));
  });

  it("goes on where it was going, once the draft is discarded", async () => {
    const { api, held } = await editing();

    fireEvent.click(screen.getByRole("button", { name: "Close the agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(api.agentsUpdate).not.toHaveBeenCalled();
    expect(held()[0].name).toBe("Reviewer");
    // Closed, and the intro is back.
    expect(screen.getByText(`Version ${__ANTHILL_VERSION__} · local-first`)).toBeTruthy();
  });

  it("stays put, with the draft untouched, when the author changes their mind", async () => {
    await editing();

    fireEvent.click(screen.getByRole("button", { name: "Close the agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(screen.queryByRole("group", { name: "Unsaved changes" })).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Careful");
  });

  /* A save that did not land must not carry on to the thing that would throw
     the draft away — that would turn one failure into two. */
  it("stays put when the save it was asked for did not land", async () => {
    const { api } = await editing();
    api.agentsUpdate.mockRejectedValueOnce(new Error("no"));

    fireEvent.click(screen.getByRole("button", { name: "Close the agent" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Unsaved changes" })).getByText("Save"));

    expect(await screen.findByText("Not saved")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Careful");
  });

  it("does not ask when there is nothing to lose", async () => {
    stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.click(screen.getByRole("button", { name: "Close the agent" }));

    expect(screen.queryByRole("group", { name: "Unsaved changes" })).toBeNull();
    expect(screen.getByText(`Version ${__ANTHILL_VERSION__} · local-first`)).toBeTruthy();
  });
});

/**
 * ANT-50. A profile is written before Anthill knows whether either coding tool
 * is on this machine, so the words can always be typed — and the model area
 * says what is actually true instead of listing models from a tool that is not
 * there. A list of Claude Code models on a machine with no Claude Code is not a
 * shortcut to a choice; it is a claim about the author's computer.
 */
describe("choosing a model before a tool is connected", () => {
  async function withoutTools(profiles = [profile()]) {
    const kept = stub(profiles, [], neitherConnected());
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    // Detection is a process on the author's machine, so the answer arrives
    // after the editor does. Nothing is claimed about the tools meanwhile.
    await screen.findAllByText("Not installed");
    return kept;
  }

  it("lets the words be written with no tool on the machine at all", async () => {
    const { api, held } = await withoutTools();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Careful" } });
    fireEvent.change(screen.getByLabelText("What it is for"), {
      target: { value: "Reads the change against what it claims to do." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(held()[0].name).toBe("Careful"));
    expect(held()[0].description).toBe("Reads the change against what it claims to do.");
    // And no model was invented on the profile's behalf.
    expect(api.agentsUpdate.mock.calls[0][1]).not.toHaveProperty("models");
  });

  /* "Not connected" is never rendered as "no model chosen": the card says what
     is true about the machine, and offers no list it could not honour. */
  it("offers a way in instead of listing models it cannot honour", async () => {
    await withoutTools();

    const cards = screen.getByRole("group", { name: "Model per coding tool" });
    expect(within(cards).getAllByRole("button", { name: "Check again" })).toHaveLength(3);
    expect(within(cards).queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Opus — Deepest reasoning, slowest")).toBeNull();
    expect(screen.queryByText("Not chosen")).toBeNull();
  });

  /* The requirement the redesign exists for: a working Claude Code must never
     be the reason Codex has no way in. */
  it("still offers the other tool a way in when one is connected", async () => {
    const half = bothConnected().map((item) =>
      item.id === "codex"
        ? { id: item.id, label: item.label, command: item.command, boundary: "", available: false }
        : item,
    );
    stub([profile()], [], half);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    expect(await screen.findByLabelText("Claude Code model for this agent")).toBeTruthy();
    const cards = screen.getByRole("group", { name: "Model per coding tool" });
    expect(within(cards).getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("opens the setup sheet from the card, over the profile", async () => {
    await withoutTools();

    fireEvent.click(screen.getAllByRole("button", { name: "Check again" })[0]);

    const sheet = screen.getByRole("dialog", { name: "Connect Claude Code" });
    expect(within(sheet).getByText("Claude Code was not found")).toBeTruthy();
    // Which step it got to, never what it ran.
    expect(within(sheet).getByText("Found on this machine")).toBeTruthy();
    expect(within(sheet).getByText("Not found")).toBeTruthy();
    expect(within(sheet).getByText(/unsaved changes to this agent are kept/)).toBeTruthy();
  });

  /* The worry the panel has to answer is "have I just lost what I typed?", and
     the answer is the draft still being on screen behind it. */
  it("keeps every unsaved field through opening and cancelling the connection", async () => {
    await withoutTools();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Careful" } });
    fireEvent.change(screen.getByLabelText("Role — optional"), { target: { value: "Reads" } });

    fireEvent.click(screen.getAllByRole("button", { name: "Check again" })[0]);
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Careful");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Careful");
    expect(screen.getByLabelText("Role — optional")).toHaveProperty("value", "Reads");
  });

  it("offers the tool's own sign-in when it is installed but signed out", async () => {
    const signedOut = neitherConnected().map((item) =>
      item.id === "claude-code"
        ? { ...item, available: true, signedIn: false, version: "2.1.0" }
        : item,
    );
    stub([profile()], [], signedOut);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    expect(await screen.findByText("Signed out")).toBeTruthy();

    const cards = screen.getByRole("group", { name: "Model per coding tool" });
    fireEvent.click(within(cards).getAllByRole("button", { name: "Check again" })[0]);

    const sheet = screen.getByRole("dialog", { name: "Connect Claude Code" });
    expect(within(sheet).getByText("Sign in to Claude Code")).toBeTruthy();
    expect(
      within(sheet).getByRole("button", { name: "Open Claude Code to sign in" }),
    ).toBeTruthy();
  });

  /*
   * State 3, and the one the brief exists for. Codex exposes no per-agent
   * model, so a `Not chosen` dropdown here read as an unanswered question the
   * author should go and answer. There is nothing to answer.
   */
  /*
   * ANT-51. Codex reads its own custom agents and each may set its own model,
   * so it gets a real picker like Claude Code — the previous "Codex cannot
   * select a model per agent" was a fact about Anthill, not about Codex.
   */
  it("offers Codex its own models, from Codex's own catalogue", async () => {
    stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    const codex = (await screen.findByLabelText(
      "OpenAI Codex CLI model for this agent",
    )) as HTMLSelectElement;
    const offered = [...codex.options].map((option) => option.value);
    expect(offered).toContain("gpt-6-astra");
    // And never the other tool's vocabulary.
    expect(offered).not.toContain("opus");
  });

  /* A model retired since it was chosen. Kept and shown rather than dropped or
     silently replaced: it is the author's decision, and a picker that had reset
     itself to something else would be the worst of the three outcomes. */
  it("surfaces a stored model the tool no longer offers", async () => {
    stub([profile({ models: { codex: { id: "gpt-4-legacy" } } })]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    expect(await screen.findByText(/no longer offers/)).toBeTruthy();
    const codex = (await screen.findByLabelText(
      "OpenAI Codex CLI model for this agent",
    )) as HTMLSelectElement;
    // Still what the agent says, rather than quietly showing something else.
    expect(codex.value).toBe("gpt-4-legacy");
  });

  /* A list Anthill has not been given is not a list that is empty, and the
     card must not report Codex as offering no models on the strength of a
     missing file. */
  it("says the catalogue is missing rather than claiming there are no models", async () => {
    stub([profile()], [], bothConnected(), null);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    expect(
      await screen.findByText(
        /OpenAI Codex CLI is connected, but Anthill has not been given its model list/,
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("OpenAI Codex CLI model for this agent")).toBeNull();
  });

  /* Installed, and the CLI would not say. Not evidence of being signed out, so
     it must not become a sign-in notice — and the models it then offers are
     the ones this version supports, which is a different claim from what the
     account can run. */
  it("does not call a tool signed out because it would not answer", async () => {
    const quiet = bothConnected().map(({ signedIn: _drop, ...item }) => item);
    stub([profile()], [], quiet);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    expect(await screen.findByLabelText("Claude Code model for this agent")).toBeTruthy();
    expect(screen.queryByText("Signed out")).toBeNull();
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
  });
});

/**
 * Two tools, two vocabularies, and no leak between them.
 */
/**
 * One model, chosen once, carrying the tool it came from.
 */
describe("the agent's model", () => {
  it("stores the answer with the tool whose vocabulary it is in", async () => {
    const { held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.change(await screen.findByLabelText("Claude Code model for this agent"), {
      target: { value: "opus" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(held()[0].models).toEqual({ "claude-code": { id: "opus" } }));
  });

  /* Set on one agent, and only on that agent: the answer lives on the profile,
     not in screen state that every profile would then share. */
  it("keeps one agent's model off another agent", async () => {
    const { held } = stub([profile(), profile({ id: "agent-2", name: "Builder" })]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    fireEvent.change(await screen.findByLabelText("Claude Code model for this agent"), {
      target: { value: "opus" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held()[0].models).toEqual({ "claude-code": { id: "opus" } }));

    fireEvent.click(screen.getByText("Builder"));
    const picker = (await screen.findByLabelText("Claude Code model for this agent")) as HTMLSelectElement;
    expect(picker.value).toBe("__unset__");
  });

  /* Two answers, and changing one must leave the other alone — that is what
     "independent configuration per harness" has to mean to be worth having. */
  it("keeps the two tools' answers independent", async () => {
    const { held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.change(await screen.findByLabelText("Claude Code model for this agent"), {
      target: { value: "opus" },
    });
    fireEvent.change(screen.getByLabelText("OpenAI Codex CLI model for this agent"), {
      target: { value: "gpt-5.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(held()[0].models).toEqual({
        "claude-code": { id: "opus" },
        codex: { id: "gpt-5.5" },
      }),
    );
  });

  /* Codex has a reasoning effort where Claude Code has none, and the levels
     offered are the ones that model supports rather than a fixed list. */
  it("offers a reasoning effort for Codex, and none for Claude Code", async () => {
    const { held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.change(await screen.findByLabelText("OpenAI Codex CLI model for this agent"), {
      target: { value: "gpt-6-astra" },
    });
    const effort = screen.getByLabelText("OpenAI Codex CLI reasoning effort for this agent");
    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(held()[0].models).toEqual({
        codex: { id: "gpt-6-astra", reasoningEffort: "high" },
      }),
    );
    expect(
      screen.queryByLabelText("Claude Code reasoning effort for this agent"),
    ).toBeNull();
  });

  /* "Nobody has answered" and "answered: this tool's default" compile the same
     and are not the same fact, so both are sayable and they are not the same
     option. */
  it("tells not choosing apart from choosing the default", async () => {
    const { held } = stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    const picker = await screen.findByLabelText("Claude Code model for this agent");
    fireEvent.change(picker, { target: { value: "__default__" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(held()[0].models).toEqual({ "claude-code": { id: "__default__" } }),
    );

    fireEvent.change(picker, { target: { value: "__unset__" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held()[0]).not.toHaveProperty("models"));
  });

  it("shows back a stored answer it could not attribute, rather than guessing", async () => {
    stub([profile({ modelNeedsReview: "gpt-5" })]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    expect(screen.getByText(/belongs to no tool Anthill can name with certainty/)).toBeTruthy();
    expect(screen.getByText("gpt-5")).toBeTruthy();
  });
});

/**
 * ANT-51, and the honesty it turns on. A CLI too old for project-scoped custom
 * agents reads no per-agent model at all, so offering the choice without saying
 * so would have Anthill quietly discard the author's answer.
 */
describe("a Codex that cannot read custom agents", () => {
  async function withOldCodex() {
    const kept = stub([profile()], [], bothConnected(), codexCatalog("unsupported"));
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    await screen.findByLabelText("Claude Code model for this agent");
    return kept;
  }

  it("says the tool needs updating rather than reporting it broken", async () => {
    await withOldCodex();

    // Amber, not red: nothing is broken and there is a next step.
    expect(screen.getByText("Update needed")).toBeTruthy();
    expect(screen.getByText(/Update OpenAI Codex CLI to use custom agents/)).toBeTruthy();
  });

  /* The choice is still right, and becomes true the moment they update. */
  it("still offers Codex's models, and still saves the answer", async () => {
    const { held } = await withOldCodex();

    fireEvent.change(screen.getByLabelText("OpenAI Codex CLI model for this agent"), {
      target: { value: "gpt-5.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(held()[0].models).toEqual({ codex: { id: "gpt-5.5" } }));
  });

  /* A question that could not be answered is not a "no": warning on it would
     send people to update software that is already fine. */
  it("stays quiet when the CLI could not be asked", async () => {
    stub([profile()], [], bothConnected(), codexCatalog("unknown"));
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    expect(await screen.findByLabelText("Claude Code model for this agent")).toBeTruthy();
    expect(screen.queryByText("Update needed")).toBeNull();
  });
});

/**
 * The sentence the per-tool shape rests on, and the one nobody can infer from
 * the controls.
 */
describe("why there is an answer per tool", () => {
  it("says the tool you start is what decides", async () => {
    stub([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    expect(
      await screen.findByText(/You start the session yourself, so the tool you start decides/),
    ).toBeTruthy();
  });
});

describe("deleting an agent", () => {
  it("deletes one nothing points at, without ceremony", async () => {
    const { api, held } = stub([profile()], [workflow()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.agentsRemove).toHaveBeenCalledWith("agent-1"));
    expect(held()).toHaveLength(0);
  });

  it("names the workflows holding a copy, and asks again", async () => {
    const { api } = stub(
      [profile()],
      [workflow({ libraryAgentIds: ["agent-1"] }), workflow({ path: "/b", name: "Other" })],
    );
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));

    // The editor already names it, before anything is clicked.
    expect(screen.getByText("Nightly review")).toBeTruthy();
    // And states the relationship without claiming to know whether the copy
    // has drifted, because Anthill does not track that.
    expect(screen.getByText(/Each holds its own copy/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(api.agentsRemove).not.toHaveBeenCalled();
    // And says what deleting would actually cost — which is not "it breaks".
    expect(screen.getByText(/keep working/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    await waitFor(() => expect(api.agentsRemove).toHaveBeenCalledWith("agent-1"));
  });
});

/**
 * The author's model preferences, followed by the editor (ANT-135): hidden
 * models stay out of the pickers, a new agent starts with the starting
 * answers, and a tier writes one model into every tool it maps.
 */
describe("following the model preferences", () => {
  const preferences = {
    hidden: { "claude-code": ["haiku"] },
    defaults: { "claude-code": { id: "sonnet" } },
    tiers: {
      fast: { "claude-code": { id: "haiku" } },
      strong: { "claude-code": { id: "sonnet" }, codex: { id: "gpt-5.5", reasoningEffort: "high" } },
      deep: {},
    },
  };

  function withPreferences(initial: GlobalAgentProfile[]) {
    const stubbed = stub(initial);
    Object.assign(stubbed.api, { modelPreferencesRead: vi.fn(async () => preferences) });
    return stubbed;
  }

  const offered = (select: HTMLElement) =>
    [...(select as HTMLSelectElement).options].map((option) => option.value);

  it("leaves a hidden model out of the picker", async () => {
    withPreferences([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    const picker = await screen.findByLabelText("Claude Code model for this agent");
    await waitFor(() => expect(offered(picker)).not.toContain("haiku"));
    expect(offered(picker)).toContain("opus");
  });

  it("still shows a hidden model an agent already uses", async () => {
    withPreferences([profile({ models: { "claude-code": { id: "haiku" } } })]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    const picker = (await screen.findByLabelText("Claude Code model for this agent")) as HTMLSelectElement;
    await waitFor(() => expect(offered(picker)).toContain("haiku"));
    expect(picker.value).toBe("haiku");
  });

  it("starts a new agent with the starting answers", async () => {
    const { api } = withPreferences([]);
    await openAgents();
    await screen.findByText(/No agents of your own yet/);
    fireEvent.click(screen.getByRole("button", { name: "+ New agent" }));
    await waitFor(() =>
      expect(api.agentsCreate).toHaveBeenCalledWith({ name: "", models: { "claude-code": { id: "sonnet" } } }),
    );
  });

  it("writes a tier's model into every tool it maps, and reads the tier back", async () => {
    const { held } = withPreferences([profile()]);
    await openAgents();
    fireEvent.click(await screen.findByText("Reviewer"));
    const strong = await screen.findByRole("button", { name: "Strong" });
    await waitFor(() => expect((strong as HTMLButtonElement).disabled).toBe(false));
    // A tier nobody mapped cannot be pressed.
    expect((screen.getByRole("button", { name: "Deep reasoning" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(strong);
    expect(strong.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(held()[0].models).toEqual({
        "claude-code": { id: "sonnet" },
        codex: { id: "gpt-5.5", reasoningEffort: "high" },
      }),
    );

    // One slot changed by hand takes the agent off the tier.
    fireEvent.change(screen.getByLabelText("Claude Code model for this agent"), { target: { value: "opus" } });
    expect(strong.getAttribute("aria-pressed")).toBe("false");
  });
});
