# The Anthill plugin for Claude Code

Hands the work of a Claude Code session to Anthill as a workflow you can read,
edit and approve, then reports progress against the revision you approved.

Anthill runs nothing. Claude Code does the work; Anthill draws it and watches.

Verified against **Claude Code 2.1.261** (desktop app 2.2553.1) and **Anthill
0.7.1** on macOS. Other versions are untested rather than unsupported.

## What it gives you

* `/anthill:workflow` — one skill, taking `design`, `review`, `status`, `resume`
  or `doctor` plus a task or a workflow id. It is listed as `anthill:workflow`,
  and a session with no other skill of that name also answers to the short
  `/workflow` — the namespaced spelling is the one that cannot be taken by
  somebody else's plugin.
* Five MCP tools from Anthill's own server, which the skill calls for you.

## Installing

Nothing here is published. The plugin is installed from this checkout, and it
needs the MCP server built from the same checkout.

```bash
# 1. Build the server the plugin talks to.
npm run build:deps && npm run build --workspace=@anthill/mcp

# 2. Tell the plugin where that server is. Pick one of the three below.
mkdir -p ~/.anthill
printf '{"server": "%s/apps/mcp/dist/server.js"}\n' "$PWD" > ~/.anthill/plugin.json

# 3. Register this checkout as a marketplace and install from it.
claude plugin marketplace add "$PWD"
claude plugin install anthill@anthill --scope user
```

Then start a new session: a plugin is read when a session starts.

### Where the server is

The plugin is a directory of text; the server is a built file elsewhere. Three
places are looked at, in order, and each is something you chose:

| | |
| --- | --- |
| `ANTHILL_MCP_SERVER` | the built `server.js` itself |
| `ANTHILL_REPO` | a checkout; the server is at `apps/mcp/dist/server.js` |
| `~/.anthill/plugin.json` | `{"server": "/abs/path/to/server.js"}` |

Prefer the file. An environment variable set in your shell profile does not
reach an app launched from the Dock, which is exactly when you will not think
of it.

A relative path is refused: this process starts in whatever directory the host
was in. If nothing is set, or the path has no file at the end of it, the server
exits with a message naming all three and the host shows it as failed — which is
the honest outcome, because a server that cannot be found is not a server that
answers "no".

### Which Anthill it talks to

By default, the installed desktop app's own data directory — right if you use
the app you downloaded. A development build keeps its data somewhere else, so
point the server at it explicitly by adding arguments in `.mcp.json`:

```json
{ "args": ["${CLAUDE_PLUGIN_ROOT}/bin/anthill-mcp", "--data-dir", "/abs/path"] }
```

Getting this wrong is quiet rather than loud: the server stores every handover
happily while the app watches a directory nothing arrives in. `/anthill:workflow doctor`
prints the directory the server is actually serving.

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
/anthill:workflow design Add retry-once to the checkout flow and show the plan
/anthill:workflow review Rework the importer, but let me approve the steps first
/anthill:workflow status  workflow-checkout-rework
/anthill:workflow resume  workflow-checkout-rework
/anthill:workflow doctor
```

`design` hands the work over and gets on with it. `review` waits for you to mark
a revision **Ready for agent** in Anthill first. With no argument the skill reads
the request and asks when it genuinely cannot tell.

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
directory: the server is writing somewhere the app is not reading. `/anthill:workflow doctor`.

**Progress does not appear in Anthill.** The `anthill` CLI writes the reports;
check it is on the path. Without it the work still happens, and the diagram just
does not move.

## What it will not do

No Anthill API, no additional model key, no shell or filesystem tools, no
network listener. The tools write into Anthill's local exchange directory
and read it back, and nothing else. Your reasoning is not collected: what
crosses the boundary is the task in your own words, the workflow, approval state
and run metadata.

The manual path — compile a prompt in Anthill, paste it in yourself — is
untouched and still works.
