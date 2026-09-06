export const PACKAGE_NAME = "@anthill/workspace"

export type {
  ExecFn,
  ExecResult,
  IsolatedWorkspaceMode,
  WorkspaceContext,
  WorkspaceGitContext,
  WorkspaceMode,
} from "./contracts.js"

export { captureGitStatus, defaultExec, detectGitContext, selectWorkspace } from "./git.js"
export { hasUncommittedChanges } from "./guardrails.js"
export { cleanupWorkspace, createIsolatedWorkspace } from "./isolation.js"
