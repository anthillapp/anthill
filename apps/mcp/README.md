# `@anthill/mcp` — the server a coding harness hands a workflow over through

One local process, spawned by the harness, speaking JSON-RPC over stdio. A
harness the user already started designs a workflow and gives it to Anthill
through the tools here; Anthill validates it, stores it, shows it, lets the
user edit and approve it, and watches the work the harness then does. This
server launches no agent, runs no command, reads none of the user's files, opens
no port and makes no network request. It writes into Anthill's exchange
directory and leaves a request there for the app, which reads on its own
schedule. There is no socket between the two.

This is the package ANT-80 and ANT-81 wrap as a plugin. What an adapter author
has to get right is the data directory, the sequence, and what an answer does
not mean.

## Running it

From the repository root, `npm run build:deps` and then
`npm run build --workspace=@anthill/mcp`. The tests want Node 22.

A harness is configured to run Node against the built file:

```text
/absolute/path/to/anthill/apps/mcp/dist/server.js
--data-dir
/absolute/path/to/anthill-user-data
```

`--data-dir` names Anthill's user-data directory — the exchange is a directory
inside it — and it has to be the same one the desktop app is reading. It is the
one setting that can be silently wrong: a server pointed elsewhere validates
every submission, stores every handover and answers every call happily, while
the app watches a directory nothing is arriving in and the user sees nothing
open. So the path must be absolute, because a harness's working directory
changes under it; it may be given at most once; and any other argument is
refused rather than skipped, since a mistyped `--data-dirr` that was shrugged at
is exactly the failure above with nothing to recover from. Given no flag, the
installed desktop's own directory is used — right for a user, wrong for
development, which should point at a directory of its own.

A flag rather than an environment variable because Codex passes only the
variables its `env_vars` allowlist names, so a server reading `ANTHILL_DATA_DIR`
would work under one harness and quietly fall back under another.

Once the server is up it writes the directory it is serving to stderr. Nothing
in the process may write to stdout: that is the transport, and a stray line
corrupts the message stream.

## The tools, and the sequence they make

`create_workflow_draft` → `get_ready_revision` → `bind_run`, once per handover.
`get_workflow` answers where a handover stands and is not part of the sequence.
`revise_workflow` stores a later version of one that exists, for when the user
asks the harness to change the plan rather than changing it in the app; it is
kept apart from `create_workflow_draft` because the two differ in what they
need — one claims a name and carries a key promising a retry is a retry, the
other addresses a name already claimed and is identified by its content.
The names carry no prefix, since a host namespaces them already, and generously:
Claude Code 2.1.261 presents them to a model as
`mcp__plugin_anthill_exchange__create_workflow_draft` — `plugin`, then the
plugin's name, then the key its `.mcp.json` gives this server. A server
configured directly rather than through a plugin gets the shorter
`mcp__anthill__…`. Either way the prefix is the host's to choose, and an
`anthill_` of our own would only repeat it.

An adapter naming this server is naming what it operates on, which is the
exchange directory — not the app, which it cannot reach and does not speak for.

1. **`create_workflow_draft`** takes `idempotencyKey`, `mode`, `source`
   (`harness`, `sessionId`, `taskText`) and the whole `workflow` document. The
   outcome is `created`, `already_exists`, `incomplete` or `invalid`. An
   incomplete handover is not stored and does not reserve its id: the result is
   the list of questions to put to the user, and the corrected document is
   submitted again under the same key. The submission lands on the id the
   document itself carries; `idempotencyKey` is the promise that a second
   submission under that id is the same call rather than different work.
   `taskText` is the user's own words, written down once and never replaced —
   Anthill shows it back to them so they can see whether the same job was
   understood — so quote them rather than paraphrasing.

2. **`get_ready_revision`** takes the workflow id and answers `ready`,
   `not_ready`, `no_such_workflow` or `invalid`. **It never blocks.** Under
   `approval-gate` it stays `not_ready` until the user approves a revision,
   which takes as long as reading takes; the answer is to say what Anthill is
   waiting for, finish the turn, and ask again when the user says they are done.
   Do not loop on it. `no_such_workflow` is not a slower `not_ready`: nothing of
   that id was ever handed to this Anthill, and waiting will not change it —
   usually it means the server is pointed at the wrong data directory. What
   comes back is the revision, its digest and its content, which may not be what
   was submitted, because the user can edit it.

