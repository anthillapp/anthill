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
 * Optional by design. The run marker already reaches the session file through
 * the user's own pasted message, so detection never depends on this; and a workflow
 * whose steps are never announced still shows a live session, just without
 * per-step progress. An agent that ignores all of it costs nothing.
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
    "nothing about the work itself.",
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
      ...steps.map((step) => `- \`${step.id}\` — ${step.name}`),
    );
  }

  lines.push("", "Ignore this section entirely if you cannot print such lines.");
  return lines.join("\n");
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
      ...steps.map((step) => `- \`${step.id}\` — ${step.name}`),
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

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a piece of recorded text carries this run's marker.
 *
 * Both halves must be present: the run id says which run, and the nonce says
 * which copy of it. Requiring both is what stops a prompt copied yesterday,
 * still sitting in someone's scrollback, from matching a run created today.
 */
export function textCarriesMarker(text: string, marker: Pick<RunMarker, "runId" | "nonce">): boolean {
  return text.includes(marker.runId) && text.includes(marker.nonce);
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
