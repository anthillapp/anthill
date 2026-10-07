# The Anthill plugin for Claude Code

Hands the work of a Claude Code session to Anthill as a workflow you can read,
edit, then reports progress against the graph you settled on.

Anthill runs nothing. Claude Code does the work; Anthill draws it and watches.

Verified against **Claude Code 2.1.261** (desktop app 2.2553.1) and **Anthill
0.7.3** on macOS. Other versions are untested rather than unsupported.

## What it gives you

* `/anthill:workflow` — one skill, taking `design` or `watch` plus the task, or
  `run` plus the path to a saved `workflow.json`.
  It is listed as `anthill:workflow`,
  and a session with no other skill of that name also answers to the short
  `/workflow` — the namespaced spelling is the one that cannot be taken by
  somebody else's plugin.
* Five MCP tools from Anthill's own server, which the skill calls for you.

## Installing

You need [Anthill](https://github.com/anthillapp/anthill) itself, and Node.js on your
`PATH` (the plugin's server is a Node program).

```bash
claude plugin marketplace add anthillapp/anthill
claude plugin install anthill@anthill --scope user
```

Then start a new session: a plugin is read when a session starts.

The plugin carries its own copy of Anthill's MCP server, in
`server/anthill-mcp.mjs`, so there is nothing else to build or configure.

### What it runs

* **`bin/anthill-mcp`**, started by Claude Code as the MCP server. It finds the
  server (below) and runs it with Node on your machine, over stdio.
* **The server** reads and writes handed-over workflows in Anthill's own data
  folder on this machine, and opens Anthill with an `anthill://` link so the
  workflow appears there. With `--dev` (below) it may start the development
  build of a checkout (`npm run dev:desktop`); on Linux it may start the web
  shell (`anthill`) on `127.0.0.1`.
* **Nothing is sent off this machine.** The server's one network request is
  to the web shell's `/health` on this machine, to see whether it is running.
  No telemetry, no error reports, no downloads.

### Running a checkout's own server

For working on Anthill itself, point the plugin at the server built in your
checkout instead of the copy it carries:

```bash
npm run build:deps && npm run build --workspace=@anthill/mcp
mkdir -p ~/.anthill
printf '{"server": "%s/apps/mcp/dist/server.js"}\n' "$PWD" > ~/.anthill/plugin.json
claude plugin marketplace add "$PWD"
claude plugin install anthill@anthill --scope user
```

Four places are looked at, in order. The first three are something you chose;
the last is the copy inside the plugin, used when none of them is set:

| | |
| --- | --- |
| `ANTHILL_MCP_SERVER` | the built `server.js` itself |
| `ANTHILL_REPO` | a checkout; the server is at `apps/mcp/dist/server.js` |
| `~/.anthill/plugin.json` | `{"server": "/abs/path/to/server.js"}` |
| `server/anthill-mcp.mjs` | the server this plugin carries |

Prefer the file. An environment variable set in your shell profile does not
reach an app launched from the Dock, which is exactly when you will not think
of it.

A relative path is refused: this process starts in whatever directory the host
was in. If a path you set has no file at the end of it, the server exits with a
message naming all of them and the host shows it as failed — which is the
honest outcome, because a server that cannot be found is not a server that
answers "no".

### Which Anthill it talks to

A chat's first handover decides, and every later call in that chat goes to the
same Anthill; switching takes a new chat. The first result says which one it is.

| Where | You type | Handovers go to |
| --- | --- | --- |
| macOS | `/anthill:workflow design …` | the installed app (`@anthill/desktop`), which is opened for you |
| macOS | `/anthill:workflow design --dev …` | the development build of this checkout (`@anthill/desktop-dev`); `npm run dev:desktop` is started if it is not running |
| Linux, Windows | either | the web shell from source (`~/.anthill/cli`) |

`--dev` counts only as its own word directly after the mode; a bare `dev`, or
`--dev` anywhere else, is part of the task. It needs the server to be built in
an Anthill checkout, which is where `npm run dev:desktop` is run from.

**For scripted QA**, where a run has nobody to type `--dev`, set the default
for every chat instead:

```bash
npm run plugin:target                   # what it is now, and what is running
npm run plugin:target -- electron-dev   # builds the server and the CLI, serves the dev build
npm run plugin:target -- web            # builds the server and the CLI, serves the web shell
npm run plugin:target -- app            # back to the default: the installed app, or --dev
```

It writes `"target"` into `~/.anthill/plugin.json` and touches nothing else there
(`--no-build` skips the build). The server reads the same file, and so does the
Codex plugin's, so both switch together, from the next harness session on. A
chat's `--dev` still outranks it, and on Linux and Windows every chat reaches the
web shell whatever it says. The skill text still comes from the installed
plugin copy; a change to the skill itself needs
`claude plugin update anthill@anthill`.

Any other data directory can be named outright by adding arguments in
`.mcp.json`; it overrides only the directory:

```json
{ "args": ["${CLAUDE_PLUGIN_ROOT}/bin/anthill-mcp", "--data-dir", "/abs/path"] }
```

Getting this wrong is quiet rather than loud: the server stores every handover
happily while the app watches a directory nothing arrives in. Every refusal
from the server names the directory it is actually serving, which is how you
find out you have two.

## Scopes

`--scope user` (the default) installs for every project you open. `--scope
project` records the plugin in the project's own settings, so everyone who opens
it is offered the same plugin — the marketplace source and the MCP command stay
reviewable in version control, and nothing is enabled without the confirmation
Claude Code puts up. `--scope local` keeps it to this checkout without touching
shared settings. All three are the host's mechanisms; this plugin adds nothing
to them and works the same under each.

## Using it

```
/anthill:workflow design Add retry-once to the checkout flow, let me read it first
/anthill:workflow watch  Rework the importer — show me the work as it happens
/anthill:workflow run "~/Library/Application Support/@anthill/desktop/exchange/workflows/importer/workflow.json"
/anthill:workflow design --dev Add retry-once to the checkout flow, in the dev build
```

On macOS, `--dev` directly after the command sends the chat to the development
build of an Anthill checkout (`npm run dev:desktop`), which Anthill starts if it
is not running; without it, the installed app. The first result says which one
the chat reaches, and switching takes a new chat. On Linux and Windows every chat
reaches the web shell from source, with or without `--dev`.

Three commands. The first two hand a new job over, and the difference is whose
workflow it is; the third runs one you already have.

**`design`** — the workflow is yours. Claude asks what it does not know, drafts
the plan and stops. Anthill opens it on the canvas, you change what you want,
press **Save** and tell the session to start. It works from what you saved.

Before it drafts anything, it asks you about the project and location, scope,
constraints, success criteria and the decisions already made. If you gave those
details in your request it summarises them back for you to confirm rather than
making you type them twice. A partial answer gets a follow-up question, not an
invented requirement, and an empty folder is an observation rather than
permission to create a project there.

**`watch`** — the workflow is Claude's, and you want to see the work happen. It
writes the graph from your task, hands it over and starts: no questions, no
waiting for you. Anthill opens the **Live Session** rather than the editor,
because there is nothing there for you to settle — the command itself was the
go-ahead. What you watch is the session's own progress reports moving through
the graph it wrote.

**`run "<path>"`** — run a workflow you already have again, from its
`workflow.json`. **Export** in Anthill copies the command with the path in it.
There is nothing to ask and nothing to draft: the file is the plan and the
command is the go-ahead, so the session starts at once, and Anthill follows each
run as a new session. Keep the command and run it as often as you like.

`create` and `display` are accepted as aliases for the two. With no command,
Claude reads the request; when that is genuinely ambiguous it asks, because the
difference is whether you get to write the plan.

Save is greyed out while the workflow has problems, and says how many. That is
the one thing stopping a session being handed a graph it cannot follow: a
handover has no other way to record a version, so nothing broken is ever
recorded.

There was a **Ready for agent** button here. It looked like it held work back
and did not — the plugin has no hooks, so withholding a revision withheld
Anthill's record of the run and not the work — while asking you to say twice
what you had already said once.

The MCP server validates what a workflow contains, not how it was arrived at.
It cannot tell whether the caller really asked you anything, so the questions
above are something the skill does rather than something the server enforces.
See [pre-draft regression checks](tests/draft-clarification.md) for the cases
that check it, including partial answers and unchanged retries.

## Updating, disabling, uninstalling

```bash
claude plugin marketplace update anthill   # after pulling the checkout
claude plugin disable anthill@anthill      # stop loading it; nothing is deleted
claude plugin enable anthill@anthill
claude plugin uninstall anthill@anthill
```

Uninstalling removes the plugin and its MCP registration. It does not touch
`~/.anthill/plugin.json`, the workflows Anthill has stored, or anything the app
holds — those are Anthill's, not the plugin's. Delete `~/.anthill/plugin.json`
by hand if you want the pointer gone too.

A binding already made is unaffected by any of this: it lives in Anthill's own
store, and a run reports progress through the `anthill` CLI rather than through
the plugin.

## When something is wrong

**The tools are not there.** The skill looks for
`mcp__plugin_anthill_exchange__create_workflow_draft`; the prefix is built from
the plugin's name and the key its `.mcp.json` gives the server — `exchange`,
because what the server operates on is Anthill's exchange directory rather than
the app itself, which it cannot reach and does not speak for. Check with:

```bash
claude mcp list | grep anthill
```

**It says connected but a session disagrees.** A server that failed to start
once is not retried for fifteen minutes. Fix the cause, then start a new session
— or, to retry at once, remove the `plugin:anthill:exchange` entry from
`~/.claude/mcp-needs-auth-cache.json`.

**`no_such_workflow` for an id you just made.** Almost always the data
directory: the server is writing somewhere the app is not reading. The refusal
names the directory the server is serving; compare it with the app's.

**Progress does not appear in Anthill.** The `anthill` CLI writes the reports;
check it is on the path. Without it the work still happens, and the diagram just
does not move.

## What it will not do

No Anthill API, no additional model key, no shell or filesystem tools, no
network listener. The tools write into Anthill's local exchange directory
and read it back, and nothing else. Your reasoning is not collected: what
crosses the boundary is the task in your own words, the workflow and run
metadata.

The manual path — compile a prompt in Anthill, paste it in yourself — is
untouched and still works.
