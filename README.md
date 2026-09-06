# Anthill

Anthill is a local-first desktop app for designing AI coding-agent workflows and
watching them happen.

You draw a workflow as a graph — the steps, the agent who carries each one out,
the conditions between them, the loops and where they stop. Anthill compiles it
into a prompt and the agent files that back it. You paste the prompt into Claude
Code or Codex yourself. Anthill then recognises that session from a marker in the
prompt and shows you, read-only, where it got to.

## What Anthill does not do

This is the most important section, so it is the first.

**Anthill does not run anything.** It never starts, stops, answers or steers an
agent. It has no terminal and no model of its own, and the running app makes no
network calls at all — not to Anthropic, not to OpenAI, not anywhere. (Installing
it downloads dependencies, like any project; using it does not.) The ordering,
conditions, loops and limits in a generated workflow are *instructions for
whoever reads the prompt*, not behaviour Anthill enforces. Generated prompts say
so in their own text, so nobody reading one mistakes a workflow for a guarantee.

It also does not:

- attach to, resume or control a session — observation is one-way and read-only;
- manage permissions, sandboxes or approvals for the agent;
- display private reasoning. It reads records the CLI already writes on this
  machine, and stores only what the Live Session view needs;
- send anything off this machine.

Running workflows — invoking agent CLIs, streaming progress, keeping run history,
isolating workspaces — is a future **Runner / Orchestrator**. Some of its code is
in this repository (`packages/engine`, `runtimes`, `workspace`, `run-store`), it
is not part of the current product, and it is not reachable from the app.

## Requirements

| | |
| --- | --- |
| **Platform** | macOS (Apple Silicon). See *Platform status* below. |
| **Node.js** | Developed and tested on 22.23. There is no `engines` pin, so older majors are untried rather than refused. |
| **npm** | 10.9 (the one that ships with Node 22). The repo is npm workspaces. |
| **Claude Code** | Optional. `claude` on your `PATH`, signed in. |
| **Codex CLI** | Optional. `codex` on your `PATH`, signed in. |

Neither CLI is required to install or open Anthill. You can design a whole
workflow with neither installed; the app says which tools it can and cannot find
rather than pretending. You need at least one to hand a workflow over, because
that is the CLI you paste the prompt into.

### Platform status

Anthill is developed and tested on macOS on Apple Silicon, and that is the only
configuration packaged today (`npm run package` builds `--mac --dir` for
`arm64`).

Windows and Linux are **not supported**. The app is Electron and much of it is
portable, but nothing has been verified there, the packaging targets do not exist,
and the paths below are macOS paths. Treat running it elsewhere as unexplored
rather than as a supported setup.

## Install

From a clean checkout:

```bash
npm install
```

Then fetch the Electron build of one native dependency:

```bash
node apps/desktop/scripts/fetch-electron-sqlite.mjs
```

Expected last line:

```text
Electron-ABI better_sqlite3 written to <repo>/apps/desktop/native/better_sqlite3.node
```

A native addon is compiled against one runtime's ABI. The copy npm installs
targets your system Node; Electron refuses to load it. This writes a second
binary beside it so the tests and the app each get the one they need. It belongs
to the future runner rather than to the workflow builder, but the app expects it
at startup.

Now start it:

```bash
npm run dev:desktop
```

This builds every workspace package and then opens the Electron window. Expect
about a minute the first time. The window is the Anthill launcher: the app mark
and three ways to start on the left, your workflows and agents on the right.

To check the tree without running it:

```bash
npm run typecheck
npm test
```

Both should pass on a clean checkout.

## Your first workflow

1. **Create one.** In the launcher, *Create New Workflow…* starts from a
   template or blank. *Workflow from a Prompt…* describes the work in your own
   words and asks a local CLI to draft a workflow — that run is locked down: no
   tools, an empty temporary folder, and none of your MCP servers.
2. **Design it.** Drag steps from the palette, connect them, and give each step
   an agent. A connection can carry a condition; a loop needs a pass limit and
   done criteria. The Problems list says what is unfinished and takes you to the
   field that fixes it.
3. **Hand it over.** Open the handover. Anthill asks for the project folder,
   writes the agent files into it, registers the run, and copies the prompt.
   That order matters: a harness fixes its list of callable agents when its
   session starts, so the files must be in place before you paste.
4. **Paste it yourself.** Start Claude Code or Codex in that project and paste
   the prompt. **Anthill does not do this for you and cannot.**
5. **Watch it.** If Live Observation is on, Anthill recognises the session from
   the run marker at the top of the prompt and the workflow shows what the
   session is doing — which step it announced, what came back, where it looped.
   When it cannot tell, it says so rather than guessing.

Without Live Observation the first four steps work exactly the same. You lose
step 5 and nothing else.

## Live Observation

Anthill sees a session in two ways, both passive:

- **Transcripts and rollouts** it can read on its own — `~/.claude/projects/`
  for Claude Code, `~/.codex/sessions/` for Codex. Nothing to install.
- **Local hooks**, which the CLI calls as it works. More timely, and they need
  one-time setup.

Open **Settings** (⌘,) to install them. Anthill adds its own entries to
`~/.claude/settings.json` and `~/.codex/hooks.json`, backing the file up first,
and marks each entry as its own so disabling later removes only what it added.
The hook command appends a line to `~/.anthill/live-hooks/events.jsonl` and
exits. It reads nothing else and sends nothing anywhere.

**Verifying it worked.** Settings reports each harness separately, and it
distinguishes states that look alike:

