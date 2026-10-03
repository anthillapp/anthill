import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExchangeStore } from "@anthill/exchange-store";
import { readExchangeView, writeWorkingCopy } from "@anthill/exchange-host";
import { WORKFLOW_FORMAT_VERSION } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";
import type { SaveWorkflowResult } from "../shared/ipc.js";
import { FileGrants } from "./safe-write.js";
import { DEFAULT_SETTINGS, workflowFolderPath } from "./settings.js";
import { workflowFilename } from "./workflow-filename.js";
import { WorkflowSaver, type ExternalSaveChoice } from "./workflow-save.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const workflow: Workflow = {
  id: "workflow-1", name: "Fix the crash", version: "1", target: "claude-code",
  brief: { goal: "Fix the crash", doneCriteria: ["Tests pass"] },
  nodes: [
    { id: "start", name: "Start", type: "start", config: {} },
    { id: "fix", name: "Fix", type: "agent", config: { actionKind: "implement", agentId: "dev", task: "Fix the crash", expectedOutput: "Patch", successCriteria: ["Tests pass"] } },
    { id: "end", name: "End", type: "end", config: {} },
  ],
  edges: [{ id: "a", source: "start", target: "fix" }, { id: "b", source: "fix", target: "end" }],
  metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION, agents: [{ id: "dev", name: "Developer", description: "Reads the code around the change, makes the smallest fix that holds, and hands back a diff with a test that fails without it.", models: { "claude-code": { id: "sonnet" } } }] } },
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "anthill-save-unit-")));
  roots.push(root);
  let folder = workflowFolderPath(DEFAULT_SETTINGS, root);
  const files = new FileGrants();
  const store = new ExchangeStore(join(root, "data"));
  let answer: ExternalSaveChoice = "copy";
  const asked: string[] = [];
  const ask = async (path: string) => { asked.push(path); return answer; };
  const options = { folder: async () => folder, files, exchange: () => store, ask, linksPath: join(root, "save-links.json") };
  const saver = new WorkflowSaver(options);
  return {
    root, files, store, saver, options, folder, asked,
    choose: (next: string) => { folder = next; },
    answer: (next: ExternalSaveChoice) => { answer = next; },
  };
}

function saved(result: SaveWorkflowResult): Extract<SaveWorkflowResult, { kind: "saved" }> {
  expect(result.kind, JSON.stringify(result)).toBe("saved");
  if (result.kind !== "saved") throw new Error("Save failed");
  return result;
}

async function handover(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.store.createWorkflow({ workflow, mode: "design", exchangeVersion: 1, idempotencyKey: "draft", source: { harness: "claude-code", sessionId: "source-1", taskText: "Fix the crash" } });
  expect(created.outcome, JSON.stringify(created)).toBe("created");
  const path = f.store.workingCopyPath(workflow.id);
  await writeWorkingCopy(path, workflow);
  await f.files.grant(path);
  return path;
}

