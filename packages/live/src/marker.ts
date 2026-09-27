/**
 * The correlation marker Anthill embeds in a copied bootstrap prompt.
 *
 * Anthill does not launch anything. The user copies a prompt, pastes it into
 * their own Codex or Claude Code, and starts it there. So the only thing that
 * can tie a local session back to Anthill is something carried inside the text
 * the user pastes — and, usefully, both tools record the user's message
 * verbatim in their own session files. The marker therefore lands in a
 * tool-owned record without the agent having to cooperate at all.
 *
 * Two rules shape the format:
 *
 * - It must be hard to confuse with ordinary task text, so it is a labelled
 *   block with a nonce rather than a bare id someone could type by accident.
 * - It must be safe to paste anywhere. No secrets, no tokens, no file paths,
 *   nothing about the machine — a run id, a nonce, the workflow's own id, the
 *   chosen CLI, and a timestamp.
 */

export type MarkerCli = "codex" | "claude-code" | "pi";

export type RunMarker = {
  /** Stable Anthill Run ID, created before the prompt leaves Anthill. */
  runId: string;
  /** Random per-copy value, so an old copied prompt cannot match a new run. */
  nonce: string;
  /** The workflow this prompt came from, when it has an id. */
  workflowId?: string;
  cli: MarkerCli;
  /** Bumped when the marker's own shape changes, not when the workflow does. */
  promptVersion: string;
  issuedAt: string;
};

export const MARKER_VERSION = "1";

/** The label every marker line carries, so a scan can be exact. */
const FIELD = {
  runId: "anthill-run-id",
  nonce: "anthill-nonce",
  workflowId: "anthill-workflow",
  cli: "anthill-cli",
  promptVersion: "anthill-prompt-version",
  issuedAt: "anthill-issued-at",
} as const;

/**
 * Make a run id that reads as one.
 *
 * Prefixed and dashed so that finding it in a transcript is unambiguous, and
 * short enough that a person can compare it against what Anthill shows.
 */
export function newRunId(random: () => string = defaultRandom): string {
  return `ANT-${random().slice(0, 8).toUpperCase()}`;
}

/**
 * Whether a string is a run id this Anthill minted.
 *
 * Beside `newRunId` so the shape has one definition: a checker that drifted
 * from the minter would start refusing this app's own runs, which is the worst
 * way for it to fail.
 *
 * It **rejects** rather than repairing, and that is the point. A run id becomes
 * a file name in the observation journal, so `../../…` once addressed a file
 * outside it — and cancelling an observation deletes that file. Sanitising
 * would have been the obvious fix and the wrong one: mapping bad characters to
 * `_` gives two different ids the same journal, and one session then reads and
 * deletes another's record. An id that is not this shape did not come from
 * here, and the honest answer to it is no.
 */
export function isRunId(value: unknown): value is string {
  return typeof value === "string" && /^ANT-[A-Z0-9]{1,32}$/.test(value);
}

export function newNonce(random: () => string = defaultRandom): string {
  return random().slice(0, 6).toLowerCase();
}

function defaultRandom(): string {
  return Math.random().toString(36).slice(2).padEnd(12, "0");
}

/**
 * The marker as it appears at the top of a copied prompt.
 *
 * An HTML comment: raw enough that both tools store it verbatim, quiet enough
 * that it does not read as another instruction, and the first line explains
 * itself so the user is not left wondering what Anthill put in their prompt.
 */
export function renderMarker(marker: RunMarker): string {
  const lines = [
    "<!-- Anthill run marker. Anthill uses this to recognise this session on this",
    "     machine after you start it. It contains no secrets, tokens, or file paths.",
    `${FIELD.runId}: ${marker.runId}`,
    `${FIELD.nonce}: ${marker.nonce}`,
  ];
  if (marker.workflowId) lines.push(`${FIELD.workflowId}: ${marker.workflowId}`);
  lines.push(
    `${FIELD.cli}: ${marker.cli}`,
    `${FIELD.promptVersion}: ${marker.promptVersion}`,
    `${FIELD.issuedAt}: ${marker.issuedAt}`,
    "-->",
  );
  return lines.join("\n");
}

/**
 * The lines the agent is asked to print.
 *
 * Detection never depends on these: the run marker already reaches the session
 * file through the user's own pasted message, and a workflow whose steps are
 * never announced still shows a live session, just without per-step progress.
 * But the section used to end by saying so to the agent — "ignore this section
 * entirely if you cannot print such lines" — and agents took the offer: in a
 * measured run Claude Code printed the run and done lines every time and never
 * the step it delegated (ANT-162). So there is no way out offered any more,
 * only a second way in: a line printed by a command is read as well (ANT-147).
 *
 * The step line is what makes per-block progress *authoritative* rather than
 * guessed. Anthill has no other way to know which step a session is on — it is
 * not driving the session — so either the agent says so, or Anthill says it
 * does not know. There is no third option that is honest.
 */
