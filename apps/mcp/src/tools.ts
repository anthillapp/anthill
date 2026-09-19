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
 * The input schemas are looser than they look like they should be, for a reason
 * spelled out in `handlers.ts`: the SDK validates them inside the try block that
 * turns everything into `isError: true`, so a field this schema rejects reaches
 * the model as an apparent crash rather than as a question it can put to the
 * user. Presence is asked for here; meaning is judged where a proper answer can
 * be given.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Handlers } from "./handlers.js";

const WORKFLOW_ID = z
  .string()
  .min(1)
  .describe("The workflow's own id: the `id` field of the document that was handed over.");

export function registerExchangeTools(server: McpServer, handlers: Handlers): void {
  server.registerTool(
    "create_workflow_draft",
    {
      title: "Hand a workflow to Anthill",
      description: `Store a workflow in Anthill and ask it to open the workflow for the user.

Returns an outcome of:
  created         stored, and nothing is missing from it.
  already_exists  this same handover was stored before, under this idempotency key.
  incomplete      stored, but questions have to be answered before any work may
                  start. The text of the result is the list of questions; put them
                  to the user in their own words.
  invalid         nothing was stored, and the problems say why.

The result also carries the workflow id, the revision the content is now at, and
an anthill:// link the user can open.`,
      inputSchema: {
        idempotencyKey: z
          .string()
          .describe(
            "Your own key for this handover, repeated verbatim if you retry it. A retry under the same key lands on the workflow it already created rather than on a second one.",
          ),
        mode: z
          .string()
          .describe(
            'How much say the user gets before work starts. "approval-gate": nothing may start until they mark a revision ready. "show-and-go": work may start as soon as the workflow is complete, and they can still edit it.',
          ),
        source: z
          .object({
            harness: z
              .string()
              .optional()
              .describe('Which tool you are: "claude-code", "codex" or "pi".'),
            sessionId: z
              .string()
              .optional()
              .describe(
                "Your own identifier for this conversation. Anthill does not parse it; it is kept so a run started from this handover can be picked up again after it goes quiet.",
              ),
            taskText: z
              .string()
              .optional()
              .describe(
                "What the user asked for, in the user's own words rather than your summary of it. Anthill shows this back to them so they can check it understood the same job they did.",
              ),
          })
          .describe("Who is handing this over, and what they were asked to do."),
        workflowId: z
          .string()
          .optional()
          .describe(
            "The workflow you believe you are addressing. Leave it out on a first submission. When given it must equal the document's own id, so a submission whose address and document disagree is refused rather than filed under one of the two.",
          ),
        workflow: z
          .unknown()
          .describe(
            "The workflow document itself, as JSON: id, name, version, target, brief, nodes and edges. It must name a goal, say what done looks like, and target the same tool that is handing it over.",
          ),
        exchangeVersion: z
          .number()
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

A status read. It changes nothing and it never waits.`,
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

Returns "ready" with the revision and the workflow, or "not_ready" with the reason
and, where there are any, the questions still to put to the user.

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
      title: "Start a run against a revision",
      description: `Create a run against the revision that may be worked on, and tell Anthill about it.

Returns a run id, a nonce, and the exact shell commands to run as you work. Those
commands are the only thing that tells Anthill which step you are on — it is not
driving your session and has no other way to know.

Call this once, at the moment work starts. Each call creates a new run.`,
      inputSchema: {
        workflowId: WORKFLOW_ID,
        revision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "The revision you believe you are binding to. Leave it out to bind whatever is eligible now; give it to be told, rather than to find out later, that the user has edited past it.",
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            "The harness session that will do the work, when it is not the one that handed the workflow over. Defaults to the submitting session.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Each call mints its own run id, so a second call is a second run
        // rather than the same one arriving twice.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => handlers.bindRun(args),
  );
}
