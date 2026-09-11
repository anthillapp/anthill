/**
 * Local observation setup.
 *
 * This module only manages Anthill's passive hook entries. Status checks do not
 * write configuration, and install/disable touch only entries whose command is
 * marked as Anthill-owned.
 */

import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { detectBinary, runProcess, type SpawnFn } from "@anthill/runtimes";
import type { MarkerCli } from "@anthill/live";

import type {
  ObservationHarnessSetup,
  ObservationSetupActionResult,
  ObservationSetupStatus,
} from "../../shared/ipc.js";

const OWNER_MARKER = "anthill-observation-hook";

const HARNESS = {
  "claude-code": {
    label: "Claude Code",
    cliCommand: "claude",
    configFile: () => join(homedir(), ".claude", "settings.json"),
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SubagentStop",
      "Notification",
      "SessionEnd",
    ],
    matcherEvents: new Set(["PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification"]),
    boundary:
      "Anthill reads local hook events and Claude Code session transcripts on this machine. It stores only observation state and correlation metadata needed for Live Session UI, never private reasoning.",
  },
  codex: {
    label: "Codex CLI",
    cliCommand: "codex",
    configFile: () => join(homedir(), ".codex", "hooks.json"),
    events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"],
    matcherEvents: new Set<string>(),
    boundary:
      "Anthill reads local hook events and Codex rollout/session metadata on this machine. It stores only observation state and correlation metadata needed for Live Session UI, never private reasoning.",
  },
} as const;

/**
 * The harnesses with a config file Anthill can install observation hooks
 * into.
 *
 * pi has no config-file hook mechanism — its extension hooks are TypeScript
 * that pi itself loads — so it is not in this table. Its observation is the
 * session files it writes for itself, which need no install and no status
 * row here.
 */
type HookHarness = "claude-code" | "codex";

type HarnessDefinition = (typeof HARNESS)[HookHarness];

type SetupPrefs = {
  dismissed?: boolean;
  harnesses?: Partial<Record<MarkerCli, { installedAt?: string; disabledAt?: string }>>;
};

export type ObservationSetupPaths = {
  prefsPath?: string;
  /** The machine-wide hook log, so the card can say whether anything arrived. */
  hookLogPath?: string;
  claudeConfigPath?: string;
  codexConfigPath?: string;
  hookHandlerPath?: string;
  /**
   * The interpreter the installed hook command names.
   *
   * Defaults to Anthill's own binary, which is the point: a hook that says
   * `node` is resolved against whatever PATH the harness happens to have, and
   * a machine whose node comes from a version manager usually has none. The
   * app already ships an interpreter that certainly exists — itself, run with
   * `ELECTRON_RUN_AS_NODE`.
   */
  execPath?: string;
};

export class ObservationSetupService {
  constructor(
    private readonly paths: ObservationSetupPaths,
    private readonly spawnFn?: SpawnFn,
  ) {}

  async status(): Promise<ObservationSetupStatus> {
    const prefs = await this.readPrefs();
    return {
      dismissed: prefs.dismissed === true,
      trigger: "Shown after the first meaningful Workflow edit: a workflow is open and the edit makes it unsaved.",
      harnesses: await Promise.all(
        (Object.keys(HARNESS) as HookHarness[]).map((id) => this.describeHarness(id, prefs)),
      ),
    };
  }

  async dismiss(): Promise<ObservationSetupStatus> {
    await this.writePrefs({ dismissed: true });
    return this.status();
  }

  async install(harness: MarkerCli): Promise<ObservationSetupActionResult> {
    return this.modify(harness, "install");
  }

  async disable(harness: MarkerCli): Promise<ObservationSetupActionResult> {
    return this.modify(harness, "disable");
  }