export function echoInstruction(
  marker: RunMarker,
  steps: readonly { id: string; name: string }[] = [],
): string {
  const lines = [
    "## Progress markers",
    "",
    "Print these lines exactly, each on a line of its own, as plain output. They",
    "are correlation markers for the Anthill window on this machine and change",
    "nothing about the work itself. Print them yourself, in this session: a",
    "subagent's output does not count, so never leave one to a subagent.",
    "",
    `**Once, before you begin:**`,
    "",
    `    ${RUN_TOKEN} ${marker.runId} ${marker.nonce}`,
    "",
    `**Immediately before you start each step, and again whenever you come back to`,
    `an earlier one:**`,
    "",
    `    ${STEP_TOKEN} ${marker.runId} ${marker.nonce} <step-id>`,
  ];

  // The ids belong next to the instruction rather than at the end of the
  // prompt: an agent asked to print an id it has to go and find several
  // sections away usually does not print it at all.
  if (steps.length > 0) {
    lines.push(
      "",
      "Use exactly these step ids:",
      "",
      ...steps.map((step) => `- \`${step.id}\` – ${step.name}`),
    );
  }

  // The counterpart of `anthill done`. A prompt that could say which step it
  // was on but never that it had stopped left Anthill only the silence rule to
  // end on — five minutes after the last word, and later than that whenever
  // anything else was still claiming work (ANT-119).
  lines.push(
    "",
    "Once the work is finished, print one more line, exactly:",
    "",
    `    ${DONE_TOKEN} ${marker.runId} ${marker.nonce}`,
  );
  lines.push(
    "",
    "Each step below opens with the command that prints its line, so a step line",
    "can come from a command's output as well as from your reply; either is read the",
    "same way. The same goes for these two lines if you cannot put them in a reply.",
  );
  return lines.join("\n");
}

/**
 * What a step opens with in the compiled workflow: its own announcement.
 *
 * The section above lists every id, but it is read once, long before the
 * steps, and a step that says only "delegate to the developer subagent" gave
 * the agent nothing to remember it by at the moment that mattered. Measured
 * on the "Implement, test, fix" template, Claude Code announced `test` in five
 * runs of five and the delegated `implement` in none (ANT-162).
 *
 * Putting the line in the step was not enough by itself: run non-interactively,
 * Claude Code goes from one tool call to the next without writing any text, so
 * "print this line before the step" had no message to land in — the same
 * measurement after that change still found `implement` in none of five. A
 * command is something it does at every step. So the step opens with one, the
 * same `printf` Codex already chose for itself (ANT-147); both observers read
 * a command's output, and Claude Code runs `printf` without asking.
 */
export function stepOpening(
  marker: Pick<RunMarker, "runId" | "nonce">,
  step: { id: string; delegated: boolean },
  via: "echo" | "cli" = "echo",
): string[] {
  const command =
    via === "cli"
      ? `${CLI_NAME} step ${marker.runId} ${marker.nonce} ${step.id}`
      : `printf '${STEP_TOKEN} ${marker.runId} ${marker.nonce} ${step.id}\\n'`;
  const lines = [
    "Your first action in this step, and again each time you come back to it: run",
    "this command, which tells the Anthill window the step has begun.",
    "",
    `    ${command}`,
  ];
  if (step.delegated) {
    lines.push("", "Run it yourself before you hand the step to the subagent; do not ask the subagent to.");
  }
  return lines;
}

/**
 * The name of the CLI the harness is told to call.
 *
 * The instruction embeds the run id and nonce, which the marker already
 * carries, and nothing else: no paths, no ports, no tokens.
 */
export const CLI_NAME = "anthill";

/**
 * The instruction for a prompt that reports through the CLI instead of
 * printing marker lines.
 *
 * The harness runs `anthill run ...` once, `anthill step ...` per step, and
 * `anthill done ...` once the work is finished. The CLI appends a line per
 * call to a local file Anthill reads afterwards. The work is not affected
 * either way: a command that cannot be run is skipped, and the step ids are
 * the same ones the marker section names.
 */
