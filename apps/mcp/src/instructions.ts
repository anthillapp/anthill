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
 *
 * Both texts are short on purpose (ANT-314). Claude Code cuts server
 * instructions and each tool description it sends up front: at 2,048
 * characters up to 2.1.295 and at 4,096 since 2.1.296. What is past the cut
 * never reaches the model, and the cut is silent, so `server.test.ts` holds
 * both to the older limit, drift notice included.
 */

/** The limit Claude Code put on instructions and tool descriptions before 2.1.296. */
export const HARNESS_TEXT_LIMIT = 2048;

/**
 * The questions a "design" handover asks first, in full.
 *
 * It is a tool description's text, on create_workflow_draft, because a host
 * may discover tools without keeping what initialize said. The instructions
 * carry `DRAFT_GATE` instead, which says the same in a sentence.
 *
 * Not named for a harness: Codex reads these instructions too, and the reason
 * to ask before drafting has nothing to do with which tool is asking.
 */
export const DRAFT_CLARIFICATION = `mode "design": before create_workflow_draft, ask the user to confirm the project directory and scope, constraints and what must be kept, success criteria, and decisions already made or left to you. If the request already answers these, summarize them and ask for confirmation instead. Wait for their actual answers (when asking in chat, end your turn without submitting) and follow up on whatever a partial reply leaves open. Never invent answers, and never take an empty directory, repository findings or passing validation as the user's agreement. Put their request and answers in source.taskText and the workflow brief. Status reads, retries and resuming an agreed scope need no new questions; asking whether to start is a separate question.

mode "watch": the user wants to watch you work, so ask nothing. Decide the scope from their words and the repository, say in one line what you took the job to be, and submit. A job larger than the one described, such as a new project or another directory, is still a question for them.`;

/** `DRAFT_CLARIFICATION` in a sentence, for the instructions. */
export const DRAFT_GATE = `Under mode "design", ask the user the questions in create_workflow_draft's description before calling it, and wait for their answers. Under "watch", ask nothing: say in one line what you took the job to be and submit.`;

export const SERVER_INSTRUCTIONS = `Anthill stores workflows locally and queues requests for its desktop app to show or observe them. A queued request is not an acknowledgement. Anthill starts and drives nothing: you do the work and it observes.

Once per handover:
0. ${DRAFT_GATE}
1. create_workflow_draft: submit. An incomplete handover is refused with questions; put them to the user, fix the document and resubmit. Never answer them yourself.
2. get_ready_revision: the revision to work from, which is the user's latest and may not be yours. There is no approval to wait for.
3. bind_run: pass that exact revision and digest, and a stable idempotencyKey (the same key on a retry; a new key is a new run). Report progress with the commands it returns.

get_workflow says where a handover stands. revise_workflow stores a new version when the user asks you to change the plan; tell them what changed and ask. A bound run keeps its revision when the user edits later.

run_workflow is the user's command to run a saved workflow.json again, and the go-ahead: no questions, no draft; carry out the prompt it returns.

No tool runs a command or reaches the network; run_workflow's workflow.json is the only file read.`;
