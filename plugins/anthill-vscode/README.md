# The Anthill plugin for VS Code

Hands the work of a VS Code agent chat to Anthill as a workflow you can read and
edit, then reports progress against the graph you settled on.

Anthill runs nothing. VS Code's agent does the work; Anthill draws it and
watches.

This is VS Code's own agent-plugin format: `plugin.json` at the root,
`.mcp.json`, and `skills/`. It needs VS Code with agent plugins (1.110 or
later) and a chat that can use tools, such as one in Agent mode. It has not yet
been verified end to end.

## What it gives you

* `/anthill:workflow` — one skill, taking `design` or `watch` plus the task.
* Six MCP tools from Anthill's own server, which the skill calls for you.

## Installing

You need [Anthill](https://github.com/nstr/anthill) itself, and Node.js on your
`PATH` (the plugin's server is a Node program).

VS Code has no command line for plugins; both ways in are settings.

**From GitHub.** Add Anthill's repository as a plugin marketplace in your user
`settings.json`, then install **anthill** from the plugins VS Code offers:

```json
"chat.plugins.marketplaces": ["nstr/anthill"]
```

VS Code reads this repository's `.github/plugin/marketplace.json`, which lists
this plugin. Claude Code reads `.claude-plugin/marketplace.json` from the same
repository and never this one, so each tool gets its own plugin named
`anthill`.

**From a checkout.** Point VS Code at this folder; it is read where it is, so a
pull is picked up by the next chat:

```json
"chat.pluginLocations": { "/abs/path/to/anthill/plugins/anthill-vscode": true }
```

Then start a new chat.

The plugin carries its own copy of Anthill's MCP server, in
`server/anthill-mcp.mjs`. VS Code may ask you to allow that server before it
starts it the first time; **MCP: List Servers** in the Command Palette shows it
and its output.

### What it runs

* **`bin/anthill-mcp`**, started by VS Code as the MCP server
  (`node ${PLUGIN_ROOT}/bin/anthill-mcp --host vscode`). It finds the server
  and runs it with Node on your machine, over stdio. `--host vscode` tells it
  which harness it serves; the server never sees the flag.
* **The server** reads and writes handed-over workflows in Anthill's own data
  folder on this machine, and opens Anthill with an `anthill://` link so the
  workflow appears there.
* **Progress commands** (`anthill run`, `anthill step`, `anthill done`, or the
  `node …/server/anthill-report.mjs` equivalent), which the agent runs in VS
  Code's terminal. VS Code may ask you to allow each one.
* **Nothing is sent off this machine.** No telemetry, no error reports, no
  downloads.

### Running a checkout's own server

As for the other plugins: `ANTHILL_MCP_SERVER`, `ANTHILL_REPO` or
`~/.anthill/plugin.json` name a server built in a checkout, and the launcher
prefers them to its own copy. See the Claude Code plugin's README for the
details; the launcher is the same file.

## Using it

```
/anthill:workflow design Add retry-once to the checkout flow, let me read it first
/anthill:workflow watch  Rework the importer — show me the work as it happens
/anthill:workflow design --dev Add retry-once to the checkout flow, in the dev build
```

**`design`** — the workflow is yours. The agent asks what it does not know,
drafts the plan and stops. Anthill opens it on the canvas, you change what you
want, press **Save** and tell the chat to start. It works from what you saved.

**`watch`** — the workflow is the agent's, and you want to see the work happen.
It writes the graph from your task, hands it over and starts. Anthill opens the
**Live Session**.

On macOS, `--dev` directly after the mode sends the chat to the development
build of an Anthill checkout; without it, the installed app.

## What Anthill sees

VS Code gives a chat no id a tool can read, so the skill makes one for each chat
(`vscode-<uuid>`) and hands it over as the session. Anthill does not read VS
Code's chat records yet: what the Live Session shows is the steps the agent
reports, and nothing between them.

Every step runs in the chat, on the chat's model. The agents a workflow names
are roles in one prompt, not separate VS Code agents, and Anthill does not pin
a model per agent here.

## Uninstalling

Remove the plugin in VS Code, or take its entry out of `chat.pluginLocations`.
That does not touch `~/.anthill/plugin.json`, the workflows Anthill has stored,
or anything the app keeps.
