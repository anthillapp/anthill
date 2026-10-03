import { describe, expect, it } from "vitest";
import type { ChildProcessLike, SpawnFn } from "@anthill/runtimes";

import { INTERPRETERS } from "@anthill/workflow";

import {
  FOLDER_MISSING,
  describeCommand,
  detectInterpreters,
  grantedDraftFolder,
  runDraft,
  shortenHome,
  signInToInterpreter,
} from "./interpreters.js";
import { FolderGrants } from "./safe-write.js";

type Script = { stdout?: string; stderr?: string; exitCode?: number; error?: NodeJS.ErrnoException };

type Recorded = { command: string; args: string[]; cwd?: string; stdin: string };

/**
 * A spawn that replays a script per call.
 *
 * Local rather than shared with the runtimes fixtures: those live in that
 * package's source and are not part of its published surface, and a thirty-line
 * fake is cheaper than exporting test scaffolding across a package boundary.
 */
function fakeSpawn(scripts: Script[]): { spawnFn: SpawnFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;

  const spawnFn: SpawnFn = (command, args, options) => {
    const script = scripts[Math.min(index, scripts.length - 1)];
    index += 1;
    const call: Recorded = { command, args: [...args], cwd: options.cwd, stdin: "" };
    calls.push(call);

    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const on = (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    };
    const emit = (target: Map<string, ((...args: unknown[]) => void)[]>, event: string, ...payload: unknown[]) => {
      for (const listener of target.get(event) ?? []) listener(...payload);
    };

    const stdoutListeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const stderrListeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const streamOn = (target: Map<string, ((...args: unknown[]) => void)[]>) =>
      (event: string, listener: (...args: unknown[]) => void) => {
        target.set(event, [...(target.get(event) ?? []), listener]);
        return undefined;
      };

    const child: ChildProcessLike = {
      stdout: { on: streamOn(stdoutListeners), setEncoding: () => undefined },
      stderr: { on: streamOn(stderrListeners), setEncoding: () => undefined },
      stdin: {
        write: (chunk: string) => {
          call.stdin += chunk;
          return true;
        },
        end: () => undefined,
        on: () => undefined,
      },
      on,
      kill: () => undefined,
    };

    queueMicrotask(() => {
      if (script.error) {
        emit(listeners, "error", script.error);
        return;
      }
      if (script.stdout) emit(stdoutListeners, "data", script.stdout);
      if (script.stderr) emit(stderrListeners, "data", script.stderr);
      emit(listeners, "close", script.exitCode ?? 0);
    });

    return child;
  };

  return { spawnFn, calls };
}

const missing = (): NodeJS.ErrnoException =>
  Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });

describe("the command shown to the author", () => {
  it("is what will actually be run", () => {
    // Both are built from the same table, so the screen cannot promise one
    // command and main run another.
    expect(describeCommand("claude-code")).toBe(
      'claude -p --output-format text --tools "" --strict-mcp-config',
    );
  });

  it("gives the interpreter no tools and no outside configuration", () => {
    const claude = describeCommand("claude-code");
    expect(claude).toContain('--tools ""');
    expect(claude).toContain("--strict-mcp-config");

    const codex = describeCommand("codex");
    expect(codex).toContain("--sandbox read-only");
    expect(codex).toContain("--ignore-user-config");
    expect(codex).toContain("--ignore-rules");
  });

  it("never asks for write access or a bypass", () => {
    for (const id of ["claude-code", "codex"] as const) {
      const command = describeCommand(id);
      expect(command).not.toContain("dangerously");
      expect(command).not.toContain("workspace-write");
      expect(command).not.toContain("bypassPermissions");
      expect(command).not.toContain("--add-dir");
    }
  });
});

describe("detecting what is installed", () => {
  it("reports an installed CLI with its version", async () => {
    const { spawnFn } = fakeSpawn([{ stdout: "1.2.3\n" }]);
    const found = await detectInterpreters(spawnFn);
    expect(found[0]).toMatchObject({ id: "claude-code", available: true, version: "1.2.3" });
  });

  it("lists a missing CLI rather than hiding it, and says why", async () => {
    const { spawnFn } = fakeSpawn([{ error: missing() }]);
    const found = await detectInterpreters(spawnFn);
    // Omitting it would leave the author wondering whether Anthill supports it.
    expect(found).toHaveLength(3);
    expect(found[0]).toMatchObject({ available: false });
    expect(found[0].reason).toContain("not found on your PATH");
  });

  it("carries the command and the boundary, so the UI cannot invent either", async () => {
    const { spawnFn } = fakeSpawn([{ stdout: "1.0.0" }]);
    const found = await detectInterpreters(spawnFn);
    expect(found[0].command).toBe(describeCommand("claude-code"));
    expect(found[0].boundary).toContain("cannot");
  });
});

