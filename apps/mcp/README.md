# Local Workflow Exchange MCP

This private workspace package exposes a local stdio MCP endpoint. It does not
launch coding agents, execute workflows, manage permissions, or make network
requests. The user starts their external harness independently.

## Development

From the repository root, build with `npm run build:deps` and
`npm run build --workspace=@anthill/mcp`. Use Node 22 for the test suite.

Configure the harness to run Node with these arguments (replace the absolute paths):

```text
/absolute/path/to/anthill/apps/mcp/dist/server.js
--data-dir
/absolute/path/to/anthill-user-data
```

Use the same data directory as the intended desktop profile. Relative, blank, or
repeated `--data-dir` arguments are rejected. With no flag, the installed desktop
profile's default directory is used. Developing against an isolated directory is
recommended; no public repository or hosted server is required.

## Handover Contract

1. `create_workflow_draft`: submit a complete, current-format workflow, source
   harness/session/task, mode, and stable `idempotencyKey`. Incomplete submissions
   are not persisted and do not reserve their workflow ID. Ask the clarification
   questions and retry the corrected draft. Successful retries must preserve the
   full original payload, including mode and source.
2. `get_ready_revision`: retrieve the full authoritative workflow, revision and
   digest. Both structured output and the text result contain the workflow.
   Approval-gate requires explicit approval of that snapshot. Do not busy-poll.
3. `bind_run`: provide `workflowId`, the exact retrieved `revision` and `digest`,
   and a stable binding `idempotencyKey`. An optional `sessionId` overrides the
   submitting session. Identical retries return the original run ID and nonce,
   including after later edits. Different content/session under the same key
   conflicts. Use a new key only for an intentional new run.

The bind preconditions are now required; older clients that omitted them must
update their tool calls. The create key and bind key have separate purposes.

The supported workflow version is advertised in the create tool's description.
Legacy, missing and future format versions are refused rather than silently
migrated. Immutable snapshots must not be upgraded in place. Creation accepts at
most 1 MB of submission JSON, 1,000 blocks, 5,000 connections, 64 levels of nesting
and 100,000 visited JSON values. Duplicate block, edge and agent identities fail
canonical validation.

## Delivery Is Not Observation

`displayRequested` and `registrationRequested` mean a request was recorded in the
local inbox. They do not prove a window opened or an observation was registered.
`displayed` and `registered` remain false without desktop acknowledgement. A
binding is labeled **Bound to run**, never **Running** based only on its existence.

This branch supplies the store and MCP foundation, not the desktop exchange
consumer. Working-copy creation, deep-link handling, approval controls, save-to-
revision capture, acknowledgements and pinned-snapshot Live registration still
need implementation and real harness/desktop E2E verification. No host should
interpret a queued request as proof those features are working.

## Persistence and Recovery

Cooperating writers serialize workflow mutations through a `proper-lockfile`
lease, then publish immutable records exclusively. Binding precondition checks
and publication are serialized against edits and approvals. Read-only queries
are advisory; callers must still supply bind preconditions.

An abandoned lease becomes recoverable after 60 seconds without a heartbeat.
Contended calls retry for roughly four seconds before reporting a filesystem
error; after a crashed writer, retry once the lease is stale. Never delete a
live writer's lease manually. This is cooperative same-user coordination, not
isolation from an agent/process allowed to rewrite the same directory.

Supported records are checked against their path and revision digest. Corrupt or
unsupported head/approval records fail closed, leaving files in place for
explicit recovery. Older readable revisions can be retrieved individually; they
are not silently substituted for a damaged head. New identity records include a
full request fingerprint so an interrupted creation can only finish its original
payload. Legacy identity-only reservations without that fingerprint require
manual recovery. Existing version-1 records without the new optional integrity
fields remain readable only if the original fields, current workflow format and
digest validate. No files are auto-migrated or deleted.

New directories/files use modes `0700`/`0600` where supported. Existing permissions
are not rewritten. File contents are synced before exclusive publication;
power-loss guarantees, directory syncing, symlink policy and retention of crash
temporary files require further work. Checksums detect accidental inconsistency,
not malicious same-user rewriting.

Run `npm run test --workspace=@anthill/mcp` after building dependencies for handler
and real stdio tests. Store tests use disposable directories, not user data.
