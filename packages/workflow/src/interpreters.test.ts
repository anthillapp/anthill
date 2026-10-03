import { describe, expect, it } from "vitest";

import { INTERPRETERS, describeInterpreterCommand, isSignedOutFailure } from "./interpreters.js";

/**
 * Telling "not signed in" apart from every other failure.
 *
 * The recovery differs in kind. "Try again, or reword it" is sound when a model
 * answered badly and useless when a session has expired — rewording a prompt
 * has never signed anyone in, and offering it sends the author round a loop
 * that cannot end. Matched on the CLI's own words because both of these exit 1
 * for everything.
 */
describe("recognising a signed-out CLI", () => {
  it("recognises the message this was found on", () => {
    expect(
      isSignedOutFailure(
        "Claude Code exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe(true);
  });

  it("recognises the other shapes a CLI says it in", () => {
    for (const said of [
      "Error: not logged in",
      "Please run `codex login` to continue",
      "401 Unauthorized",
      "Your login has expired",
    ]) {
      expect(isSignedOutFailure(said)).toBe(true);
    }
  });

  it("does not read an ordinary failure as a sign-in problem", () => {
    // Sending someone to sign in when they are already signed in is the same
    // mistake in the other direction.
    for (const said of [
      "No JSON object was found in the reply.",
      "Claude Code exited with code 1: model overloaded, try again",
      "The proposal names a block that does not exist.",
      "spawn claude ENOENT",
    ]) {
      expect(isSignedOutFailure(said)).toBe(false);
    }
  });

  it("gives every interpreter a sign-in command to hand over", () => {
    for (const item of INTERPRETERS) {
      expect(item.signIn.length).toBeGreaterThan(0);
      // It has to be that CLI's own command, or the advice is wrong again.
      expect(item.signIn.startsWith(item.command)).toBe(true);
    }
  });
});

/**
 * A project folder (ANT-67): read-only tools in the author's folder, and a
 * command on screen that is still the one that runs.
 */
describe("drafting with a project folder", () => {
  it("gives Claude Code the three tools that only look, kept inside the folder", () => {
    expect(describeInterpreterCommand("claude-code", "~/code/acme-web")).toBe(
      "cd ~/code/acme-web && claude -p --output-format text --tools Read,Glob,Grep --restricted --strict-mcp-config",
    );
  });

  it("keeps Codex in its read-only sandbox, standing in the folder", () => {
    const codex = describeInterpreterCommand("codex", "/Users/me/code/acme-web");
    expect(codex).toContain("--sandbox read-only");
    expect(codex).toContain("-C /Users/me/code/acme-web");
    // `-C` already says where it runs, so there is no `cd` in front.
    expect(codex.startsWith("codex exec")).toBe(true);
  });

  it("gives pi an allowlist of its read-only tools instead of none", () => {
    expect(describeInterpreterCommand("pi", "~/code/acme-web")).toBe(
      "cd ~/code/acme-web && pi -p --tools read,grep,find,ls",
    );
  });

  it("leaves the commands without a folder exactly as they were", () => {
    expect(describeInterpreterCommand("claude-code")).toBe(
      'claude -p --output-format text --tools "" --strict-mcp-config',
    );
    expect(describeInterpreterCommand("pi")).toBe("pi -p --no-tools");
  });

  it("quotes a folder the shell would split, and still expands its ~", () => {
    expect(describeInterpreterCommand("pi", "~/My Projects/it's here")).toBe(
      "cd ~/'My Projects/it'\\''s here' && pi -p --tools read,grep,find,ls",
    );
  });

  it("never grants writing, a shell or a bypass", () => {
    for (const item of INTERPRETERS) {
      const args = item.args({ workDir: "/p", replyFile: "/r", readsWorkDir: true }).join(" ");
      for (const banned of ["Bash", "Edit", "Write", "bash", "edit", "write", "workspace-write", "dangerously", "bypass", "--add-dir"]) {
        expect(args).not.toContain(banned);
      }
    }
  });

  it("says what each CLI may do with the folder", () => {
    for (const item of INTERPRETERS) {
      expect(item.folderBoundary).toContain("folder you chose");
      expect(item.folderBoundary).toMatch(/cannot change or run anything|touches nothing else/);
    }
  });
});