describe("running one drafting pass", () => {
  const instruction = "Draft a workflow from this.";

  it("hands the instruction to the CLI on stdin", async () => {
    const { spawnFn, calls } = fakeSpawn([{ stdout: "1.0" }, { stdout: "{}" }]);
    await runDraft({ interpreterId: "claude-code", instruction, spawnFn });
    expect(calls[1].stdin).toBe(instruction);
  });

  it("returns the reply untouched, for the workflow to parse", async () => {
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: 'Sure!\n{"draftVersion":1}' }]);
    const result = await runDraft({ interpreterId: "claude-code", instruction, spawnFn });
    expect(result).toMatchObject({ ok: true, reply: 'Sure!\n{"draftVersion":1}' });
  });

  it("runs in a temporary folder, not in the author's project", async () => {
    const { spawnFn, calls } = fakeSpawn([{ stdout: "1.0" }, { stdout: "{}" }]);
    await runDraft({ interpreterId: "claude-code", instruction, spawnFn });
    expect(calls[1].cwd).toContain("anthill-draft-");
    expect(calls[1].cwd).not.toContain("anthill/apps");
  });

  it("refuses when the chosen CLI is not installed, and does not use the other", async () => {
    const { spawnFn, calls } = fakeSpawn([{ error: missing() }]);
    const result = await runDraft({ interpreterId: "codex", instruction, spawnFn });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Codex CLI was not found");
    // Detection only. Silently drafting the author's workflow with a different
    // model is not a decision Anthill gets to make for them.
    expect(calls).toHaveLength(1);
    expect(result.command).toContain("codex");
  });

  it("reports a non-zero exit with whatever the CLI said about it", async () => {
    const { spawnFn } = fakeSpawn([
      { stdout: "1.0" },
      { stderr: "not logged in", exitCode: 1 },
    ]);
    const result = await runDraft({ interpreterId: "claude-code", instruction, spawnFn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not logged in");
  });

  it("reports an empty reply rather than passing nothing on to be parsed", async () => {
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: "   " }]);
    const result = await runDraft({ interpreterId: "claude-code", instruction, spawnFn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned nothing");
  });

  it("falls back to stdout when Codex wrote no reply file", async () => {
    // The file is the reliable path; stdout is what is left if it is missing.
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: '{"draftVersion":1}' }]);
    const result = await runDraft({ interpreterId: "codex", instruction, spawnFn });
    expect(result).toMatchObject({ ok: true, reply: '{"draftVersion":1}' });
  });

  it("gives up on a CLI that never answers", async () => {
    const spawnFn: SpawnFn = (_command, _args, _options) => ({
      stdout: { on: () => undefined, setEncoding: () => undefined },
      stderr: { on: () => undefined, setEncoding: () => undefined },
      stdin: { write: () => true, end: () => undefined, on: () => undefined },
      on: () => undefined,
      kill: () => undefined,
    });
    const detect = fakeSpawn([{ stdout: "1.0" }]);
    let first = true;
    const combined: SpawnFn = (command, args, options) => {
      if (first) {
        first = false;
        return detect.spawnFn(command, args, options);
      }
      return spawnFn(command, args, options);
    };

    const result = await runDraft({
      interpreterId: "claude-code",
      instruction,
      spawnFn: combined,
      timeoutMs: 30,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("did not answer");
  });
});

