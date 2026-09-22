/**
 * The `react-flow` subpath: the legacy xyflow surface, and the proof that
 * the main entry no longer carries it.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as main from "./index";
import { Canvas, WorkflowBuilder } from "./react-flow";

describe("the react-flow subpath", () => {
  it("exports the xyflow surface", () => {
    expect(typeof Canvas).toBe("function");
    expect(typeof WorkflowBuilder).toBe("function");
  });

  it("is no longer exported from the main entry", () => {
    const mainExports = main as Record<string, unknown>;
    expect(mainExports.Canvas).toBeUndefined();
    expect(mainExports.WorkflowBuilder).toBeUndefined();
  });

  it("leaves @xyflow/react out of the main entry's source", () => {
    // Vitest rewrites module URLs, so read the file relative to the package
    // cwd (vitest runs from the package root) rather than via import.meta.url.
    const source = readFileSync("src/index.ts", "utf8");
    expect(source).not.toContain("@xyflow");
  });
});
