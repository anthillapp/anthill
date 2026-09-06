/**
 * Does a captured `git status --porcelain` snapshot show uncommitted work?
 *
 * Pure — takes the output of `captureGitStatus`, never touches the filesystem.
 *
 * - `undefined` (not a git repo) -> `false`. Without git we cannot know, and
 *   nagging a user who is not using git would be noise.
 * - `""` (clean tree) -> `false`.
 * - anything else -> `true`.
 *
 * Whitespace-only input is treated as clean: porcelain output for a clean tree
 * is the empty string, but a stray trailing newline should not be reported as
 * a dirty workspace.
 *
 * Backs the MVP guardrail "warn when a workflow starts with uncommitted
 * changes" — this returns the fact; the engine/UI decides how to warn.
 */
export function hasUncommittedChanges(statusOutput: string | undefined): boolean {
  if (typeof statusOutput !== "string") return false
  return statusOutput.trim().length > 0
}
