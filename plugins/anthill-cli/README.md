# The Anthill plugin for Codex

This local plugin adds `$anthill` to Codex and connects it to Anthill's shared
workflow exchange. Codex designs and performs the work; Anthill stores the
workflow and passively observes explicit progress.

Anthill does not start Codex, launch agents, create worktrees, choose
permissions, or execute workflows.

Verified locally against **Codex CLI 0.153.4** and **Anthill 0.7.5** on macOS.
The package uses Codex's native plugin format, shared by the CLI and desktop;
the desktop plugin UI still needs a manual smoke test because this environment
cannot automate the Codex app. Other versions are untested rather than
unsupported.

## Install from this checkout

Build the shared MCP server first:

```bash
npm run build:deps
npm run build --workspace=@anthill/mcp
npm run build --workspace=@anthill/cli
npm install --global ./apps/cli
```

Point the plugin at that exact built server. An absolute path is required:

```bash
mkdir -p ~/.anthill
printf '{"server": "%s/apps/mcp/dist/server.js"}\n' "$PWD" > ~/.anthill/plugin.json
```

Register this repository's marketplace and install the plugin:

```bash
codex plugin marketplace add "$PWD"
codex plugin add anthill-cli@anthill-local
```

Start a new Codex task after installation. Plugins are loaded when a task
starts, so an already-running task is not an installation check.

Check each local surface independently:

```bash
codex plugin list --json
codex mcp get exchange --json
command -v anthill
open -Ra Anthill
```

The first two show that the skill package and MCP configuration are enabled;
the latter two locate the progress reporter and installed desktop app. MCP can
store a handover while Anthill is closed, so this is availability information,
not proof that a queued display request was consumed.

The plugin can also locate the server through `ANTHILL_MCP_SERVER` (the absolute
`server.js` path) or `ANTHILL_REPO` (the absolute checkout path). The settings
file is preferred for a desktop app launched from Finder or the Dock because it
does not inherit shell-profile environment variables.

To use a development data directory instead of the installed Anthill app's
default, add `--data-dir` and an absolute path to the `args` in `.mcp.json` while
testing. A mismatched directory is quiet: the MCP server stores the handover,
but a desktop watching another directory cannot see it.

## Use

```text
$anthill design Add retry-once to checkout; let me edit the workflow first
$anthill watch Fix the importer and show the work in Anthill while you do it
$anthill Describe this task as a workflow
```

`design` asks for missing scope, constraints, success criteria, and fixed
decisions, then stops after opening the draft. `watch` binds immediately and
reports the work through the existing `anthill` CLI channel. With no explicit
mode, the skill infers execution intent and otherwise defaults to `design`.

The source session id comes from `CODEX_SESSION_ID`, which Codex records as
`session_id` in its local rollout metadata. The skill never invents or borrows
an id. The workflow target and source harness are both `codex`.

## Optional detailed progress

With the current Anthill CLI, the skill checks `anthill observation status` in
the project directory and offers detailed progress when it has not been set up.
Accepting runs `anthill observation enable`; declining runs
`anthill observation skip` and remembers the choice. Basic session observation
and explicit workflow reports remain available either way.

Codex separately requires native hook trust. When prompted, enter `/hooks` in
Codex and review the entries containing `anthill-observation-hook`. Installation
does not grant that trust. Start a new session after installing or changing
permissions; check `anthill observation status` again. `ready` confirms enabled,
trusted hooks; a non-null `lastEventAt` confirms an actual event in the retained
log. An old CLI without these commands falls back to basic progress.

Rebuild/update the Anthill CLI as well as refreshing the plugin to get this flow.

## Update, disable, and uninstall

After pulling changes from this local checkout, reinstall so Codex copies a
fresh plugin version into its cache:

```bash
codex plugin remove anthill-cli@anthill-local
codex plugin add anthill-cli@anthill-local
```

`codex plugin marketplace upgrade` refreshes Git-backed marketplaces; it is
not needed for this local marketplace.

Use the Codex Plugins UI to disable the plugin without deleting it. To remove
the cached installation:

```bash
codex plugin remove anthill-cli@anthill-local
```

Removing the plugin does not remove `~/.anthill/plugin.json`, workflows,
revisions, bindings, or Live Session history. Those belong to Anthill.

## Troubleshooting

**The plugin is missing.** Check the marketplace and install state, then start a
new task:

```bash
codex plugin marketplace list
codex plugin list --available
```

**`$anthill` exists but exchange tools do not.** The MCP server failed to start.
Confirm `~/.anthill/plugin.json` contains an absolute path to a built
`apps/mcp/dist/server.js`. Rebuild after changing MCP packages.

**A handover exists but Anthill does not open it.** Start Anthill and compare the
MCP server's reported data directory with the app's data directory. Queueing a
display request is not proof that the app consumed it.

**The workflow opens but progress does not move.** Confirm the `anthill` CLI is
available to the Codex task and that `anthill --help` exits successfully. MCP
creates and binds the workflow; progress uses only the existing CLI commands
returned by `bind_run`. Codex may ask for narrow permission to append
`~/.anthill/cli/harness-reports.jsonl`; granting it allows the local app to see
step markers, while rejecting it leaves task execution unchanged.

**A resumed task cannot find a workflow.** Supply the workflow id or its
`anthill://workflow/<id>` link. The plugin intentionally never guesses by
recency.

## Local-only boundary

This package makes no network request and requires no API key. Its MCP process
reads and writes only Anthill's local exchange directory. It does not expose a
runner or a second progress transport, and it never collects private reasoning.

The manual flow, where a user copies a prompt from Anthill into Codex, remains
available and unchanged.

Detailed-progress hooks installed by the CLI currently require the macOS app in
`/Applications/Anthill.app` or `~/Applications/Anthill.app`. The command uses its
bundled runtime and handler, not the Node running the CLI. Basic progress remains
available on other platforms. A CLI status result with `requiresHostAccess: true`
needs approval for that exact command outside the agent sandbox; it does not mean
Codex hook trust was granted. Preferences are shared in
`~/.anthill/live-observation-setup.json`; older shell preferences are read during
migration. The app checks pending trust at 15–60 second intervals and on focus;
after readiness, only focus/reopening triggers a permission check.
