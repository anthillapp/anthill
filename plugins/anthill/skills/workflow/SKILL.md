---
name: workflow
description: Use when the user wants the work of this session laid out as a workflow in Anthill — "show this in Anthill", "plan this out in Anthill", "/anthill:workflow design …" — or wants to watch this session do a job as a diagram, "/anthill:workflow watch …". Covers handing a task over as a graph, asking the questions that make it complete, binding a run to the graph the user settled on, and reporting progress against it. Not for work that is not going to be done in this session.
version: 0.8.3
user-invocable: true
argument-hint: "[design|create · display|watch] [task]"
---

Anthill is a desktop app that draws the work of a coding session as a diagram and
follows along. This skill hands it the work of *this* session: you describe the
task as a workflow, Anthill shows it to the user, and then you do the work and
say which step you are on.

Anthill does not run anything. It does not start you, stop you, or tell you what
to do next. You do the work; it draws it and watches. Nothing in this skill
should suggest otherwise to the user.

## The two commands

There are two, and the difference between them is whose workflow it is.

* **`design <task>`** — alias `create`. The workflow is **theirs**. You ask what
  you do not know, draft it, hand it over, and stop. They read it on the canvas,
  change what they want, press **Save**, and tell you to go. Then you bind what
  they settled on and work through it.

* **`watch <task>`** — alias `display`. The workflow is **yours**, and they want
  to see the work happen. You compose the graph from the task, hand it over, bind
  it and start — no questionnaire, no waiting. Anthill opens the **Live Session**
  rather than the editor, because there is nothing on the canvas for them to
  settle. Running the command is the go-ahead; do not ask for a second one.

With no argument, read the request. "Plan this out in Anthill", "let me look at
it first", "check with me before you start" is `design`. "Show me this in Anthill
and do it", "I want to watch you do this" is `watch`. When it is genuinely
unclear, **ask** — the difference is whether the user gets to write the plan.

Nothing else is a command. Checking that Anthill is reachable is the first thing
this skill does anyway, and picking up an existing handover is a section near the
bottom; neither needs a word of its own in front of the user.

## Before anything else

Both commands need this.

Check the tools exist. Claude Code presents them as
`mcp__plugin_anthill_exchange__create_workflow_draft` and the others — the prefix
is built from the plugin's name and the key its config gives the server. If they
are not there, the plugin is installed but its MCP server is not connected. Say
so, say the work can go ahead without Anthill if they want, and do not pretend a
workflow exists. Never build a workflow you cannot submit.

A server that failed to start once is not retried for fifteen minutes, so a
connection fixed a moment ago may still look broken. `claude mcp list` says what
is actually reachable.

**Find out who you are.** Every handover records the session that made it, and
Anthill reads that session's own records to show what the work is doing. Run:

```bash
echo "${CLAUDE_CODE_SESSION_ID:-}"
```

That is this session's own id, the one its transcript is named for and carries
inside. **`CLAUDE_CODE_HOST_SESSION_ID` is not it** — that names the app that
started you, it carries a `local_` prefix, and it is the same value for every
session that app spawns, so a handover recorded under it would name somebody
else's conversation. It has been used by mistake once; do not reach for it.

If the variable is empty, say that you could not establish this session's
identity and ask the user whether to continue without it — a handover can still
be made, but Anthill will have nothing to read, so the graph will show only the
steps you report and none of the work. That matters more under `watch` than
under `design`, because watching is the whole point of it. **Never invent one,
and never reuse an id from another session.** It is the one field where a
plausible guess does more damage than an admitted gap.

## Handing a workflow over

1. **Understand the task as work, not as text.** Read what the repository
   actually contains before deciding what the steps are. A workflow that could
   have been written without opening the project is a workflow the user will
   have to rewrite — or, under `watch`, a diagram of a job nobody is doing.

