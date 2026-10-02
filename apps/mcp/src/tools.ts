/**
 * The four tools, as the harness sees them.
 *
 * `registerTool` rather than `server.tool`, which is deprecated in every one of
 * its overloads in SDK 1.30.0. Names carry no prefix, because the host adds a
 * generous one of its own: Claude Code 2.1.261 presents a plugin's tools as
 * `mcp__plugin_anthill_exchange__create_workflow_draft`, built from the plugin's
 * name and the key its `.mcp.json` gives this server. (An earlier comment here
 * guessed `mcp__anthill__`, which is what a server configured directly rather
 * than through a plugin gets; the guess was corrected by calling one.) An
 * `anthill_` of our own would only repeat what the host already said.
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
import { DRAFT_CLARIFICATION } from "./instructions.js";

const WORKFLOW_ID = z
  .unknown()
  .optional()
  .describe(
    "The workflow's own id: the `id` field of the document that was handed over. Every call needs one, because it is the only thing that says which handover is being asked about.",
  );

/**
 * Which Anthill a chat's first handover asks for (ANT-223).
 *
 * The skill passes it when the user wrote `--dev`; the server never reads the
 * chat. Described here too, so an agent working from an older skill can still
 * say what the user asked for.
 */
const BUILD = z
  .unknown()
  .optional()
  .describe(
    '"dev" when the user asked for the development build with --dev (macOS; ignored elsewhere), left out for the installed Anthill: the first handover of a chat decides, and a later call asking for another build is refused.',
  );

export function registerExchangeTools(server: McpServer, handlers: Handlers): void {
  server.registerTool(
    "create_workflow_draft",
    {
      title: "Hand a workflow to Anthill",
      description: `Store a workflow in Anthill and ask it to open the workflow for the user.

${DRAFT_CLARIFICATION}

Returns an outcome of:
  created         stored, and nothing is missing from it.
  already_exists  this same handover was stored before, under this idempotency key.
  incomplete      not stored; questions have to be answered before any work may
                  start. The text of the result is the list of questions; put them
                  to the user in their own words.
  invalid         nothing was stored, and the problems say why.

The result also carries the workflow id and, where something was stored, the
revision the content is now at and a link the user can open (anthill://, or
the web shell's http:// link). A
refusal carries no link, because there would be nothing of yours behind it.

Pass open: false to store the workflow without opening Anthill yet – when there
is something to ask the user first – and call open_workflow afterwards.

Every handover carries idempotencyKey, mode, source – harness, sessionId and
taskText – and workflow. A call that leaves one of them out is answered with
which one, and nothing is stored.`,
      inputSchema: {
        open: z
          .unknown()
          .optional()
          .describe(
            "false to store the workflow without opening Anthill, so you can ask the user something first; then call open_workflow. Leave it out to open Anthill at once.",
          ),
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
            'Which of the two things the user asked for. "design" means they want a workflow of their own: Anthill opens it in the editor, and they read, change and save it. "watch" means they want to see the work happen: you composed the graph yourself and are already doing the work, so Anthill opens the Live Session and there is no editing step. It chooses which screen the handover lands on and holds no work back – nothing here can stop a harness working, and what decides whether work starts is the user telling you to. The older names "show-and-go" and "approval-gate" are still accepted and both read as "design".',
          ),
        source: z
          .object({
            harness: z
              .unknown()
              .optional()
              .describe('Which tool you are: "claude-code", "codex", "pi" or "vscode".'),
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
        build: BUILD,
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
    "revise_workflow",
    {
      title: "Change a workflow Anthill already has",
      description: `Store a later version of a workflow that was handed over, and ask Anthill to show it.

For when the user asks you to change the plan rather than changing it themselves
in Anthill. What you send is the whole workflow as it should now read, not a
description of the change.

Returns an outcome of:
  revised           stored as a new revision, and Anthill was asked to show it.
  unchanged         Anthill already held exactly this content. Nothing was added,
                    and nothing needed to be – a retry, or a change the user had
                    already made.
  incomplete        nothing was stored; the questions have to be answered first.
  no_such_workflow  nothing of that id has been handed over to this Anthill.
  invalid           nothing was stored, and the call itself is what has to change.
  conflict          nothing was stored, and the reason says what is in the way.

A revision is not a decision, and this tool makes none. The revision a run is
bound to never changes, so a workflow being worked on right now carries on
exactly as it was – your revision does not reach it. And nothing here approves
anything: tell the user what you changed and let them say whether to work from
it. Writing a revision and then binding it is approving your own work.`,
      inputSchema: {
        workflowId: WORKFLOW_ID,
        workflow: z
          .unknown()
          .optional()
          .describe(
            `The whole workflow document as it should now read, in the same shape create_workflow_draft takes, at metadata.workflow.formatVersion: ${WORKFLOW_FORMAT_VERSION}. Its \`id\` must be the workflow you are revising: this replaces a workflow's content, and never its identity.`,
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Nothing is overwritten: a revision is a new record beside the ones
        // already there, and content that is already held is recognised.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => handlers.reviseWorkflow(args),
  );

  server.registerTool(
    "open_workflow",
    {
      title: "Open a stored workflow in Anthill",
      description: `Open a workflow in Anthill that create_workflow_draft stored with open: false.

Launches Anthill if it is closed, brings it to the front if it is open, and asks
it to show the workflow's head revision. Asking twice for the same revision does
not open it twice. It takes the workflowId, and build when it is a chat's first handover.

Returns open_requested, with the app's own outcome in "app" – opened, or a
message to pass on – or not_found for an id this machine has never stored.`,
      inputSchema: { workflowId: WORKFLOW_ID, build: BUILD },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => handlers.openWorkflow(args),
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Look up a handed-over workflow",
      description: `Where a handover stands: who handed it over and what they asked for, the head
revision, which runs are bound to it, and the handover mode it was stored
under.

A status read. It changes nothing and it never waits. It takes the workflowId –
and build: "dev" when picking a --dev handover back up, which reads the
development build's exchange without deciding the chat's build – and a call that
does not name a workflow answers "invalid" without looking anything up.`,
      inputSchema: { workflowId: WORKFLOW_ID, build: BUILD },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handlers.getWorkflow(args),
  );

  server.registerTool(
    "get_ready_revision",
    {
      title: "Find the revision to work from",
      description: `The revision that may be worked on, under the mode this handover was stored with,
together with its content – which may not be what you submitted, because the user
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

This call answers immediately and never waits for anybody, and there is no
approval for it to wait on: Anthill records work rather than authorising it.
"not_ready" means the graph cannot be compiled into a prompt yet, and the
questions to put to the user come with it.

What should keep you from binding is not this call. It is that you asked the
user whether to start and they have not answered.`,
      inputSchema: { workflowId: WORKFLOW_ID, build: BUILD },
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
step you are on – it is not driving your session and has no other way to know.

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
        build: BUILD,
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
