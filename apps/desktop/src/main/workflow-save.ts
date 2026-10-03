import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ExchangeStore } from "@anthill/exchange-store";
import type { Workflow } from "@anthill/workflow-schema";
import { exchangeDestination, saveExchangeCopy } from "@anthill/exchange-host";
import type { SaveWorkflowRequest, SaveWorkflowResult } from "../shared/ipc.js";
import { destinationInside, FileGrants, writeAllOrNothing } from "./safe-write.js";
import { workflowFilename } from "./workflow-filename.js";

type SaveLink = { workflowId: string; exchangePath: string };

/** What to do with a workflow file that lives outside the workflow folder. */
export type ExternalSaveChoice = "overwrite" | "copy" | "cancel";

/** Where one save goes, and what the file there must still hold. */
type Target = { folder: string; path: string; createOnly: boolean; expectedContents?: string };

const SUFFIX = ".workflow.json";

/**
 * Desktop Save owns its destination; a renderer can only reuse a granted file.
 *
 * A workflow's JSON lives in the workflow folder from Settings under a name
 * taken from its title when the file was made. The file keeps that name: a
 * later rename changes the title inside it, not the filename. A same-titled
 * workflow gets " 2", " 3" and so on. A file opened from anywhere else is
 * the author's to decide about on its first save: overwrite it there, or
 * save a copy into the folder.
 */
export class WorkflowSaver {
  private queue: Promise<unknown> = Promise.resolve();
  private links?: Record<string, SaveLink>;
  private loadingLinks?: Promise<Record<string, SaveLink>>;
  /** Files outside the folder the author chose to keep overwriting, this session. */
  private readonly overwriting = new Set<string>();

  constructor(private readonly options: {
    folder: () => Promise<string>;
    files: FileGrants;
    exchange: () => ExchangeStore;
    /** Asked on the first save of a file outside the workflow folder. */
    ask?: (path: string) => Promise<ExternalSaveChoice>;
    /** Local app data, never embedded into the workflow JSON. */
    linksPath?: string;
  }) {}

  save(request: SaveWorkflowRequest): Promise<SaveWorkflowResult> {
    return this.queued(() => this.write(request)).catch((error): SaveWorkflowResult => ({
      kind: "failed", error: error instanceof Error ? error.message : String(error),
    }));
  }