2. **On `design`: ask before drafting. Every new handover needs the user's
   answers.** Before building or calling `create_workflow_draft`, ask a short
   batch of questions covering:

   * **Project and scope:** which project/directory to use, whether this is new
     work or a change to an existing project, and what is in or out of scope.
   * **Constraints:** architecture/patterns, limits, and what must not change or
     must be preserved.
   * **Success criteria:** what the user will check to call this done.
   * **Decisions already made:** what is fixed, what remains open, and which
     choices the user explicitly wants you to make.

   Use what the user has already said: summarize those answers and ask them to
   confirm or correct them rather than asking them to type everything again.
   Even a detailed request needs this confirmation before the first draft.
   An empty directory is an observation, **not permission to create a project**.
   Ask whether to create it there or use an existing project elsewhere. An
   installed toolchain is not a choice of architecture or scope.

   **Wait for an actual user response.** Use the host's question tool when
   available; otherwise ask in chat and finish your turn. Do not submit in the
   same unanswered turn, answer your own questions, treat silence as agreement,
   or add a future "clarify requirements" block instead of asking now. Do not
   create/scaffold a project during this clarification stage; read-only
   inspection is enough. A schema-valid document proves no user intent.

   Proceed only when the user has supplied or confirmed the answers, including
   explicit delegation such as "you choose the architecture" or "no additional
   constraints". If their reply covers only some areas, ask about the remaining
   ones instead of inventing answers. Keep the confirmed answers in the brief's
   context, constraints and done criteria, with delegated choices identified.

   This is what a **new draft** needs, not a questionnaire to repeat on an
   unchanged retry or on picking the same agreed scope back up. Materially new
   scope needs its own clarification.

   **On `watch`: do not run this questionnaire.** The user asked to watch you
   work, and four questions in reply is the opposite of that. Decide the scope
   from what they said and what the repository shows, write the steps you are
   actually going to take, and say in one line what you took the job to be so a
   wrong reading is cheap to correct.

   What `watch` does *not* excuse: it is not permission to create a project
   where none was named, to work outside the directory the conversation is
   about, or to do anything you would have asked about had they not used the
   word. **Ask about that, and only that.** A command that means "get on with
   it" means get on with the job they described, not with a bigger one.

3. **Build the document.** The shape is in
   [reference/workflow-format.md](reference/workflow-format.md). Read it; it is
   exact, and a document that misses it comes back as a refusal rather than as a
   diagram.

   Under `watch` the graph is a promise about what you are about to do, and it
   is the only thing the user will have to read. Write the steps you will report
   against — not an idealised plan you will then depart from.

4. **Submit it** with `create_workflow_draft`, carrying `idempotencyKey`, `mode`,
   `source` (`harness: "claude-code"`, the session id you established, and
   `taskText`), and `workflow`.

   `mode` is the command the user ran: **`"design"`** or **`"watch"`**. It is
   what tells Anthill which screen to open — the canvas or the Live Session —
   and it is the only thing it decides. Do not send one and behave like the
   other.

   `taskText` is **the user's own words**, quoted, not your summary of them.
   Preserve the original request and, under `design`, quote the user's
   clarification answers alongside it, clearly separated; do not put your
   proposed answers in their mouth.
   Anthill shows it back to them to check it understood the same job they did,
   and it is written down once — nothing said later replaces it.

   Mint one `idempotencyKey` for the task and reuse it verbatim on every retry of
   the same handover. A different key means different work.

5. **Read the outcome.**
   * `created` — it is stored, and Anthill has been asked to open it.
   * `already_exists` — this same handover was already stored. Not an error.
   * `incomplete` — nothing was stored. The result carries the questions. Under
     `design`, put them to the user in their own words and submit the corrected
     document under the same key after they answer. Under `watch`, they are
     usually questions you can answer from the task and the repository — answer
     those and resubmit; ask the user only about what you genuinely cannot know.
     Never fill a requirement with an invention to pass validation. The model
     question is the common one: unless the user named a model, answer it with
     the session's own — `"models": { "claude-code": { "id": "__default__" } }`
     on every agent — and better still, write that in the first submission (see
     `reference/workflow-format.md`, Agents).
   * `invalid` — nothing was stored, and the problems say what to change.

   The result carries an `anthill://workflow/<id>` link. Give it to the user —
   it opens or focuses the workflow. **Keep the workflow id**; every later call
   needs it, and a new session cannot guess it.

   Anthill is brought up for it: the server hands the same link to the machine,
   which launches the app or brings it to the front. What that amounts to is in
   the result's `app` field, and it is worth reading before you describe what
   the user is looking at:

   * `opened` — the link was taken. The app is starting or already in front.
   * anything else — `no_handler`, `failed`, `unsupported`, `disabled` — carries
     a message saying why. Pass it on; the handover is stored either way, and
     the link still opens it by hand.

   A stored handover is still not a displayed one. The server writes a request
   into a local inbox and the app reads it on its own schedule, so say that the
   workflow was handed over and Anthill asked to show it — not that the user is
   looking at it.

## On `design`, ask before you start. Always.

The workflow is now in front of the user. **Do not begin the work until they have
said to.** Ask, in your own words, whether the plan is right or something should
change, and say where the workflow is so they can read it.

**Nothing in Anthill enforces this, and nothing ever did.** There was a mode
that appeared to: the approval gate withheld the revision until the user
pressed a button in the app. It withheld the run record and not the work —
this plugin has no hooks, and the server writes files rather than holding a
lock on your repository — while making the user do twice what they had already
done once by answering you. It is gone.

So what stops you is this instruction and nothing else, which makes it worth
more rather than less. A workflow the user has not agreed to is a plan you
wrote for yourself.

Then **finish your turn** and wait. Anthill cannot interrupt this session — it
has no way to reach you, by design — so nothing arrives to tell you they are
done. The next thing they say is what starts you moving.

This section is `design`'s alone. Under `watch` the user has already said to
start, in the command itself; asking again is asking them to approve a plan they
told you not to write for them.

