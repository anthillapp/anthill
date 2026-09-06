import { describe, expect, it } from "vitest";

import {
  ACTION_CATEGORY_LABELS,
  ACTION_CATEGORY_ORDER,
  ACTION_KINDS,
  ACTION_LIBRARY,
  actionDefinition,
  isActionKind,
  paletteActions,
  type ActionCategory,
  type ActionVisibility,
} from "./actions.js";

const VALID_CATEGORIES: readonly ActionCategory[] = ["understand", "build", "verify", "deliver"];
const VALID_VISIBILITY: readonly ActionVisibility[] = ["palette", "library", "template"];
const VALID_SUGGESTED_FIELDS = new Set([
  "inputs",
  "expectedOutput",
  "successCriteria",
  "constraints",
  "handoff",
]);

/**
 * Ids that predate this catalog and are persisted on saved workflows already. A
 * rename here is a silent break for every workflow using them — see the
 * "id was renamed away" test below, which is the one this list exists to
 * support.
 */
const ORIGINAL_ELEVEN = [
  "llm-consult",
  "brainstorm",
  "clarify-requirements",
  "decompose",
  "agent-step",
  "check",
  "llm-review",
  "adversarial-review",
  "run-tests",
  "browser-check",
  "final-action",
] as const;

describe("action catalog integrity", () => {
  it("has 29 actions, one entry per kind, with no duplicate ids", () => {
    expect(ACTION_KINDS.length).toBe(29);
    expect(new Set(ACTION_KINDS).size).toBe(ACTION_KINDS.length);
    expect(Object.keys(ACTION_LIBRARY).length).toBe(ACTION_KINDS.length);
  });

  it("every entry's own kind matches the key it is stored under", () => {
    for (const [key, definition] of Object.entries(ACTION_LIBRARY)) {
      expect(definition.kind).toBe(key);
    }
  });

  it("every entry carries the full field set with the right shapes", () => {
    for (const definition of Object.values(ACTION_LIBRARY)) {
      expect(typeof definition.kind).toBe("string");
      expect(definition.kind.length).toBeGreaterThan(0);

      expect(typeof definition.label).toBe("string");
      expect(definition.label.length).toBeGreaterThan(0);

      expect(VALID_CATEGORIES).toContain(definition.category);

      expect(typeof definition.summary).toBe("string");
      expect(definition.summary.length).toBeGreaterThan(0);

      expect(typeof definition.defaultPurpose).toBe("string");
      expect(definition.defaultPurpose.length).toBeGreaterThan(0);

      expect(Array.isArray(definition.suggestedInputs)).toBe(true);
      expect(definition.suggestedInputs.length).toBeGreaterThan(0);

      expect(typeof definition.defaultExpectedOutput).toBe("string");
      expect(definition.defaultExpectedOutput.length).toBeGreaterThan(0);

      expect(Array.isArray(definition.defaultSuccessCriteria)).toBe(true);
      expect(definition.defaultSuccessCriteria.length).toBeGreaterThan(0);

      expect(Array.isArray(definition.typicalNextPaths)).toBe(true);
      expect(definition.typicalNextPaths.length).toBeGreaterThan(0);

      expect(typeof definition.producesDecision).toBe("boolean");
      if (definition.decisionValues !== undefined) {
        expect(Array.isArray(definition.decisionValues)).toBe(true);
        expect(definition.decisionValues.length).toBeGreaterThan(0);
      }

      expect(VALID_VISIBILITY).toContain(definition.mvpVisibility);

      expect(Array.isArray(definition.suggestedFields)).toBe(true);
      for (const field of definition.suggestedFields) {
        expect(VALID_SUGGESTED_FIELDS.has(field)).toBe(true);
      }
    }
  });

  it("every category is one of the four the palette groups by", () => {
    expect(ACTION_CATEGORY_ORDER).toEqual(["understand", "build", "verify", "deliver"]);
    expect(Object.keys(ACTION_CATEGORY_LABELS).sort()).toEqual([...VALID_CATEGORIES].sort());
    for (const definition of Object.values(ACTION_LIBRARY)) {
      expect(ACTION_CATEGORY_ORDER).toContain(definition.category);
    }
  });

  it("the palette is exactly the 12 actions the research names", () => {
    const palette = paletteActions();
    expect(palette).toHaveLength(12);
    expect(new Set(palette.map((item) => item.mvpVisibility))).toEqual(new Set(["palette"]));
    expect(palette.map((item) => item.kind).sort()).toEqual(
      [
        "clarify-requirements",
        "llm-consult",
        "decompose",
        "agent-step",
        "implement",
        "generate-artifact",
        "check",
        "llm-review",
        "adversarial-review",
        "run-tests",
        "browser-check",
        "final-action",
      ].sort(),
    );
  });

  it("every non-palette action is library-tier by default", () => {
    for (const definition of Object.values(ACTION_LIBRARY)) {
      if (definition.mvpVisibility === "palette") continue;
      expect(definition.mvpVisibility).toBe("library");
    }
  });

  it.each(ORIGINAL_ELEVEN)("original id %s still resolves to an action", (kind) => {
    expect(isActionKind(kind)).toBe(true);
    expect(actionDefinition(kind).kind).toBe(kind);
  });

  it("run-tests and final-action keep their pre-research labels", () => {
    expect(actionDefinition("run-tests").label).toBe("Run Tests");
    expect(actionDefinition("final-action").label).toBe("Final Action");
  });

  it("rejects an id that was never in the catalog", () => {
    expect(isActionKind("does-not-exist")).toBe(false);
    expect(isActionKind("run_tests")).toBe(false);
  });
});
