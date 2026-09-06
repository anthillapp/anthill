/**
 * Prompt-to-Workflow: running a local CLI as a workflow drafter.
 *
 * Anthill has no API keys, makes no cloud calls of its own, and has no network
 * configuration. What it has is whichever coding CLI the author already has
 * installed and signed in to. This module launches one of them, hands it the
 * drafting instruction, and takes back its text.
 *
 * It is not a runner. It runs one process, once, waits for it to finish, and
 * throws the process away. No run record, no worktree, no streaming, no
 * approvals, no `AgentRuntime`. `runProcess` and `detectBinary` are reused from
 * `@anthill/runtimes` because they are process plumbing rather than execution
 * semantics — nothing else from that package is imported.
 *
 * The safety boundary is threefold, and all of it is visible in the command the
 * author is shown before they run it:
 *
 * 1. No tools. Claude Code is given `--tools ""` and Codex a read-only sandbox,
 *    so neither can edit a file or run a command even if it decided to.
 * 2. No project. The working directory is an empty temporary folder, so there
 *    is nothing of the author's to read, let alone write.
 * 3. No configuration of the author's that could widen either. MCP servers and
 *    local hook/rule files are excluded, so a drafting run cannot pick up
 *    capabilities from an unrelated setup.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectBinary, runProcess, type SpawnFn } from "@anthill/runtimes";
import {
  INTERPRETERS,
  describeInterpreterCommand,
  interpreterDefinition,
  type InterpreterId,
} from "@anthill/workflow";

import type { InterpreterInfo, PromptDraftResponse } from "../shared/ipc.js";

/** How long a drafting run may take before it is given up on. */
const DRAFT_TIMEOUT_MS = 180_000;

/** The command as the author will see it, and as it is actually run. */
export function describeCommand(id: InterpreterId): string {
  return describeInterpreterCommand(id);
}

/**
 * Which interpreters are installed, and whether they start.
 *
 * `--version` is not a formality: it resolves the binary on PATH and runs it,
 * so a command that is present but cannot execute fails here rather than at the
 * point the author is waiting on a draft. Every interpreter is reported,
 * available or not — a list that silently omits an option leaves the author
 * wondering whether Anthill supports it at all.
 */
/**
 * `claude --version` prints "2.1.226 (Claude Code)". Beside a card already
 * headed "Claude Code", the parenthetical is the same word twice.
 */
