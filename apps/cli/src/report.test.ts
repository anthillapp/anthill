/**
 * The report file: what lands in it when a harness runs the report
 * subcommands, and that earlier reports survive later ones.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseReportLine } from "@anthill/live";

import { appendReport, reportPath } from "./report.js";

async function withDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "anthill-cli-report-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("appendReport", () => {
  it("creates the data directory and appends one line per report", async () => {
    await withDataDir(async (dir) => {
      const paths = { userData: dir, home: dir };
      await appendReport(paths, { kind: "run", runId: "ANT-1A2B3C4D", nonce: "9f8e7d", at: "2026-08-29T10:00:00.000Z" });
      await appendReport(paths, { kind: "step", runId: "ANT-1A2B3C4D", nonce: "9f8e7d", stepId: "read", at: "2026-08-29T10:01:00.000Z" });

      const text = await readFile(reportPath(paths), "utf8");
      const lines = text.split("\n").filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);
      expect(parseReportLine(lines[0]!)).toEqual({ kind: "run", runId: "ANT-1A2B3C4D", nonce: "9f8e7d", at: "2026-08-29T10:00:00.000Z" });
      expect(parseReportLine(lines[1]!)).toEqual({ kind: "step", runId: "ANT-1A2B3C4D", nonce: "9f8e7d", stepId: "read", at: "2026-08-29T10:01:00.000Z" });
    });
  });

  it("keeps earlier reports when a later one lands", async () => {
    await withDataDir(async (dir) => {
      const paths = { userData: dir, home: dir };
      await appendReport(paths, { kind: "run", runId: "ANT-1A2B3C4D", nonce: "9f8e7d", at: "2026-08-29T10:00:00.000Z" });
      await appendReport(paths, { kind: "step", runId: "ANT-1A2B3C4D", nonce: "9f8e7d", stepId: "review", at: "2026-08-29T10:02:00.000Z" });

      const text = await readFile(reportPath(paths), "utf8");
      const lines = text.split("\n").filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);
      expect(parseReportLine(lines[0]!)?.kind).toBe("run");
      expect(parseReportLine(lines[1]!)?.stepId).toBe("review");
    });
  });
});
