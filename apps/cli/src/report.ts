/**
 * Appending a progress report to the local report file.
 *
 * The file lives in the CLI's own data directory: it is Anthill's state,
 * written by the CLI on the harness's behalf and read afterwards by the
 * live observer. The report subcommands never start a server and never take
 * the instance lock, so a harness mid-step cannot be blocked by a running
 * Anthill, and a harness on a machine without one simply gets an error.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { reportLine, type HarnessReport } from "@anthill/live";
import type { Paths } from "./paths.js";

/** The report file's name, within the CLI's data directory. */
export const REPORT_FILE_NAME = "harness-reports.jsonl";

/** Where the report file lives for a given set of paths. */
export function reportPath(paths: Paths): string {
  return join(paths.userData, REPORT_FILE_NAME);
}

/**
 * Append one report to the file, creating the data directory if needed.
 *
 * Append-only: a report is a fact about the harness, and an earlier report
 * is never rewritten.
 */
export async function appendReport(paths: Paths, report: HarnessReport): Promise<void> {
  await mkdir(paths.userData, { recursive: true });
  await appendFile(reportPath(paths), `${reportLine(report)}\n`, "utf8");
}
