import { describe, expect, it } from "vitest";
import { extractAgentResult, normalizeProcessOutput } from "./normalize-output.js";

const base = { exitCode: 0, stdout: "", stderr: "" };

describe("normalizeProcessOutput", () => {
  describe("failure branch", () => {
    it("maps a non-zero exit code to failed and keeps stderr as the summary", () => {
      const result = normalizeProcessOutput({
        exitCode: 3,
        stdout: "some partial work\n",
        stderr: "fatal: model endpoint unreachable\n",
      });

      expect(result.status).toBe("failed");
      expect(result.summary).toBe("fatal: model endpoint unreachable");
      expect(result.metadata).toEqual({ exitCode: 3 });
      expect(result.artifacts).toEqual([]);
      expect(result.issues).toEqual([]);
    });

    it("falls back to a generic summary when stderr is empty", () => {
      const result = normalizeProcessOutput({ exitCode: 127, stdout: "", stderr: "   " });

      expect(result.status).toBe("failed");
      expect(result.summary).toBe("Agent process exited with code 127.");
    });

    it("treats a null exit code (killed by signal) as failed", () => {
      const result = normalizeProcessOutput({ exitCode: null, stdout: "", stderr: "" });

      expect(result.status).toBe("failed");
      expect(result.metadata).toEqual({ exitCode: null });
    });

    it("ignores a valid JSON result when the process failed", () => {
      const result = normalizeProcessOutput({
        exitCode: 1,
        stdout: JSON.stringify({ status: "success", summary: "all good" }),
        stderr: "boom",
      });

      expect(result.status).toBe("failed");
      expect(result.summary).toBe("boom");
    });
  });

  describe("timeout branch", () => {
    it("marks timedOut in metadata and fails", () => {
      const result = normalizeProcessOutput({
        exitCode: null,
        stdout: "working...",
        stderr: "",
        timedOut: true,
      });

      expect(result.status).toBe("failed");
      expect(result.summary).toBe("Agent run exceeded its time budget and was terminated.");
      expect(result.metadata).toEqual({ timedOut: true, exitCode: null });
    });

    it("prefers stderr as the summary when the process said something", () => {
      const result = normalizeProcessOutput({
        exitCode: null,
        stdout: "",
        stderr: "context window exhausted",
        timedOut: true,
      });

      expect(result.summary).toBe("context window exhausted");
      expect(result.metadata.timedOut).toBe(true);
    });
  });

  describe("cancellation branch", () => {
    it("maps cancellation to status cancelled and wins over timeout", () => {
      const result = normalizeProcessOutput({
        exitCode: null,
        stdout: "",
        stderr: "",
        cancelled: true,
        timedOut: true,
      });

      expect(result.status).toBe("cancelled");
      expect(result.summary).toBe("Agent run was cancelled before it completed.");
      expect(result.metadata).toEqual({ cancelled: true, exitCode: null });
    });

    it("wins over a non-zero exit code", () => {
      const result = normalizeProcessOutput({
        exitCode: 143,
        stdout: "",
        stderr: "terminated",
        cancelled: true,
      });

      expect(result.status).toBe("cancelled");
    });
  });

  describe("structured JSON branch", () => {
    it("uses a bare JSON object printed on stdout", () => {
      const payload = {
        status: "requires_approval",
        summary: "Needs a human to approve the migration.",
        decision: "escalate",
        artifacts: [{ id: "a1", type: "diff", title: "Migration", path: "db/001.sql" }],
        issues: [{ severity: "high", title: "Destructive migration" }],
        metrics: { tokens: 1234 },
        metadata: { model: "test" },
      };

      const result = normalizeProcessOutput({ ...base, stdout: JSON.stringify(payload) });

      expect(result.status).toBe("requires_approval");
      expect(result.summary).toBe("Needs a human to approve the migration.");
      expect(result.decision).toBe("escalate");
      expect(result.artifacts).toEqual(payload.artifacts);
      expect(result.issues).toEqual(payload.issues);
      expect(result.metrics).toEqual({ tokens: 1234 });
      expect(result.metadata).toEqual({ model: "test" });
    });

    it("finds JSON surrounded by chatter and markdown fences", () => {
      const stdout = [
        "Thinking about the task...",
        "```json",
        '{ "status": "success", "summary": "Done." }',
        "```",
        "Bye!",
      ].join("\n");

      const result = normalizeProcessOutput({ ...base, stdout });

      expect(result.status).toBe("success");
      expect(result.summary).toBe("Done.");
    });

    it("skips leading JSON objects that are not AgentResults", () => {
      const stdout = [
        '{"type":"log","message":"starting"}',
        '{"type":"log","message":"still going"}',
        '{"status":"success","summary":"The real result."}',
      ].join("\n");

      const result = normalizeProcessOutput({ ...base, stdout });

      expect(result.summary).toBe("The real result.");
    });

    it("handles nested objects and braces inside strings", () => {
      const stdout = `noise {not json} more noise ${JSON.stringify({
        status: "success",
        summary: "Handled { braces } in a string",
        metadata: { nested: { deep: { deeper: true } } },
      })} trailing`;

      const result = normalizeProcessOutput({ ...base, stdout });

      expect(result.summary).toBe("Handled { braces } in a string");
      expect(result.metadata).toEqual({ nested: { deep: { deeper: true } } });
    });

    it("fills in missing required fields with defaults", () => {
      const result = normalizeProcessOutput({
        ...base,
        stdout: '{"status":"success","summary":"Minimal."}',
      });

      expect(result.artifacts).toEqual([]);
      expect(result.issues).toEqual([]);
      expect(result.metadata).toEqual({});
      expect(result.decision).toBeUndefined();
      expect(result.metrics).toBeUndefined();
    });

    it("repairs malformed artifacts and issues instead of throwing", () => {
      const result = normalizeProcessOutput({
        ...base,
        stdout: JSON.stringify({
          status: "success",
          summary: "Sloppy output.",
          artifacts: [{ title: "No id or type" }, "not an object", { id: 7 }],
          issues: [{ severity: "catastrophic", title: "Bad severity" }, { description: "no title" }],
          metadata: "not an object",
        }),
      });

      expect(result.artifacts).toEqual([
        { id: "artifact-1", type: "unknown", title: "No id or type" },
        { id: "artifact-3", type: "unknown", title: "Untitled artifact" },
      ]);
      expect(result.issues).toEqual([
        { severity: "medium", title: "Bad severity" },
        { severity: "medium", title: "Untitled issue", description: "no title" },
      ]);
      expect(result.metadata).toEqual({});
    });

    it("ignores JSON when parseJson is disabled (text output mode)", () => {
      const stdout = '{"status":"success","summary":"structured"}';
      const result = normalizeProcessOutput({ ...base, stdout }, { parseJson: false });

      expect(result.summary).toBe(stdout);
      expect(result.metadata).toEqual({ rawStdoutTruncated: false });
    });
  });

  describe("plain-text success branch", () => {
    it("summarizes short stdout verbatim", () => {
      const result = normalizeProcessOutput({ ...base, stdout: "  I did the thing.\n" });

      expect(result.status).toBe("success");
      expect(result.summary).toBe("I did the thing.");
      expect(result.metadata).toEqual({ rawStdoutTruncated: false });
      expect(result.artifacts).toEqual([]);
      expect(result.issues).toEqual([]);
    });

    it("truncates long stdout to 500 chars and flags it", () => {
      const stdout = "x".repeat(1200);
      const result = normalizeProcessOutput({ ...base, stdout });

      expect(result.summary).toHaveLength(500);
      expect(result.metadata).toEqual({ rawStdoutTruncated: true });
    });

    it("handles a silent but successful process", () => {
      const result = normalizeProcessOutput({ ...base, stdout: "" });

      expect(result.status).toBe("success");
      expect(result.summary).toBe("Agent completed successfully with no output.");
      expect(result.metadata).toEqual({ rawStdoutTruncated: false });
    });

    it("falls back to text when stdout contains unparseable JSON-ish output", () => {
      const result = normalizeProcessOutput({
        ...base,
        stdout: '{"status": "success", "summary": }',
      });

      expect(result.status).toBe("success");
      expect(result.summary).toBe('{"status": "success", "summary": }');
    });
  });
});

describe("extractAgentResult", () => {
  it("returns undefined when there is no JSON at all", () => {
    expect(extractAgentResult("just some prose")).toBeUndefined();
  });

  it("returns undefined for JSON with an unknown status", () => {
    expect(extractAgentResult('{"status":"maybe","summary":"hm"}')).toBeUndefined();
  });

  it("returns undefined when summary is missing", () => {
    expect(extractAgentResult('{"status":"success"}')).toBeUndefined();
  });
});