  private async modify(
    harness: MarkerCli,
    action: "install" | "disable",
  ): Promise<ObservationSetupActionResult> {
    try {
      if (!isHookHarnessId(harness)) {
        return {
          ok: false,
          status: await this.status(),
          error: `Unsupported observation harness: ${String(harness)}.`,
        };
      }
      const def = HARNESS[harness];
      const configPath = this.configPath(harness);
      const hookHandlerPath = this.hookHandlerPath();
      if (action === "install" && !existsSync(hookHandlerPath)) {
        return {
          ok: false,
          status: await this.status(),
          error: `Anthill's hook handler was not found at ${hookHandlerPath}.`,
        };
      }

      const before = await this.readJsonObject(configPath);
      const backupPath = await this.backup(configPath);
      const after =
        action === "install"
          ? withAnthillHooks(before, def, harness, hookHandlerPath, this.execPath())
          : withoutAnthillHooks(before, def);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, `${JSON.stringify(after, null, 2)}\n`, "utf8");

      await this.recordHarnessAction(harness, action);
      const status = await this.status();
      const installed = status.harnesses.find((item) => item.id === harness)?.hookInstalled;
      if (action === "install" && !installed) {
        return {
          ok: false,
          status,
          backupPath,
          error: `${def.label} hooks were written, but verification did not find the expected Anthill entries.`,
        };
      }
      return {
        ok: true,
        status,
        backupPath,
        message:
          action === "install"
            ? `${def.label} observation hooks are enabled. This affects Anthill observation only.`
            : `${def.label} observation hooks are disabled. The CLI itself is unchanged.`,
      };
    } catch (error) {
      return {
        ok: false,
        status: await this.status(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async describeHarness(id: HookHarness, prefs?: SetupPrefs): Promise<ObservationHarnessSetup> {
    const def = HARNESS[id];
    const installedAt = prefs?.harnesses?.[id]?.installedAt;
    const detection = await detectBinary({
      command: def.cliCommand,
      notFoundReason: `${def.label} was not found on your PATH.`,
      spawnFn: this.spawnFn,
    });
    const configPath = this.configPath(id);
    const config = await this.readJsonObject(configPath).catch(() => ({}));
    const hookHandlerPath = this.hookHandlerPath();
    const entriesPresent = hasEveryAnthillHook(config, def) && existsSync(hookHandlerPath);
    // Only worth probing when there is something to probe: a run costs a
    // process, and "not installed" is already the honest answer.
    const problem = entriesPresent
      ? await this.probeHook(anthillCommands(config, def)[0])
      : undefined;
    // Asked only when there is an install to describe: a harness with no
    // entries has nothing to have fired.
    const lastEventAt = entriesPresent ? await this.lastHookEvent(id) : undefined;
    return {
      id,
      label: def.label,
      cliCommand: def.cliCommand,
      cliAvailable: detection.available,
      ...(detection.version ? { version: trimVersion(detection.version) } : {}),
      ...(detection.available ? {} : { reason: detection.reason }),
      hookInstalled: entriesPresent && problem === undefined,
      hookEntriesPresent: entriesPresent,
      ...(problem ? { hookProblem: problem } : {}),
      ...(lastEventAt ? { hookLastEventAt: lastEventAt } : {}),
      ...(installedAt && entriesPresent ? { hookInstalledAt: installedAt } : {}),
      configPath,
      hookHandlerPath,
      installerAction:
        "No shell installer command is run. After you click Enable, Anthill's main process backs up and merges Anthill-owned hook entries into this local config file.",
      installCommand: commandFor(id, def.events[0], hookHandlerPath, this.execPath()),
      hookCommands: def.events.map((event) =>
        commandFor(id, event, hookHandlerPath, this.execPath()),
      ),
      eventCategories: def.events.map(labelEvent),
      localDataBoundary: `${def.boundary} MCP is optional and not required for this hooks-based observation.`,
      changes: [
        `Back up ${configPath} before changing it.`,
        `Merge Anthill-owned hook entries into ${configPath}; unrelated hooks stay in place.`,
        `Reference ${hookHandlerPath} from each Anthill hook entry.`,
        "Record hook payloads locally for observation; do not start, attach to, stop, or steer any session.",
      ],
    };
  }

  private configPath(harness: HookHarness): string {
    if (harness === "claude-code") return this.paths.claudeConfigPath ?? HARNESS[harness].configFile();
    return this.paths.codexConfigPath ?? HARNESS[harness].configFile();
  }

  private hookHandlerPath(): string {
    return this.paths.hookHandlerPath ?? join(__dirname, "live-hook-handler.js");
  }

  private execPath(): string {
    return this.paths.execPath ?? process.execPath;
  }

  /**
   * Run the hook once, exactly as written, and say what went wrong if it will
   * not run.
   *
   * Checking that the entries exist and the file is on disk was the whole of
   * verification, and it passed on a machine where every hook had been failing
   * since installation — the interpreter the command named was not on the
   * harness's PATH. Entries prove the install wrote them; only running the
   * thing proves the harness can run it.
   *
   * So the probe runs *the command in the config*, not the command Anthill
   * would write today, and runs it through a shell because that is how a
   * harness invokes a hook. Anything else would verify a different thing than
   * the one that fires: an install written by an older version, naming an
   * interpreter that has since moved, has to fail this check — that is the
   * whole case it exists for.
   *
   * It writes to a temporary log rather than the real one, so it exercises the
   * handler's actual job — parse, open, append — without putting a fake event
   * in anybody's record.
   */
  private async probeHook(command: string | undefined): Promise<string | undefined> {
    if (!command) return "No Anthill hook command was found in the config file.";
    // Before running anything: a command that names its interpreter by bare
    // name is resolved against whatever PATH the *harness* has, which is not
    // the PATH Anthill has and not one Anthill can see. Such a command can
    // pass the probe here and still fail every time it actually fires — which
    // is exactly what happened. It is unverifiable by construction, so it does
    // not get to be called working.
    if (pathDependent(command)) {
      return "The hook command finds its interpreter through PATH, which the harness may not share with Anthill. Re-enable observation to rewrite the entries with an absolute path.";
    }
    const log = join(tmpdir(), `anthill-hook-probe-${process.pid}-${Date.now()}.jsonl`);
    try {
      const outcome = await runProcess({
        command: "/bin/sh",
        args: ["-c", command],
        env: { ANTHILL_LIVE_HOOK_LOG: log },
        stdinPayload: "{}",
        timeoutMs: 10_000,
        ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
      });
      if (outcome.spawnError) {
        return `The hook command could not be started: ${outcome.spawnError.message}. Re-enable observation to rewrite the hook entries.`;
      }
      if (outcome.exitCode !== 0) {
        const said = (outcome.stderr || outcome.stdout).trim().split("\n")[0];
        return `The hook command exited with ${outcome.exitCode}${said ? `: ${said}` : "."} Re-enable observation to rewrite the hook entries.`;
      }
      return undefined;
    } catch (error) {
      return `The hook command could not be checked: ${(error as Error).message}`;
    } finally {
      await rm(log, { force: true }).catch(() => undefined);
    }
  }

  private hookLogPath(): string {
    return this.paths.hookLogPath ?? join(homedir(), ".anthill", "live-hooks", "events.jsonl");
  }

  /**
   * When this harness last wrote to the hook log, if it ever has.
   *
   * ANT-42. Verification runs the hook command, which proves Anthill can run
   * it; it says nothing about whether the harness ever does. Codex had six
   * entries in `~/.codex/hooks.json`, written with an absolute interpreter
   * path, a handler that runs on demand, and — across eight sessions — not one
   * event. Claude Code's hooks had written hundreds to the same file in the
   * same period, so the log and the handler were both plainly fine. Only the
   * harness was not calling it, and the card said Enabled throughout.
   *
   * The log is a line per event and is read whole: it is the only place the
   * answer lives, and a harness that has never fired is exactly the case where
   * no shortcut from the end of the file can stop early.
   */
  private async lastHookEvent(harness: HookHarness): Promise<string | undefined> {
    const text = await readFile(this.hookLogPath(), "utf8").catch(() => "");
    if (!text) return undefined;
    const marker = `"harness":"${harness}"`;
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes(marker)) continue;
      try {
        const row = JSON.parse(line) as { recordedAt?: unknown };
        if (typeof row.recordedAt === "string") return row.recordedAt;
      } catch {
        // A line the app was killed halfway through writing. Keep looking
        // back rather than reporting a time this cannot read.
        continue;
      }
    }
    return undefined;
  }

  private prefsPath(): string {
    return this.paths.prefsPath ?? join(homedir(), ".anthill", "live-observation-setup.json");
  }

  private async readPrefs(): Promise<SetupPrefs> {
    const text = await readFile(this.prefsPath(), "utf8").catch(() => "");
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as SetupPrefs;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async writePrefs(prefs: SetupPrefs): Promise<void> {
    const path = this.prefsPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
  }

  private async updatePrefs(update: (prefs: SetupPrefs) => SetupPrefs): Promise<void> {
    await this.writePrefs(update(await this.readPrefs()));
  }

  private async recordHarnessAction(harness: HookHarness, action: "install" | "disable"): Promise<void> {
    const now = new Date().toISOString();
    await this.updatePrefs((prefs) => ({
      ...prefs,
      dismissed: true,
      harnesses: {
        ...(prefs.harnesses ?? {}),
        [harness]:
          action === "install"
            ? { installedAt: now }
            : { ...(prefs.harnesses?.[harness] ?? {}), disabledAt: now },
      },
    }));
  }

  private async readJsonObject(path: string): Promise<Record<string, unknown>> {
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!text.trim()) return {};
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object.`);
    return parsed;
  }

  private async backup(path: string): Promise<string | undefined> {
    const exists = await stat(path).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!exists) return undefined;
    const backupPath = `${path}.anthill-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(path, backupPath);
    return backupPath;
  }
}

/**
 * The command an installed hook entry runs.
 *
 * The interpreter is named by absolute path rather than as `node`, because a
 * hook is spawned by the harness with whatever environment the harness has —
 * which on a machine using a version manager does not include the shell PATH
 * where `node` lives. Anthill's own binary is always there, and
 * `ELECTRON_RUN_AS_NODE` makes it behave as node.
 */
function commandFor(
  harness: MarkerCli,
  event: string,
  hookHandlerPath: string,
  execPath: string,
): string {
  return `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${hookHandlerPath}" ${OWNER_MARKER} ${harness} ${event}`;
}

function hookEntry(
  harness: MarkerCli,
  event: string,
  def: HarnessDefinition,
  hookHandlerPath: string,
  execPath: string,
) {
  const entry: Record<string, unknown> = {
    hooks: [
      {
        type: "command",
        command: commandFor(harness, event, hookHandlerPath, execPath),
      },
    ],
  };
  if (def.matcherEvents.has(event)) entry.matcher = "*";
  return entry;
}

function withAnthillHooks(
  config: Record<string, unknown>,
  def: HarnessDefinition,
  harness: MarkerCli,
  hookHandlerPath: string,
  execPath: string,
): Record<string, unknown> {
  const hooks = hooksObject(config);
  for (const event of def.events) {
    const existing = entriesFor(hooks[event]).filter((entry) => !isAnthillEntry(entry));
    hooks[event] = [...existing, hookEntry(harness, event, def, hookHandlerPath, execPath)];
  }
  return { ...config, hooks };
}

function withoutAnthillHooks(
  config: Record<string, unknown>,
  def: HarnessDefinition,
): Record<string, unknown> {
  const hooks = hooksObject(config);
  for (const event of def.events) {
    hooks[event] = entriesFor(hooks[event]).filter((entry) => !isAnthillEntry(entry));
  }
  return { ...config, hooks };
}

/**
 * Whether a command leaves it to PATH to find its interpreter.
 *
 * Leading `NAME=value` assignments are the shell's, not the command's; the
 * first token after them is the program. An absolute path is the only form
 * that means the same thing in every environment.
 */
function pathDependent(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const program = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  if (!program) return true;
  return !program.replace(/^"/, "").startsWith("/");
}

/** The commands Anthill's own entries currently carry — what actually fires. */
function anthillCommands(config: Record<string, unknown>, def: HarnessDefinition): string[] {
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  const out: string[] = [];
  for (const event of def.events) {
    for (const entry of entriesFor(hooks[event])) {
      if (typeof entry.command === "string" && entry.command.includes(OWNER_MARKER)) {
        out.push(entry.command);
        continue;
      }
      for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
        if (isRecord(hook) && typeof hook.command === "string" && hook.command.includes(OWNER_MARKER)) {
          out.push(hook.command);
        }
      }
    }
  }
  return out;
}

function hasEveryAnthillHook(config: Record<string, unknown>, def: HarnessDefinition): boolean {
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  return def.events.every((event) => entriesFor(hooks[event]).some(isAnthillEntry));
}

function hooksObject(config: Record<string, unknown>): Record<string, unknown> {
  return isRecord(config.hooks) ? { ...config.hooks } : {};
}

function entriesFor(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isAnthillEntry(entry: Record<string, unknown>): boolean {
  if (typeof entry.command === "string" && entry.command.includes(OWNER_MARKER)) return true;
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  return hooks.some(
    (hook) => isRecord(hook) && typeof hook.command === "string" && hook.command.includes(OWNER_MARKER),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimVersion(version: string): string {
  return version.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function labelEvent(event: string): string {
  return event
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace("Pre Tool Use", "Tool start")
    .replace("Post Tool Use", "Tool completion")
    .replace("User Prompt Submit", "User prompt submit");
}

function isHookHarnessId(value: unknown): value is HookHarness {
  return value === "claude-code" || value === "codex";
}
