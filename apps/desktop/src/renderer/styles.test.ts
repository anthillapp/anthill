/**
 * That the stylesheet's own vocabulary resolves.
 *
 * A `var()` naming a custom property nobody defines does not warn, does not
 * fail a build, and does not fall back to something sensible: the whole
 * declaration is thrown away. `border: 1px solid var(--line)` with no `--line`
 * is not a grey border or a black one — it is no border at all, because the
 * shorthand resets `border-style` to `none` on its way out.
 *
 * That is how the activity feed lost its card: every rule from the design was
 * present and correct, and three of the names in them — `--line`, `--muted`,
 * `--surface-2` — were never in this app's token block. The cards had no
 * border, no left state rule and no tint, and nothing anywhere said so.
 *
 * So the sheet is read as data and its names are checked against each other.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Vitest runs from the desktop package, so the sheet is found from there.
const css = readFileSync(resolve("src/renderer/styles.css"), "utf8");

describe("the design tokens", () => {
  it("defines every custom property the sheet depends on", () => {
    const defined = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
    // A `var()` carrying a fallback is a deliberate contract with the view —
    // `--assembly-delay` is set per element from the canvas — and it degrades
    // to the fallback rather than taking its declaration down. Only the bare
    // form is a dependency this sheet has to satisfy itself.
    const required = [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]);
    expect([...new Set(required)].filter((name) => !defined.has(name))).toEqual([]);
  });
});

/**
 * Two features in this app own agents: the workflow inspector's panel and the
 * launch window's library. They were designed years apart and landed on the
 * same words — `.agent-row`, `.agent-list`, `.agent-name`, `.agent-editor`,
 * `.agent-uses` — so an unscoped rule written for one silently restyles the
 * other, with the later definition winning every property they share.
 *
 * The launch window's rules carry a pane in front of them for exactly this
 * reason. The names stay the ones the design uses; the scope keeps them local.
 */
describe("the two agent surfaces", () => {
  const SHARED = ["agent-row", "agent-list", "agent-name", "agent-editor", "agent-uses"];
  const LAUNCH = css.indexOf("/* Launch: two libraries in one pane");

  it("has a launch section to scope", () => {
    expect(LAUNCH).toBeGreaterThan(0);
  });

  it("scopes the launch library's rules to a launch pane", () => {
    const loose: string[] = [];
    for (const match of css.matchAll(/(^|})([^{}@]+)\{/g)) {
      if (match.index === undefined || match.index < LAUNCH) continue;
      for (const selector of match[2].split(",")) {
        const text = selector.trim();
        // `(?![\w-])` so `.agent-row-text` is not read as `.agent-row`: the
        // suffixed names belong to the launch library alone and collide with
        // nothing.
        if (!SHARED.some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(text))) continue;
        if (/\.launch-(left|right)\b/.test(text)) continue;
        loose.push(text);
      }
    }
    expect(loose).toEqual([]);
  });
});

/**
 * Selectors naming elements nothing renders.
 *
 * The arrival animation never played for a release because its rule targeted
 * `.live-feed-row.is-new`, a class from a design that had already been deleted
 * — present, correct, and matching nothing. So the classes the agent library
 * actually renders are checked against the sheet that is supposed to style
 * them.
 */
describe("the agent library's classes", () => {
  const RENDERED = [
    "launch-list-head",
    "launch-tabs",
    "launch-tab",
    "launch-tab-count",
    "btn-new-agent",
    "agent-group-head",
    "agent-group-label",
    "agent-group-count",
    "agent-mark",
    "agent-row-text",
    "agent-row-top",
    "agent-needs-name",
    "agent-model",
    "agent-summary",
    "agent-usage",
    "agent-editor-head",
    "agent-save",
    "agent-leaving",
    "agent-models",
    "agent-model-field",
    "agent-model-none",
    "agent-models-intro",
    "agent-models-review",
    "tool-card",
    "tool-card-top",
    "tool-logo",
    "tool-name",
    "tool-badge",
    "tool-note",
    "tool-actions",
    "tool-connect",
    "tool-review",
    "connect-scrim",
    "connect-sheet",
    "connect-top",
    "connect-title",
    "connect-body",
    "connect-steps",
    "connect-step",
    "connect-note",
    "connect-actions",
    "agent-editor-body",
    "agent-editor-title",
    "agent-editor-actions",
    "agent-field",
    "agent-two-up",
    "agent-id",
    "used-tag",
    "section-rule",
  ];

  it("styles every class the components put on the page", () => {
    const missing = RENDERED.filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css));
    expect(missing).toEqual([]);
  });
});

/**
 * Red is spent, not spread.
 *
 * The token block states the rule in as many words: red means the plan
 * stopping for a person, and a problem. `button.link` is nonetheless accent-700
 * app-wide, so any list of ordinary links inherits the colour of a fault. Under
 * "Used by" — a list of the steps an agent is correctly assigned to — that read
 * as a validation error against a perfectly valid assignment (ANT-56).
 */
describe("the Used by links", () => {
  const rule = css.match(/\.agent-uses \.link \{([^}]*)\}/)?.[1] ?? "";

  it("are drawn in ink rather than the accent red", () => {
    expect(rule).toContain("color: var(--ink-2)");
    expect(rule).not.toContain("--accent");
  });

  it("keep an underline to stay recognisable as links", () => {
    expect(rule).toContain("text-decoration-color");
    expect(rule).not.toContain("text-decoration: none");
  });

  it("answer to the keyboard as well as the pointer", () => {
    expect(css).toMatch(/\.agent-uses \.link:hover,\s*\.agent-uses \.link:focus-visible \{/);
  });
});

/**
 * A recent row is a fixed width; the things in it are not.
 *
 * Each row carries a name, a path and — for a watched session — a chip holding
 * a state and a step, which is easily as wide as "Observation lost ·
 * Checkpoint, close and report". The chip's column does not shrink, so anything
 * to its left that refuses to wrap and refuses to clip paints straight through
 * it. The path was always clipped. The name was not, and overran into the chip.
 */
describe("the recent rows", () => {
  const rule = (name: string) => {
    // Two blocks define these classes, ~2000 lines apart; the later one wins on
    // the properties it sets. Reading the last is reading what actually applies.
    const all = [...css.matchAll(new RegExp(`\\.${name} \\{([^}]*)\\}`, "g"))];
    return all[all.length - 1]?.[1] ?? "";
  };

  it("clip the name so it cannot run under the session chip", () => {
    const name = rule("recent-name");
    expect(name).toContain("overflow: hidden");
    expect(name).toContain("text-overflow: ellipsis");
    expect(name).toContain("white-space: nowrap");
  });

  it("clip the path the same way, as they always did", () => {
    const path = rule("recent-path");
    expect(path).toContain("overflow: hidden");
    expect(path).toContain("text-overflow: ellipsis");
  });

  /** If this column could shrink, a long chip would squeeze itself instead. */
  it("keep the chip's column from being squeezed", () => {
    expect(rule("recent-right")).toContain("flex: none");
  });
});
