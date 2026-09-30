---
name: anthill
description: Hand the current Codex task to Anthill as a complete workflow, optionally let the user review it, then report this task's progress against the exact bound revision. Use when the user invokes $anthill or asks Codex to design, display, or watch work in Anthill.
---

# Anthill workflow handover

Anthill draws the work of this Codex task as a workflow and observes explicit
progress. Anthill does not run Codex, launch agents, select permissions, create
worktrees, or decide what happens next. This task continues to do the work.

Use the Anthill `exchange` MCP tools. Their visible names are host-namespaced;
identify them by these exact suffixes:

- `create_workflow_draft`
- `open_workflow`
- `revise_workflow`
- `get_workflow`
- `get_ready_revision`
- `bind_run`

If they are unavailable, say the local Anthill MCP connection is unavailable.
Do not claim that a workflow was created, and do not synthesize a replacement
transport. The user's task can still continue without Anthill if they choose.

## Invocation and modes

`$anthill` supports two modes:

- **`design <task>`**: draft a workflow for the user to inspect and edit in
  Anthill before this task starts doing the work. `create` is an alias.
- **`watch <task>`**: create and bind the workflow, then do the work while
  reporting each step. `display` is an alias.

With `$anthill <task>` and no mode, infer the mode from the request. Requests to
"review", "edit", "approve", or "look first" mean `design`. Requests to "do",
"implement", "fix", or "show me while you work" mean `watch`. If neither intent
is present, use `design`; it preserves the user's chance to edit before work.

The mode changes the handover UX, not Anthill's authority. It never causes
Anthill to execute anything.

## Which Anthill: `--dev`

On macOS a Codex task reaches one of two Anthills: the installed app, or the
development build of an Anthill checkout. Which one is the user's to say, in
the command itself:

* `$anthill design <task>` (or `watch <task>`) — the installed app.
* `$anthill design --dev <task>` (or `watch --dev <task>`) — the development
  build. Anthill starts it if it is not running.

The same words work when the plugin is tagged rather than typed:
`@anthill design --dev …`.

A machine set up for scripted QA (`npm run plugin:target`) can send a task
without `--dev` somewhere other than the installed app. The first result names
the Anthill the task reached; tell the user that one, not this list.

**`--dev` is the flag only as its own word directly after the mode** —
`design`, `watch`, or their aliases. Everything after it is the task. A bare
`dev` is never the flag: `design dev server for staging` is a task about a dev
server, for the installed app. `--dev` anywhere else in the text is part of the
task too. When in doubt, it is part of the task.

When the user's command carries `--dev`, pass `build: "dev"` on **every** call
to Anthill that takes it for that command — `create_workflow_draft`,
`open_workflow`, `bind_run`, and `get_workflow` or `get_ready_revision` when
picking a `--dev` handover back up. Without `--dev`, leave `build` out. The
task's first handover pins its Anthill, and every later call goes to the same
one; a later `--dev` in a task pinned to the installed app is refused, and a
read with `build` looks without deciding anything.

The first result says which Anthill the task reaches: "This chat's handovers go
to Anthill (dev build)." or "… to Anthill (installed app)." Tell the user in one
line, with whatever the result says about it running or starting. If it is not
the one they meant, say that switching takes a new task: a later call asking for
another build is refused, because the workflows so far live in this Anthill's
exchange. Do not try to work around the refusal.

On Linux and Windows there is only one Anthill, the web shell from source, and
every task reaches it, with `--dev` or without. There is nothing to say about it.

| The user wrote | The task | `build` |
| --- | --- | --- |
| `design Add retry to checkout` | Add retry to checkout | left out |
| `design --dev Add retry to checkout` | Add retry to checkout | `"dev"` |
| `design dev server for staging` | dev server for staging | left out |
| `design --dev …` in a task that already handed over to the installed app | the rest | `"dev"`, refused: tell them it takes a new task |

## Detailed progress: settle it before Anthill opens

Anthill always shows basic progress from Codex's own session records. Anthill's
hooks add the agent's actions and detailed progress. Settle them once per task,
**after** the workflow is stored and **before** it is opened — see "Submit
exactly once": store with `open: false`, do this, then call `open_workflow`.

Run `anthill observation status` from the project directory. It only reads; it
never installs hooks or changes Codex permissions. If the command is missing or
fails, continue with basic progress and do not invent a setup command.

If the result says `requiresHostAccess: true` (even with exit code zero), or the
command reports a local filesystem permission failure, request host approval for
that exact `anthill observation` command and retry once. Do not change sandbox
configuration or broaden future permissions. If approval is unavailable, say so
and continue with basic progress.

