import { describe, expect, it } from "vitest";

import { HARNESS_DEFAULT } from "./agent-models.js";
import {
  DEFAULT_MODEL_PREFERENCES,
  applyTier,
  readModelPreferences,
  startingModels,
  tierOf,
  visibleModelIds,
  type ModelPreferences,
} from "./model-preferences.js";

const withCodex: ModelPreferences = {
  ...DEFAULT_MODEL_PREFERENCES,
  tiers: {
    ...DEFAULT_MODEL_PREFERENCES.tiers,
    strong: { "claude-code": { id: "sonnet" }, codex: { id: "gpt-5.5", reasoningEffort: "medium" } },
  },
};

describe("reading stored preferences", () => {
  it("gives the defaults for nothing, or for something that is not preferences", () => {
    expect(readModelPreferences(undefined)).toEqual(DEFAULT_MODEL_PREFERENCES);
    expect(readModelPreferences("nonsense")).toEqual(DEFAULT_MODEL_PREFERENCES);
  });

  it("keeps what is good and drops what is not, field by field", () => {
    const read = readModelPreferences({
      hidden: { codex: ["gpt-4.1", "gpt-4.1", " ", 7], nowhere: ["x"] },
      defaults: { "claude-code": { id: "opus" }, codex: { id: "" } },
      tiers: { fast: { "claude-code": { id: "not-a-claude-model" } } },
    });
    expect(read.hidden).toEqual({ codex: ["gpt-4.1"] });
    expect(read.defaults).toEqual({ "claude-code": { id: "opus" } });
    // Written, so taken as written — and a Claude Code name that does not
    // exist is not an answer, which leaves the tier empty rather than wrong.
    expect(read.tiers.fast).toEqual({});
    // Not written, so the default mapping stands.
    expect(read.tiers.deep).toEqual({ "claude-code": { id: "opus" } });
  });
});

describe("what a picker offers", () => {
  const prefs: ModelPreferences = { ...DEFAULT_MODEL_PREFERENCES, hidden: { codex: ["gpt-4.1", "o3"] } };

  it("leaves the hidden ones out", () => {
    expect(visibleModelIds(["gpt-5.5", "gpt-4.1", "o3"], "codex", prefs)).toEqual(["gpt-5.5"]);
  });

  it("still shows a hidden model the agent already has", () => {
    expect(visibleModelIds(["gpt-5.5", "gpt-4.1", "o3"], "codex", prefs, "o3")).toEqual(["gpt-5.5", "o3"]);
  });

  it("hides nothing for a tool nobody curated", () => {
    expect(visibleModelIds(["opus", "sonnet"], "claude-code", prefs)).toEqual(["opus", "sonnet"]);
  });
});

describe("tiers", () => {
  it("answer for every tool the tier maps, in one go", () => {
    expect(applyTier(undefined, "strong", withCodex)).toEqual({
      "claude-code": { id: "sonnet" },
      codex: { id: "gpt-5.5", reasoningEffort: "medium" },
    });
  });

  it("leave a tool the tier says nothing about as it was", () => {
    const models = { pi: { id: "some/pi-model" }, "claude-code": { id: "haiku" } };
    expect(applyTier(models, "strong", withCodex)).toEqual({
      pi: { id: "some/pi-model" },
      "claude-code": { id: "sonnet" },
      codex: { id: "gpt-5.5", reasoningEffort: "medium" },
    });
  });

  it("are read back from what the agent holds, not stored", () => {
    const applied = applyTier(undefined, "strong", withCodex);
    expect(tierOf(applied, withCodex)).toBe("strong");
    // One tool changed by hand, and the agent is no longer on the tier.
    expect(tierOf({ ...applied, codex: { id: "gpt-5.5", reasoningEffort: "high" } }, withCodex)).toBeUndefined();
    expect(tierOf(undefined, withCodex)).toBeUndefined();
  });

  it("never claim an agent for a tier that maps nothing", () => {
    const empty: ModelPreferences = { ...DEFAULT_MODEL_PREFERENCES, tiers: { fast: {}, strong: {}, deep: {} } };
    expect(tierOf({ "claude-code": { id: HARNESS_DEFAULT } }, empty)).toBeUndefined();
  });
});

describe("a new agent's starting answer", () => {
  it("is nothing until the author gives one", () => {
    expect(startingModels(DEFAULT_MODEL_PREFERENCES)).toBeUndefined();
  });

  it("is the author's starting answer per tool", () => {
    const prefs = { ...DEFAULT_MODEL_PREFERENCES, defaults: { "claude-code": { id: "sonnet" } } };
    expect(startingModels(prefs)).toEqual({ "claude-code": { id: "sonnet" } });
  });
});
