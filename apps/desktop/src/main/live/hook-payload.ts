/**
 * What an observation hook is allowed to write down.
 *
 * The handler used to append the whole incoming payload. For Claude Code that
 * includes `tool_input`, which is the full shell command for `Bash` and the
 * full file contents for `Write` — so a session that exported a token, or
 * wrote a file holding one, put it in `~/.anthill/live-hooks/events.jsonl`
 * permanently, and Anthill then drew it in the Live Session feed (ANT-98).
 *
 * Anthill's promise is that it shows what a session did, not what was in it.
 * So this is an allowlist rather than a blocklist: the fields below are the
 * ones the hooks observer actually reads, and everything else is dropped
 * without being examined. A field nobody reads cannot be worth the risk of
 * keeping, and a blocklist would have to be right about every payload shape
 * every harness will ever send.
 *
 * Two things are narrowed further rather than dropped:
 *
 * - `tool_response` is read only as "is it there", never for its content, so
 *   only that question is recorded.
 * - `tool_input` is reduced to the one value the feed shows as a target — a
 *   path, a pattern, a description — and that value is redacted and truncated.
 */

export { redactSecrets } from "./redact.js";
import { redactSecrets } from "./redact.js";
import { commandLine, filesLabel, patchFiles } from "./tool-target.js";

/** How much of a target value is kept. Long enough to recognise, not to carry. */
const MAX_VALUE = 200;


function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactSecrets(value);
  return redacted.length > MAX_VALUE ? `${redacted.slice(0, MAX_VALUE)}…` : redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one value from `tool_input` the feed shows, redacted and truncated.
 *
 * Mirrors what `toolTarget` in the hooks observer picks out. The observer goes
 * on doing its own picking — it has to, for logs written before this — but
 * from now on there is only one field there for it to find.
 */
function target(toolName: string | undefined, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  if (toolName === "Bash") {
    const value = clean(input.description);
    if (value) return { description: value };
    // No description — Codex writes none — so the command, its first line
    // only, redacted and cut short (ANT-301).
    const command = typeof input.command === "string" ? commandLine(input.command) : undefined;
    return command ? { command } : {};
  }
  // A patch names the files it changes on lines of its own; only those are
  // kept, never the patch (ANT-301).
  if (toolName === "apply_patch") {
    const text = Object.values(input).find((value): value is string => typeof value === "string" && value.includes("*** "));
    const files = text ? filesLabel(patchFiles(text)) : undefined;
    return files ? { description: files } : {};
  }
  const path = clean(input.file_path) ?? clean(input.path) ?? clean(input.notebook_path);
  if (path) return { file_path: path };
  const other = clean(input.pattern) ?? clean(input.query) ?? clean(input.description);
  return other ? { description: other } : {};
}

/**
 * A hook payload reduced to what passive observation needs.
 *
 * Only complete step markers are kept from `last_assistant_message`. The
 * surrounding prose is not needed for hook-based progress.
 */
export function minimalHookPayload(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return {};
  const toolName = typeof data.tool_name === "string" ? data.tool_name : undefined;

  const out: Record<string, unknown> = {};
  // `agent_id` and `agent_type` name the subagent a SubagentStop is for, so a
  // stop can be tied to the subagent that stopped — or known to be Claude
  // Code's own helper, which no Agent call started (ANT-245).
  for (const key of ["session_id", "hook_event_name", "tool_name", "tool_use_id", "agent_id", "agent_type"] as const) {
    const value = data[key];
    // Identifiers, not prose: kept whole, and not searched for secrets.
    if (typeof value === "string") out[key] = value.slice(0, MAX_VALUE);
  }
  if (typeof data.duration_ms === "number") out.duration_ms = data.duration_ms;

  // Read only as "did the tool answer at all". The answer itself is where a
  // file's contents and an API's response would be.
  if (data.tool_response !== undefined) out.tool_response = true;

  const message = clean(data.message);
  if (message) out.message = message;

  // Why a session ended, in the CLI's own word for it — `clear`, `logout`,
  // `prompt_input_exit`, `other`. A short enumerated token, not prose, and
  // without it a clean quit, a `/clear` and a logout are the same record
  // (ANT-122). Bounded in case the enumeration grows a long member.
  // An enumerated token, so it is taken as itself rather than through
  // `clean`, which is for prose somebody might have put a secret in.
  if (typeof data.reason === "string" && /^[a-z_]{1,40}$/.test(data.reason)) {
    out.reason = data.reason;
  }

  // Keep only complete announcements, wherever they occur in the message:
  // which step the agent is on, and that it has finished. Truncating prose
  // first loses markers beyond the first 200 characters.
  if (typeof data.last_assistant_message === "string") {
    const markers = data.last_assistant_message.matchAll(
      /\bANTHILL-(?:STEP\s+ANT-[A-Z0-9]+\s+[a-z0-9]+\s+[A-Za-z0-9_.:-]+|DONE\s+ANT-[A-Z0-9]+\s+[a-z0-9]+)/g,
    );
    const kept: string[] = [];
    for (const match of markers) {
      kept.push(match[0]);
      if (kept.length === 100) break;
    }
    out.last_assistant_message = kept.join("\n");
  }

  const reduced = target(toolName, data.tool_input);
  if (Object.keys(reduced).length > 0) out.tool_input = reduced;

  if (Array.isArray(data.background_tasks)) {
    out.background_tasks = data.background_tasks.slice(0, 50).map((task) => {
      if (!isRecord(task)) return {};
      const description = clean(task.description);
      return {
        ...(typeof task.id === "string" ? { id: task.id.slice(0, MAX_VALUE) } : {}),
        ...(typeof task.status === "string" ? { status: task.status.slice(0, MAX_VALUE) } : {}),
        ...(description ? { description } : {}),
      };
    });
  }

  return out;
}
