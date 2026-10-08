/**
 * What a tool card names, read out of Codex's records (ANT-301).
 *
 * The programs below are cut from a real Codex rollout: the `exec` tool's
 * input is JavaScript that calls the tools it uses.
 */

import { describe, expect, it } from "vitest";

import { codexExecTarget, commandLine, filesLabel, patchFiles } from "./tool-target.js";

describe("a command as a card shows it", () => {
  it("is its first line, marked when there is more", () => {
    expect(commandLine("git status")).toBe("git status");
    expect(commandLine("\n  .venv/bin/python - <<'PY'\nimport json\nPY")).toBe(".venv/bin/python - <<'PY' …");
  });

  it("is redacted and cut short", () => {
    expect(commandLine("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x' https://x")).toBe("curl -H '[redacted] https://x");
    expect(commandLine("x".repeat(200))).toBe(`${"x".repeat(120)}…`);
  });
});

describe("the files a patch touches", () => {
  it("are read from its own lines, written out or escaped in a string", () => {
    const patch = "*** Begin Patch\n*** Add File: /a/b/AUDIT.md\n+x\n*** Update File: scripts/r.py\n@@\n*** End Patch";
    expect(patchFiles(patch)).toEqual(["/a/b/AUDIT.md", "scripts/r.py"]);
    expect(patchFiles(patch.replace(/\n/g, "\\n"))).toEqual(["/a/b/AUDIT.md", "scripts/r.py"]);
  });

  it("are named by their last two parts, the first two of them", () => {
    expect(filesLabel(["/a/b/AUDIT.md"])).toBe("b/AUDIT.md");
    expect(filesLabel(["a/x.py", "b/y.py", "c/z.py", "d/w.py"])).toBe("a/x.py, b/y.py (+2 more)");
    expect(filesLabel([])).toBeUndefined();
  });
});

describe("what one of Codex's exec programs does", () => {
  it("is the command it runs", () => {
    const program =
      "const r = await tools.exec_command({cmd:\"pwd && cat AGENTS.md WORKFLOW.md\",max_output_tokens:30000});text(r.output);\ntext(ALL_TOOLS.filter(x=>/exchange/.test(x.name)));\n";
    expect(codexExecTarget(program)).toBe("pwd && cat AGENTS.md WORKFLOW.md");
  });

  it("is the first line of a script it runs, with escapes read", () => {
    const program =
      "text(await tools.write_stdin({session_id:33017,chars:\"\",yield_time_ms:1000}));\ntext(await tools.exec_command({cmd:\".venv/bin/python - <<'PY'\\nimport json\\nprint(\\\"x\\\")\\nPY\"}));";
    expect(codexExecTarget(program)).toBe(".venv/bin/python - <<'PY' …");
  });

  it("is the files a patch touches", () => {
    const program =
      'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: /Users/me/w/runs/x/AUDIT.md\\n+# Audit\\n*** End Patch"));';
    expect(codexExecTarget(program)).toBe("x/AUDIT.md");
  });

  it("names a tool it calls, and how many more things it does", () => {
    const program =
      'const r=await tools.mcp__exchange__open_workflow({workflowId:"w"});\nconst ready=await tools.mcp__exchange__get_ready_revision({workflowId:"w"});';
    expect(codexExecTarget(program)).toBe("mcp__exchange__open_workflow (+1 more)");
  });

  it("does not guess at a command the program builds as it runs", () => {
    expect(codexExecTarget("text(await tools.exec_command({cmd:cmds[0],max_output_tokens:1000}));")).toBeUndefined();
    expect(codexExecTarget("text(await tools.exec_command({cmd:`git ${x}`}));")).toBeUndefined();
  });
});

/*
  ANT-301, from a later run: Codex put the patch in a variable first, then
  called `apply_patch(patch)`; and a command can be passed as `{cmd}`.
*/
describe("what a program passes through a name", () => {
  it("is the patch declared above the call", () => {
    const program =
      'const patch = "*** Begin Patch\\n*** Add File: /w/runs/x/EVALUATION-PROTOCOL.md\\n+# Protocol\\n*** End Patch";\ntext(await tools.apply_patch(patch));';
    expect(codexExecTarget(program)).toBe("x/EVALUATION-PROTOCOL.md");
  });

  it("is whatever patch the program writes out, when the call's argument is built", () => {
    const program =
      'const body = "x";\nconst p = ["*** Begin Patch", "*** Update File: src/a.py", body, "*** End Patch"].join("\\n");\ntext(await tools.apply_patch(p));';
    expect(codexExecTarget(program)).toBe("src/a.py");
  });

  it("is the command declared above a shorthand cmd", () => {
    expect(codexExecTarget('const cmd = "git status";\ntext(await tools.exec_command({cmd, workdir:"/w"}));')).toBe("git status");
    expect(codexExecTarget('text(await tools.exec_command({"cmd":"ls -la","workdir":"/w"}));')).toBe("ls -la");
  });

  it("is still nothing for a command computed as it runs", () => {
    expect(codexExecTarget('const cmd = parts.join(" ");\ntext(await tools.exec_command({cmd}));')).toBeUndefined();
  });
});