3. **`bind_run`** takes that exact `revision` and `digest`, plus a stable
   `idempotencyKey` of its own and optionally a `sessionId` when the session
   doing the work is not the one that handed the workflow over. It answers
   `bound`, `already_bound`, `not_ready`, `no_such_workflow`, `conflict` or
   `invalid`. A stale revision is refused. The same key with the same payload
   returns the original run id and nonce, including after later edits; a new key
   means a deliberate new run. Editing after binding makes a new revision and
   leaves the bound run on the one it started from, so nothing changes
   underneath the work.

4. **`revise_workflow`** takes the workflow id and the whole document as it
   should now read, and answers `revised`, `unchanged`, `incomplete`,
   `no_such_workflow`, `invalid` or `conflict`. It carries no idempotency key:
   a revision is identified by its content, so the store recognises what it
   already holds and answers `unchanged`, which makes a retry after a lost
   reply safe without a promise from the sender. It decides nothing — the
   revision a run is bound to never changes, and a revision the harness wrote
   is not one the user has agreed to. A display request is queued with it,
   because the document the user has open is the working copy, which this
   server never writes: without it they would read the old graph while the
   store held a newer one.

Every result carries both a human-readable text block and `structuredContent`:
hosts differ in whether the model sees structured output, so the text is the
complete answer rather than a summary of it. Where there is something to open,
the result carries an `anthill://workflow/<id>` link — the one line in an answer
a person can act on. A refusal carries none, because there would be nothing of
theirs behind it.

A refusal is never thrown. The SDK turns anything a handler throws into
`isError: true` with a sentence, which a model cannot tell apart from the server
having fallen over, so every no is an ordinary result with an explicit outcome
and `isError` is left for genuine faults. The input schemas name the keys a call
may carry and judge none of them for the same reason: what a call is refused
without is said in the tool descriptions and answered by the handler, which can
name every value that has to change.

## What an answer does not mean

`displayRequested` and `registrationRequested` mean a request was written into
the local inbox. They are not acknowledgements, and this server has no way to
obtain one: `displayed` and `registered` are always false in its answers. The
desktop opens the workflow, or registers the run, on its own schedule, and its
record of having done so is the drop moved into `inbox/done/`.

A binding is a binding. The desktop says **Bound to revision N** for one, and
**Running** only once the run's own reports say so; nothing should call a run
live on the strength of a binding existing.

## Progress reporting

Anthill is not driving the session and has no other way to learn which step the
work is on. A successful `bind_run` returns the exact commands for it, built by
`cliInstruction` in `@anthill/live` — the same text the desktop's own prompt
hands out — carrying the run id, the nonce and the step ids of the bound
revision:

```text
anthill run <run-id> <nonce>
anthill step <run-id> <nonce> <step-id>
anthill done <run-id> <nonce>
```

They are run by the harness as it works. The `anthill` CLI appends a line per
call to `~/.anthill/cli/harness-reports.jsonl`, which the desktop reads. This
server reports no progress of its own and infers none from a binding. If a
command cannot be run, the work carries on without it.

## Records on disk

Handovers are stored by `@anthill/exchange-store`, which never rewrites a file:
identity is created once, revisions are immutable and numbered, an approval and
a withdrawal are records of their own, and a binding belongs to one run.
Cooperating writers take a `proper-lockfile` lease before mutating a workflow
and then publish records exclusively, so binding precondition checks are
serialised against the app's edits and approvals. An abandoned lease becomes
recoverable after 60 seconds without a heartbeat; a contended call retries for
roughly four seconds before reporting a filesystem error. Never delete a live
writer's lease by hand. This is cooperation between a user's own processes, not
isolation from a process that rewrites the directory underneath it.

Records are checked against their path and their digest, and a damaged head
revision or approval fails closed rather than falling back to an older one.
Older readable revisions stay individually retrievable for deliberate recovery.
A submission has to be at the workflow format the create tool's description
advertises: a legacy, missing or future format is refused rather than migrated.
Records already on disk from the format before this one are read and upgraded in
memory, never rewritten, because the bytes are what the digest beside them
describes. Nothing here is auto-migrated or deleted.

A submission is accepted up to 1 MB of JSON, 1,000 blocks, 5,000 connections, 64
levels of nesting and 100,000 visited JSON values. Duplicate block, edge or
agent identities fail validation, as does a workflow that names no goal, says
nothing about what done looks like, or targets a tool other than the one
submitting it. New directories and files are created `0700`/`0600` where the
platform supports it; existing permissions are left alone.

## Tests

`npm run test --workspace=@anthill/mcp`, after the dependencies are built. The
handler tests call the four handlers directly against a temporary data
directory; the wiring test spawns the built server and speaks JSON-RPC to it
over real stdio, which is the only place the tool registrations, the schemas
the tools advertise and the process's exit behaviour are covered. Store tests use disposable directories, never user data.