Then act on `ask`, and on nothing else:

- **`null`** — nothing to ask. The hooks are installed, enabled and approved, or
  already working in this session (`confirmedInSession: true`). Continue.
- **`"connect"`** — the hooks are missing or need reconnecting. Explain in one or
  two sentences that they let Anthill show the agent's actions and detailed
  progress, and that basic progress works without them. Offer **Connect** and
  **Continue with basic progress**, in the user's language. Wait for the answer;
  silence is not consent. On Connect, run `anthill observation enable` and act on
  its `ask` the same way. On Continue, run `anthill observation skip`.
- **`"trust"`** — Codex holds the hooks but has not approved them. Ask the user to
  type `/hooks` in Codex, choose **Review hooks**, and allow only the entries
  containing `anthill-observation-hook`. Never suggest **Trust all**: it would
  also approve every other tool's hooks in that list. Never grant trust
  yourself or work around the check. When the user says they are done, run
  `anthill observation status` again and act on the new result. If they would
  rather not, run `anthill observation skip` and continue.
- **`"hint"`** — Anthill could not confirm the hooks' state. Do not call them
  unapproved. Relay the `message` in plain words and continue with basic
  progress.

Relay `message` rather than composing your own claim about the hooks. Only
`confirmedInSession: true` means detailed progress is already flowing in this
session; approved hooks that have not fired here yet may start only in a new
Codex session. Either way, continue this task — never ask the user to abandon it.

Do not ask again in the same task once `ask` is `null` or the user chose basic
progress. Anthill asks again on its own when the hooks change, are switched off,
or lose their approval.

Permanent hooks use the installed Anthill app's bundled runtime. If Anthill
cannot find it, relay the installation message; do not write hooks that depend
on nvm, the repository build output, or a guessed executable. Detailed progress
never replaces the bound workflow's `anthill run/step/done` reports.

## Establish the Codex task identity

Before submitting, read the current Codex session identifier without printing
unrelated environment values:

```bash
printf 'session=%s\nthread=%s\n' "${CODEX_SESSION_ID:-}" "${CODEX_THREAD_ID:-}"
```

Use the non-empty `CODEX_SESSION_ID` value verbatim as `source.sessionId`. It is
the `session_id` written into Codex's local rollout metadata and is the value
Anthill's passive observer correlates. `CODEX_THREAD_ID` can help explain which
task is active, but do not substitute it when it differs from the session id.
Never invent an id, copy one from another task, infer one from a file name, or
use a parent/delegating task's id. If `CODEX_SESSION_ID` is empty, do not submit
or bind a workflow. Explain that a verified Codex session id is required for a
correlated handover, then continue the user's underlying task without Anthill
if they choose.

## Understand before drafting

Read the relevant repository files before deciding on workflow steps. A generic
workflow that could have been written without looking at the project is not a
useful handover.

For every new `design` handover, confirm these four areas before calling
`create_workflow_draft`:

1. project/directory and scope, including what is out of scope;
2. constraints and what must be preserved or prohibited;
3. observable success criteria and verification;
4. decisions already made and decisions explicitly delegated to Codex.

Use facts already supplied by the user: summarize them and ask for confirmation
rather than asking them to repeat themselves. A partial answer requires a
follow-up. Wait for the user's actual response; do not answer your own question,
infer permission from an empty directory, scaffold during clarification, or use
a future clarify block as a substitute for this conversation.

For `watch`, do not impose the full questionnaire after the user asked Codex to
start. Say in one line what scope you understood, then proceed. Still ask about
an unsafe or genuinely unspecified boundary, such as creating a new project in
an unnamed directory or working outside the selected repository.

## Build the workflow document

Read [reference/workflow-format.md](reference/workflow-format.md) before building
the document. Submit a complete format-version 5 workflow with:

- a stable workflow id and stable ids for every block, edge, and agent;
- `target: "codex"`;
- the user's goal, project context, constraints, prohibited actions, done
  criteria, verification, and desired final action where known;
- agent profiles referenced by id, with roles matching the actual work;
- concrete tasks, expected outputs, and success criteria on agent blocks;
- explicit connections, conditions, fallback branches, and bounded loops;
- only steps this Codex task can honestly report while doing the work.

Do not create decorative agents or pretend subagents will be used unless the
workflow and this task actually use them. Anthill models intended work; it does
not create Codex agents.

## Submit exactly once, retry idempotently

Call `create_workflow_draft` with `open: false` and:

- one stable `idempotencyKey` for this handover;
- `mode: "design"` or `mode: "watch"`;
- `source.harness: "codex"`;
- the verified `source.sessionId`;
- `source.taskText` containing the user's original request verbatim and, for
  `design`, their clarification answers clearly separated from it;
- the complete `workflow` document;
- `build: "dev"` if the user wrote `--dev` (see "Which Anthill: `--dev`"),
  and no `build` otherwise.

Keep the same key and payload after a lost response. A new key means an
intentional new handover. Never change the workflow id to bypass a refusal.

Handle the returned outcome literally:

- `created`: stored, not opened yet;
- `already_exists`: the identical handover already exists;
- `incomplete`: ask the returned questions or use an answer the user already
  gave, then retry the corrected document under the same identity. The model
  question is the common one: unless the user named a model, the answer is the
  session's own, `"models": { "codex": { "id": "__default__" } }` on every
  agent — write it in the first submission and the question never comes back;
- `invalid`: correct the reported call/document problems.

Once the workflow is stored, settle detailed progress (the section above), then
call `open_workflow` with the workflow id. That brings Anthill up for it: a
closed app is launched, a running one comes to the front. Its `app` field says
what happened — `opened`, or one of `no_handler`, `failed`, `unsupported`,
`disabled` with a message to pass on. Give the user the `anthill://workflow/<id>`
link. A queued request still does not prove that the desktop app opened the
workflow, so say it was handed over and Anthill asked to show it.

## Design mode: stop for the user

After a successful `design` submission, ask whether the workflow is right or
needs changes, then finish the turn. Do not bind or start task work until the
user explicitly says to proceed.

If the user edits in Anthill, ask them to save and tell this task when done.
Then call `get_workflow`, describe the revision now present, and confirm that it
is the one to use. If the revision did not change, say so instead of assuming.

If the user asks Codex to edit the workflow, call `revise_workflow` with the
whole updated document, explain the changes, and ask again. A revision Codex
wrote is not approval from the user.

Do not poll `get_ready_revision`. It returns immediately; the user's next
message is the synchronization boundary.

## Bind the exact revision

For `watch`, continue immediately after submission. For approved `design`,
continue after the user's explicit reply.

1. Call `get_ready_revision` with the workflow id.
2. Work from the returned workflow, not the document originally submitted.
3. Call `bind_run` with its exact `revision` and `digest`, a stable binding
   idempotency key, and the verified current session id as `sessionId`.
4. Retry a lost bind with the identical values. Use a new key only for an
   intentional second run.

If the revision is stale, read readiness again. `not_ready` means the graph
cannot compile; ask or fix only what the result names. `no_such_workflow` will
not become ready by waiting. Never bind a different revision merely because it
is newer.

Binding freezes the run to an immutable workflow revision. Later canvas edits
create another revision and do not alter the running task.

## Report progress through the existing CLI channel

Use the exact commands returned by `bind_run`. They are the only progress
transport; do not write progress into the exchange, invent an MCP reporting
tool, or treat ordinary tool calls as authoritative workflow progress.

The commands have this shape:

```bash
anthill run <run-id> <nonce>
anthill step <run-id> <nonce> <block-id>
anthill done <run-id> <nonce>
```

Run `anthill run` once immediately before work. Run `anthill step` only when
actually entering that block. Run `anthill done` only after the bound workflow's
done criteria and final action are complete. These commands write Anthill's
local progress journal outside the project workspace. If Codex reports
`EPERM`/`EACCES` for that journal, request the narrow local permission the host
offers and retry the same reporting command once. Do not broaden the request to
task files or unrelated paths. If the CLI is unavailable or the user rejects
that permission, say so once and continue the task; reporting failure must not
become task execution failure.

The returned run id, nonce, workflow id, revision, and reporting commands are
correlation data. Preserve them exactly and do not print private reasoning.

## Resume and recovery

A new Codex task has no reliable knowledge of an earlier handover. Require the
workflow id or an `anthill://` link, then call `get_workflow`. Never choose by
recency. If this task will perform work handed over by a different task, pass
this task's verified `CODEX_SESSION_ID` to `bind_run`.

For failures:

- relay MCP refusal details rather than reinterpret them;
- distinguish MCP unavailable from Anthill desktop closed;
- distinguish a stored workflow from one visibly opened by the desktop;
- preserve idempotency keys across unchanged retries;
- do not claim that binding proves observation is active;
- do not collect or display private reasoning.

The manual Anthill copy-paste flow remains valid and must not be modified by
this plugin.