  /**
   * The JSON for a handover, in the workflow folder from the moment it opens.
   *
   * An export made before is reused. A new one is written from the workflow
   * as opened and records no exchange revision: opening is not an edit.
   */
  exportHandover(exchangePath: string, workflow: Workflow): Promise<string> {
    return this.queued(async () => {
      const store = this.options.exchange();
      if (!await this.options.files.has(exchangePath) || !await exchangeDestination(store, exchangePath, workflow.id)) {
        throw new Error("Open the handed-over workflow before exporting it.");
      }
      const folder = await this.managedFolder();
      const existing = await this.exportOf(exchangePath, workflow.id, folder);
      if (existing) return existing;
      const path = await this.freePath(folder, workflow.name);
      await this.commit({ folder, path, createOnly: true }, workflow, { exchangePath, recordRevision: false });
      return path;
    });
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async readLinks(): Promise<Record<string, SaveLink>> {
    if (this.links) return this.links;
    this.loadingLinks ??= this.loadLinks().then((links) => (this.links = links));
    return this.loadingLinks;
  }

  /** A record Anthill cannot read costs the handover context, never a save. */
  private async loadLinks(): Promise<Record<string, SaveLink>> {
    if (!this.options.linksPath) return {};
    try {
      const value: unknown = JSON.parse(await readFile(this.options.linksPath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, SaveLink] => {
        const link = entry[1];
        return link && typeof link === "object" && typeof link.workflowId === "string" && typeof link.exchangePath === "string";
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[anthill] saved workflow links unreadable, starting afresh:", error);
      }
      return {};
    }
  }

  /** Restore handover context when an exported JSON is reopened after restart. */
  async linkedExchangePath(path: string, workflowId: string): Promise<string | undefined> {
    if (!await this.options.files.has(path)) return undefined;
    const link = (await this.readLinks())[await canonical(path)];
    if (!link || link.workflowId !== workflowId) return undefined;
    if (!await exchangeDestination(this.options.exchange(), link.exchangePath, workflowId)) {
      throw new Error("The saved workflow's exchange link is invalid.");
    }
    await this.options.files.grant(link.exchangePath);
    return link.exchangePath;
  }

  private async rememberLink(path: string, link: SaveLink): Promise<void> {
    const kept: Record<string, SaveLink> = {};
    // Exports that are gone are dropped, so the record does not grow forever.
    for (const [savedPath, saved] of Object.entries(await this.readLinks())) {
      if (savedPath !== path && await exists(savedPath)) kept[savedPath] = saved;
    }
    const next = { ...kept, [path]: link };
    if (this.options.linksPath) {
      await mkdir(dirname(this.options.linksPath), { recursive: true });
      const temp = `${this.options.linksPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await rename(temp, this.options.linksPath);
      } finally {
        await rm(temp, { force: true });
      }
    }
    this.links = next;
  }

  private async managedFolder(): Promise<string> {
    const wanted = await this.options.folder();
    await mkdir(wanted, { recursive: true });
    return realpath(wanted);
  }

  /** The export already made for this handover in the folder, if it is still there. */
  private async exportOf(exchangePath: string, workflowId: string, folder: string): Promise<string | undefined> {
    const found = Object.entries(await this.readLinks()).reverse().find(([path, link]) =>
      link.workflowId === workflowId && link.exchangePath === exchangePath && dirname(path) === folder);
    if (!found || !await exists(found[0])) return undefined;
    await this.options.files.grant(found[0]);
    return found[0];
  }

  /** `<title>.workflow.json`, or `<title> 2.workflow.json` and on when taken. */
  private async freePath(folder: string, name: string): Promise<string> {
    const stem = workflowFilename(name).slice(0, -SUFFIX.length);
    for (let number = 1; ; number += 1) {
      const candidate = join(folder, `${stem}${number === 1 ? "" : ` ${number}`}${SUFFIX}`);
      if (!await exists(candidate)) return candidate;
    }
  }

  private async write(request: SaveWorkflowRequest): Promise<SaveWorkflowResult> {
    const { files } = this.options;
    const store = this.options.exchange();
    const { workflow } = request;
    let previous = request.path && await files.has(request.path) ? request.path : undefined;
    // The exported JSON and the exchange working copy have different jobs.
    // Retain the original grant so later saves still record revisions.
    let exchangePath = request.exchangePath ?? (previous ? await this.linkedExchangePath(previous, workflow.id) : undefined);
    if (exchangePath && (!await files.has(exchangePath) ||
        !await exchangeDestination(store, exchangePath, workflow.id))) {
      throw new Error("Open the handed-over workflow before saving its exchange revision.");
    }
    const folder = await this.managedFolder();
    if (previous && await exchangeDestination(store, previous, workflow.id)) exchangePath = previous;
    if (exchangePath && (!previous || previous === exchangePath)) {
      // Saving through the original handover updates its export rather than
      // minting another JSON every time it is opened again.
      previous = await this.exportOf(exchangePath, workflow.id, folder);
    }

    const target = previous ? await this.targetFor(previous, folder, request) : undefined;
    if (target === "cancelled") return { kind: "cancelled" };
    const where = target ?? { folder, path: await this.freePath(folder, workflow.name), createOnly: true };
    const path = await this.commit(where, workflow, exchangePath ? { exchangePath, recordRevision: true } : undefined);
    return { kind: "saved", path, ...(exchangePath ? { exchangePath } : {}) };
  }

  /**
   * Where a save of an already-saved workflow goes: back into its file when
   * that is in the workflow folder or the author said so, otherwise a new
   * file in the folder (undefined).
   */
  private async targetFor(previous: string, folder: string, request: SaveWorkflowRequest): Promise<Target | "cancelled" | undefined> {
    const directory = await realpath(dirname(previous));
    const path = join(directory, basename(previous));
    const contents = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (directory === folder) {
      // Deleted from under us: made again under the same name if it is free.
      if (contents === undefined) return await exists(path) ? undefined : { folder, path, createOnly: true };
      sameWorkflow(contents, request.workflow.id);
      return { folder, path, createOnly: false, expectedContents: contents };
    }
    // Nothing left to overwrite outside the folder: the save goes into it.
    if (contents === undefined) return undefined;
    let choice: ExternalSaveChoice = this.overwriting.has(path) ? "overwrite" : "copy";
    if (choice !== "overwrite") {
      // A save made on the author's behalf cannot ask, so it is not made.
      if (request.quiet) return "cancelled";
      choice = await this.options.ask?.(path) ?? "copy";
    }
    if (choice === "cancel") return "cancelled";
    if (choice === "copy") return undefined;
    sameWorkflow(contents, request.workflow.id);
    this.overwriting.add(path);
    return { folder: directory, path, createOnly: false, expectedContents: contents };
  }

  private async commit(
    target: Target,
    workflow: Workflow,
    exchange?: { exchangePath: string; recordRevision: boolean },
  ): Promise<string> {
    const store = this.options.exchange();
    // Resolve the folder before checking the exchange's reserved paths.
    const safe = await destinationInside(target.folder, basename(target.path));
    if (!safe.ok) throw new Error(safe.reason);
    if (await exchangeDestination(store, safe.path, workflow.id)) {
      throw new Error("Choose a workflow folder outside the exchange records in Settings.");
    }
    const written = await writeAllOrNothing([{
      path: safe.path, relative: basename(safe.path), createOnly: target.createOnly,
      content: `${JSON.stringify(workflow, null, 2)}\n`,
    }], async () => {
      if (!target.createOnly) {
        const current = await destinationInside(target.folder, basename(safe.path));
        if (!current.ok) throw new Error(current.reason);
        if (current.path !== safe.path || await readFile(safe.path, "utf8") !== target.expectedContents) {
          throw new Error("The saved JSON changed while saving. It was not replaced. Open it again before saving.");
        }
      }
      if (exchange) {
        if (exchange.recordRevision) await saveExchangeCopy(store, exchange.exchangePath, workflow);
        await this.rememberLink(safe.path, { workflowId: workflow.id, exchangePath: exchange.exchangePath });
      }
    });
    if (!written.ok) throw new Error(written.error);
    await this.options.files.grant(safe.path);
    return safe.path;
  }
}

async function canonical(path: string): Promise<string> {
  return join(await realpath(dirname(path)), basename(path));
}

/** Anything at the path, a dangling symlink included, takes the name. */
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  });
}

/** Never replace a file that holds another workflow, or that cannot be read as one. */
function sameWorkflow(contents: string, id: string): void {
  let saved: { id?: unknown };
  try { saved = JSON.parse(contents); }
  catch { throw new Error("The saved JSON is unreadable. It was not replaced."); }
  if (!saved || saved.id !== id) throw new Error("The saved file belongs to another workflow. It was not replaced.");
}

