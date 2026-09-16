/**
 * The report channel: what a harness says when it is told to use the CLI.
 *
 * The fixtures are the JSON lines the CLI appends, written to a real file in
 * a temporary directory. The observer matches on the marker's two halves, so
 * a report for another run — even one with the same step id — is noise.
 */

import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPendingRun, type PendingRun } from "@anthill/live";

import { CliReportObserver } from "./cli-report.js";

const RUN_ID = "ANT-1A2B3C4D";
const NONCE = "9f8e7d";

function pending(partial: Partial<PendingRun> = {}): PendingRun {
  return {
    ...createPendingRun({
      anthillRunId: RUN_ID,
      correlationNonce: NONCE,
      selectedCli: "claude-code",
      promptVersion: "1",
      bootstrapPromptHash: "abcd1234",
      now: new Date(Date.now() - 5_000).toISOString(),
    }),
    detectedSessionId: "sess-1",
    state: "detected_live",
    ...partial,
  };
}

async function reportFile(rows: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-reports-"));
  const path = join(dir, "harness-reports.jsonl");
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return path;
}

const at = (iso: string) => iso;

describe("the cli report observer", () => {
  it("reads a run report as activity, with no event", async () => {
    const path = await reportFile([
      { kind: "run", runId: RUN_ID, nonce: NONCE, at: at("2026-08-29T10:00:01.000Z") },
    ]);
    const { evidence, events } = await new CliReportObserver(path).poll(
      pending(),
      new Date().toISOString(),
    );
    expect(evidence).toEqual([
      { kind: "activity", sessionId: "sess-1", at: "2026-08-29T10:00:01.000Z", channel: "anthill:report" },
    ]);
    expect(events).toEqual([]);
  });

  it("reads a step report as activity plus a step marker", async () => {
    const path = await reportFile([
      { kind: "step", runId: RUN_ID, nonce: NONCE, stepId: "implement", at: at("2026-08-29T10:00:02.000Z") },
    ]);
    const { evidence, events } = await new CliReportObserver(path).poll(
      pending(),
      new Date().toISOString(),
    );
    expect(evidence).toEqual([
      { kind: "activity", sessionId: "sess-1", at: "2026-08-29T10:00:02.000Z", channel: "anthill:report" },
    ]);
    expect(events).toEqual([
      {
        at: "2026-08-29T10:00:02.000Z",
        cli: "claude-code",
        source: "anthill",
        channel: "anthill:report",
        sessionId: "sess-1",
        kind: "step.marker",
        title: "Step announced",
        detail: "implement",
        blockId: "implement",
      },
    ]);
  });

  it("ignores a report for a different run, even with the same step id", async () => {
    const path = await reportFile([
      { kind: "step", runId: "ANT-99999999", nonce: NONCE, stepId: "implement", at: at("2026-08-29T10:00:02.000Z") },
    ]);
    expect(await new CliReportObserver(path).poll(pending(), new Date().toISOString())).toEqual({
      evidence: [],
      events: [],
    });
  });

  it("ignores a report for a different nonce, even with the same run id", async () => {
    const path = await reportFile([
      { kind: "run", runId: RUN_ID, nonce: "000000", at: at("2026-08-29T10:00:01.000Z") },
    ]);
    expect(await new CliReportObserver(path).poll(pending(), new Date().toISOString())).toEqual({
      evidence: [],
      events: [],
    });
  });

  it("drops malformed lines and keeps the good ones", async () => {
    const path = await reportFile([
      "{ not json",
      { kind: "step", runId: RUN_ID, nonce: NONCE, stepId: "one", at: at("2026-08-29T10:00:02.000Z") },
      { kind: "unknown", runId: RUN_ID, nonce: NONCE, at: at("2026-08-29T10:00:03.000Z") },
    ]);
    const { evidence, events } = await new CliReportObserver(path).poll(
      pending(),
      new Date().toISOString(),
    );
    expect(evidence).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ blockId: "one" });
  });

  it("reads a done report as completion, with a session end", async () => {
    const path = await reportFile([
      { kind: "done", runId: RUN_ID, nonce: NONCE, at: at("2026-08-29T10:00:03.000Z") },
    ]);
    const { evidence, events } = await new CliReportObserver(path).poll(
      pending(),
      new Date().toISOString(),
    );
    expect(evidence).toEqual([
      {
        kind: "completed",
        sessionId: "sess-1",
        channel: "anthill:report",
        at: "2026-08-29T10:00:03.000Z",
        detail: "The harness reported the work as finished.",
      },
    ]);
    expect(events).toEqual([
      {
        at: "2026-08-29T10:00:03.000Z",
        cli: "claude-code",
        source: "anthill",
        channel: "anthill:report",
        sessionId: "sess-1",
        kind: "session.end",
        title: "The harness reported the work as finished",
      },
    ]);
  });

  it("matches before a session is known, with the synthetic session id", async () => {
    const path = await reportFile([
      { kind: "step", runId: RUN_ID, nonce: NONCE, stepId: "one", at: at("2026-08-29T10:00:02.000Z") },
    ]);
    const { evidence, events } = await new CliReportObserver(path).poll(
      pending({ detectedSessionId: undefined, state: "pending_after_copy" }),
      new Date().toISOString(),
    );
    expect(evidence).toEqual([
      { kind: "activity", sessionId: "cli-report", at: "2026-08-29T10:00:02.000Z", channel: "anthill:report" },
    ]);
    expect(events[0]).toMatchObject({ sessionId: "cli-report" });
  });

  it("reads each line once, however often it is polled", async () => {
    const path = await reportFile([
      { kind: "run", runId: RUN_ID, nonce: NONCE, at: at("2026-08-29T10:00:01.000Z") },
    ]);
    const observer = new CliReportObserver(path);
    expect((await observer.poll(pending(), new Date().toISOString())).evidence).toHaveLength(1);
    expect(await observer.poll(pending(), new Date().toISOString())).toEqual({
      evidence: [],
      events: [],
    });
  });

  it("reads a line appended after the first poll", async () => {
    const path = await reportFile([
      { kind: "run", runId: RUN_ID, nonce: NONCE, at: at("2026-08-29T10:00:01.000Z") },
    ]);
    const observer = new CliReportObserver(path);
    await observer.poll(pending(), new Date().toISOString());
    await appendFile(
      path,
      JSON.stringify({ kind: "step", runId: RUN_ID, nonce: NONCE, stepId: "two", at: at("2026-08-29T10:00:05.000Z") }) + "\n",
      "utf8",
    );
    const { events } = await observer.poll(pending(), new Date().toISOString());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ blockId: "two" });
  });

  it("forgets its place when told to", async () => {
    const path = await reportFile([
      { kind: "run", runId: RUN_ID, nonce: NONCE, at: at("2026-08-29T10:00:01.000Z") },
    ]);
    const observer = new CliReportObserver(path);
    await observer.poll(pending(), new Date().toISOString());
    observer.forget(RUN_ID);
    // A fresh cursor re-reads the file from the top.
    const again = await observer.poll(pending(), new Date().toISOString());
    expect(again.evidence).toHaveLength(1);
  });

  it("says nothing at all when the file does not exist", async () => {
    const observer = new CliReportObserver(join(tmpdir(), "anthill-no-such-report.jsonl"));
    expect(await observer.poll(pending(), new Date().toISOString())).toEqual({
      evidence: [],
      events: [],
    });
  });
});
