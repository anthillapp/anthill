/**
 * What the harness is told about this server, once, when it connects.
 *
 * `ServerOptions.instructions` is delivered at initialize and applies to the
 * whole server, which makes it the right place for the one thing the tools have
 * in common: three of them are steps of a single sequence, and a tool
 * description that explained the sequence would have to be repeated in each of
 * them and kept in step in each of them.
 *
 * What belongs here is what a caller cannot work out from a tool's signature:
 * that questions go to the user *before* a draft is submitted rather than after,
 * that polling never blocks and must not be looped on, and that the reporting
 * commands are the only channel Anthill has. What belongs in a tool description
 * is what that tool takes and returns.
 */

/** Shared by initialize and tool discovery so neither entry point skips the gate. */
export const CLAUDE_DRAFT_CLARIFICATION = `For every new Claude Code handover, ask the user before create_workflow_draft:
confirm the project/directory and scope, constraints and what must be preserved,
success criteria, and decisions already made or explicitly delegated to you.
This applies to both show-and-go and approval-gate. If the request already gives
the answers, summarize them and ask for confirmation rather than repeating the
questions. Wait for the user's actual answers or confirmation; when asking in
chat, finish your turn without submitting. A partial reply requires follow-up
on what remains unanswered. Do not invent answers, count a future clarification
block as this conversation, or infer permission to create a project from an empty
directory. Read-only environment findings are not user decisions. Schema
validation cannot establish that the user agreed. Preserve the original request
and the user's clarification answers in source.taskText and the workflow brief.
Status reads, unchanged retries and resuming an agreed scope do not require a
new questionnaire. Post-display approval is separate from pre-draft clarification.`;

export const SERVER_INSTRUCTIONS = `These tools store a workflow locally for Anthill and queue desktop display or
observation requests. Queueing is not acknowledgement: this server cannot confirm
that the desktop opened the workflow or that Live Session observation is active.

Anthill starts nothing and drives nothing. You keep doing the work; Anthill can only observe it.

The sequence, once per handover:

0. ${CLAUDE_DRAFT_CLARIFICATION}

1. create_workflow_draft — submit the workflow. An incomplete handover is refused
   without reserving its identity. Ask the returned questions, correct the
   document after the user answers, and resubmit it. Never answer missing
   requirements yourself to make validation pass. A queued display request does not confirm that
   the desktop has opened it.

2. get_ready_revision — ask which revision to work from. It is the latest the
   user has, which may not be what you submitted, because they can edit it.
   There is no approval to wait for: Anthill records the work, it does not
   authorise it, and nothing here can stop you starting. What should stop you
   is that you asked the user and they have not answered yet. A revision is
   refused only when the graph itself cannot be compiled into a prompt, and the
   questions to put to the user come back with the refusal.

3. bind_run — pass the exact revision and digest you retrieved, plus a stable
   idempotencyKey for this request. Retry the same payload/key after a lost
   answer; a new key means an intentional new run. A stale revision is refused.
   The returned commands report progress; Anthill does not start your session.
   A binding and a queued registration are not evidence of live activity.

get_workflow answers where a handover stands, at any point.

revise_workflow stores a later version of a workflow that already exists, for
when the user asks you to change the plan rather than changing it themselves. It
decides nothing: the revision a run is bound to never changes, and a revision you
wrote is not a revision the user has agreed to. Tell them what you changed and
ask.

The user may edit the workflow while you work. That makes a new revision; the run
you bound keeps the one it started from, so nothing changes underneath you.

None of these tools reads your files, runs a command, or reaches the network.`;
