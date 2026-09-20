import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_TEMPLATES } from "@anthill/workflow";
import { createBridge, type Bridge } from "./bridge.js";

vi.mock("../../desktop/src/main/user-path.js", () => ({ adoptUserPath: async () => false }));

const fixtures: { bridge: Bridge; root: string }[] = [];
afterEach(async () => {
  for (const { bridge, root } of fixtures.splice(0)) {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anthill-bridge-"));
  const workspace = join(root, "workspace");
  const userData = join(root, "data");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  const bridge = await createBridge({ paths: { userData, home: root }, workspace, broadcast: () => undefined, onMessage: () => undefined });
  fixtures.push({ bridge, root });
  return { bridge, workspace, userData, outside };
}

describe("privileged CLI bridge boundaries", () => {
  it("exposes history reads but not runner controls, without initializing history at startup", async () => {
    const { bridge, userData } = await fixture();
    const { channels } = await bridge.capabilities();
    expect(channels).toContain("run:get");
    expect(channels).toContain("run:list");
    for (const name of ["run:start", "run:cancel", "approval:respond"]) expect(channels).not.toContain(name);
    expect(await readdir(userData).catch(() => [])).not.toContain("runs");
    expect(await bridge.api.getRun("absent")).toBeUndefined();
    expect(await readdir(userData).catch(() => [])).not.toContain("runs");
  });

  /**
   * A store that will not open is the same fact, from the page's side, as no
   * store at all. It used to be a rejection instead, and `LiveSessionPage`
   * asks for the snapshot before falling back to the open workflow — so a
   * corrupt `runs.db`, or a native binding this build cannot load, replaced
   * every manually pasted Live Session with an error and a Retry that re-ran
   * the same failing open.
   */
  it("answers like an absent store when the legacy one cannot be opened", async () => {
    const { bridge, userData } = await fixture();
    await mkdir(join(userData, "runs"), { recursive: true });
    await writeFile(join(userData, "runs", "runs.db"), "not a database, not even close", "utf8");

    expect(await bridge.api.getRun("whatever")).toBeUndefined();
    expect(await bridge.api.listRuns()).toEqual([]);
  });

  it("rejects arbitrary roots and symlink escapes without writing outside the workspace", async () => {
    const { bridge, workspace, outside } = await fixture();
    const files = [{ path: "file.md", content: "generated" }];
    expect(await bridge.api.exportWorkflow({ root: outside, files })).toMatchObject({ ok: false });
    await symlink(outside, join(workspace, "link"), "dir");
    expect(await bridge.api.exportWorkflow({ root: workspace, files: [{ path: "link/new/file.md", content: "generated" }] })).toMatchObject({ ok: false });
    expect(await readdir(outside)).toEqual([]);
  });

  it("exports all files, and leaves originals intact on a later invalid destination", async () => {
    const { bridge, workspace } = await fixture();
    expect(await bridge.api.exportWorkflow({ files: [{ path: "a.md", content: "original" }], prompt: "prompt" })).toMatchObject({ ok: true });
    await mkdir(join(workspace, "blocked.md"));
    expect(await bridge.api.exportWorkflow({ files: [{ path: "a.md", content: "new" }, { path: "blocked.md", content: "new" }] })).toMatchObject({ ok: false });
    expect(await readFile(join(workspace, "a.md"), "utf8")).toBe("original");
    expect(await readFile(join(workspace, "anthill-prompt.md"), "utf8")).toBe("prompt");
  });

  it("does not open or overwrite an ungranted renderer-supplied path", async () => {
    const { bridge, outside } = await fixture();
    const workflow = WORKFLOW_TEMPLATES[0].build();
    const path = join(outside, "private.workflow.json");
    const original = JSON.stringify(workflow);
    await writeFile(path, original);
    expect(await bridge.api.openWorkflow(path)).toMatchObject({ ok: false });
    expect(await bridge.api.saveWorkflow({ path, workflow })).toMatchObject({ kind: "failed" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("round-trips unknown workflow fields through open and save", async () => {
    const { bridge, workspace } = await fixture();
    const workflow = WORKFLOW_TEMPLATES[0].build();
    const path = join(workspace, "roundtrip.workflow.json");
    const source = { ...workflow, futureDocumentField: { value: 1 }, nodes: workflow.nodes.map((node) => ({ ...node, futureNodeField: "keep" })) };
    await writeFile(path, JSON.stringify(source));
    const opened = await bridge.api.openWorkflow(path);
    if (!opened.ok) throw new Error("fixture did not open");
    expect(await bridge.api.saveWorkflow({ path, workflow: opened.opened.workflow })).toMatchObject({ kind: "saved" });
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.futureDocumentField).toEqual({ value: 1 });
    expect(saved.nodes.every((node: Record<string, unknown>) => node.futureNodeField === "keep")).toBe(true);
  });
});
