/**
 * The one file this server reads on a harness's behalf: the `workflow.json` a
 * `run` command names (ANT-281).
 *
 * Everything else this server is handed arrives as a tool argument. `run`
 * takes a path instead, because the point of it is a command the user can keep
 * and paste again — `/anthill:workflow run "<path>"` — and a path is the part
 * of that which stays the same from one run to the next.
 *
 * What the path may look like is what a person copies: the status bar's
 * `~/Library/Application Support/…/workflow.json`, in quotes because of the
 * space. A harness usually hands it over unquoted and unexpanded, since nothing
 * between the user and this call runs a shell, so both are undone here.
 *
 * Read through the same door as the store's own files rather than the one
 * submissions use: a working copy written by an older Anthill is upgraded the
 * way the editor upgrades it on open, instead of being refused for a format
 * nobody chose.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { readStoredWorkflowDocument, type ExchangeProblem } from "@anthill/workflow-exchange";
import type { Workflow } from "@anthill/workflow-schema";

/** The server's own codes for a file that could not be read as a workflow. */
export const WORKFLOW_FILE_PROBLEM_CODES = {
  WORKFLOW_FILE_UNREADABLE: "WORKFLOW_FILE_UNREADABLE",
  WORKFLOW_FILE_NOT_JSON: "WORKFLOW_FILE_NOT_JSON",
  WORKFLOW_FILE_TOO_LARGE: "WORKFLOW_FILE_TOO_LARGE",
} as const;

export type WorkflowFileRead =
  | { ok: true; path: string; workflow: Workflow }
  | { ok: false; path: string; problems: ExchangeProblem[] };

export type WorkflowFileOptions = {
  /** The home directory `~` stands for. Defaults to this user's. */
  home?: string;
  /** What a relative path is relative to. Defaults to this process's directory, which a harness starts in its project. */
  cwd?: string;
  /** The largest file read, in bytes. */
  maxBytes: number;
};

/**
 * The path as the file system needs it: surrounding quotes taken off, `~`
 * expanded, and resolved against the working directory.
 */
export function resolveWorkflowPath(given: string, options: Pick<WorkflowFileOptions, "home" | "cwd"> = {}): string {
  let path = given.trim();
  const quoted = path.match(/^(["'])(.*)\1$/);
  if (quoted) path = quoted[2]!.trim();

  const home = options.home ?? homedir();
  if (path === "~") path = home;
  else if (path.startsWith("~/") || path.startsWith("~\\")) path = `${home}${path.slice(1)}`;

  return isAbsolute(path) ? resolve(path) : resolve(options.cwd ?? process.cwd(), path);
}

export async function readWorkflowFile(given: string, options: WorkflowFileOptions): Promise<WorkflowFileRead> {
  const path = resolveWorkflowPath(given, options);
  const refused = (code: keyof typeof WORKFLOW_FILE_PROBLEM_CODES, message: string): WorkflowFileRead => ({
    ok: false,
    path,
    problems: [{ code: WORKFLOW_FILE_PROBLEM_CODES[code], message, field: "path" }],
  });

  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return refused("WORKFLOW_FILE_UNREADABLE", `${path} is not a file. Name the workflow.json itself.`);
    size = info.size;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return refused(
      "WORKFLOW_FILE_UNREADABLE",
      missing
        ? `There is no file at ${path}. Check the path: copy it again from Anthill's Export dialog or status bar.`
        : `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (size > options.maxBytes) {
    return refused(
      "WORKFLOW_FILE_TOO_LARGE",
      `${path} is ${size} bytes, larger than the ${options.maxBytes} a workflow can be. It is probably not a workflow.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return error instanceof SyntaxError
      ? refused("WORKFLOW_FILE_NOT_JSON", `${path} is not JSON: ${error.message}. Is it the workflow.json?`)
      : refused("WORKFLOW_FILE_UNREADABLE", `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  const read = readStoredWorkflowDocument(parsed);
  if (!read.ok) return { ok: false, path, problems: read.problems };
  return { ok: true, path, workflow: read.workflow };
}