function trimVersion(version: string): string {
  return version.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Whether this CLI currently has anybody signed in.
 *
 * Asked before a draft rather than discovered after one: an expired session is
 * the one failure that lets a run look fine for a minute and then fail for a
 * reason the prompt had nothing to do with.
 *
 * A question that cannot be answered stays unanswered. `undefined` is returned
 * for an unfamiliar output, a timeout, or a status command that would not run
 * — none of which is evidence that the author is signed out, and none of which
 * should put a sign-in notice in front of them.
 */
async function readSignedIn(
  item: (typeof INTERPRETERS)[number],
  spawnFn?: SpawnFn,
): Promise<boolean | undefined> {
  try {
    const outcome = await runProcess({
      command: item.command,
      args: item.statusArgs,
      timeoutMs: 5_000,
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (outcome.spawnError) return undefined;
    return item.readStatus(outcome.stdout, outcome.exitCode);
  } catch {
    return undefined;
  }
}

export async function detectInterpreters(spawnFn?: SpawnFn): Promise<InterpreterInfo[]> {
  return Promise.all(
    INTERPRETERS.map(async (item) => {
      const detection = await detectBinary({
        command: item.command,
        notFoundReason: `${item.label} was not found on your PATH.`,
        spawnFn,
      });
      // Only worth asking of a CLI that is actually there.
      const signedIn = detection.available ? await readSignedIn(item, spawnFn) : undefined;
      return {
        id: item.id,
        label: item.label,
        command: describeInterpreterCommand(item.id),
        boundary: item.boundary,
        available: detection.available,
        ...(detection.available && detection.version
          ? { version: trimVersion(detection.version) }
          : {}),
        ...(detection.available ? {} : { reason: detection.reason }),
        ...(signedIn === undefined ? {} : { signedIn }),
      };
    }),
  );
}

/**
 * The stages that happen in main.
 *
 * Only two, because only two are real here: finding the CLI, and waiting for
 * it. The renderer adds the stages it owns. Nothing reports a stage it has not
 * reached — a progress display that runs ahead of the work is worse than none.
 */
/**
 * The stages main can honestly report, and where each comes from.
 *
 * Probed empirically (2026-09-01) against the exact argv this app uses, with
 * per-byte timestamps:
 *
 * - Claude Code `-p --output-format text --tools ""`: silent for the whole
 *   run, then the answer flushes in one piece — first stdout byte at 5.8s of
 *   a 5.9s run. No intermediate signal exists in this mode. (stream-json
 *   would provide message events, but changes the reply contract; future.)
 * - Codex `exec -o file`: a config banner on stderr in the first second, then
 *   silence until the answer — stdout at 10.0s of a 10.3s run. Its thinking
 *   happens upstream and nothing streams meanwhile.
 *
 * So neither CLI, locked down for drafting, exposes real mid-run progress,
 * and the middle of the wait stays an illustrative product state — the sheet
 * says so in words. What both *do* evidence is the moment the answer starts
 * arriving: the first stdout byte. That is `replying`, and it is the only
 * stage here driven by the child's own output. The bytes are counted, never
 * read: Codex's stdout can carry reasoning summaries, and a progress label
 * must not become a transcript.
 */
export type DraftStage = "preparing" | "analyzing" | "replying";

export type DraftRunOptions = {
  interpreterId: InterpreterId;
  instruction: string;
  onStage?: (stage: DraftStage) => void;
  /** Aborts the run. The CLI is signalled and the scratch folder cleaned up. */
  signal?: AbortSignal;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
};

/**
 * Run one drafting pass and return whatever the CLI said.
 *
 * Deliberately returns text rather than a parsed draft: parsing and validating
 * belong to `@anthill/workflow`, where they are pure and tested, and keeping the
 * raw reply intact is what lets a malformed answer be shown to the author
 * instead of disappearing into an exception.
 */
export async function runDraft(options: DraftRunOptions): Promise<PromptDraftResponse> {
  const item = interpreterDefinition(options.interpreterId);
  const command = describeInterpreterCommand(options.interpreterId);

  options.onStage?.("preparing");
  if (options.signal?.aborted) return { ok: false, cancelled: true, command };

  const detection = await detectBinary({
    command: item.command,
    notFoundReason: `${item.label} was not found on your PATH.`,
    spawnFn: options.spawnFn,
  });
  if (!detection.available) {
    // Never fall back to the other CLI: the author chose this one, and quietly
    // using a different model to draft their workflow is not ours to decide.
    return { ok: false, error: detection.reason ?? `${item.label} is not available.`, command };
  }

  // An empty folder, so the interpreter has none of the author's work in reach.
  const workDir = await mkdtemp(join(tmpdir(), "anthill-draft-"));
  const replyFile = join(workDir, "reply.txt");

  try {
    const args = item.args(workDir, replyFile);
    options.onStage?.("analyzing");
    let replying = false;
    const outcome = await runProcess({
      command: item.command,
      args,
      stdinPayload: options.instruction,
      cwd: workDir,
      timeoutMs: options.timeoutMs ?? DRAFT_TIMEOUT_MS,
      signal: options.signal,
      spawnFn: options.spawnFn,
      // The one evidence-driven stage: the first stdout byte means the answer
      // has started arriving. stderr does not count — Codex greets on stderr
      // within a second of starting, long before it has anything to say.
      onOutput: (stream) => {
        if (stream !== "stdout" || replying) return;
        replying = true;
        options.onStage?.("replying");
      },
    });

    // Cancellation is not a failure, and must not be reported as one: the
    // author asked for it, and the screen goes back to their prompt.
    if (outcome.cancelled) return { ok: false, cancelled: true, command };

    if (outcome.spawnError) {
      return { ok: false, error: `${item.label} could not be started: ${outcome.spawnError.message}`, command };
    }
    if (outcome.timedOut) {
      return {
        ok: false,
        error: `${item.label} did not answer within ${Math.round((options.timeoutMs ?? DRAFT_TIMEOUT_MS) / 1000)}s.`,
        command,
      };
    }
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      return {
        ok: false,
        error: `${item.label} exited with code ${String(outcome.exitCode)}${detail ? `: ${detail}` : "."}`,
        command,
      };
    }

    const reply =
      item.replyFrom === "file"
        ? await readFile(replyFile, "utf8").catch(() => outcome.stdout)
        : outcome.stdout;

    if (reply.trim().length === 0) {
      return { ok: false, error: `${item.label} returned nothing.`, command };
    }
    return { ok: true, reply, command };
  } finally {
    // The folder was only ever a place to stand.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Open the author's terminal on a CLI's own sign-in command.
 *
 * The narrowest thing that answers "let me sign in from here". Anthill does
 * not sign anyone in: the browser flow is the CLI's and the account is the
 * author's, and no credential passes through this process at any point. What
 * this does is put the command somewhere the author can see it run and answer
 * whatever it asks — which a headless spawn could not, since a login prompt
 * with nobody able to read or reply to it is worse than no button at all.
 *
 * A `.command` file handed to `open`, rather than AppleScript telling Terminal
 * what to type. Driving Terminal is an Apple event, which macOS gates behind
 * the Automation permission — and that failed here in exactly the way such
 * things do: silently, with a button that reported only that it had not
 * worked. `open` goes through LaunchServices and needs no such grant.
 *
 * The command is never taken from the caller. The renderer sends an id, this
 * looks up the string in the table, and an id that is not in the table gets
 * nothing — so no argument crossing IPC can become something that runs.
 */
export type SignInOutcome = { ok: boolean; error?: string };

export async function signInToInterpreter(
  id: string,
  spawnFn?: SpawnFn,
): Promise<SignInOutcome> {
  const item = INTERPRETERS.find((candidate) => candidate.id === id);
  if (!item) return { ok: false, error: "That is not a CLI Anthill knows." };

  try {
    const dir = await mkdtemp(join(tmpdir(), "anthill-signin-"));
    const script = join(dir, `sign-in-to-${item.id}.command`);
    // Written out so the author can read it before it runs, and so the window
    // says what it is doing rather than showing a bare prompt.
    await writeFile(
      script,
      [
        "#!/bin/sh",
        `echo "Signing in to ${item.label} for Anthill."`,
        'echo "Anthill does not see your sign-in — this is the CLI\'s own login."',
        "echo",
        item.signIn,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const outcome = await runProcess({
      command: "open",
      args: ["-a", "Terminal", script],
      timeoutMs: 10_000,
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (outcome.spawnError) {
      return { ok: false, error: outcome.spawnError.message };
    }
    if (outcome.exitCode !== 0) {
      return { ok: false, error: (outcome.stderr || outcome.stdout).trim() || "Terminal did not open." };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
