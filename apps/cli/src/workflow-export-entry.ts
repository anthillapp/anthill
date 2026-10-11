import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveWorkflowGraph } from "../../desktop/src/renderer/live/LiveWorkflowGraph.js";
import { buildCanvasModel, withDisplayLayout } from "@anthill/builder";
import graphStyles from "../../desktop/src/renderer/styles.css?raw";
import type { Workflow } from "@anthill/workflow-schema";
import type { LiveSessionView } from "@anthill/live";

/**
 * The `workflow export` entry — bundled by vite (like `web-bridge.ts`),
 * imported by `cli.ts` at the point of use.
 *
 * What it produces: the workflow's execution flow **as the app draws it** —
 * the same `<svg>` the live session renders (`LiveWorkflowGraph`, laid out
 * by the same `buildCanvasModel`), serialized to a self-contained file.
 * No new layout code, no second renderer: the diagram is laid out exactly
 * as drawn.
 *
 * What the export shows: the workflow as drawn, in its neutral state
 * (`sessionState: "idle"`, an empty view) — the flow, not a moment of a run.
 *
 * Self-containment: the component styles its blocks and edges by class
 * (`.live-node`, `.live-edge …`), and those rules live in the app's
 * stylesheet. The export inlines the graph's rules as a `<style>` element
 * inside the SVG and gives the canvas explicit `width`/`height` from the
 * layout's extent, so the file renders in a browser, Inkscape or
 * `rsvg-convert` with no app around it.
 */

/** The one view a drawn-but-unobserved workflow has: nothing recorded. */
const NEUTRAL_VIEW: LiveSessionView = {
  blocks: {},
  activeBlockIds: [],
  spans: [],
  detours: [],
  overlaps: [],
  events: [],
  unmappedCount: 0,
  empty: true,
};

const XML_PROLOG = `<?xml version="1.0" encoding="UTF-8"?>\n`;

/**
 * The graph's share of the app stylesheet: every rule whose selector names a
 * `.live-…` class — top-level, and inside `@media` blocks. Nothing else is
 * inlined: the file carries its diagram's styles and no more.
 */
export function graphCssRules(css: string): string {
  const kept: string[] = [];
  const keep = (unit: string): void => {
    const brace = unit.indexOf("{");
    if (brace === -1) return;
    const selector = unit.slice(0, brace).trim();
    if (selector.includes(".live-")) kept.push(unit.trim());
  };
  const scan = (text: string): void => {
    let depth = 0;
    let unitStart = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]!;
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const unit = text.slice(unitStart, i + 1);
          keep(unit);
          // A unit's body may hold rules of its own (`@media`).
          const body = unit.slice(unit.indexOf("{") + 1, unit.lastIndexOf("}"));
          if (unit.trim().startsWith("@")) scan(body);
          unitStart = i + 1;
        }
      }
    }
  };
  scan(css);
  return kept.join("\n");
}

/**
 * The canvas the layout occupies: the blocks' extent, with a margin for the
 * edges and labels that run past it. The blocks get their places the same
 * way the component gives them (`withDisplayLayout`), so a workflow with no
 * stored positions measures where it will actually be drawn.
 */
function canvasSize(workflow: Workflow): { width: number; height: number } {
  const model = buildCanvasModel(withDisplayLayout(workflow, new Map()));
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of model.rects.values()) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.w);
    bottom = Math.max(bottom, rect.top + rect.h);
  }
  const MARGIN = 40;
  if (!Number.isFinite(left)) return { width: 800, height: 600 };
  return {
    width: Math.ceil(right - left + MARGIN * 2),
    height: Math.ceil(bottom - top + MARGIN * 2),
  };
}

/**
 * Render the workflow's diagram to a self-contained SVG document.
 *
 * The component wraps its `<svg>` in a div with the zoom controls; only the
 * `<svg>` goes in the file. The graph's CSS rules are inlined as a
 * `<style>` right after the opening tag, and the canvas gets explicit
 * `width`/`height` (the component leaves sizing to its container's CSS,
 * which a standalone file has none of).
 */
