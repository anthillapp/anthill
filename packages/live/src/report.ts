/**
 * A progress report a harness makes to the Anthill CLI.
 *
 * When the prompt tells the harness to use the CLI, the harness runs
 * `anthill run <runId> <nonce>` once, `anthill step <runId> <nonce>
 * <step-id>` per step, and `anthill done <runId> <nonce>` once the work is
 * finished. The CLI appends one JSON line per call to a local file, and the
 * live observer reads that file afterwards, the same way the hook observer
 * reads the hook log.
 *
 * The line carries both halves of the correlation marker. The run id on its
 * own is not enough: a prompt copied at some other time can still be in
 * someone's clipboard, and its run id is not the one being watched. The
 * nonce is per copy, so a report is evidence only for the run it was
 * written for.
 *
 * The file is Anthill's own state: the CLI writes it on the harness's
 * behalf, the app reads it. Nothing in here reaches the harness.
 */

import type { RunMarker } from "./marker.js";

export type HarnessReport =
  | {
      /** The run announced itself: the harness is here. */
      kind: "run";
      runId: string;
      nonce: string;
      /** When the CLI recorded the call, ISO 8601. */
      at: string;
    }
  | {
      /** The harness started (or came back to) a step. */
      kind: "step";
      runId: string;
      nonce: string;
      stepId: string;
      at: string;
    }
  | {
      /** The harness said the work is finished. */
      kind: "done";
      runId: string;
      nonce: string;
      at: string;
    };

/** One line in the report file. */
export function reportLine(report: HarnessReport): string {
  return JSON.stringify(report);
}

/**
 * The inverse of `reportLine`.
 *
 * A line that is not a report is not a report: a half-written line, a line
 * from some other tool, or a line missing the fields the observer needs is
 * dropped. The file is append-only and the observer tails it, so a dropped
 * line costs nothing.
 */
export function parseReportLine(line: string): HarnessReport | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0) return undefined;
  if (typeof candidate.nonce !== "string" || candidate.nonce.length === 0) return undefined;
  if (typeof candidate.at !== "string" || candidate.at.length === 0) return undefined;
  // The evidence fold passes `at` to `Date.parse` and then `toISOString`; an
  // unparseable value would throw out of the poll. Drop it as malformed.
  if (Number.isNaN(Date.parse(candidate.at))) return undefined;
  if (candidate.kind === "run") {
    return { kind: "run", runId: candidate.runId, nonce: candidate.nonce, at: candidate.at };
  }
  if (candidate.kind === "step") {
    if (typeof candidate.stepId !== "string" || candidate.stepId.length === 0) return undefined;
    return {
      kind: "step",
      runId: candidate.runId,
      nonce: candidate.nonce,
      stepId: candidate.stepId,
      at: candidate.at,
    };
  }
  if (candidate.kind === "done") {
    return { kind: "done", runId: candidate.runId, nonce: candidate.nonce, at: candidate.at };
  }
  return undefined;
}

/**
 * Whether a report is for a given marker.
 *
 * Both halves have to match, exactly as for detection: a step id on its own
 * would match a prompt copied at some other time, and the whole value of
 * this channel is that it cannot.
 */
export function isReportFor(
  report: HarnessReport,
  marker: Pick<RunMarker, "runId" | "nonce">,
): boolean {
  return report.runId === marker.runId && report.nonce === marker.nonce;
}
