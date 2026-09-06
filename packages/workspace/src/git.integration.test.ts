import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { captureGitStatus, defaultExec, selectWorkspace } from "./git.js"
import { hasUncommittedChanges } from "./guardrails.js"

/**
 * These tests exercise the REAL default exec path against REAL git in a real
 * temp directory. They are the proof that `defaultExec` actually works; the
 * fake-exec suite in `git.test.ts` only proves the branching logic.
 */

/** Run a real command and fail loudly if it did not succeed. */
async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const result = await defaultExec(cmd, args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed in ${cwd} (exit ${result.exitCode}): ${result.stderr}`,
    )
  }
  return result.stdout
}

describe("real git integration", () => {
  let baseDir: string
  let repoDir: string
  let plainDir: string

  beforeAll(async () => {
    // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var) and
    // git reports the resolved path, so normalize up front.
    const base = await realpath(await mkdtemp(join(tmpdir(), "anthill-workspace-")))
    baseDir = base
    repoDir = join(base, "repo")
    plainDir = join(base, "plain")

    await run("mkdir", ["-p", repoDir], base)
    await run("mkdir", ["-p", plainDir], base)

    // `-b main` pins the initial branch so the assertion does not depend on
    // the machine's init.defaultBranch setting.
    await run("git", ["init", "-b", "main"], repoDir)
    await run("git", ["config", "user.email", "test@anthill.local"], repoDir)
    await run("git", ["config", "user.name", "Anthill Test"], repoDir)
    await run("git", ["config", "commit.gpgsign", "false"], repoDir)

    await writeFile(join(repoDir, "README.md"), "# fixture\n", "utf8")
    await run("git", ["add", "README.md"], repoDir)
    await run("git", ["commit", "-m", "initial commit"], repoDir)
  })

  afterAll(async () => {
    if (baseDir) {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it("selectWorkspace reports the real repository root and branch", async () => {
    const ctx = await selectWorkspace(repoDir)

    expect(ctx.mode).toBe("shared")
    expect(ctx.activePath).toBe(repoDir)
    expect(ctx.git?.repositoryRoot).toBe(repoDir)
    expect(ctx.git?.branch).toBe("main")
  })

  it("selectWorkspace resolves the repository root from a subdirectory", async () => {
    const nested = join(repoDir, "packages", "thing")
    await run("mkdir", ["-p", nested], repoDir)

    const ctx = await selectWorkspace(nested)

    expect(ctx.rootPath).toBe(nested)
    expect(ctx.activePath).toBe(nested)
    expect(ctx.git?.repositoryRoot).toBe(repoDir)
  })

  it("selectWorkspace yields no git context for a plain directory", async () => {
    const ctx = await selectWorkspace(plainDir)

    expect(ctx.mode).toBe("shared")
    expect(ctx.git).toBeUndefined()
  })

  it("captureGitStatus goes clean -> dirty -> clean against real git", async () => {
    // Committed fixture plus the mkdir from the test above (empty dirs are
    // invisible to git), so start from a genuinely clean tree.
    await run("git", ["add", "-A"], repoDir)
    const clean = await captureGitStatus(repoDir)
    expect(clean).toBe("")
    expect(hasUncommittedChanges(clean)).toBe(false)

    await writeFile(join(repoDir, "scratch.txt"), "agent output\n", "utf8")
    const dirty = await captureGitStatus(repoDir)
    expect(dirty).toContain("?? scratch.txt")
    expect(hasUncommittedChanges(dirty)).toBe(true)

    await rm(join(repoDir, "scratch.txt"))
    const cleanAgain = await captureGitStatus(repoDir)
    expect(cleanAgain).toBe("")
    expect(hasUncommittedChanges(cleanAgain)).toBe(false)
  })

  it("captureGitStatus detects a modified tracked file", async () => {
    await writeFile(join(repoDir, "README.md"), "# fixture edited\n", "utf8")

    const status = await captureGitStatus(repoDir)
    expect(status).toContain("README.md")
    expect(hasUncommittedChanges(status)).toBe(true)

    await writeFile(join(repoDir, "README.md"), "# fixture\n", "utf8")
  })

  it("captureGitStatus returns undefined for a plain directory", async () => {
    await expect(captureGitStatus(plainDir)).resolves.toBeUndefined()
  })

  it("defaultExec reports a non-zero exit code without throwing", async () => {
    const result = await defaultExec("git", ["rev-parse", "--show-toplevel"], plainDir)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("not a git repository")
  })

  it("defaultExec reports exitCode null when the binary does not exist", async () => {
    const result = await defaultExec("anthill-definitely-not-a-real-binary", [], repoDir)

    expect(result.exitCode).toBeNull()
  })

  it("defaultExec reports exitCode null when cwd does not exist", async () => {
    const result = await defaultExec("git", ["status"], join(repoDir, "no-such-dir"))

    expect(result.exitCode).toBeNull()
  })
})
