/**
 * A model per coding tool, and the migrations into that shape.
 *
 * Two properties carry it. A model name never crosses providers: whatever Codex
 * compiles with came from the Codex answer, whatever the Claude answer says.
 * And migrating a profile written in any earlier shape is deterministic and
 * never guesses — a bare name belonging to no tool Anthill can attribute is
 * handed back for a person to settle.
 */

import { describe, expect, it } from "vitest";

import {
  HARNESS_DEFAULT,
  configuredHarnesses,
  explicitModelFor,
  harnessOwningModel,
  isConfiguredFor,
  migrateModels,
  modelFor,
  readAgentModels,
  readModelChoice,
  reasoningEffortFor,
} from "./agent-models.js";
import { harnessProfile } from "./harness.js";

const CLAUDE = { "claude-code": { id: "opus" } } as const;

describe("a model per tool", () => {
  it("tells an unanswered question from an answer of 'inherit'", () => {
    expect(isConfiguredFor(undefined, "codex")).toBe(false);
    expect(isConfiguredFor({}, "codex")).toBe(false);
    // Both compile to a file with no model in it, and they are still not the
    // same fact: only one of them is a decision somebody made.
    expect(isConfiguredFor({ codex: { id: HARNESS_DEFAULT } }, "codex")).toBe(true);
    expect(explicitModelFor({ codex: { id: HARNESS_DEFAULT } }, "codex")).toBeUndefined();
  });

  it("keeps each tool's answer in its own vocabulary", () => {
    expect(explicitModelFor(CLAUDE, "claude-code")).toBe("opus");
    // The whole point of the split: Codex has no idea what opus is.
    expect(explicitModelFor(CLAUDE, "codex")).toBeUndefined();
    expect(modelFor(CLAUDE, "codex")).toBe(harnessProfile("codex").defaultModel);
  });

  it("lists the tools somebody has answered for", () => {
    expect(configuredHarnesses({ codex: { id: "gpt-5.5" } })).toEqual(["codex"]);
    expect(configuredHarnesses({ ...CLAUDE, codex: { id: "gpt-5.5" } })).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(configuredHarnesses(undefined)).toEqual([]);
  });

  it("offers a reasoning effort only where the tool has the concept", () => {
    const models = {
      codex: { id: "gpt-5.5", reasoningEffort: "high" },
      "claude-code": { id: "opus", reasoningEffort: "high" },
    };
    expect(reasoningEffortFor(models, "codex")).toBe("high");
    // Claude Code has no such setting, so an effort stored against it is not
    // reported as one — a file cannot carry a key its reader does not have.
    expect(reasoningEffortFor(models, "claude-code")).toBeUndefined();
  });

  it("treats an inherited effort as no effort, like an inherited model", () => {
    expect(
      reasoningEffortFor({ codex: { id: "gpt-5.5", reasoningEffort: HARNESS_DEFAULT } }, "codex"),
    ).toBeUndefined();
  });
});

describe("reading a stored answer", () => {
  it("keeps a model a declared list actually offers", () => {
    expect(readModelChoice("claude-code", { id: "opus" })).toEqual({ id: "opus" });
  });

  it("drops a model a declared list does not offer", () => {
    // Only reachable by hand-editing or by a tool retiring a model, and
    // "unanswered" is a state the UI can explain.
    expect(readModelChoice("claude-code", { id: "gpt-5.5" })).toBeUndefined();
  });

  /*
   * Codex's models are discovered on the machine, not declared here. A name
   * missing from an empty list means "this table does not know", never "that
   * model does not exist" — rejecting it would throw away the author's answer
   * on the strength of a list Anthill never had.
   */
  it("keeps a discovered tool's model without a list to check it against", () => {
    expect(readModelChoice("codex", { id: "gpt-6-astra" })).toEqual({ id: "gpt-6-astra" });
  });

  it("reads the earlier shape, a bare name per tool", () => {
    expect(readModelChoice("claude-code", "opus")).toEqual({ id: "opus" });
  });

  it("ignores an empty answer and anything that is not one", () => {
    expect(readModelChoice("codex", { id: "  " })).toBeUndefined();
    expect(readModelChoice("codex", null)).toBeUndefined();
    expect(readAgentModels({ "gemini-cli": { id: "pro" } })).toBeUndefined();
    expect(readAgentModels("opus")).toBeUndefined();
  });
});

describe("migrating a profile written in an earlier shape", () => {
  it("places a bare model name only one declared list offers", () => {
    expect(migrateModels("opus")).toEqual({ models: { "claude-code": { id: "opus" } } });
  });

  it("leaves nothing chosen as nothing chosen", () => {
    // Writing a default in here would turn every old profile into one that had
    // answered a question nobody asked it.
    expect(migrateModels(undefined)).toEqual({ models: {} });
    expect(migrateModels("   ")).toEqual({ models: {} });
  });

  it("hands back a bare name it cannot attribute, rather than guessing", () => {
    // Codex's list is discovered, so a name that is not Claude's cannot be
    // called Codex's by elimination — that would be exactly the provider guess
    // this refuses to make.
    expect(migrateModels("gpt-5.5")).toEqual({ models: {}, needsReview: "gpt-5.5" });
  });

  it("reads the pass that allowed one answer in total", () => {
    expect(migrateModels({ target: "codex", id: "gpt-5.5" })).toEqual({
      models: { codex: { id: "gpt-5.5" } },
    });
  });

  it("reads the first split, which had no reasoning effort", () => {
    expect(migrateModels({ "claude-code": "opus" })).toEqual({
      models: { "claude-code": { id: "opus" } },
    });
  });

  it("is the same answer on every machine, whatever is installed", () => {
    // Nothing in the migration reads the machine, so the same file in the same
    // repository cannot migrate differently on a colleague's computer.
    expect(migrateModels("sonnet")).toEqual(migrateModels("sonnet"));
  });

  it("names the owner of a name only when one declared list has it", () => {
    expect(harnessOwningModel("opus")).toBe("claude-code");
    // Codex declares nothing, so nothing is ever attributed to it this way.
    expect(harnessOwningModel("gpt-6-astra")).toBeUndefined();
    expect(harnessOwningModel("nonsense")).toBeUndefined();
  });
});
