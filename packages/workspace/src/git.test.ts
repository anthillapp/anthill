import { describe, expect, it } from "vitest"

import type { ExecFn, ExecResult } from "./contracts.js"
import { captureGitStatus, detectGitContext, selectWorkspace } from "./git.js"

type Call = { cmd: string; args: string[]; cwd: string }

/**
 * Build a fake `ExecFn` from a map of `"<cmd> <args joined by space>"` to the
 * result git would produce. Unmapped commands resolve like a git failure.
 */
function fakeExec(
  responses: Record<string, Partial<ExecResult>>,
): ExecFn & { calls: Call[] } {
  const calls: Call[] = []
  const exec = (async (cmd: string, args: string[], cwd: string) => {
    calls.push({ cmd, args, cwd })
    const key = [cmd, ...args].join(" ")
    const hit = responses[key]
    if (!hit) return { stdout: "", stderr: `unexpected command: ${key}`, exitCode: 128 }
    return { stdout: "", stderr: "", exitCode: 0, ...hit }
  }) as ExecFn & { calls: Call[] }
  exec.calls = calls
  return exec
}

const NOT_A_REPO: Record<string, Partial<ExecResult>> = {
  "git rev-parse --show-toplevel": {
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    exitCode: 128,
  },
  "git status --porcelain": {
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    exitCode: 128,
  },
}

const CLEAN_REPO: Record<string, Partial<ExecResult>> = {
  "git rev-parse --show-toplevel": { stdout: "/repo\n" },
  "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
  "git status --porcelain": { stdout: "" },
}

describe("selectWorkspace (injected exec)", () => {
  it("always resolves shared mode with activePath === rootPath", async () => {
    const exec = fakeExec(CLEAN_REPO)
    const ctx = await selectWorkspace("/repo/sub", exec)

    expect(ctx.mode).toBe("shared")
    expect(ctx.rootPath).toBe("/repo/sub")
    expect(ctx.activePath).toBe("/repo/sub")
  })

  it("detects repository root and branch inside a git repo", async () => {
    const exec = fakeExec(CLEAN_REPO)
    const ctx = await selectWorkspace("/repo/sub", exec)

    expect(ctx.git).toEqual({ repositoryRoot: "/repo", branch: "main" })
    // baseRef/beforeStatus are the engine's to stamp, not ours.
    expect(ctx.git?.baseRef).toBeUndefined()
    expect(ctx.git?.beforeStatus).toBeUndefined()
  })

  it("runs git commands in rootPath", async () => {
    const exec = fakeExec(CLEAN_REPO)
    await selectWorkspace("/repo/sub", exec)

    expect(exec.calls).toEqual([
      { cmd: "git", args: ["rev-parse", "--show-toplevel"], cwd: "/repo/sub" },
      { cmd: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: "/repo/sub" },
    ])
  })

  it("leaves git undefined outside a git repository instead of throwing", async () => {
    const exec = fakeExec(NOT_A_REPO)
    const ctx = await selectWorkspace("/tmp/plain-dir", exec)

    expect(ctx).toEqual({
      rootPath: "/tmp/plain-dir",
      mode: "shared",
      activePath: "/tmp/plain-dir",
    })
    expect(ctx.git).toBeUndefined()
    // It must not even try to read HEAD once toplevel failed.
    expect(exec.calls).toHaveLength(1)
  })

  it("leaves git undefined when git itself is unavailable (exitCode null)", async () => {
    const exec = fakeExec({
      "git rev-parse --show-toplevel": { stderr: "spawn git ENOENT", exitCode: null },
    })
    const ctx = await selectWorkspace("/anywhere", exec)

    expect(ctx.git).toBeUndefined()
  })

  it("omits branch on a detached HEAD but still reports the repository root", async () => {
    const exec = fakeExec({
      "git rev-parse --show-toplevel": { stdout: "/repo\n" },
      "git rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" },
    })
    const ctx = await selectWorkspace("/repo", exec)

    expect(ctx.git).toEqual({ repositoryRoot: "/repo" })
  })

  it("omits branch on an unborn branch (repo with no commits)", async () => {
    const exec = fakeExec({
      "git rev-parse --show-toplevel": { stdout: "/repo\n" },
      "git rev-parse --abbrev-ref HEAD": {
        stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n",
        exitCode: 128,
      },
    })
    const ctx = await selectWorkspace("/repo", exec)

    expect(ctx.git).toEqual({ repositoryRoot: "/repo" })
  })

  it("treats blank toplevel output as not-a-repo", async () => {
    const exec = fakeExec({ "git rev-parse --show-toplevel": { stdout: "  \n" } })

    await expect(detectGitContext("/repo", exec)).resolves.toBeUndefined()
  })
})

describe("captureGitStatus (injected exec)", () => {
  it("returns an empty string for a clean working tree", async () => {
    const exec = fakeExec(CLEAN_REPO)

    await expect(captureGitStatus("/repo", exec)).resolves.toBe("")
  })

  it("returns raw porcelain output for a dirty working tree", async () => {
    const dirty = " M src/index.ts\n?? notes.md\n"
    const exec = fakeExec({ "git status --porcelain": { stdout: dirty } })

    await expect(captureGitStatus("/repo", exec)).resolves.toBe(dirty)
  })

  it("returns undefined outside a git repository", async () => {
    const exec = fakeExec(NOT_A_REPO)

    await expect(captureGitStatus("/tmp/plain-dir", exec)).resolves.toBeUndefined()
  })

  it("uses --porcelain so untracked files are included", async () => {
    const exec = fakeExec(CLEAN_REPO)
    await captureGitStatus("/repo", exec)

    expect(exec.calls).toEqual([
      { cmd: "git", args: ["status", "--porcelain"], cwd: "/repo" },
    ])
  })
})
