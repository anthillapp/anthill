import { execFile } from "node:child_process"

import type { ExecFn, ExecResult, WorkspaceContext, WorkspaceGitContext } from "./contracts.js"

/** 8 MiB — `git status --porcelain` on a very large dirty tree can be big. */
const MAX_BUFFER = 8 * 1024 * 1024

/**
 * Real `ExecFn`, backed by `node:child_process`'s `execFile`.
 *
 * Never rejects: a non-zero exit, a missing binary and a missing `cwd` all
 * resolve to an `ExecResult`. Callers decide what a failure means, which is
 * what lets "not a git repository" be a normal answer rather than a throw.
 */
export const defaultExec: ExecFn = (cmd, args, cwd) =>
  new Promise<ExecResult>((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER },
        (error, stdout, stderr) => {
          if (error) {
            // `error.code` is the exit status for a process that ran, or a
            // string errno (e.g. "ENOENT") when it never started.
            const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              exitCode: typeof code === "number" ? code : null,
            })
            return
          }
          resolve({ stdout, stderr, exitCode: 0 })
        },
      )
    } catch (error) {
      resolve({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: null })
    }
  })

/**
 * Best-effort git detection for `rootPath`.
 *
 * Returns `undefined` when `rootPath` is not inside a git repository (or git
 * is unavailable) — that is a supported configuration, not a failure.
 */
export async function detectGitContext(
  rootPath: string,
  exec: ExecFn = defaultExec,
): Promise<WorkspaceGitContext | undefined> {
  const topLevel = await exec("git", ["rev-parse", "--show-toplevel"], rootPath)
  if (topLevel.exitCode !== 0) return undefined

  const repositoryRoot = topLevel.stdout.trim()
  if (repositoryRoot.length === 0) return undefined

  const context: WorkspaceGitContext = { repositoryRoot }

  const head = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], rootPath)
  if (head.exitCode === 0) {
    const branch = head.stdout.trim()
    // "HEAD" means detached; a repo with no commits yet fails outright above.
    if (branch.length > 0 && branch !== "HEAD") {
      context.branch = branch
    }
  }

  return context
}

/**
 * Resolve the workspace a run executes against.
 *
 * MVP: always `"shared"` — the agent runs directly in the user's own checkout,
 * so `activePath === rootPath`. Other isolation modes are reserved; see
 * `createIsolatedWorkspace`.
 */
export async function selectWorkspace(
  rootPath: string,
  exec: ExecFn = defaultExec,
): Promise<WorkspaceContext> {
  const git = await detectGitContext(rootPath, exec)

  const context: WorkspaceContext = {
    rootPath,
    mode: "shared",
    activePath: rootPath,
  }
  if (git) context.git = git

  return context
}

/**
 * Capture the raw `git status --porcelain` output for `rootPath`.
 *
 * - `""`        — inside a git repo, working tree clean.
 * - non-empty   — inside a git repo, working tree dirty (raw porcelain lines).
 * - `undefined` — not a git repository (or git unavailable).
 *
 * This is only the primitive. The engine is responsible for calling it before
 * and after each agent node attempt and diffing the two snapshots.
 *
 * `--porcelain` (v1) is used deliberately: its format is guaranteed stable
 * across git versions, unlike the human-readable `git status`. It also
 * includes untracked files by default, which is what "did the agent change
 * anything?" needs.
 */
export async function captureGitStatus(
  rootPath: string,
  exec: ExecFn = defaultExec,
): Promise<string | undefined> {
  const result = await exec("git", ["status", "--porcelain"], rootPath)
  if (result.exitCode !== 0) return undefined
  return result.stdout
}
