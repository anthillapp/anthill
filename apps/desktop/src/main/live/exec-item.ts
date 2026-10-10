/**
 * What one finished thing inside a Codex `exec` program was (ANT-311).
 *
 * Codex runs most of its work as one `exec` call whose input is a short
 * program, and Anthill drew that program as one card with one outcome: a
 * program whose tests failed but which itself completed was green. As each
 * command, file change and MCP call inside it finishes, Codex writes an
 * `item_completed` record for it. That record is read here — and only the
 * fields named below. It also carries the command's whole output and, for a
 * file change, the file's whole contents; those are never read, kept or
 * passed on.
 */

import { basename, dirname, isAbsolute, relative } from "node:path";
import { homedir } from "node:os";

import type { ExecItem } from "@anthill/live";

import { redactSecrets } from "./redact.js";
import { commandLine, filesLabel } from "./tool-target.js";

/** How much of a path, a search or a tool name is kept. */
const VALUE_MAX = 120;

/** An item as an event carries it. */
export type ExecItemRecord = {
  id: string;
  item: ExecItem;
  ok: boolean;
  durationMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A value as Anthill keeps it: one line, redacted, cut short. */
function short(value: string): string {
  const flat = redactSecrets(value.replace(/\s+/g, " ").trim());
  return flat.length > VALUE_MAX ? `${flat.slice(0, VALUE_MAX)}…` : flat;
}

/** Codex's `{ secs, nanos }`, as milliseconds. */
function durationOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const secs = typeof value.secs === "number" ? value.secs : undefined;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  return secs === undefined ? undefined : Math.round(secs * 1000 + nanos / 1e6);
}

/** A path as a second line: under the session's folder when it is, else from home. */
function shownPath(path: string, cwd: string | undefined): string {
  if (cwd && isAbsolute(path)) {
    const inside = relative(cwd, path);
    if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return short(inside);
  }
  const home = homedir();
  return short(home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path);
}

/** The folder a file is in, for the line under its name, or nothing at the top. */
function folderOf(path: string, cwd: string | undefined): string | undefined {
  const folder = dirname(path);
  return folder === "." || folder === "/" ? undefined : `${shownPath(folder, cwd)}/`;
}

/**
 * The script a `["zsh", "-lc", "<script>"]` command runs, or the words.
 *
 * A command Codex ran directly names its program and files by full path —
 * `/Users/…/.nvm/versions/node/v22/bin/node /Users/…/cli.js step …` — which
 * fills the row with the folders and hides what ran. Each such word is
 * shown by its name: `node cli.js step …`.
 */
function commandText(command: unknown): string | undefined {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return undefined;
  const words = command.filter((word): word is string => typeof word === "string");
  const shell = words.length === 3 && /(?:^|\/)(?:ba|z)?sh$/.test(words[0] ?? "") && words[1]?.startsWith("-");
  if (shell) return words[2];
  return words.map((word) => (isAbsolute(word) && !/\s/.test(word) ? basename(word) : word)).join(" ");
}

type Parsed = { type: string; path?: string; name?: string; query?: string };

/**
 * Codex's own reading of a command, when it made one. Only a command that is
 * one read, one search or one listing — or several reads — gets a verb; a
 * chain of different things, or anything Codex calls `unknown`, shows its own
 * first line.
 */
function classified(parsed: Parsed[], cwd: string | undefined): Pick<ExecItem, "verb" | "target" | "sub"> | undefined {
  if (parsed.length === 0) return undefined;
  const types = new Set(parsed.map((entry) => entry.type));
  if (types.size !== 1) return undefined;
  const [first] = parsed as [Parsed, ...Parsed[]];
  if (first.type === "read") {
    const names = parsed.map((entry) => entry.name ?? (entry.path ? basename(entry.path) : undefined));
    if (names.some((name) => !name)) return undefined;
    const target = names.length === 1 ? names[0] : `${names[0]} (+${names.length - 1} more)`;
    const folder = parsed.length === 1 && first.path ? folderOf(first.path, cwd) : undefined;
    return { verb: "Read", target: short(target as string), ...(folder ? { sub: folder } : {}) };
  }
  if (parsed.length !== 1) return undefined;
  if (first.type === "search" && first.query) {
    return { verb: "Searched", target: short(`“${first.query}”`), ...(first.path ? { sub: shownPath(first.path, cwd) } : {}) };
  }
  if (first.type === "list_files") {
    return { verb: "Listed", target: first.path ? shownPath(first.path, cwd) : "." };
  }
  return undefined;
}

/**
 * One `item_completed` record's item, as Anthill keeps it, or nothing for an
 * item that is not a command, a file change or an MCP call.
 *
 * `cwd` is the session's folder, which paths are shown under.
 */
export function codexExecItem(item: unknown, cwd?: string): ExecItemRecord | undefined {
  if (!isRecord(item)) return undefined;
  const id = str(item.id);
  if (!id) return undefined;
  const failed = item.status === "failed";

  if (item.type === "CommandExecution") {
    const parsed: Parsed[] = Array.isArray(item.parsed_cmd)
      ? item.parsed_cmd.filter(isRecord).map((entry) => ({
          type: str(entry.type) ?? "unknown",
          ...(str(entry.path) ? { path: str(entry.path) as string } : {}),
          ...(str(entry.name) ? { name: str(entry.name) as string } : {}),
          ...(str(entry.query) ? { query: str(entry.query) as string } : {}),
        }))
      : [];
    const exitCode = typeof item.exit_code === "number" && Number.isInteger(item.exit_code) ? item.exit_code : undefined;
    const known = classified(parsed, str(item.cwd) ?? cwd);
    const text = commandText(item.command);
    const line = text ? commandLine(text) : undefined;
    const label = known ?? (line ? { target: line } : undefined);
    if (!label) return undefined;
    const durationMs = durationOf(item.duration);
    return {
      id,
      item: { kind: "command", ...label, ...(exitCode !== undefined ? { exitCode } : {}) },
      ok: !failed && (exitCode === undefined || exitCode === 0),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (item.type === "FileChange") {
    // The paths and what happened to each — never what was written.
    const changes = isRecord(item.changes) ? item.changes : {};
    const paths = Object.keys(changes);
    if (paths.length === 0) return undefined;
    const kinds = new Set(paths.map((path) => (isRecord(changes[path]) ? str((changes[path] as Record<string, unknown>).type) : undefined)));
    const verb = kinds.size === 1 && kinds.has("add") ? "Added" : kinds.size === 1 && kinds.has("delete") ? "Deleted" : "Changed";
    const single = paths.length === 1 ? (paths[0] as string) : undefined;
    return {
      id,
      item: {
        kind: "file",
        verb,
        target: short(single ? basename(single) : (filesLabel(paths) ?? `${paths.length} files`)),
        ...(single ? { sub: shownPath(single, cwd) } : {}),
      },
      ok: !failed,
    };
  }

  if (item.type === "McpToolCall") {
    // Which server and tool — never what it was asked or what it answered.
    const tool = str(item.tool);
    if (!tool) return undefined;
    const server = str(item.server);
    const durationMs = durationOf(item.duration);
    return {
      id,
      item: { kind: "mcp", target: short(tool), ...(server ? { sub: short(server) } : {}) },
      ok: !failed,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  return undefined;
}
