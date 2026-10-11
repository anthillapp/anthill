/**
 * What is kept of one finished thing inside a Codex program (ANT-311): what
 * it was and how it ended, never its output, a file's contents, or an MCP
 * call's arguments and result.
 */

import { describe, expect, it } from "vitest";

import { codexExecItem } from "./exec-item.js";

const CWD = "/Users/someone/dev/projects/anthill-qa/m9";

/** A command record, shaped as Codex writes it. */
const command = (parsed: unknown[], partial: Record<string, unknown> = {}) => ({
  type: "CommandExecution",
  id: "exec-89c31d53",
  command: ["/bin/zsh", "-lc", "cat skills/anthill/SKILL.md"],
  cwd: CWD,
  status: "completed",
  exit_code: 0,
  duration: { secs: 0, nanos: 12_000_000 },
  parsed_cmd: parsed,
  aggregated_output: "SECRET OUTPUT token=hunter2",
  formatted_output: "SECRET OUTPUT",
  stdout: "SECRET OUTPUT",
  stderr: "",
  process_id: "1234",
  source: "unified_exec_startup",
  ...partial,
});

describe("a command inside a program", () => {
  it("is labelled by Codex's own reading of a read, with its folder", () => {
    const found = codexExecItem(
      command([{ type: "read", cmd: "cat skills/anthill/SKILL.md", name: "SKILL.md", path: "skills/anthill/SKILL.md" }]),
      CWD,
    );
    expect(found).toEqual({
      id: "exec-89c31d53",
      item: { kind: "command", verb: "Read", target: "SKILL.md", sub: "skills/anthill/", exitCode: 0 },
      ok: true,
      durationMs: 12,
    });
    expect(JSON.stringify(found)).not.toContain("SECRET");
  });

  it("names a search by its query and where it looked", () => {
    const found = codexExecItem(command([{ type: "search", cmd: "rg -n count_words src", query: "count_words", path: "src" }]), CWD);
    expect(found?.item).toMatchObject({ verb: "Searched", target: "“count_words”", sub: "src" });
  });

  it("names a listing by its folder", () => {
    const found = codexExecItem(command([{ type: "list_files", cmd: "ls tests/rate_limit", path: "tests/rate_limit" }]), CWD);
    expect(found?.item).toMatchObject({ verb: "Listed", target: "tests/rate_limit" });
  });

  it("shows its own first line when Codex could not say what it was, or it did several things", () => {
    const unknown = codexExecItem(
      command([{ type: "unknown", cmd: "npm test -- tests/rate_limit" }], {
        command: ["/bin/zsh", "-lc", "npm test -- tests/rate_limit"],
        exit_code: 1,
        status: "failed",
        duration: { secs: 5, nanos: 900_000_000 },
      }),
      CWD,
    );
    expect(unknown).toEqual({
      id: "exec-89c31d53",
      item: { kind: "command", target: "npm test -- tests/rate_limit", exitCode: 1 },
      ok: false,
      durationMs: 5900,
    });
    const mixed = codexExecItem(
      command(
        [
          { type: "list_files", cmd: "ls design", path: "design" },
          { type: "search", cmd: "rg accent", query: "accent", path: "src" },
        ],
        { command: ["/bin/zsh", "-lc", "ls design\nrg accent src"] },
      ),
      CWD,
    );
    expect(mixed?.item.verb).toBeUndefined();
    expect(mixed?.item.target).toBe("ls design …");
  });

  it("names a program run directly by its name, not its folders", () => {
    const found = codexExecItem(
      command([{ type: "unknown", cmd: "node cli.js step" }], {
        command: ["/Users/someone/.nvm/versions/node/v22.23.2/bin/node", "/Users/someone/dev/anthill/cli.js", "step", "ANT-1", "abc", "verify"],
      }),
      CWD,
    );
    expect(found?.item.target).toBe("node cli.js step ANT-1 abc verify");
  });

  it("fails on a non-zero exit even when the record says completed", () => {
    expect(codexExecItem(command([{ type: "unknown", cmd: "false" }], { exit_code: 1, command: ["false"] }), CWD)?.ok).toBe(false);
  });

  it("redacts a credential in the command it shows", () => {
    const found = codexExecItem(
      command([{ type: "unknown", cmd: "curl" }], { command: ["/bin/zsh", "-lc", "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x.test"] }),
      CWD,
    );
    expect(found?.item.target).not.toContain("abcdefghijklmnop");
  });
});

describe("a file change inside a program", () => {
  it("names one file and its path under the session's folder, never its contents", () => {
    const found = codexExecItem(
      {
        type: "FileChange",
        id: "patch-1",
        status: "completed",
        changes: { [`${CWD}/src/wordcount.py`]: { type: "update", diff: "- old\n+ SECRET NEW LINE" } },
        stdout: "Success",
        stderr: "",
      },
      CWD,
    );
    expect(found).toEqual({ id: "patch-1", item: { kind: "file", verb: "Changed", target: "wordcount.py", sub: "src/wordcount.py" }, ok: true });
    expect(JSON.stringify(found)).not.toContain("SECRET");
  });

  it("says Added or Deleted when every file was, and counts the rest", () => {
    const added = codexExecItem(
      { type: "FileChange", id: "p", status: "completed", changes: { [`${CWD}/a.ts`]: { type: "add", content: "SECRET" }, [`${CWD}/b.ts`]: { type: "add", content: "SECRET" } } },
      CWD,
    );
    expect(added?.item.verb).toBe("Added");
    expect(added?.item.target).toContain("a.ts");
    expect(added?.item.sub).toBeUndefined();
    expect(JSON.stringify(added)).not.toContain("SECRET");
    const mixed = codexExecItem(
      { type: "FileChange", id: "q", status: "completed", changes: { [`${CWD}/a.ts`]: { type: "add" }, [`${CWD}/b.ts`]: { type: "delete" } } },
      CWD,
    );
    expect(mixed?.item.verb).toBe("Changed");
  });
});

describe("an MCP call inside a program", () => {
  it("names its server and tool, never what it was asked or answered", () => {
    const found = codexExecItem({
      type: "McpToolCall",
      id: "mcp-1",
      server: "linear",
      tool: "get_issue",
      status: "completed",
      duration: { secs: 0, nanos: 420_000_000 },
      arguments: { id: "SECRET-ARG" },
      result: { content: "SECRET RESULT" },
      readOnlyHint: true,
      pluginId: "x",
    });
    expect(found).toEqual({ id: "mcp-1", item: { kind: "mcp", target: "get_issue", sub: "linear" }, ok: true, durationMs: 420 });
    expect(JSON.stringify(found)).not.toContain("SECRET");
  });
});

it("ignores what is not a command, a file change or an MCP call", () => {
  expect(codexExecItem({ type: "Reasoning", id: "r", raw_content: "thinking" })).toBeUndefined();
  expect(codexExecItem({ type: "AgentMessage", id: "m", content: "hi" })).toBeUndefined();
  expect(codexExecItem({ type: "CommandExecution" })).toBeUndefined();
});
