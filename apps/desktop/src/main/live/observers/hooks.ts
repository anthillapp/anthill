/**
 * Reading the lifecycle hooks the user chose to install.
 *
 * Hooks tell Anthill two things a transcript tells it less well: that a session
 * is *waiting for a person*, and how long a tool call actually took. Both
 * matter on the Live Session page — "waiting on you" is a state a person needs
 * to see, and inferring it from silence would be a guess dressed as a fact.
 *
 * Only the first of those is now shared. A transcript cannot time a tool call,
 * but it does record that a turn ended, and since ANT-47 it says so: the
 * Notification hook remains the CLI stating outright that it wants something
 * from a person, while a turn ending is the weaker record that the agent
 * handed control back — enough to stop the diagram claiming it is working.
 *
 * This reader is passive in the same way everything else here is. It does not
 * install anything (that is `setup.ts`, and only on an explicit user action)
 * and it does not run when a session runs — the hook handler writes a line to
 * `~/.anthill/live-hooks/events.jsonl` and exits, and this reads that file
 * afterwards. If the user never installed hooks the file never exists, and the
 * page simply has less to show and says so.
 *
 * The log is machine-wide, so lines are kept only once the run has a session id
 * to match them against. Before that, another session's hooks are somebody
 * else's business.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseStepMarkers, type MarkerCli, type PendingRun } from "@anthill/live";

import type { ObservationEventDraft } from "./types.js";
import { newCursor, readNewLines, type TailCursor } from "./tail.js";

export const HOOK_LOG = join(homedir(), ".anthill", "live-hooks", "events.jsonl");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** How each hook event reads on the page. */
const KIND: Record<string, ObservationEventDraft["kind"]> = {
  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "prompt.submit",
  PreToolUse: "tool.start",
  PostToolUse: "tool.end",
  SubagentStop: "subagent.end",
  Notification: "notification",
  Stop: "turn.end",
};

const TITLE: Record<string, string> = {
  SessionStart: "Session started",
  SessionEnd: "Session ended",
  UserPromptSubmit: "A prompt was submitted",
  SubagentStop: "A subagent finished",
  Notification: "The session is waiting for you",
  Stop: "The agent finished its turn",
};

/** The field of a tool's input that names what it is acting on. */
function toolTarget(name: string | undefined, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (name === "Bash") return str(input.description) ?? str(input.command);
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  if (path) return path.split("/").slice(-2).join("/");
  return str(input.pattern) ?? str(input.query) ?? str(input.description);
}

export class HookLogObserver {
  private readonly path: string;
  /** Bytes already read, per run, so a growing log is never re-parsed whole. */
  private readonly cursors = new Map<string, TailCursor>();

  constructor(path: string = HOOK_LOG) {
    this.path = path;
  }

  forget(runId: string): void {
    this.cursors.delete(runId);
  }

  /** Whether hooks are installed and have ever recorded anything. */
  async available(): Promise<boolean> {
    return stat(this.path).then(
      (info) => info.isFile(),
      () => false,
    );
  }

  /**
   * Read whatever the log has gained.
   *
   * Only lines whose session id matches this run are kept, which is why nothing
   * is returned until the run has been matched to a session by another channel.
   */
  async poll(run: PendingRun, now: string): Promise<ObservationEventDraft[]> {
    if (!run.detectedSessionId) return [];

    let cursor = this.cursors.get(run.anthillRunId);
    if (!cursor) {
      cursor = newCursor();
      this.cursors.set(run.anthillRunId, cursor);
    }

    const chunk = await readNewLines(this.path, cursor);
    if (!chunk.grew) return [];

    const events: ObservationEventDraft[] = [];
    for (const line of chunk.lines) {
      if (!line.startsWith("{")) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const data = isRecord(row.data) ? row.data : undefined;
      if (!data) continue;
      if (str(data.session_id) !== run.detectedSessionId) continue;

      const name = str(data.hook_event_name) ?? str(row.eventType) ?? "";
      const kind = KIND[name];
      if (!kind) continue;

      const cli = (str(row.harness) as MarkerCli | undefined) ?? run.selectedCli;
      const at = str(row.recordedAt) ?? now;
      const toolName = str(data.tool_name);

      const base: ObservationEventDraft = {
        at,
        cli,
        source: "hook",
        channel: `${cli}:hook`,
        sessionId: run.detectedSessionId,
        kind,
        title: TITLE[name] ?? toolName ?? name,
        ...(toolName ? { toolName } : {}),
        ...(str(data.tool_use_id) ? { toolUseId: str(data.tool_use_id) as string } : {}),
        ...(typeof data.duration_ms === "number" ? { durationMs: data.duration_ms } : {}),
      };

      if (kind === "tool.start" || kind === "tool.end") {
        const target = toolTarget(toolName, data.tool_input);
        events.push({
          ...base,
          title: toolName ?? "A tool",
          ...(target ? { detail: target } : {}),
          ...(kind === "tool.end" ? { ok: data.tool_response !== undefined } : {}),
        });
        continue;
      }

      if (name === "Notification") {
        // The one field here is the CLI's own short message about what it is
        // waiting for. It is written for a person to read, not model prose.
        events.push({ ...base, ...(str(data.message) ? { detail: str(data.message) as string } : {}) });
        continue;
      }

      if (name === "Stop") {
        // The last assistant message is scanned for step markers and then
        // thrown away — the message itself is never stored or shown.
        const announced = parseStepMarkers(str(data.last_assistant_message) ?? "", {
          runId: run.anthillRunId,
          nonce: run.correlationNonce,
        });
        for (const blockId of announced) {
          events.push({ ...base, kind: "step.marker", title: "Step announced", detail: blockId, blockId });
        }
        events.push(base);
        continue;
      }

      events.push(base);
    }
    return events;
  }
}