export function cliInstruction(
  marker: RunMarker,
  steps: readonly { id: string; name: string }[] = [],
): string {
  const lines = [
    "## Progress reports",
    "",
    "Run these commands in a shell. They tell the Anthill window on this machine",
    "which step the work is on. They do not affect the work: if a command cannot",
    "be run, continue without it.",
    "",
    "**Once, before you begin:**",
    "",
    `    ${CLI_NAME} run ${marker.runId} ${marker.nonce}`,
    "",
    "**Immediately before you start each step, and again whenever you come back to",
    "an earlier one:**",
    "",
    `    ${CLI_NAME} step ${marker.runId} ${marker.nonce} <step-id>`,
    "",
    "**Once the work is finished:**",
    "",
    `    ${CLI_NAME} done ${marker.runId} ${marker.nonce}`,
  ];

  // The ids belong next to the instruction rather than at the end of the
  // prompt, for the same reason as the marker section's.
  if (steps.length > 0) {
    lines.push(
      "",
      "Use exactly these step ids:",
      "",
      ...steps.map((step) => `- \`${step.id}\` – ${step.name}`),
    );
  }

  return lines.join("\n");
}

export const RUN_TOKEN = "ANTHILL-RUN";
export const STEP_TOKEN = "ANTHILL-STEP";

/**
 * Read step announcements out of a piece of text the CLI recorded.
 *
 * Both halves of the marker are required before a line counts, exactly as for
 * detection: a step id on its own would match a prompt copied at some other
 * time, and the whole value of this channel is that it cannot.
 */
export function parseStepMarkers(
  text: string,
  marker: Pick<RunMarker, "runId" | "nonce">,
): string[] {
  const pattern = new RegExp(
    `${STEP_TOKEN}\\s+${escape(marker.runId)}\\s+${escape(marker.nonce)}\\s+([A-Za-z0-9_.:-]+)`,
    "g",
  );
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) found.push(match[1]);
  return found;
}

export const DONE_TOKEN = "ANTHILL-DONE";

/**
 * Whether a piece of recorded text says the work is finished.
 *
 * The marker-line counterpart of `anthill done`. Without it, a prompt that
 * reports by printing lines had a way to say which step it was on and no way
 * to say it had stopped — so the only ending Anthill could reach was the one
 * it infers from silence, five minutes after the last word, and a stale claim
 * from any other channel could hold that off indefinitely (ANT-119). Both
 * halves of the marker are required, for the same reason as everywhere else:
 * a bare token would match a prompt copied some other day.
 */
export function parseDoneMarker(text: string, marker: Pick<RunMarker, "runId" | "nonce">): boolean {
  return new RegExp(`${DONE_TOKEN}\\s+${escape(marker.runId)}\\s+${escape(marker.nonce)}\\b`).test(text);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a piece of recorded text carries this run's marker.
 *
 * Both halves must be present: the run id says which run, and the nonce says
 * which copy of it. Requiring both is what stops a prompt copied yesterday,
 * still sitting in someone's scrollback, from matching a run created today.
 *
 * And both must be present *as the marker block writes them* — each on a line
 * of its own, under its own field name. Two substrings anywhere was the test
 * once, so a session that merely mentioned a run became a candidate for it: a
 * driver printing the id and nonce in a table, a Live Session rail pasted into
 * another chat, a progress command carrying both on one line (ANT-79). Only a
 * pasted Anthill prompt produces the block. Leading whitespace is allowed,
 * because a paste can indent it; nothing else is.
 */
export function textCarriesMarker(text: string, marker: Pick<RunMarker, "runId" | "nonce">): boolean {
  const line = (field: string, value: string) =>
    new RegExp(`^[ \\t>]*${field}:[ \\t]*${escape(value)}[ \\t]*$`, "m").test(text);
  return line(FIELD.runId, marker.runId) && line(FIELD.nonce, marker.nonce);
}

/** Read a marker back out of a prompt, for tests and for diagnostics. */
export function parseMarker(text: string): RunMarker | undefined {
  const read = (field: string): string | undefined => {
    const match = new RegExp(`^${field}:\\s*(\\S+)\\s*$`, "m").exec(text);
    return match?.[1];
  };

  const runId = read(FIELD.runId);
  const nonce = read(FIELD.nonce);
  const cli = read(FIELD.cli);
  const promptVersion = read(FIELD.promptVersion);
  const issuedAt = read(FIELD.issuedAt);
  if (!runId || !nonce || !issuedAt) return undefined;
  if (cli !== "codex" && cli !== "claude-code" && cli !== "pi") return undefined;

  const workflowId = read(FIELD.workflowId);
  return {
    runId,
    nonce,
    cli,
    promptVersion: promptVersion ?? MARKER_VERSION,
    issuedAt,
    ...(workflowId ? { workflowId } : {}),
  };
}
