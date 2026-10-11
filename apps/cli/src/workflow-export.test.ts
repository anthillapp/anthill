import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkflow, graphCssRules, renderWorkflowSvg } from "./workflow-export-entry.js";
import type { Workflow } from "@anthill/workflow-schema";

const fixture: Workflow = {
  id: "wf-export-1",
  name: "Export check",
  version: "1.0.0",
  nodes: [
    { id: "start", type: "start", name: "Start", config: {} },
    { id: "t", type: "agent", name: "Triage", config: { role: "Triage" } },
    { id: "end", type: "end", name: "End", config: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "t", kind: "next" },
    { id: "e2", source: "t", target: "end", kind: "stop" },
  ],
};

describe("graphCssRules", () => {
  it("keeps the rules that name a .live- class, top-level and inside @media", () => {
    const css = [
      ".other { color: red; }",
      ".live-node { fill: #fff; }",
      "@media (prefers-reduced-motion: no-preference) {",
      "  .live-node-body { transition: fill 200ms; }",
      "  .unrelated { color: blue; }",
      "}",
      ".live-edge.tone-live { stroke: green; }",
    ].join("\n");
    const rules = graphCssRules(css);
    expect(rules).toContain(".live-node { fill: #fff; }");
    expect(rules).toContain(".live-node-body { transition: fill 200ms; }");
    expect(rules).toContain(".live-edge.tone-live { stroke: green; }");
    expect(rules).not.toContain(".other");
    expect(rules).not.toContain(".unrelated");
  });
});

describe("renderWorkflowSvg", () => {
  it("renders a self-contained SVG: prolog, sized canvas, inlined styles, the blocks", () => {
    const svg = renderWorkflowSvg(fixture);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg).toContain("<svg");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/width="\d+" height="\d+"/);
    expect(svg).toContain("<style type=\"text/css\">");
    // (The rule content is covered by the graphCssRules test: vitest returns
    // an empty string for `?raw` CSS imports, so the inlined rules are
    // verified end-to-end by the live export check instead.)
    // The diagram carries the blocks' names.
    expect(svg).toContain("Triage");
    expect(svg).toContain("Start");
    // And closes as one document.
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });
});

describe("findWorkflow", () => {
  it("finds a workflow by id in the workflow folder, via the data dir's settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthill-export-"));
    try {
      const dataDir = join(dir, "cli");
      const folder = join(dir, "workflows");
      await mkdir(dataDir, { recursive: true });
      await mkdir(folder, { recursive: true });
      await writeFile(join(dataDir, "settings.json"), JSON.stringify({ version: 1, settings: { workflowFolder: folder } }));
      await writeFile(join(folder, "Export check.workflow.json"), JSON.stringify(fixture));

      const found = await findWorkflow("wf-export-1", { dataDir, home: dir });
      expect(found.workflow.name).toBe("Export check");
      expect(found.file).toBe(join(folder, "Export check.workflow.json"));

      await expect(findWorkflow("no-such-id", { dataDir, home: dir })).rejects.toThrow(/No workflow with id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