describe("progress, cancellation and retry", () => {
  const instruction = "Draft a workflow from this.";

  it("reports its own stages, then the one the interpreter evidences", () => {
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: "{}" }]);
    const stages: string[] = [];
    return runDraft({
      interpreterId: "claude-code",
      instruction,
      spawnFn,
      onStage: (stage) => stages.push(stage),
    }).then(() => {
      // Finding the CLI, waiting for it, and then its first byte of answer —
      // the only stage here the child itself evidences.
      expect(stages).toEqual(["preparing", "analyzing", "replying"]);
    });
  });

  it("does not call a stderr greeting an answer", async () => {
    // Codex prints a config banner to stderr within a second of starting,
    // long before it has anything to say. That is not the draft arriving.
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stderr: "banner", exitCode: 1 }]);
    const stages: string[] = [];
    await runDraft({
      interpreterId: "claude-code",
      instruction,
      spawnFn,
      onStage: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(["preparing", "analyzing"]);
  });

  it("does not report analyzing when the CLI was never found", async () => {
    const { spawnFn } = fakeSpawn([{ error: missing() }]);
    const stages: string[] = [];
    await runDraft({
      interpreterId: "claude-code",
      instruction,
      spawnFn,
      onStage: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(["preparing"]);
  });

  it("stops before spawning when cancelled during preflight", async () => {
    const { spawnFn, calls } = fakeSpawn([{ stdout: "1.0" }]);
    const controller = new AbortController();
    controller.abort();

    const result = await runDraft({
      interpreterId: "claude-code",
      instruction,
      spawnFn,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(calls).toHaveLength(0);
  });

  it("reports a cancelled run as cancelled, not as a failure", async () => {
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }]);
    const controller = new AbortController();
    // Abort once the CLI has been reached, which is when a person would.
    const combined: SpawnFn = (command, args, options) => {
      if (args[0] !== "--version") queueMicrotask(() => controller.abort());
      return spawnFn(command, args, options);
    };

    const result = await runDraft({
      interpreterId: "claude-code",
      instruction,
      spawnFn: combined,
      signal: controller.signal,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The author asked for this; showing it as an error would be a lie.
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("can be run again after a failure, with nothing left over", async () => {
    const failing = fakeSpawn([{ stdout: "1.0" }, { stderr: "rate limited", exitCode: 1 }]);
    const first = await runDraft({ interpreterId: "claude-code", instruction, spawnFn: failing.spawnFn });
    expect(first.ok).toBe(false);

    const working = fakeSpawn([{ stdout: "1.0" }, { stdout: '{"draftVersion":1}' }]);
    const second = await runDraft({ interpreterId: "claude-code", instruction, spawnFn: working.spawnFn });
    expect(second).toMatchObject({ ok: true, reply: '{"draftVersion":1}' });
  });

  it("keeps a failed run's scratch folder out of the way", async () => {
    // The folder is made per run and removed whatever happens, so a retry does
    // not accumulate them.
    const { spawnFn, calls } = fakeSpawn([
      { stdout: "1.0" },
      { stderr: "boom", exitCode: 1 },
    ]);
    await runDraft({ interpreterId: "claude-code", instruction, spawnFn });
    const { existsSync } = await import("node:fs");
    expect(existsSync(calls[1].cwd as string)).toBe(false);
  });
});

describe("the version shown beside a tool", () => {
  it("drops a parenthetical that repeats the tool's own name", async () => {
    // `claude --version` prints "2.1.226 (Claude Code)".
    const { spawnFn } = fakeSpawn([{ stdout: "2.1.226 (Claude Code)\n" }]);
    const found = await detectInterpreters(spawnFn);
    expect(found[0].version).toBe("2.1.226");
  });

  it("leaves a plain version alone", async () => {
    const { spawnFn } = fakeSpawn([{ stdout: "codex-cli 0.147.0\n" }]);
    const found = await detectInterpreters(spawnFn);
    expect(found[0].version).toBe("codex-cli 0.147.0");
  });
});

/**
 * Asking a CLI whether anybody is signed in, and opening the way back in.
 *
 * The point of asking before a draft: an expired session is the one failure
 * that lets a run look fine for a minute and then fail for a reason the prompt
 * had nothing to do with.
 */
describe("sign-in state", () => {
  const claude = INTERPRETERS.find((item) => item.id === "claude-code")!;
  const codex = INTERPRETERS.find((item) => item.id === "codex")!;

  it("reads Claude Code's JSON both ways", () => {
    expect(claude.readStatus('{"loggedIn": true}', 0)).toBe(true);
    expect(claude.readStatus('{"loggedIn": false}', 0)).toBe(false);
  });

  it("reads Codex's sentence both ways", () => {
    expect(codex.readStatus("Logged in using ChatGPT", 0)).toBe(true);
    expect(codex.readStatus("Not logged in", 1)).toBe(false);
  });

  it("answers nothing when it cannot tell", () => {
    // An unfamiliar version or a changed format is not evidence of being
    // signed out, and must not put a sign-in notice in front of anyone.
    expect(claude.readStatus("not json at all", 0)).toBeUndefined();
    expect(claude.readStatus('{"other": 1}', 0)).toBeUndefined();
    expect(codex.readStatus("something new", 0)).toBeUndefined();
  });

  it("does not ask pi, which has no non-interactive sign-in check", () => {
    const pi = INTERPRETERS.find((item) => item.id === "pi")!;
    // The question is not asked at all; the answer stays `undefined` rather
    // than being read as a sign-out.
    expect(pi.statusArgs).toBeUndefined();
    expect(pi.readStatus("whatever", 0)).toBeUndefined();
  });
});

describe("opening the way back in", () => {
  it("refuses an id that is not one of ours", async () => {
    // The command is looked up here, never taken from the caller, so nothing
    // crossing IPC can turn into something run in a shell.
    const { spawnFn, calls } = fakeSpawn([{ exitCode: 0 }]);
    const outcome = await signInToInterpreter("; rm -rf /", spawnFn);
    expect(outcome.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("opens the terminal through LaunchServices, not Apple events", async () => {
    // Driving Terminal is an Apple event, gated behind the Automation
    // permission — which blocked on its own approval dialog long enough for a
    // ten-second timeout to report a failure that had not happened. `open`
    // needs no such grant.
    const { spawnFn, calls } = fakeSpawn([{ exitCode: 0 }]);
    const outcome = await signInToInterpreter("claude-code", spawnFn);
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.command).toBe("open");
    expect(calls[0]?.args.slice(0, 2)).toEqual(["-a", "Terminal"]);
    expect(calls[0]?.args[2]).toContain("sign-in-to-claude-code.command");
  });

  it("says why when the terminal does not open", async () => {
    // A button that reports a bare failure leaves nothing to act on.
    const { spawnFn } = fakeSpawn([{ exitCode: 1, stderr: "no application found" }]);
    const outcome = await signInToInterpreter("claude-code", spawnFn);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("no application");
  });
});

/**
 * An expired CLI sign-in is the one failure with a way out, so it is named
 * rather than relayed (ANT-111).
 *
 * It used to come back as "exited with code 1: Failed to authenticate: OAuth
 * session expired and could not be refreshed" — the CLI talking to itself, in
 * a panel with no button and no explanation.
 */
describe("a CLI whose sign-in has expired", () => {
  const instruction = "Add a step.";
  const EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";

  it("says the sign-in expired, and which CLI it was", async () => {
    const { spawnFn } = fakeSpawn([
      { stdout: "1.0" },                                        // detect
      { stderr: EXPIRED, exitCode: 1 },                         // the draft
      { stdout: JSON.stringify({ loggedIn: false }) },          // auth status
    ]);

    const result = await runDraft({ interpreterId: "claude-code", instruction, spawnFn });

    expect(result).toMatchObject({ ok: false, signedOut: "claude-code" });
    if (!result.ok && result.error) {
      expect(result.error).toContain("sign-in has expired");
      // Anthill cannot sign anyone in, and says so where the author decides.
      expect(result.error).toContain("never sees your sign-in");
      expect(result.error).not.toContain("exited with code");
    }
  });

  /**
   * The wording belongs to the CLI and will change, so it is a trigger for
   * asking and never the verdict. Here the message looks like an auth failure
   * and the CLI says it is signed in — which means something else is wrong.
   */
  it("does not claim a sign-in expired when the CLI says it has not", async () => {
    const { spawnFn } = fakeSpawn([
      { stdout: "1.0" },
      { stderr: "could not authenticate with the proxy", exitCode: 1 },
      { stdout: JSON.stringify({ loggedIn: true }) },
    ]);

    const result = await runDraft({ interpreterId: "claude-code", instruction, spawnFn });

    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty("signedOut");
    if (!result.ok && result.error) expect(result.error).toContain("exited with code");
  });

  it("leaves an ordinary failure exactly as it was, and asks nothing", async () => {
    const { spawnFn, calls } = fakeSpawn([
      { stdout: "1.0" },
      { stderr: "the prompt was too long", exitCode: 1 },
    ]);

    const result = await runDraft({ interpreterId: "claude-code", instruction, spawnFn });

    expect(result).not.toHaveProperty("signedOut");
    if (!result.ok && result.error) expect(result.error).toContain("the prompt was too long");
    // No status call: a failure that does not look like one is not worth a
    // second process.
    expect(calls).toHaveLength(2);
  });
});

/**
 * A project folder (ANT-67). The CLI stands in the author's folder with
 * read-only tools, and main believes a folder only when its picker chose it.
 */
describe("drafting with a project folder", () => {
  const instruction = "Draft a workflow from this.";

  async function project(): Promise<string> {
    const { mkdtemp, writeFile, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await realpath(await mkdtemp(join(tmpdir(), "anthill-project-")));
    await writeFile(join(dir, "package.json"), "{}");
    return dir;
  }

  it("runs Claude Code in the folder, with only the tools that look", async () => {
    const folder = await project();
    const { spawnFn, calls } = fakeSpawn([{ stdout: "1.0" }, { stdout: "{}" }]);
    const result = await runDraft({ interpreterId: "claude-code", instruction, folder, spawnFn });
    expect(calls[1].cwd).toBe(folder);
    expect(calls[1].args).toEqual([
      "-p", "--output-format", "text", "--tools", "Read,Glob,Grep", "--restricted", "--strict-mcp-config",
    ]);
    // The record of what ran names the folder.
    expect(result.command).toBe(`cd ${folder} && claude -p --output-format text --tools Read,Glob,Grep --restricted --strict-mcp-config`);
  });

  it("writes Codex's reply outside the author's folder, and leaves the folder alone", async () => {
    const folder = await project();
    const { spawnFn, calls } = fakeSpawn([{ stdout: "1.0" }, { stdout: "{}" }]);
    await runDraft({ interpreterId: "codex", instruction, folder, spawnFn });
    const args = calls[1].args;
    expect(args[args.indexOf("-C") + 1]).toBe(folder);
    expect(args[args.indexOf("-o") + 1].startsWith(folder)).toBe(false);
    const { readdir } = await import("node:fs/promises");
    // Still there, and nothing added: cleaning up is for the scratch folder only.
    expect(await readdir(folder)).toEqual(["package.json"]);
  });

  it("says the folder has gone, and runs nothing", async () => {
    const { spawnFn, calls } = fakeSpawn([{ stdout: "1.0" }, { stdout: "{}" }]);
    const result = await runDraft({
      interpreterId: "claude-code",
      instruction,
      folder: "/nowhere/anthill-gone",
      spawnFn,
    });
    expect(result).toMatchObject({ ok: false, folderMissing: true, error: FOLDER_MISSING });
    expect(calls).toHaveLength(0);
  });

  it("believes a folder only when the picker returned it", async () => {
    const folder = await project();
    const grants = new FolderGrants();
    const request = { interpreterId: "claude-code" as const, instruction, folder };

    const refused = await grantedDraftFolder(request, grants);
    expect(refused.refused).toMatchObject({ ok: false });
    expect(refused.refused?.ok === false && refused.refused.error).toContain("did not open that folder");

    await grants.grant(folder);
    expect(await grantedDraftFolder(request, grants)).toEqual({ folder });
  });

  it("tells a missing folder apart from one never chosen", async () => {
    const result = await grantedDraftFolder(
      { interpreterId: "codex", instruction, folder: "/nowhere/anthill-gone" },
      new FolderGrants(),
    );
    expect(result.refused).toMatchObject({ ok: false, folderMissing: true, error: FOLDER_MISSING });
  });

  it("lets a request with no folder through untouched", async () => {
    expect(await grantedDraftFolder({ interpreterId: "pi", instruction }, new FolderGrants())).toEqual({});
  });

  it("shows the home directory as ~, and nothing else", () => {
    expect(shortenHome("/Users/me/code/acme-web", "/Users/me")).toBe("~/code/acme-web");
    expect(shortenHome("/Users/meadow/x", "/Users/me")).toBe("/Users/meadow/x");
    expect(shortenHome("/opt/x", "/Users/me")).toBe("/opt/x");
  });

  it("carries each CLI's folder boundary to the screen", async () => {
    const { spawnFn } = fakeSpawn([{ stdout: "1.0.0" }]);
    const found = await detectInterpreters(spawnFn);
    for (const item of found) expect(item.folderBoundary).toContain("folder you chose");
  });
});
