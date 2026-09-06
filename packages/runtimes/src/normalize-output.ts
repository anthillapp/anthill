import {
  AGENT_RESULT_STATUSES,
  ISSUE_SEVERITIES,
  type AgentResult,
  type AgentResultStatus,
  type Artifact,
  type Issue,
  type IssueSeverity,
} from "./contracts.js";

/** Raw process-level facts, decoupled from how the process was actually spawned. */
export interface ProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface NormalizeOptions {
  /**
   * When false, stdout is never scanned for an embedded `AgentResult` JSON
   * block — used by `outputMode: "text"` adapters. Defaults to true.
   */
  parseJson?: boolean;
  /** How much stdout to keep as the fallback summary. Defaults to 500. */
  maxSummaryLength?: number;
}

const DEFAULT_MAX_SUMMARY_LENGTH = 500;

/**
 * The single normalization rule shared by every runtime adapter.
 *
 * Precedence (load-bearing — adapters rely on this exact ordering):
 *  1. `cancelled`  -> status "cancelled"
 *  2. `timedOut`   -> status "failed", metadata.timedOut = true
 *  3. exit code is not 0 (including `null`) -> status "failed"
 *  4. exit code 0 and stdout contains a parseable `AgentResult` JSON object
 *     -> use it, filling missing fields with defaults
 *  5. exit code 0, no parseable result -> status "success" with a truncated
 *     stdout summary
 */
export function normalizeProcessOutput(
  input: ProcessOutput,
  options: NormalizeOptions = {},
): AgentResult {
  const { parseJson = true, maxSummaryLength = DEFAULT_MAX_SUMMARY_LENGTH } = options;
  const stderr = input.stderr ?? "";
  const stdout = input.stdout ?? "";

  if (input.cancelled) {
    return {
      status: "cancelled",
      summary: "Agent run was cancelled before it completed.",
      artifacts: [],
      issues: [],
      metadata: { cancelled: true, exitCode: input.exitCode ?? null },
    };
  }

  if (input.timedOut) {
    return {
      status: "failed",
      summary: firstNonEmpty(
        stderr.trim(),
        "Agent run exceeded its time budget and was terminated.",
      ),
      artifacts: [],
      issues: [],
      metadata: { timedOut: true, exitCode: input.exitCode ?? null },
    };
  }

  if (input.exitCode !== 0) {
    return {
      status: "failed",
      summary: firstNonEmpty(
        stderr.trim(),
        `Agent process exited with code ${String(input.exitCode)}.`,
      ),
      artifacts: [],
      issues: [],
      metadata: { exitCode: input.exitCode ?? null },
    };
  }

  if (parseJson) {
    const parsed = extractAgentResult(stdout);
    if (parsed) return parsed;
  }

  const trimmed = stdout.trim();
  const truncated = trimmed.length > maxSummaryLength;
  return {
    status: "success",
    summary: truncated
      ? trimmed.slice(0, maxSummaryLength)
      : firstNonEmpty(trimmed, "Agent completed successfully with no output."),
    artifacts: [],
    issues: [],
    metadata: { rawStdoutTruncated: truncated },
  };
}

/**
 * Scans `text` for the first balanced `{...}` block that parses as JSON and
 * looks like an `AgentResult` (a valid `status` plus a string `summary`).
 * Deliberately lenient: agent CLIs routinely print banners, log lines or
 * markdown fences around their JSON.
 *
 * Returns the coerced result, or `undefined` when nothing matches.
 */
export function extractAgentResult(text: string): AgentResult | undefined {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const end = findBalancedObjectEnd(text, i);
    if (end === -1) continue;

    const candidate = text.slice(i, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!looksLikeAgentResult(parsed)) continue;
    return coerceAgentResult(parsed);
  }
  return undefined;
}

/**
 * Fills in the required fields of a loosely-typed `AgentResult`-ish object.
 * Never throws — anything unusable is replaced by a sane default.
 */
export function coerceAgentResult(value: Record<string, unknown>): AgentResult {
  const status = isAgentResultStatus(value.status) ? value.status : "success";
  const summary = typeof value.summary === "string" ? value.summary : "";

  const result: AgentResult = {
    status,
    summary,
    artifacts: coerceArtifacts(value.artifacts),
    issues: coerceIssues(value.issues),
    metadata: isPlainObject(value.metadata) ? value.metadata : {},
  };

  if (typeof value.decision === "string") result.decision = value.decision;
  if (isPlainObject(value.metrics)) result.metrics = value.metrics;

  return result;
}

function coerceArtifacts(value: unknown): Artifact[] {
  if (!Array.isArray(value)) return [];
  const artifacts: Artifact[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) continue;
    const artifact: Artifact = {
      id: typeof entry.id === "string" ? entry.id : `artifact-${index + 1}`,
      type: typeof entry.type === "string" ? entry.type : "unknown",
      title: typeof entry.title === "string" ? entry.title : "Untitled artifact",
    };
    if (typeof entry.path === "string") artifact.path = entry.path;
    if (typeof entry.content === "string") artifact.content = entry.content;
    if (isPlainObject(entry.metadata)) artifact.metadata = entry.metadata;
    artifacts.push(artifact);
  }
  return artifacts;
}

function coerceIssues(value: unknown): Issue[] {
  if (!Array.isArray(value)) return [];
  const issues: Issue[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const issue: Issue = {
      severity: isIssueSeverity(entry.severity) ? entry.severity : "medium",
      title: typeof entry.title === "string" ? entry.title : "Untitled issue",
    };
    if (typeof entry.file === "string") issue.file = entry.file;
    if (typeof entry.description === "string") issue.description = entry.description;
    issues.push(issue);
  }
  return issues;
}

/**
 * Walks forward from `start` (which must be a `{`) and returns the index of the
 * matching `}`, or -1. String literals and escapes are respected so braces
 * inside JSON strings do not throw the counter off.
 */
function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function looksLikeAgentResult(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    isAgentResultStatus(value.status) &&
    typeof value.summary === "string"
  );
}

function isAgentResultStatus(value: unknown): value is AgentResultStatus {
  return typeof value === "string" && (AGENT_RESULT_STATUSES as readonly string[]).includes(value);
}

function isIssueSeverity(value: unknown): value is IssueSeverity {
  return typeof value === "string" && (ISSUE_SEVERITIES as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmpty(...candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate.length > 0) return candidate;
  }
  return "";
}
