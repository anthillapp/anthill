/**
 * Reading the progress reports a harness makes to the Anthill CLI.
 *
 * When the prompt tells the harness to use the CLI, the harness runs
 * `anthill run`, `anthill step`, and `anthill done`; the CLI appends one
 * JSON line per call to `~/.anthill/cli/harness-reports.jsonl`. This
 * observer tails that file, matches each line against the run it is
 * watching (both halves of the marker), and turns a match into evidence.
 *
 * Passive, like everything else here. It reads a file the CLI wrote and
 * writes nothing back: the report file is Anthill's own state, and the
 * observer never reaches the harness.
 *
 * Unlike the hook log, the file is not matched on a session id. A report
 * line carries the run id and the nonce directly, so it can be matched even
 * before another channel has found the session — and it is not gated on
 * one. A line that does not carry both halves of this run's marker is
 * somebody else's report, and is dropped.
 *
 * A report is not a `match`: it has no harness session id, and a synthetic
 * match could make a real transcript that arrives later look like a second
 * session. What a report is, is activity: the harness for this run is here,
 * and it said which step it was on. The session id, when one is known, is
 * the real one; before that it is the synthetic `cli-report`, which keeps
 * the evidence honest about where it came from.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { isReportFor, parseReportLine, type Evidence, type PendingRun } from "@anthill/live";

import type { ObservationEventDraft, PollResult } from "./types.js";
import { newCursor, readNewLines, type TailCursor } from "./tail.js";

/**
 * The report file, in the CLI's default data directory.
 *
 * This channel stays at the CLI's default location even when Desktop uses an
 * isolated --data-dir: report commands from a harness use the CLI default too.
 * A custom CLI data directory must be paired with an explicit observer path.
 */
export const REPORT_LOG = join(homedir(), ".anthill", "cli", "harness-reports.jsonl");

export class CliReportObserver {
  private readonly path: string;
  /** Bytes already read, per run, so a growing file is never re-parsed whole. */
  private readonly cursors = new Map<string, TailCursor>();

  constructor(path: string = REPORT_LOG) {
    this.path = path;
  }

  forget(runId: string): void {
    this.cursors.delete(runId);
  }

  /**
   * Read whatever the file has gained.
   *
   * Each line that carries this run's marker is evidence that the harness is
   * alive, at the moment the CLI recorded it — the report's own time, not
   * the poll's. A step report is also a `step.marker` event: the harness
   * said which step it was on, and that is the one thing no other channel
   * can know. A `done` report is the harness saying the work is finished:
   * it is `completed` evidence, the run's own "finished" state, and a
   * `session.end` event.
   */
  async poll(run: PendingRun, _now: string): Promise<PollResult> {
    let cursor = this.cursors.get(run.anthillRunId);
    if (!cursor) {
      cursor = newCursor();
      this.cursors.set(run.anthillRunId, cursor);
    }

    const chunk = await readNewLines(this.path, cursor);
    if (!chunk.grew) return { evidence: [], events: [] };

    const sessionId = run.detectedSessionId ?? "cli-report";
    const marker = { runId: run.anthillRunId, nonce: run.correlationNonce };
    const evidence: Evidence[] = [];
    const events: ObservationEventDraft[] = [];
    for (const line of chunk.lines) {
      const report = parseReportLine(line);
      if (report === undefined || !isReportFor(report, marker)) continue;
      if (report.kind === "done") {
        evidence.push({
          kind: "completed",
          sessionId,
          channel: "anthill:report",
          at: report.at,
          detail: "The harness reported the work as finished.",
        });
        events.push({
          at: report.at,
          cli: run.selectedCli,
          source: "anthill",
          channel: "anthill:report",
          sessionId,
          kind: "session.end",
          title: "The harness reported the work as finished",
          completion: "done",
        });
        continue;
      }
      evidence.push({ kind: "activity", sessionId, at: report.at, channel: "anthill:report" });
      if (report.kind === "step") {
        events.push({
          at: report.at,
          cli: run.selectedCli,
          source: "anthill",
          channel: "anthill:report",
          sessionId,
          kind: "step.marker",
          title: "Step announced",
          detail: report.stepId,
          blockId: report.stepId,
        });
      }
    }
    return { evidence, events };
  }
}
