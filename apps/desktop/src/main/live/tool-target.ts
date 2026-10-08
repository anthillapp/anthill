/**
 * What a tool card names as its target, when the record has no description.
 *
 * ANT-98 kept only a tool's `description` for a shell call, because the
 * command itself is where a token typed on the command line would be. Claude
 * Code writes a description for every Bash call; Codex writes none, so every
 * Codex card was a bare "Bash" or "exec" (ANT-301). The command is now shown
 * after all — its first line, cut short, and with anything shaped like a
 * credential redacted, as every other value Anthill keeps is.
 *
 * Codex's own record of a call has a shape of its own: one `exec` tool whose
 * input is a short JavaScript program calling `tools.exec_command({cmd: …})`,
 * `tools.apply_patch("*** Begin Patch …")` or an MCP tool. That program is
 * read for the commands and files it names, never run and never kept.
 */

import { redactSecrets } from "./redact.js";

/** How much of a command is kept: enough to recognise it, not to carry it. */
export const COMMAND_MAX = 120;

/** A command as a card shows it: its first line, redacted and cut short. */
export function commandLine(command: string): string | undefined {
  const first = command
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return undefined;
  const redacted = redactSecrets(first);
  const more = command.trim().includes("\n") ? " …" : "";
  return redacted.length > COMMAND_MAX ? `${redacted.slice(0, COMMAND_MAX)}…` : `${redacted}${more}`;
}

/**
 * The files a patch in Codex's format adds, changes or deletes, in order.
 *
 * `anywhere` reads a whole program rather than a patch: there the header may
 * sit inside a string that does not start the line (ANT-301).
 */
export function patchFiles(patch: string, anywhere = false): string[] {
  // Read both as written and as a string literal in a program, where each
  // line break is the two characters `\n`.
  const text = patch.replace(/\\n/g, "\n");
  const files: string[] = [];
  const header = anywhere
    ? /\*\*\* (?:Add|Update|Delete) File: ([^\n"'`\\]+)/g
    : /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  for (const match of text.matchAll(header)) {
    const path = match[1]?.trim().replace(/["'`]+$/, "");
    if (path && !files.includes(path)) files.push(path);
  }
  return files;
}

/** Files as a card names them: the last two parts of each path, the first few. */
export function filesLabel(files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  const short = files.map((path) => path.split("/").slice(-2).join("/"));
  const shown = short.slice(0, 2).join(", ");
  return files.length > 2 ? `${shown} (+${files.length - 2} more)` : shown;
}

/** A JavaScript string literal at the start of `text`, decoded, or nothing. */
function stringLiteral(text: string): string | undefined {
  const quote = text[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let out = "";
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      out += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
      index += 1;
      continue;
    }
    if (char === quote) return out;
    // A template literal that interpolates is not a command written out.
    if (quote === "`" && char === "$" && text[index + 1] === "{") return undefined;
    out += char;
  }
  return undefined;
}

/**
 * The string a program passes, written out where it is passed or in the
 * declaration of the name it passes: `apply_patch(patch)` with
 * `const patch = "*** Begin Patch…"` above it, `exec_command({cmd})` with
 * `const cmd = "…"` (ANT-301). Nothing for a value computed as it runs.
 */
function passedString(program: string, at: string): string | undefined {
  const literal = stringLiteral(at);
  if (literal !== undefined) return literal;
  const name = /^([A-Za-z_$][\w$]*)/.exec(at)?.[1];
  if (!name) return undefined;
  const declared = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*`).exec(program);
  return declared ? stringLiteral(program.slice(declared.index + declared[0].length)) : undefined;
}

/**
 * What one of Codex's `exec` programs does, as a card's second line.
 *
 * The first command it runs, or the files its patch touches, or the tool it
 * calls — with how many more there are. A command the program builds at run
 * time is not written in it, and is not guessed at.
 */
export function codexExecTarget(program: string): string | undefined {
  const parts: string[] = [];
  for (const call of program.matchAll(/tools\.([A-Za-z0-9_]+)\(/g)) {
    const tool = call[1] ?? "";
    const rest = program.slice((call.index ?? 0) + call[0].length).trimStart();
    if (tool === "exec_command") {
      // `{cmd: "…"}`, `{"cmd": "…"}`, `{cmd: name}` or the shorthand `{cmd}`.
      const key = /^\{\s*["']?cmd\b["']?\s*(:\s*)?/.exec(rest);
      const value = !key ? undefined : key[1] ? passedString(program, rest.slice(key[0].length)) : passedString(program, "cmd");
      const line = value === undefined ? undefined : commandLine(value);
      if (line) parts.push(line);
      continue;
    }
    if (tool === "apply_patch") {
      // The patch, or failing that whatever patch the program writes out:
      // the files it names are on lines of their own either way.
      const files = patchFiles(passedString(program, rest) ?? "");
      const label = filesLabel(files.length > 0 ? files : patchFiles(program, true));
      if (label) parts.push(label);
      continue;
    }
    // Reading what a running command printed is not a new thing done.
    if (tool === "write_stdin") continue;
    parts.push(tool);
  }
  if (parts.length === 0) return undefined;
  return parts.length > 1 ? `${parts[0]} (+${parts.length - 1} more)` : parts[0];
}
