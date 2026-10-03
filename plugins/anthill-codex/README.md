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

## Install

You need [Anthill](https://github.com/anthillapp/anthill) itself, and Node.js on your
`PATH` (the plugin's server is a Node program).

```bash
codex plugin marketplace add anthillapp/anthill
codex plugin add anthill@anthill-local
```

Start a new Codex task after installation. Plugins are loaded when a task
starts, so an already-running task is not an installation check.

The plugin carries its own copy of Anthill's MCP server and of the progress
reporter (`server/anthill-mcp.mjs`, `server/anthill-report.mjs`), so there is
nothing else to build or configure. To update it later:

```bash
codex plugin marketplace upgrade anthill-local
codex plugin add anthill@anthill-local
```

Check each local surface independently:

```bash
codex plugin list --json
codex mcp get exchange --json
open -Ra Anthill
```

The first two show that the skill package and MCP configuration are enabled;
the last locates the installed desktop app. MCP can store a handover while
Anthill is closed, so this is availability information, not proof that a
queued display request was consumed.

### What it runs

* **`bin/anthill-mcp`**, started by Codex as the MCP server. It finds the
  server (below) and runs it with Node on your machine, over stdio.
* **The server** reads and writes handed-over workflows in Anthill's own data
  folder on this machine, and opens Anthill with an `anthill://` link so the
  workflow appears there. With `--dev` (below) it may start the development
  build of a checkout (`npm run dev:desktop`); on Linux it may start the web
  shell (`anthill`) on `127.0.0.1`.
* **Progress reports.** When a run starts, the server gives Codex the commands
  that report each step: `anthill run/step/done …`, or `node
  …/server/anthill-report.mjs run/step/done …` when there is no `anthill` on
  the `PATH`. Each appends one line to `~/.anthill/cli/harness-reports.jsonl`.
* **Nothing is sent off this machine.** The server's one network request is to
  the web shell's `/health` on this machine, to see whether it is running. No
  telemetry, no error reports, no downloads.

### Running a checkout's own server

For working on Anthill itself, build the server and the CLI in your checkout and
point the plugin at that server instead of the copy it carries:

```bash
npm run build:deps
npm run build --workspace=@anthill/mcp
npm run build --workspace=@anthill/cli
npm install --global ./apps/cli
mkdir -p ~/.anthill
printf '{"server": "%s/apps/mcp/dist/server.js"}\n' "$PWD" > ~/.anthill/plugin.json
codex plugin marketplace add "$PWD"
codex plugin add anthill@anthill-local
```

The plugin can also locate the server through `ANTHILL_MCP_SERVER` (the absolute
`server.js` path) or `ANTHILL_REPO` (the absolute checkout path). The settings
file is preferred for a desktop app launched from Finder or the Dock because it
does not inherit shell-profile environment variables. With none of the three
set, the plugin starts the server it carries.

### Which Anthill it talks to

A task's first handover decides, and every later call in that task goes to the
same Anthill; switching takes a new task. The first result says which one it is.

| Where | You type | Handovers go to |
| --- | --- | --- |
| macOS | `$anthill design …` | the installed app (`@anthill/desktop`), which is opened for you |
| macOS | `$anthill design --dev …` | the development build of this checkout (`@anthill/desktop-dev`); `npm run dev:desktop` is started if it is not running |
| Linux, Windows | either | the web shell from source (`~/.anthill/cli`) |

`--dev` counts only as its own word directly after the mode; a bare `dev`, or
`--dev` anywhere else, is part of the task. It needs the server to be built in
an Anthill checkout, which is where `npm run dev:desktop` is run from.

For scripted QA, where a run has nobody to type `--dev`, set the default for
every task instead:

```bash
npm run plugin:target                   # what it is now, and what is running
npm run plugin:target -- electron-dev   # builds the server and the CLI, serves the dev build
npm run plugin:target -- web            # builds the server and the CLI, serves the web shell
npm run plugin:target -- app            # back to the default: the installed app, or --dev
```

It writes `"target"` into `~/.anthill/plugin.json` and touches nothing else there
(`--no-build` skips the build). The Claude Code plugin's server reads the same
file, so both switch together, from the next Codex session on. A task's `--dev`
still outranks it, and on Linux and Windows every task reaches the web shell
whatever it says.

Any other data directory can be named with `--data-dir` and an absolute path in
the `args` in `.mcp.json`; it overrides only the directory. A mismatched
directory is quiet: the MCP server stores the handover, but an Anthill watching
another directory cannot see it.

## Use

```text
$anthill design Add retry-once to checkout; let me edit the workflow first
$anthill watch Fix the importer and show the work in Anthill while you do it
$anthill design --dev Add retry-once to checkout, in the development build
$anthill Describe this task as a workflow
```

On macOS, `--dev` directly after the mode sends the task to the development
build of an Anthill checkout (`npm run dev:desktop`), which Anthill starts if it
is not running; without it, the installed app. The first result says which one
the task reaches, and switching takes a new task. On Linux and Windows every
task reaches the web shell from source, with or without `--dev`.

`design` asks for missing scope, constraints, success criteria, and fixed
decisions, then stops after opening the draft. `watch` binds immediately and
reports the work through the existing `anthill` CLI channel. With no explicit
mode, the skill infers execution intent and otherwise defaults to `design`.

The source session id comes from `CODEX_SESSION_ID`, which Codex records as
`session_id` in its local rollout metadata. The skill never invents or borrows
an id. The workflow target and source harness are both `codex`.

## Detailed progress

Anthill always shows basic progress from Codex's own session records. Its hooks
add the agent's actions and detailed progress. The skill settles them after the
workflow is stored and before Anthill opens it (`create_workflow_draft` with
`open: false`, then `open_workflow`), with `anthill observation status`:

- nothing is asked when Codex has the hooks installed, enabled and approved, or
  when one of them has already fired in this session;
- when they are missing, the user is offered **Connect** or **Continue with basic
  progress**; Connect runs `anthill observation enable`, the other
  `anthill observation skip`, which is remembered until Anthill's hooks change;
- when Codex has not approved them, the user types `/hooks`, chooses **Review
  hooks**, and allows only the entries containing `anthill-observation-hook` —
  never **Trust all**, which would approve every other tool's hooks too. Codex
  also shows **Hooks need review** by itself when a session starts with
  unapproved hooks;
- when the state cannot be confirmed — from inside Codex's sandbox, for
  instance — it is not treated as unapproved: the skill asks for one-time host
  access for that exact command, or carries on with basic progress.

Installing never grants trust, and nothing in Anthill grants it for the user.

Rebuild/update the Anthill CLI as well as refreshing the plugin to get this flow.

## Update, disable, and uninstall

After pulling changes from this local checkout, reinstall so Codex copies a
fresh plugin version into its cache:

```bash
codex plugin remove anthill@anthill-local
codex plugin add anthill@anthill-local
```

`codex plugin marketplace upgrade` refreshes Git-backed marketplaces; it is
not needed for this local marketplace.

Use the Codex Plugins UI to disable the plugin without deleting it. To remove
the cached installation:

```bash
codex plugin remove anthill@anthill-local
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
