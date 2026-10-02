# Pre-draft clarification regression checks (ANT-93)

These are behavioral checks of the Claude Code skill, not a schema assertion.
The server cannot authenticate user answers from a caller-supplied workflow.
Automated MCP tests verify that the guidance reaches initialize and tools/list;
they do not prove that a language model follows it.

## Setup

Use the skill and built MCP server from the branch under test. A cached plugin
from an older installation is not evidence of the branch's behavior. Start a new
Claude Code session and record the plugin path/version, Claude version, model,
commit and local modifications. Use a disposable directory and an isolated
Anthill data directory, not a real project. Do not install global hooks or change
the user's plugin configuration to run these checks.

Prefer the Claude Code app for final acceptance. A CLI smoke test with an
explicit local plugin and isolated MCP configuration is useful supplementary
evidence, but must be recorded as CLI, not app-based E2E. Do not capture private
reasoning; record visible questions, tool names, submitted arguments and outcomes.

## Cases

| Case | Input / next reply | Required observable result |
| --- | --- | --- |
| Empty directory, design | `/anthill:workflow design Make a small macOS menu bar todo app and show it in Anthill.` | Ask about project location/new vs existing, scope, constraints/preservation, success and prior decisions. Stop before draft submission or project creation. Empty directory/toolchain findings must not decide the project location. |
| Empty directory, watch | The same task with `watch` | No questionnaire: it drafts, binds and starts, and says in one line what it took the job to be. It still asks before creating a project the user never named — `watch` skips the questions about a job they described, not permission for a bigger one. |
| Detailed request | Explicitly give a directory, scope, constraints, success criteria and fixed architecture | Summarize those facts and ask for confirmation before draft; do not make the user re-enter the facts. |
| Partial answer | Answer only the directory question | Ask for the unanswered areas. No draft yet. |
| Explicit delegation | Answer scope/location and success; say `You choose the architecture; no other constraints.` | Treat this as a user decision, not a missing architecture value; do not loop on already answered questions. |
| Confirmed answers | Confirm all four areas | Submit exactly one draft containing the agreed context/constraints/done criteria and original request plus user answers. Then use the existing, separate post-display approval flow. Do not start task work in this check. |
| Validation refuses content | Make an agreed draft fail completeness, for example by omitting done criteria | Ask the returned questions or use the actual already-confirmed answer; never invent an answer just to satisfy validation. Reuse the same identity/key. |
| Lost response / retry | Retry exactly the same confirmed submission | Do not restart the questionnaire or duplicate the workflow. |
| Picking one back up | Ask about an existing workflow with unchanged scope | Do not impose a new-draft questionnaire. If scope materially changes, clarify that change. |

For the pre-answer cases, inspect the isolated exchange as well as the text:
there must be no new workflow identity, revision, display request or binding.
Questions followed immediately by a draft without a user reply are a failure.
A future clarify-requirements block is also a failure: it cannot replace the
pre-draft conversation. A question tool result only counts when it contains a
real user answer; an unavailable question tool must fall back to chat and stop.

## Initial verification

On `codex/ant-93-draft-clarification`, based on `b29c90c` with the ANT-93
working-tree changes:

* Dependency build passed under Node 22.23.2.
* MCP: 63 tests passed, including delivery of the clarification gate through
  the built server's initialize response and create tool description.
* Workflow exchange: 69 tests passed with the existing submission contract.
* Typechecks passed for all workspaces that expose a typecheck script.
* A CLI smoke attempt used Claude Code 2.1.261, model `claude-sonnet-5`, a
  temporary copy of this branch's plugin (manifest version 0.7.1), an empty
  project directory and an isolated exchange. User hooks were disabled. The
  initialization output confirmed that the local plugin loaded and the MCP
  server connected with `create_workflow_draft` available.
* **Behavioral check blocked:** the authenticated attempt returned
  `Failed to authenticate: OAuth session expired and could not be refreshed`
  before model execution. Empty project/data directories therefore do not
  count as evidence that Claude obeyed the clarification gate. Re-authenticate
  with `/login` and run the cases above before marking behavioral acceptance
  complete. No app-based E2E pass is claimed.
