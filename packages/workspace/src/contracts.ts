/**
 * Local mirror of the canonical `workspace-isolation` contract owned by
 * `@anthill/workflow-schema`.
 *
 * This package deliberately does NOT import `@anthill/workflow-schema` yet:
 * the schema package is being authored in parallel. Once it lands, these
 * declarations should be deleted and re-exported from the schema package
 * instead. Keep the shapes below byte-for-byte compatible with the spec.
 */

/**
 * How a run's files are isolated from the developer's working tree.
 *
 * MVP only implements `"shared"` — the agent operates directly on the user's
 * own checkout. The remaining modes are reserved, not implemented.
 */
export type WorkspaceMode = "shared" | "run_worktree" | "node_worktree" | "temp_copy"

/** Every isolation mode other than the one the MVP actually supports. */
export type IsolatedWorkspaceMode = Exclude<WorkspaceMode, "shared">

/**
 * Git facts about a workspace, captured best-effort.
 *
 * Absent entirely when the workspace root is not inside a git repository —
 * Anthill must work on non-git directories, so this is never an error case.
 */
export type WorkspaceGitContext = {
  /** Absolute path to the repository root (`git rev-parse --show-toplevel`). */
  repositoryRoot: string
  /**
   * Commit/ref a run is measured against. Not populated by `selectWorkspace`;
   * the engine stamps it when a run starts so diffs have a fixed baseline.
   */
  baseRef?: string
  /** Current branch name. Absent on a detached HEAD or an unborn branch. */
  branch?: string
  /**
   * Raw `git status --porcelain` output captured before a node executed.
   * Populated by the engine via `captureGitStatus`, not by `selectWorkspace`.
   */
  beforeStatus?: string
}

/** Resolved workspace a run (or a single agent node) executes against. */
export type WorkspaceContext = {
  /** The directory the user selected as the project root. */
  rootPath: string
  mode: WorkspaceMode
  /**
   * Directory the agent CLI is actually spawned in. Equal to `rootPath` in
   * `"shared"` mode; would point at a worktree/copy in the other modes.
   */
  activePath: string
  git?: WorkspaceGitContext
}

/** Result of running a child process. */
export type ExecResult = {
  stdout: string
  stderr: string
  /** Process exit code, or `null` when the process never ran (e.g. ENOENT). */
  exitCode: number | null
}

/**
 * Injectable child-process runner. Every git call in this package goes through
 * one of these so tests can substitute a deterministic fake.
 */
export type ExecFn = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>
