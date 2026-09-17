/**
 * The local CLIs Anthill can ask to draft a workflow, and exactly how it asks.
 *
 * Data, not behaviour: the command name, the arguments, and a plain-language
 * account of what those arguments allow. Spawning belongs to the app shell, so
 * this stays in the pure package — which also means the screen that shows the
 * command and the process that runs it read the same table, and cannot drift
 * into promising one thing and doing another.
 *
 * Every argument here exists to take something away. There is no flag in this
 * file that grants access; if one ever appears, it is a bug.
 */

export type InterpreterId = "claude-code" | "codex" | "pi";

export type InterpreterDefinition = {
  id: InterpreterId;
  label: string;
  /** Executable name, resolved on the author's PATH. */
  command: string;
  /** What this invocation can and cannot do, for the author to read. */
  boundary: string;
  /**
   * Where the final answer is read from. Codex prints a progress log and writes
   * its last message to a file, which is far more reliable than sifting the
   * answer out of the log; Claude Code prints the answer and nothing else.
   */
  replyFrom: "stdout" | "file";
  /**
   * The arguments, given the scratch directory the run happens in and the file
   * Codex is told to write its answer to. A function rather than a constant
   * because both paths are made fresh for each run.
   */
  args: (workDir: string, replyFile: string) => string[];
  /**
   * What the author runs to sign in again, when this CLI says it is not.
   *
   * Data, like everything else here: Anthill never signs anyone in. It cannot
   * — the flow needs the author's own browser and account — and it should not
   * handle credentials on their behalf. What it can do is stop giving advice
   * that could never work and hand over the exact command.
   */
  signIn: string;
  /**
   * How to ask this CLI whether anybody is signed in, and how to read what it
   * says back.
   *
   * Worth asking before a draft rather than after: the sign-in state is the
   * one thing that makes an otherwise perfect run fail a minute later, and
   * finding out at the end costs the author that minute for nothing.
   *
   * `undefined` from the reader means the question could not be answered —
   * an unfamiliar version, a changed format. That is not the same as "signed
   * out", and nothing should tell the author to sign in on the strength of it.
   *
   * Absent when the CLI has no reliable non-interactive sign-in check at all
   * (pi signs in through its own interactive prompt, or a key it already
   * holds). Then the question is not asked; the answer is `undefined`, and
   * nothing may read that as a sign-out.
   */
  statusArgs?: string[];
  readStatus: (stdout: string, exitCode: number | null) => boolean | undefined;
};

export const INTERPRETERS: InterpreterDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    boundary:
      "Runs with every tool disabled and no MCP servers, in an empty temporary folder. It can read your prompt and answer; it cannot open, change or run anything.",
    replyFrom: "stdout",
    signIn: "claude auth login",
    statusArgs: ["auth", "status"],
    // Prints JSON with a `loggedIn` boolean.
    readStatus: (stdout) => {
      try {
        const parsed: unknown = JSON.parse(stdout);
        const value = (parsed as { loggedIn?: unknown }).loggedIn;
        return typeof value === "boolean" ? value : undefined;
      } catch {
        return undefined;
      }
    },
    args: () => [
      "-p",
      "--output-format",
      "text",
      // The whole boundary in one flag: with no tools there is nothing to
      // permit, nothing to sandbox, and nothing to ask about.
      "--tools",
      "",
      // Without this, MCP servers configured elsewhere on the machine would be
      // loaded into a run that has no use for them.
      "--strict-mcp-config",
    ],
  },
  {
    id: "codex",
    label: "Codex CLI",
    command: "codex",
    boundary:
      "Runs in Codex's read-only sandbox in an empty temporary folder, with your Codex config, MCP servers and rule files ignored. It can read your prompt and answer; it cannot change anything.",
    replyFrom: "file",
    signIn: "codex login",
    statusArgs: ["login", "status"],
    // Prints a sentence rather than JSON: "Logged in using ChatGPT".
    readStatus: (stdout, exitCode) => {
      const said = stdout.toLowerCase();
      if (said.includes("logged in")) return !said.includes("not logged in");
      // Nothing recognisable was said, so the exit code is all there is — and
      // only a clean exit is worth reading as a yes.
      return exitCode === 0 ? undefined : false;
    },
    args: (workDir, replyFile) => [
      "exec",
      "--sandbox",
      "read-only",
      // The scratch folder is not a repository, and Codex refuses to start
      // outside one unless told that is fine.
      "--skip-git-repo-check",
      // No session files left behind by a run not worth resuming.
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "-C",
      workDir,
      "-o",
      replyFile,
      "-",
    ],
  },
  {
    id: "pi",
    label: "Pi",
    command: "pi",
    boundary:
      "Runs with every tool disabled in an empty temporary folder. It can read your prompt and answer; it cannot open, change or run anything.",
    replyFrom: "stdout",
    // pi signs in through its own interactive prompt (run `pi`, then `/login`)
    // or a key it already holds; there is no one-shot non-interactive login
    // command, so this is the TUI the author types into.
    signIn: "pi",
    // pi has no non-interactive sign-in status command that works without a
    // provider argument; `pi auth check` alone exits 2. The question is not
    // asked, so the answer stays `undefined` rather than being read as a
    // sign-out.
    statusArgs: undefined,
    readStatus: () => undefined,
    args: () => [
      // `-p` prints the answer and exits; a piped prompt is merged into the
      // initial prompt, which is how the drafting instruction reaches it.
      "-p",
      // The whole boundary in one flag: with no tools there is nothing to
      // permit, nothing to sandbox, and nothing to ask about.
      "--no-tools",
    ],
  },
];

export function interpreterDefinition(id: InterpreterId): InterpreterDefinition {
  const found = INTERPRETERS.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown interpreter: ${id}`);
  return found;
}

/** The invocation as the author is shown it, and as it is actually run. */
export function describeInterpreterCommand(id: InterpreterId): string {
  const item = interpreterDefinition(id);
  return [
    item.command,
    ...item
      .args("<temp folder>", "<reply file>")
      // An empty argument is real and load-bearing; printing nothing there
      // would show a command the author could not reproduce.
      .map((arg) => (arg === "" ? '""' : arg)),
  ].join(" ");
}

/** The interpreter Anthill reaches for when the author has expressed no preference. */
export const DEFAULT_INTERPRETER: InterpreterId = "claude-code";

/**
 * Whether a failure is the CLI saying nobody is signed in.
 *
 * Worth telling apart from every other failure because the recovery is
 * different in kind. "Try again, or reword it" is sound advice when a model
 * answered badly and useless when a session has expired — rewording a prompt
 * has never signed anyone in, and offering it as the way out sends the author
 * round a loop that cannot end.
 *
 * Matched on the CLI's own words rather than an exit code: both of these exit
 * 1 for everything, and the wording is what actually carries the reason.
 */
export function isSignedOutFailure(error: string): boolean {
  const said = error.toLowerCase();
  return (
    said.includes("failed to authenticate") ||
    said.includes("oauth") ||
    said.includes("not logged in") ||
    said.includes("please run `claude login`") ||
    said.includes("please run `codex login`") ||
    (said.includes("login") && said.includes("expired")) ||
    said.includes("unauthorized") ||
    said.includes("401")
  );
}