async function external(f: Awaited<ReturnType<typeof fixture>>, contents = JSON.stringify(workflow)) {
  const path = join(f.root, "elsewhere", "imported.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  await f.files.grant(path);
  return path;
}

describe("desktop Save in the Settings folder", () => {
  it("creates the default folder and saves JSON under the title, embedded profiles intact", async () => {
    const f = await fixture();
    const result = saved(await f.saver.save({ workflow }));
    expect(result.path).toBe(join(f.folder, "Fix the crash.workflow.json"));
    expect(await readFile(result.path, "utf8")).toBe(`${JSON.stringify(workflow, null, 2)}\n`);
    expect(await f.files.has(result.path)).toBe(true);
  });

  it("keeps repeated saves in one file, including when reopened in a new process", async () => {
    const f = await fixture();
    const first = saved(await f.saver.save({ workflow }));
    const reopenedFiles = new FileGrants();
    await reopenedFiles.grant(first.path);
    const reopened = new WorkflowSaver({ ...f.options, files: reopenedFiles });
    const edited = { ...workflow, brief: { ...workflow.brief!, goal: "Fix and verify" } };
    expect(saved(await reopened.save({ workflow: edited, path: first.path })).path).toBe(first.path);
    expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual(edited);
  });

  it("keeps the filename when the workflow is renamed", async () => {
    const f = await fixture();
    const first = saved(await f.saver.save({ workflow }));
    const renamed = { ...workflow, name: "Renamed" };
    expect(saved(await f.saver.save({ workflow: renamed, path: first.path })).path).toBe(first.path);
    expect(JSON.parse(await readFile(first.path, "utf8")).name).toBe("Renamed");
    expect(await readdir(f.folder)).toEqual(["Fix the crash.workflow.json"]);
  });

  it("numbers same-titled workflows, even when their saves overlap", async () => {
    const f = await fixture();
    const [a, b, c] = (await Promise.all([
      f.saver.save({ workflow }),
      f.saver.save({ workflow: { ...workflow, id: "another" } }),
      f.saver.save({ workflow: { ...workflow, id: "third" } }),
    ])).map(saved);
    expect(basename(a.path)).toBe("Fix the crash.workflow.json");
    expect(basename(b.path)).toBe("Fix the crash 2.workflow.json");
    expect(basename(c.path)).toBe("Fix the crash 3.workflow.json");
    expect(JSON.parse(await readFile(a.path, "utf8")).id).toBe(workflow.id);
    expect(saved(await f.saver.save({ workflow: { ...workflow, id: "another" }, path: b.path })).path).toBe(b.path);
  });

  it("makes a deleted JSON again under its own name", async () => {
    const f = await fixture();
    const first = saved(await f.saver.save({ workflow: { ...workflow, name: "Renamed later" } }));
    await rm(first.path);
    expect(saved(await f.saver.save({ workflow, path: first.path })).path).toBe(first.path);
  });

  it("treats dangling symlinks as occupied names and never writes through them", async () => {
    const f = await fixture();
    await mkdir(f.folder, { recursive: true });
    const target = join(f.root, "do-not-create.json");
    await symlink(target, join(f.folder, "Fix the crash.workflow.json"));
    const result = saved(await f.saver.save({ workflow }));
    expect(basename(result.path)).toBe("Fix the crash 2.workflow.json");
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("ignores an ungranted renderer destination and refuses to replace a granted file changed to another workflow", async () => {
    const f = await fixture();
    const outside = join(f.root, "private.json");
    await writeFile(outside, "private");
    const first = saved(await f.saver.save({ workflow, path: outside }));
    expect(await readFile(outside, "utf8")).toBe("private");
    expect(f.asked).toEqual([]);
    await writeFile(first.path, JSON.stringify({ ...workflow, id: "other" }));
    expect(await f.saver.save({ workflow, path: first.path })).toMatchObject({ kind: "failed", error: expect.stringContaining("another workflow") });
    expect(JSON.parse(await readFile(first.path, "utf8")).id).toBe("other");
  });

  it("reports a folder failure and can save again after it is fixed", async () => {
    const f = await fixture();
    const blocked = join(f.root, "blocked");
    await writeFile(blocked, "keep me");
    f.choose(join(blocked, "workflows"));
    expect(await f.saver.save({ workflow })).toMatchObject({ kind: "failed" });
    expect(await readFile(blocked, "utf8")).toBe("keep me");
    f.choose(f.folder);
    saved(await f.saver.save({ workflow }));
  });

  it("does not let an unreadable link record stop a save", async () => {
    const f = await fixture();
    await writeFile(f.options.linksPath, "{ not json");
    const first = saved(await f.saver.save({ workflow }));
    expect(saved(await f.saver.save({ workflow, path: first.path })).path).toBe(first.path);
  });
});

describe("a workflow opened from outside the folder", () => {
  it("is overwritten in place when the author says so, and not asked about again", async () => {
    const f = await fixture();
    const path = await external(f);
    f.answer("overwrite");
    const edited = { ...workflow, name: "Edited" };
    expect(saved(await f.saver.save({ workflow: edited, path })).path).toBe(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(edited);
    expect(saved(await f.saver.save({ workflow, path })).path).toBe(path);
    expect(f.asked).toEqual([path]);
    await expect(readdir(f.folder)).resolves.toEqual([]);
  });

  it("is copied into the folder when the author says so, leaving the original intact", async () => {
    const f = await fixture();
    const path = await external(f);
    f.answer("copy");
    const edited = { ...workflow, name: "Imported edit" };
    const copy = saved(await f.saver.save({ workflow: edited, path }));
    expect(copy.path).toBe(join(f.folder, "Imported edit.workflow.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(workflow);
    expect(saved(await f.saver.save({ workflow: edited, path: copy.path })).path).toBe(copy.path);
    expect(f.asked).toEqual([path]);
  });

  it("writes nothing when the author cancels, and never asks for a save made on their behalf", async () => {
    const f = await fixture();
    const path = await external(f);
    f.answer("cancel");
    expect(await f.saver.save({ workflow: { ...workflow, name: "Edited" }, path })).toEqual({ kind: "cancelled" });
    expect(await f.saver.save({ workflow, path, quiet: true })).toEqual({ kind: "cancelled" });
    expect(f.asked).toEqual([path]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(workflow);
  });

  it("refuses to overwrite a file that now holds another workflow", async () => {
    const f = await fixture();
    const path = await external(f, JSON.stringify({ ...workflow, id: "other" }));
    f.answer("overwrite");
    expect(await f.saver.save({ workflow, path })).toMatchObject({ kind: "failed", error: expect.stringContaining("another workflow") });
  });

  it("goes into the folder without asking when the original is gone", async () => {
    const f = await fixture();
    const path = await external(f);
    await rm(path);
    expect(saved(await f.saver.save({ workflow, path })).path).toBe(join(f.folder, "Fix the crash.workflow.json"));
    expect(f.asked).toEqual([]);
  });

  it("includes a file left behind in a folder Settings no longer names", async () => {
    const f = await fixture();
    const first = saved(await f.saver.save({ workflow }));
    f.choose(join(f.root, "new folder"));
    f.answer("copy");
    const next = saved(await f.saver.save({ workflow, path: first.path }));
    expect(next.path).toBe(join(f.root, "new folder", "Fix the crash.workflow.json"));
    expect(f.asked).toEqual([first.path]);
    expect(await readFile(first.path, "utf8")).toBe(await readFile(next.path, "utf8"));
  });
});

describe("exchange saves exported into the Settings folder", () => {
  it("exports a handover as it opens, once, without recording a revision", async () => {
    const f = await fixture();
    const origin = await handover(f);
    const exported = await f.saver.exportHandover(origin, workflow);
    expect(exported).toBe(join(f.folder, "Fix the crash.workflow.json"));
    expect(JSON.parse(await readFile(exported, "utf8"))).toEqual(workflow);
    expect(await f.files.has(exported)).toBe(true);
    expect((await readExchangeView(f.store, origin, workflow.id))?.revision).toBe(1);
    expect(await f.saver.exportHandover(origin, workflow)).toBe(exported);
    expect(await f.saver.linkedExchangePath(exported, workflow.id)).toBe(origin);
    // Saved through the handover or through its JSON, it is the same file.
    const edited = { ...workflow, brief: { ...workflow.brief!, goal: "Fix and verify" } };
    expect(saved(await f.saver.save({ workflow: edited, path: origin })).path).toBe(exported);
    expect(saved(await f.saver.save({ workflow: edited, exchangePath: origin })).path).toBe(exported);
    expect(await readdir(f.folder)).toEqual(["Fix the crash.workflow.json"]);
  });

  it("refuses to export a handover it was not granted", async () => {
    const f = await fixture();
    const origin = await handover(f);
    const noGrants = new WorkflowSaver({ ...f.options, files: new FileGrants() });
    await expect(noGrants.exportHandover(origin, workflow)).rejects.toThrow();
  });

  it("retains revisions on repeated saves and after reopening either JSON or the original handover", async () => {
    const f = await fixture();
    const origin = await handover(f);
    const first = saved(await f.saver.save({ workflow: { ...workflow, name: "Edited" }, path: origin }));
    expect(first.exchangePath).toBe(origin);
    expect(first.path).toBe(join(f.folder, "Edited.workflow.json"));
    expect((await readExchangeView(f.store, origin, workflow.id))?.revision).toBe(2);
    expect((await f.store.readRevision(workflow.id, 1))?.workflow).toEqual(workflow);
    const reopenedFiles = new FileGrants();
    await reopenedFiles.grant(first.path);
    const reopened = new WorkflowSaver({ ...f.options, files: reopenedFiles });
    expect(await reopened.linkedExchangePath(first.path, workflow.id)).toBe(origin);
    const edited = { ...workflow, name: "Edited", brief: { ...workflow.brief!, goal: "Fix and verify" } };
    const second = saved(await reopened.save({ workflow: edited, path: first.path }));
    expect(second).toEqual(first);
    expect((await readExchangeView(f.store, origin, workflow.id))?.revision).toBe(3);
    expect(JSON.parse(await readFile(origin, "utf8"))).toEqual(edited);
    expect(saved(await reopened.save({ workflow: edited, path: origin })).path).toBe(first.path);
  });

  it("refuses a forged exchange grant and a configured folder inside immutable exchange records", async () => {
    const f = await fixture();
    const origin = await handover(f);
    const noGrants = new WorkflowSaver({ ...f.options, files: new FileGrants() });
    expect(await noGrants.save({ workflow, exchangePath: origin })).toMatchObject({ kind: "failed" });
    f.choose(join(f.store.root, "workflows", workflow.id, "revisions"));
    expect(await f.saver.save({ workflow, path: origin })).toMatchObject({ kind: "failed", error: expect.stringContaining("reserved") });
    expect((await f.store.readRevision(workflow.id, 1))?.workflow).toEqual(workflow);
  });

  it("leaves the previous JSON and revision intact when the exchange rejects an edit", async () => {
    const f = await fixture();
    const origin = await handover(f);
    const first = saved(await f.saver.save({ workflow, path: origin }));
    const contents = await readFile(first.path, "utf8");
    const failed = await f.saver.save({ workflow: { ...workflow, metadata: { workflow: { formatVersion: WORKFLOW_FORMAT_VERSION + 1, agents: [] } } }, path: first.path, exchangePath: origin });
    expect(failed.kind).toBe("failed");
    expect(await readFile(first.path, "utf8")).toBe(contents);
    expect((await readExchangeView(f.store, origin, workflow.id))?.revision).toBe(1);
  });
});

describe("safe readable filenames", () => {
  it("flattens separators, avoids hidden and Windows reserved names, and limits Unicode byte length", () => {
    expect(workflowFilename("../reports\\2026: draft?\u0000")).toBe("reports 2026 draft.workflow.json");
    expect(workflowFilename(" ... ")).toBe("workflow.workflow.json");
    expect(workflowFilename("CON")).toBe("_CON.workflow.json");
    expect(Buffer.byteLength(workflowFilename("😀".repeat(200)))).toBeLessThan(200);
  });
});