### If they say yes

Go on to `get_ready_revision` and bind.

### If they want to change it

Two ways, and the user picks:

**They edit it in Anthill.** Tell them the two things they need:

> When it looks right, press **Save** in Anthill, then tell me.

Say both halves. Saving is what records the version you will work from — until
they press it, their changes are on their screen and nowhere else. And telling
you is the only way you find out, because Anthill has no way to reach this
session.

If **Save** is greyed out, the graph has problems and Anthill will say how
many. That is deliberate: saving a workflow that does not compile would hand
you a plan you cannot follow. They fix the problems, then save.

Then, when they come back — whatever they say — call `get_workflow` before you
do anything else. A higher revision number means they saved: say which revision
you can now see, confirm that is what they want worked on, and only then bind.
If the number has not moved, say so rather than assuming they changed their
mind — they may have looked and left it alone, or they may have edited and not
pressed Save, and the two are worth telling apart. Never bind the revision you
submitted after they have told you they were going to change it; read what is
there now.

**They ask you to change it.** `revise_workflow` takes the workflow id and the
whole document as it should now read — not a description of the change, and not
just the part that moved. Anthill stores it as a new revision and asks the app
to show it, so they are reading what you wrote rather than what they had.

Then **ask again**. A revision you wrote is not a revision they agreed to, and
writing one and binding it is agreeing with yourself. Say what you changed, and
let them answer.

Two things that are not errors: `unchanged` means Anthill already held exactly
that content, so there was nothing to add — usually a retry, or a change they had
already made themselves. And a workflow with a run bound to it can still be
revised; the run stays on the revision it bound, so nothing shifts under work
already under way.

Never resubmit under a new id to get around a refusal. That leaves two
workflows where the user meant one, and the second is one they never saw.

## Starting the work

`get_ready_revision` tells you which revision may be worked on, and gives you its
content — **which may not be what you submitted, because the user can edit it.**
Work from what it returns, not from what you sent. Under `watch` that will
normally be the revision you just wrote, and reading it back still costs one
call and settles the digest you are about to bind.

What comes back is the latest revision, which is whatever the user last left
on their canvas. It is `not_ready` only when the graph itself cannot be
compiled into a prompt, and the questions to put to the user come back with it.

> **Never poll it.** It answers immediately and it never waits for anybody.
> What you wait for is the user's answer, not this call, and you wait for that
> by finishing your turn. A loop here burns the session doing nothing.

`no_such_workflow` is not a slower `not_ready` — nothing of that id was handed to
this Anthill, and waiting will not change it. Check the id.

Then `bind_run` with that exact `revision` and `digest` and an idempotency key of
its own. Binding freezes the revision: the user can keep editing, and their edits
become a new revision that does not disturb the run. A successful bind returns
the run id, the nonce, and **the exact commands to report progress with**.

Under `watch`, the bind is also what puts the session on the user's screen:
Anthill has the workflow open and moves to the Live Session as soon as a run is
bound to it. Bind before you start working, not after.

## Reporting progress

Anthill has no other way to know which step the work is on. Run the commands
`bind_run` gave you, as you go:

```bash
anthill run <run-id> <nonce>                 # once, before you start
anthill step <run-id> <nonce> <step-id>      # entering each step
anthill done <run-id> <nonce>                # when the work is finished
```

The step ids are the block ids of the bound revision. Report a step when you
actually start it, not in advance. If the `anthill` command is not on the path,
say so once and carry on with the work — the reporting is how the user watches,
not how the work happens.

This is the whole of what `watch` shows. A watched session that never reports a
step is a Live Session page with a graph nobody is moving through, which is the
one way this command can disappoint somebody who asked for nothing else.

## Picking a handover back up

A new session knows nothing. Ask the user for the workflow id, or take it from
the `anthill://` link if they have it, and read it with `get_workflow`. **Never
guess from recency**: opening somebody else's workflow because it was the most
recent is worse than asking. Picking up an agreed scope is not a new draft, and
does not need the clarification questions again.

If this session's id differs from the one that made the handover, pass yours to
`bind_run` as `sessionId` so the run is matched against the right session files.

## When something is wrong

Every refusal from these tools says what to change. Relay it, do not reinterpret
it. In particular:

* **Anthill not running** — the handover is stored and waiting. Not a failure.
  Under `watch`, say so plainly: there is nothing to watch until they open it.
* **`conflict`** — something else holds what this call asked for. The message
  names it. A deliberate new run needs a new idempotency key.
* **Stale revision** — the user edited past what you were about to bind. Read
  `get_ready_revision` again and bind what it says now.
* **The server is pointed at the wrong data directory** — the usual cause of
  `no_such_workflow` for an id you just created. Every refusal from the server
  reports the directory it is serving.

Never report a workflow as created, displayed or bound on the strength of a call
you did not make or an outcome you did not read.
