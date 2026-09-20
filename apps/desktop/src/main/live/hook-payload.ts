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

/**
 * Values that look like credentials, whatever they are attached to.
 *
 * Two kinds, kept apart because they redact differently. A *named* value —
 * `--token=x`, `PASSWORD=x` — keeps its name, because "the command set
 * AWS_SECRET_ACCESS_KEY" is useful and "the command set something" is not. A
 * *recognisable* value is the secret itself, so the whole match goes; an
 * earlier version tried to infer which was which from the capture group and
 * put vendor keys straight back into the output.
 */
const NAMED_SECRET: readonly RegExp[] = [
  /\b([A-Za-z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|credential|auth)[A-Za-z0-9_-]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
];

const RECOGNISABLE_SECRET: readonly RegExp[] = [
  // Vendor-shaped keys, which need no name beside them to be recognised.
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{30,})/g,
  // An authorization header. The scheme word is matched explicitly: with a
  // bare `\S+` after the colon, `Authorization: Bearer eyJ…` consumed the word
  // "Bearer" and left the token itself in the output.
  /\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*(?:(?:Bearer|Basic|Token|Digest)\s+)?\S+/gi,
  // And the scheme on its own, which is how it usually appears in a command.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Anything shaped like a private key block.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

/** How much of a target value is kept. Long enough to recognise, not to carry. */
const MAX_VALUE = 200;

/**
 * Replace anything that looks like a credential.
 *
 * Exported because the same text is redacted on the way in and checked on the
 * way out; one definition means the two cannot disagree.
 */
export function redactSecrets(value: string): string {
  let out = value;
  // Recognisable values first. `Authorization` contains "auth", so the named
  // rule below matches it and takes only the next token — which for
  // `Authorization: Bearer eyJ…` is the word "Bearer", leaving the token
  // itself behind. Consuming the whole header first avoids that.
  for (const pattern of RECOGNISABLE_SECRET) out = out.replace(pattern, "[redacted]");
  for (const pattern of NAMED_SECRET) {
    out = out.replace(pattern, (_match, name: string) => `${name}=[redacted]`);
  }
  return out;
}

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
    return value ? { description: value } : {};
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
  for (const key of ["session_id", "hook_event_name", "tool_name", "tool_use_id"] as const) {
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