export function renderWorkflowSvg(workflow: Workflow): string {
  const markup = renderToStaticMarkup(
    createElement(LiveWorkflowGraph, {
      workflow,
      view: NEUTRAL_VIEW,
      sessionState: "idle",
      onSelect: () => {},
    }),
  );
  const open = markup.indexOf("<svg");
  const close = markup.lastIndexOf("</svg>");
  if (open === -1 || close === -1) throw new Error("The diagram did not render an <svg> element.");
  let svg = markup.slice(open, close + "</svg>".length);

  // The component's <svg> carries no size of its own; give the file one.
  const { width, height } = canvasSize(workflow);
  svg = svg.replace("<svg", `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"`);

  // Inline the graph's styles, so the file needs no stylesheet around it.
  // The rules are XML-escaped: a CSS comment may carry a literal `<g>`,
  // which is fine in a browser stylesheet and fatal in an XML document.
  const rules = graphCssRules(graphStyles)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  svg = svg.replace(/(<svg[^>]*>)/, `$1\n  <style type="text/css">\n${rules}\n  </style>`);

  // The block labels are HTML inside <foreignObject>. In the app's DOM that
  // needs no namespace; in a standalone XML document it must declare the
  // XHTML namespace, or a renderer drops the label and leaves an empty box.
  svg = svg.replace(/<foreignObject /g, '<foreignObject xmlns="http://www.w3.org/1999/xhtml" ');

  return XML_PROLOG + svg + "\n";
}

/**
 * Where desktop Save keeps workflow JSON: the one chosen in settings, or
 * `~/Documents/Anthill`. Mirrors `workflowFolderPath` in the desktop's
 * `settings.ts` (the CLI cannot import the store, only the rule).
 */
function workflowFolder(settingsJson: string | null, home: string): string {
  if (settingsJson) {
    try {
      const stored = JSON.parse(settingsJson) as { settings?: { workflowFolder?: string } };
      const folder = stored.settings?.workflowFolder;
      if (folder && isAbsolute(folder)) return folder;
    } catch {
      /* a damaged settings file falls back to the default, like the app */
    }
  }
  return join(home, "Documents", "Anthill");
}

/**
 * Find one workflow by id: the workflow folder's `*.workflow.json` files,
 * matched on the `id` inside.
 */
export async function findWorkflow(
  id: string,
  opts: { dataDir: string; home: string },
): Promise<{ workflow: Workflow; file: string }> {
  const folder = workflowFolder(await readSettings(opts.dataDir), opts.home);
  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch {
    throw new Error(`No workflow folder at ${folder} — save a workflow first, or check the workflow folder in Settings.`);
  }
  for (const name of entries.sort()) {
    if (!name.endsWith(".workflow.json")) continue;
    const file = join(folder, name);
    try {
      const workflow = JSON.parse(await readFile(file, "utf8")) as Workflow;
      if (workflow.id === id) return { workflow, file };
    } catch {
      /* a file that cannot be read is not the one asked for */
    }
  }
  throw new Error(`No workflow with id "${id}" in ${folder}.`);
}

async function readSettings(dataDir: string): Promise<string | null> {
  try {
    return await readFile(join(dataDir, "settings.json"), "utf8");
  } catch {
    return null;
  }
}

/**
 * `anthill workflow export <id> --format svg [--out <path>]` — write the
 * workflow's diagram to `<name>.ahl.svg` (or `--out`), and say where.
 */
export async function exportWorkflowSvg(args: {
  id: string;
  format: string;
  out?: string;
  dataDir?: string;
}): Promise<string> {
  if (args.format !== "svg") {
    throw new Error(`--format ${args.format} is not supported; the export is vector (svg).`);
  }
  const home = homedir();
  const dataDir = args.dataDir ? resolve(args.dataDir) : join(home, ".anthill", "cli");
  const { workflow, file } = await findWorkflow(args.id, { dataDir, home });
  const base = file.replace(/\.workflow\.json$/, "");
  const out = args.out ? resolve(args.out) : `${base}.ahl.svg`;
  await writeFile(out, renderWorkflowSvg(workflow), "utf8");
  return out;
}