- *Not installed* — no Anthill entries in that config file.
- *Installed, waiting* — entries are there, and the CLI has not called them yet.
- *Working* — an event has actually arrived. This is the only state that proves
  the hooks run, because a config file can be correct and still never be read.

If a harness stays at *installed, waiting*, start a session in that CLI and do
something in it. Anthill re-checks when you come back to the window. You can also
look directly:

```bash
tail -f ~/.anthill/live-hooks/events.jsonl
```

Lines appearing there while a session runs means the hooks work, whatever the
screen says.

## What lands in your project

Only the agent files, and only in the folder you choose during handover:

- **Claude Code** — `.claude/agents/<agent>.md`, Markdown with YAML front
  matter.
- **Codex** — `.codex/agents/<agent>.toml`, the documented custom-agent schema.

The prompt itself goes to your clipboard, not to disk. Anthill writes nothing
else into your repository.

> **Codex version note.** Project-scoped custom agents are a recent Codex
> feature. Anthill checks the `codex` on your `PATH` — not a copy inside some
> application bundle — and if that build does not read `.codex/agents`, the app
> says *Update needed* on the tool's card, keeps whatever model you chose, marks
> it "saved, but not applied", and warns you before handover that the files will
> be ignored and every step will run on the session's own model. Nothing is
> blocked; the choice becomes true when you update.

## Where Anthill keeps things

Everything is local, and there is no account, no sync and no telemetry.

| Path | What |
| --- | --- |
| `~/Library/Application Support/@anthill/desktop/` | Recent workflows, the agent library, pending-run state |
| `~/.anthill/live-hooks/events.jsonl` | The hook event log |
| `~/.anthill/live-observation-setup.json` | Whether you dismissed or installed hook setup |
| `~/.claude/settings.json`, `~/.codex/hooks.json` | Your CLIs' own configs — Anthill adds only its own marked entries |

Your workflows are ordinary `.workflow.json` files, wherever you saved them.

Anthill reads two things it does not own: your CLIs' session transcripts, to
follow a run, and Codex's model catalogue, to offer real model names instead of
a list hand-copied into our source. Both are read-only, both are local.

## Troubleshooting

**A blank window in development.** The Vite dev server on port 5173 has died.
Check with `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` and
restart `npm run dev:desktop` if it is not answering.

**`npm run dev:desktop` exits immediately.** A packaged `Anthill.app` is already
running and holds the single-instance lock. Quit it and try again.

**`ERR_DLOPEN_FAILED` or a `NODE_MODULE_VERSION` mismatch at startup.** The
Electron build of `better-sqlite3` is missing. Re-run
`node apps/desktop/scripts/fetch-electron-sqlite.mjs`. Re-running is safe; it
never writes into `node_modules`.

**A CLI shows as "not found" that you know is installed.** Anthill resolves it on
the `PATH` its own process inherited, which is not your shell's if you launched
the app from Finder. Start it from a terminal to check.

**A CLI shows as "signed out" and you are not.** Anthill asks the CLI, and takes
an unclear answer as unclear rather than as a no. If it says *signed out*, the
CLI said so; sign in from that CLI's own window and come back — Anthill re-checks
when the window regains focus. It never handles your credentials.

**The session is running and Anthill shows nothing.** Check the hook log above.
If the log is empty, the hooks are not installed or the CLI is not calling them.
If the log has lines, the run marker was probably lost — that happens when the
prompt is edited before pasting.

## Repository layout

```text
apps/
  desktop/          Electron app: the launcher, canvas, handover and Live Session

packages/
  workflow-schema/  the graph model and its validation
  workflow/         actions, agents, harness profiles, validation, prompt and file compilation
  builder/          canvas, palette, document operations
  live/             run markers, pending-run state, bootstrap prompts, observation events
  ui/               shared UI primitives

  # Future Runner / Orchestrator — not part of the product today
  engine/           workflow execution
  runtimes/         Codex CLI and Claude Code adapters
  workspace/        repository and isolation management
  run-store/        run persistence
```

## Documentation and issues

Planning and specs live in Linear, under the Anthill team's
[documents](https://linear.app/anthill-workspace/team/ANT/documents):

- [The workflow builder](https://linear.app/anthill-workspace/document/the-workflow-builder-c4a416250c41) — how it works
- [Product Brief](https://linear.app/anthill-workspace/document/product-brief-e6635d9d808b)
- [Workflow Model](https://linear.app/anthill-workspace/document/workflow-model-20e3ec89564a)
- [Visual Builder — the canvas](https://linear.app/anthill-workspace/document/visual-builder-the-canvas-e429d736305f)
- [Live Session Auto-Detection](https://linear.app/anthill-workspace/document/live-session-auto-detection-the-observation-spec-f7d0e5667ebc) — the observation spec
- [Block Library Research](https://linear.app/anthill-workspace/document/block-library-research-the-approved-spec-66ac6a45830f)
- [Roadmap](https://linear.app/anthill-workspace/document/roadmap-f761b9ffd48f)
- [Backlog and Known Gaps](https://linear.app/anthill-workspace/document/backlog-and-known-gaps-d04735ba2e04)

Report bugs and request features as issues in the
[Anthill team](https://linear.app/anthill-workspace/team/ANT/all). For anything
about a session Anthill misread, say which CLI and whether hooks were installed —
those two facts decide almost every observation question.

Note that `docs/` is git-ignored: it is a scratch directory for generated
reports, not project documentation.
