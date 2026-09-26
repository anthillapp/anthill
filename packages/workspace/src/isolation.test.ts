import { describe, expect, it } from "vitest"

import type { IsolatedWorkspaceMode, WorkspaceContext } from "./contracts.js"
import { cleanupWorkspace, createIsolatedWorkspace } from "./isolation.js"

const ISOLATED_MODES: IsolatedWorkspaceMode[] = ["run_worktree", "node_worktree", "temp_copy"]

describe("createIsolatedWorkspace", () => {
  for (const mode of ISOLATED_MODES) {
    it(`throws a clear not-implemented error for '${mode}'`, async () => {
      await expect(createIsolatedWorkspace("/repo", mode)).rejects.toThrow(
        `Workspace isolation mode '${mode}' is not implemented yet – MVP only supports 'shared'`,
      )
    })

    it(`rejects with an Error instance for '${mode}'`, async () => {
      await expect(createIsolatedWorkspace("/repo", mode)).rejects.toBeInstanceOf(Error)
    })
  }

  it("does not silently fall back to a shared workspace", async () => {
    const result = await createIsolatedWorkspace("/repo", "run_worktree").catch(
      (error: unknown) => error,
    )

    expect(result).toBeInstanceOf(Error)
    expect(result).not.toMatchObject({ mode: "shared" })
  })
})

describe("cleanupWorkspace", () => {
  it("is a no-op for a shared workspace", async () => {
    const context: WorkspaceContext = {
      rootPath: "/repo",
      mode: "shared",
      activePath: "/repo",
      git: { repositoryRoot: "/repo", branch: "main" },
    }

    await expect(cleanupWorkspace(context)).resolves.toBeUndefined()
  })

  it("is idempotent", async () => {
    const context: WorkspaceContext = {
      rootPath: "/repo",
      mode: "shared",
      activePath: "/repo",
    }

    await cleanupWorkspace(context)
    await expect(cleanupWorkspace(context)).resolves.toBeUndefined()
  })

  it("does not mutate the context it is given", async () => {
    const context: WorkspaceContext = {
      rootPath: "/repo",
      mode: "shared",
      activePath: "/repo",
    }
    const snapshot = structuredClone(context)

    await cleanupWorkspace(context)

    expect(context).toEqual(snapshot)
  })

  it("tolerates a context in a not-yet-implemented mode", async () => {
    // Unreachable in practice (createIsolatedWorkspace throws), but cleanup
    // must stay safe to call unconditionally from a `finally`.
    for (const mode of ISOLATED_MODES) {
      const context: WorkspaceContext = {
        rootPath: "/repo",
        mode,
        activePath: "/tmp/would-be-worktree",
      }
      await expect(cleanupWorkspace(context)).resolves.toBeUndefined()
    }
  })
})
