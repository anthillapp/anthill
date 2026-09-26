import type { IsolatedWorkspaceMode, WorkspaceContext } from "./contracts.js"

/**
 * Create an isolated workspace (git worktree / temp copy) for a run or node.
 *
 * NOT IMPLEMENTED. The MVP supports a single shared working directory only;
 * isolation is explicitly out of scope per the product spec. This throws
 * rather than silently degrading to `"shared"`, because a caller that asked
 * for isolation and quietly got the user's live checkout would be a data-loss
 * hazard, not a minor inconvenience.
 *
 * When this is implemented it should: create the worktree/copy, return a
 * context whose `activePath` points at it (with `rootPath` still the user's
 * project root), and record enough state for `cleanupWorkspace` to undo it.
 *
 * @throws Always.
 */
export async function createIsolatedWorkspace(
  rootPath: string,
  mode: IsolatedWorkspaceMode,
): Promise<WorkspaceContext> {
  void rootPath
  throw new Error(
    `Workspace isolation mode '${mode}' is not implemented yet – MVP only supports 'shared'`,
  )
}

/**
 * Release whatever `selectWorkspace` / `createIsolatedWorkspace` acquired.
 *
 * Currently a no-op for every mode:
 *
 * - `"shared"` — there is nothing to clean up, and there never will be. The
 *   active path IS the developer's own working directory; removing or
 *   resetting anything here would destroy their work.
 * - `"run_worktree"` / `"node_worktree"` / `"temp_copy"` — unreachable today,
 *   since `createIsolatedWorkspace` throws, so no context in these modes can
 *   exist. Once isolation lands this function becomes load-bearing: it must
 *   `git worktree remove` (or `fs.rm`) the `activePath` and prune the
 *   worktree registry, and it must stay safe to call twice and after a
 *   crashed run.
 *
 * Safe to call unconditionally, including in a `finally`.
 */
export async function cleanupWorkspace(context: WorkspaceContext): Promise<void> {
  void context
  return
}
