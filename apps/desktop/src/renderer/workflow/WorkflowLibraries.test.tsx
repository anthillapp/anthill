/**
 * The rail's "Blocks" tab count used to be a hardcoded `14 + custom.length`
 * (see the block-library work) — a number that quietly went stale the moment
 * the action catalog grew past 11 entries. These tests exist so a regression
 * back to a constant fails immediately instead of silently under-counting.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ACTION_LIBRARY } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";

import { WorkflowLibraries } from "./WorkflowLibraries.js";

const workflow: Workflow = {
  id: "p",
  name: "P",
  version: "1",
  target: "claude-code",
  nodes: [],
  edges: [],
  metadata: { workflow: { formatVersion: 4, agents: [] } },
};

/** Every action plus the four controls (Start, Approval Gate, Condition, End). */
const CATALOG_BLOCK_COUNT = Object.keys(ACTION_LIBRARY).length + 4;

function renderRail(custom: { label: string; summary: string }[]) {
  render(
    <WorkflowLibraries
      workflow={workflow}
      onChange={() => undefined}
      tab="blocks"
      onTabChange={() => undefined}
      custom={custom}
      onAddCustom={() => undefined}
      onAddBlock={() => undefined}
      onSelectAgent={() => undefined}
    />,
  );
}

describe("the Blocks tab count", () => {
  it("matches the catalog size, not a hardcoded constant", () => {
    renderRail([]);
    const tab = screen.getByRole("tab", { name: /Blocks/ });
    expect(tab.textContent).toBe(`Blocks${CATALOG_BLOCK_COUNT}`);
  });

  it("grows with custom blocks instead of staying fixed", () => {
    renderRail([
      { label: "One", summary: "First" },
      { label: "Two", summary: "Second" },
    ]);
    const tab = screen.getByRole("tab", { name: /Blocks/ });
    expect(tab.textContent).toBe(`Blocks${CATALOG_BLOCK_COUNT + 2}`);
  });
});
