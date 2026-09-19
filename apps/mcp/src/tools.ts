/**
 * The four tools, as the harness sees them.
 *
 * `registerTool` rather than `server.tool`, which is deprecated in every one of
 * its overloads in SDK 1.30.0. Names carry no prefix: Claude Code already
 * presents a plugin's tools as `mcp__anthill__create_workflow_draft`, so an
 * `anthill_` of our own would say it twice.
 *
 * No `outputSchema` on any of them, and that is a decision rather than an
 * omission. Declaring one obliges every non-error result to carry
 * `structuredContent` or the SDK throws on the way out and the call fails for a
 * reason that has nothing to do with what it was doing. These four all populate
 * it today, but the obligation would bite the first time one of them did not,
 * and it would bite in production rather than in a test. The shapes can be
 * declared once they have stopped moving.
 *
 * The input schemas name the keys a call may carry and judge none of them, for a
 * reason spelled out in `handlers.ts`: the SDK validates them inside the try
 * block that turns everything into `isError: true`, so a value this schema
 * rejects reaches the model as an apparent crash rather than as a question it
 * can put to the user. `readSubmission` and the handlers are written to answer
 * for every one of these fields, in the vocabulary the design asks for, and a
 * type declared here would refuse them first and leave that answer unreachable.
 *
 * Nothing is marked required either, and that is the half most likely to be
 * corrected back. A field that is absent is no more distinguishable from a
 * crash than a field that is malformed — the SDK answers both with `isError`
 * and a zod sentence — and absence is the commoner mistake of the two, so it is
 * the one that least deserves the worse answer. A requirement stated in a
 * `describe` reaches the model and costs nothing; the same requirement marked
 * on the schema hands the answer to the SDK, which has no outcome to return and
 * no question to ask. What a call is actually refused without is said in the
 * descriptions below and answered by the handler, which knows how to say
 * "this call does not carry `revision`" and which of a call's values to change.
 *
 * The one line the SDK still draws is that a `source` that arrives at all is an
 * object, because the shape is where its three fields are described and a
 * schema is the only place a sender reads them.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WORKFLOW_FORMAT_VERSION } from "@anthill/workflow-exchange";

import type { Handlers } from "./handlers.js";

const WORKFLOW_ID = z
  .unknown()
  .optional()
  .describe(
    "The workflow's own id: the `id` field of the document that was handed over. Every call needs one, because it is the only thing that says which handover is being asked about.",
  );

export function registerExchangeTools(server: McpServer, handlers: Handlers): void {
  server.registerTool(
    "create_workflow_draft",
    {
      title: "Hand a workflow to Anthill",
      description: `Store a workflow in Anthill and ask it to open the workflow for the user.

Returns an outcome of:
  created         stored, and nothing is missing from it.
  already_exists  this same handover was stored before, under this idempotency key.
  incomplete      not stored; questions have to be answered before any work may
                  start. The text of the result is the list of questions; put them
                  to the user in their own words.
  invalid         nothing was stored, and the problems say why.

The result also carries the workflow id and, where something was stored, the
revision the content is now at and an anthill:// link the user can open. A
refusal carries no link, because there would be nothing of yours behind it.

Every handover carries idempotencyKey, mode, source — harness, sessionId and
taskText — and workflow. A call that leaves one of them out is answered with
which one, and nothing is stored.`,
      inputSchema: {
        idempotencyKey: z
          .unknown()
          .optional()
          .describe(
            "Your own key for this handover, repeated verbatim if you retry it. It is not an address: a submission lands on the id its workflow document carries, and this key is your promise that a second submission under that id is the same call rather than different work. The same key under a different document id creates a second workflow rather than revising the first.",
          ),
        mode: z
          .unknown()
          .optional()
          .describe(
            'How much say the user gets before work starts. "approval-gate": nothing may start until they mark a revision ready. "show-and-go": work may start as soon as the workflow is complete, and they can still edit it.',
          ),
        source: z
          .object({
            harness: z
              .unknown()
              .optional()
              .describe('Which tool you are: "claude-code", "codex" or "pi".'),
            sessionId: z
              .unknown()
              .optional()
              .describe(
                "Your own identifier for this conversation: letters, digits, hyphens and underscores. Anthill does not read it, but it writes it down and matches it against your own session files, so a run started from this handover can be picked up again after it goes quiet.",
              ),
            taskText: z
              .unknown()
              .optional()
              .describe(
                "What the user asked for, in the user's own words rather than your summary of it. Anthill shows this back to them so they can check it understood the same job they did, and it is written down once at the handover: nothing said later replaces it, and it is not in the document they can edit. Quote them.",
              ),
          })
          .optional()
          .describe(
            "Who is handing this over, and what they were asked to do: all three of harness, sessionId and taskText.",
          ),
        workflowId: z
          .unknown()
          .optional()
          .describe(
            "The workflow you believe you are addressing. Leave it out on a first submission. When given it must equal the document's own id, so a submission whose address and document disagree is refused rather than filed under one of the two.",
          ),
        workflow: z
          .unknown()
          .optional()
          .describe(
            `The complete workflow document as JSON: id, name, version, target, brief, nodes, edges and metadata.workflow.formatVersion: ${WORKFLOW_FORMAT_VERSION}. It must name a goal, say what done looks like, and target the submitting tool. Legacy or future workflow formats are refused, not migrated.`,
          ),
        exchangeVersion: z
          .unknown()
          .optional()
          .describe(
            "The exchange version you speak. Leave it out unless you know you speak a later one than this server, which is refused by number rather than half-understood.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Nothing in this store is ever overwritten: every write is an
        // exclusive create, and a repeat is recognised rather than applied.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => handlers.createWorkflowDraft(args),
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Look up a handed-over workflow",
      description: `Where a handover stands: who handed it over and what they asked for, the head
revision, which revision the user has approved, which runs are bound to it, and
the handover mode it was stored under.

A status read. It changes nothing and it never waits. It takes the workflowId
and nothing else, and a call that does not name one answers "invalid" without
looking anything up.`,
      inputSchema: { workflowId: WORKFLOW_ID },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handlers.getWorkflow(args),
  );

  server.registerTool(
    "get_ready_revision",
    {
      title: "Find the revision to work from",
      description: `The revision that may be worked on, under the mode this handover was stored with,
together with its content — which may not be what you submitted, because the user
can edit it.

Returns an outcome of:
  ready             the revision and the workflow to work from.
  not_ready         the reason, and where there are any, the questions still to
                    put to the user. The workflow exists; something about it has
                    yet to happen.
  no_such_workflow  nothing of that id has been handed over to this Anthill.
                    Check the id; waiting will not change it.
  invalid           nothing was looked up: the call named no workflow to look
                    up, and the problems say what to send instead.

This call answers immediately and never waits for anybody. Under approval-gate it
stays "not_ready" until the user approves a revision, which takes as long as
reading takes: say what Anthill is waiting for, finish your turn, and ask again
when they say they are done. Do not poll this in a loop.`,
      inputSchema: { workflowId: WORKFLOW_ID },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handlers.getReadyRevision(args),
  );

  server.registerTool(
    "bind_run",
    {
      title: "Bind an external session to a revision",
      description: `Create a run against the revision that may be worked on, and tell Anthill about it.

Returns an outcome of:
  bound             the run was created against the revision named in the result.
  already_bound     this run id was already bound to that same revision.
  not_ready         nothing was bound: the revision cannot be worked on yet, and
                    the reason says why.
  no_such_workflow  nothing of that id has been handed over to this Anthill.
  conflict          nothing was bound, and something else already holds what this
                    call asked for.
  invalid           nothing was bound, and the call itself is what has to change.

On success the result also carries a run id, a nonce, and the exact shell commands
to run as you work. Those commands are the only thing that tells Anthill which
step you are on — it is not driving your session and has no other way to know.

Retry with the same idempotencyKey, revision, digest and session after a lost reply.
Use a new key only for an intentional new run. Binding does not start the agent
or confirm that the desktop has registered observation.

Every bind carries workflowId, revision, digest and idempotencyKey. A call that
leaves one of them out, or sends one Anthill cannot use, is answered with which
one, and nothing is bound.`,
      inputSchema: {
        workflowId: WORKFLOW_ID,
        revision: z
          .unknown()
          .optional()
          .describe(
            "The exact revision returned by get_ready_revision, which every bind needs. A stale revision is refused.",
          ),
        digest: z
          .unknown()
          .optional()
          .describe(
            "The digest returned with that exact revision, which every bind needs alongside the number: together they say this run is against the content that was read.",
          ),
        idempotencyKey: z
          .unknown()
          .optional()
          .describe(
            "A stable key for this binding request, of at most 256 characters; keep it unchanged on retries. Every bind needs one.",
          ),
        sessionId: z
          .unknown()
          .optional()
          .describe(
            "The harness session that will do the work, when it is not the one that handed the workflow over. Letters, digits, hyphens and underscores, as in the handover. Defaults to the submitting session.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // The same key and payload return the original committed binding.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => handlers.bindRun(args),
  );
}
