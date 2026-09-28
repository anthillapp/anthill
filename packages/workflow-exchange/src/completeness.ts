/**
 * Is this workflow one a person could be asked to approve?
 *
 * Not the same question the canvas asks. The canvas asks whether a diagram can
 * be compiled into a prompt, and answers helpfully — it distinguishes errors
 * from advisories so that an author mid-thought is not nagged about a step they
 * have not filled in yet. A handover is a different moment: the author has
 * stopped, a coding agent is about to be let loose on the result, and the user
 * is about to be shown something and asked whether it is what they meant. At
 * that moment an advisory is not a nicety. A step that never says what it
 * produces is a step nobody can check, and "the agent will work it out" is
 * exactly the promise a handover must not make.
 *
 * So every error and every advisory the workflow validator reports is a reason
 * to refuse, and this module adds the few rules that exist only because this is
 * a handover rather than an edit.
 *
 * Which validator matters, because four functions in this repository are called
 * `validateWorkflow`. This is the workflow-mode one from `@anthill/workflow`,
 * the same one the canvas and `compile()` use. The one in `@anthill/workflow-schema`
 * reads `config.role`, `config.runtime` and `config.instructions`, which
 * workflow-mode steps do not carry, and would report three errors per step on
 * every real workflow.
 *
 * Every problem this module returns carries an `ask`: the question to put to
 * the user, in their language rather than the validator's. That is the whole
 * mechanism by which a harness knows what to say out loud before it may hand
 * anything over, and a code that reaches here without a question of its own is
 * a code nobody can act on.
 */

import {
  WORKFLOWNER_ADVISORY_CODES,
  WORKFLOWNER_VALIDATION_CODES,
  harnessProfile,
  validateWorkflow,
} from "@anthill/workflow";
import type { ValidationError, Workflow } from "@anthill/workflow-schema";

import {
  EXCHANGE_PROBLEM_CODES,
  type ExchangeProblem,
  type ExchangeSource,
} from "./contracts.js";

/**
 * The question that resolves each problem, phrased for a person.
 *
 * These are read aloud to users by a coding agent, so they are questions rather
 * than instructions, they name the thing the user cares about rather than the
 * field it is stored in, and none of them assumes the user has the diagram in
 * front of them.
 *
 * Keyed by string rather than by the code union so a validator that gains a
 * rule degrades to a problem with no question instead of failing to compile —
 * and `checkCompleteness` says so plainly when that happens, because a silent
 * gap here is a question the user never gets asked.
 */
const ASKS: Record<string, string> = {
  [WORKFLOWNER_VALIDATION_CODES.DUPLICATE_BLOCK_ID]: "Which distinct id should each block use?",
  [WORKFLOWNER_VALIDATION_CODES.DUPLICATE_EDGE_ID]: "Which distinct id should each connection use?",
  [WORKFLOWNER_VALIDATION_CODES.DUPLICATE_AGENT_ID]: "Which distinct id should each agent use?",
  // Workflow-level
  [WORKFLOWNER_VALIDATION_CODES.NO_TARGET]:
    "Which coding tool should carry this out – Claude Code, Codex, or pi?",
  [WORKFLOWNER_VALIDATION_CODES.NO_START_BLOCK]: "Where does this work begin?",
  [WORKFLOWNER_VALIDATION_CODES.MULTIPLE_START_BLOCKS]:
    "There is more than one place this could begin. Which one should it actually start at?",
  [WORKFLOWNER_VALIDATION_CODES.NO_END_BLOCK]:
    "How does this finish? What is the last thing that happens?",
  [WORKFLOWNER_VALIDATION_CODES.UNSUPPORTED_BLOCK_TYPE]:
    "This block is of a kind Anthill cannot hand over. Is it a piece of work someone does, or a decision you want to sign off yourself?",
  [WORKFLOWNER_VALIDATION_CODES.UNREACHABLE_BLOCK]:
    "Nothing leads to this step, so it would never happen. Which step should come before it – or should it go?",
  [WORKFLOWNER_VALIDATION_CODES.DEAD_END_BLOCK]:
    "What happens after this step? At the moment the work stops there without finishing.",

  // Steps
  [WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_ACTION]:
    "What kind of work is this step – finding something out, building something, checking something, or handing something over?",
  [WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_TASK]:
    "What exactly should this step do? Say it the way you would to the person doing it.",
  [WORKFLOWNER_VALIDATION_CODES.STEP_MISSING_AGENT]: "Who should carry out this step?",
  [WORKFLOWNER_VALIDATION_CODES.STEP_UNKNOWN_AGENT]:
    "This step is assigned to someone who is not part of this workflow. Who should do it instead?",

  // Agents
  [WORKFLOWNER_VALIDATION_CODES.AGENT_MISSING_NAME]:
    "What should this agent be called? The name is what you will see it work under.",
  [WORKFLOWNER_VALIDATION_CODES.DUPLICATE_AGENT_NAME]:
    "Two agents here have the same name, so you could not tell their work apart. What should the second one be called?",

  // Control blocks
  [WORKFLOWNER_VALIDATION_CODES.APPROVAL_NO_PATH]:
    "What should happen after you approve this – and what should happen if you do not?",
  [WORKFLOWNER_VALIDATION_CODES.APPROVAL_UNLABELLED_PATHS]:
    "Which way out of this approval is which? Say which one means yes and which means no.",

  // Connections, branches and loops
  [WORKFLOWNER_VALIDATION_CODES.DANGLING_CONNECTION]:
    "This connection points at a step that is not here. Where was it meant to go?",
  [WORKFLOWNER_VALIDATION_CODES.INVALID_CONDITION]:
    "This condition cannot be read. What should it say, in the form agent.field == \"value\"?",
  [WORKFLOWNER_VALIDATION_CODES.CONDITION_UNKNOWN_AGENT]:
    "This condition waits on a result from someone who is not in this workflow. Whose result did you mean?",
  [WORKFLOWNER_VALIDATION_CODES.BRANCH_WITHOUT_FALLBACK]:
    "Every way out of this step depends on a condition. Which way should the work go when none of them holds?",
  [WORKFLOWNER_VALIDATION_CODES.OUTPUT_NOT_CONNECTED]:
    "Where should this outcome lead? Nothing follows it at the moment.",
  [WORKFLOWNER_VALIDATION_CODES.UNBOUNDED_LOOP]:
    "This step can repeat. How many times should it try before it gives up and tells you?",
  [WORKFLOWNER_VALIDATION_CODES.LOOP_WITHOUT_DONE_CRITERIA]:
    "This work goes round in a loop. What has to be true for it to stop going round?",

  // Advisories in the editor, refusals here
  [WORKFLOWNER_ADVISORY_CODES.WORKFLOW_NO_GOAL]:
    "What is this work for? One sentence about what it should achieve.",
  [WORKFLOWNER_ADVISORY_CODES.AGENT_NO_MODEL_FOR_TARGET]:
    "Which model should this agent use, or should it simply use whatever the session is on?",
  [WORKFLOWNER_ADVISORY_CODES.AGENT_NO_DESCRIPTION]:
    "How should this agent go about its work across the steps it owns – what it is for, what it looks at, what it hands back, and how it knows it is done?",
  [WORKFLOWNER_ADVISORY_CODES.STEP_NO_EXPECTED_OUTPUT]:
    "What should this step hand back when it is done?",
  [WORKFLOWNER_ADVISORY_CODES.STEP_NO_SUCCESS_CRITERIA]:
    "How would you tell this step went well rather than badly?",

  // The handover's own
  [EXCHANGE_PROBLEM_CODES.HANDOVER_NO_DONE_CRITERIA]:
    "What does \"done\" look like for this work? Name the things that have to be true before it is finished.",
  [EXCHANGE_PROBLEM_CODES.HANDOVER_NO_TASK_TEXT]:
    "What did you ask for, in your own words? Anthill shows it back to you so you can check it understood the same job you did.",
  [EXCHANGE_PROBLEM_CODES.HANDOVER_TARGET_MISMATCH]:
    "This workflow was written for a different coding tool than the one about to run it. Which tool should do the work?",
};

/**
 * The question written for one problem code, if there is one.
 *
 * Exported so the table's coverage can be checked against the validator's own
 * vocabulary: a code that gains a rule and never gains a question is a handover
 * that stalls on something the user is never asked about.
 */
export function askFor(code: string): string | undefined {
  return ASKS[code];
}

/**
 * Everything standing between this workflow and a handover, in the order a
 * person would deal with it.
 *
 * An empty list means it may be shown to the user and handed over. A non-empty
 * one is the list of questions to put to them first.
 *
 * Takes the source as well as the workflow, because two of the rules are about
 * the handover rather than the diagram: whether the submission carries what the
 * user actually asked for, and whether the workflow was written for the tool
 * that is about to run it.
 */
export function checkCompleteness(workflow: Workflow, source: ExchangeSource): ExchangeProblem[] {
  const validation = validateWorkflow(workflow);
  const problems: ExchangeProblem[] = [];

  // The handover's own promises come first. Whether this is the right tool for
  // the right job is worth settling before anybody reads the diagram.
  if (!source.taskText.trim()) {
    problems.push(
      problem(
        EXCHANGE_PROBLEM_CODES.HANDOVER_NO_TASK_TEXT,
        "The handover does not carry what the user asked for, so Anthill has nothing to show back to them.",
        { field: "source.taskText" },
      ),
    );
  }

  // Only a mismatch, never an absence: a workflow with no target at all is
  // already NO_TARGET below, and saying it twice in two vocabularies would put
  // the same question to the user twice.
  if (workflow.target && workflow.target !== source.harness) {
    problems.push(
      problem(
        EXCHANGE_PROBLEM_CODES.HANDOVER_TARGET_MISMATCH,
        `This workflow targets ${harnessProfile(workflow.target).displayName}, but ${harnessProfile(source.harness).displayName} is handing it over. The prompt the user reviews would describe a different tool than the one about to run.`,
        { field: "workflow.target" },
      ),
    );
  }

  // The editor demands done criteria only once a workflow loops, because
  // without them a loop cannot say when to stop. A handover is a promise about
  // when the work is finished, which is the same requirement for a different
  // reason, so it holds here whatever shape the graph is. Where the loop rule
  // has already fired the two are the same sentence, and it is said once.
  const loopAlreadySaidIt = validation.errors.some(
    (error) => error.code === WORKFLOWNER_VALIDATION_CODES.LOOP_WITHOUT_DONE_CRITERIA,
  );
  const doneCriteria = workflow.brief?.doneCriteria?.filter((item) => item.trim().length > 0) ?? [];
  if (doneCriteria.length === 0 && !loopAlreadySaidIt) {
    problems.push(
      problem(
        EXCHANGE_PROBLEM_CODES.HANDOVER_NO_DONE_CRITERIA,
        "The brief does not say what has to be true before this work is finished, so nothing can tell whether the agent got there.",
        { field: "workflow.brief.doneCriteria" },
      ),
    );
  }

  const target = workflow.target ?? source.harness;
  for (const error of validation.errors) problems.push(fromValidation(error, target));
  for (const advisory of validation.warnings ?? []) problems.push(fromValidation(advisory, target));

  return problems;
}

/**
 * A validator finding, in the exchange's vocabulary.
 *
 * The code and the message travel through unchanged — the validator's wording
 * is already the wording the canvas shows, and two descriptions of one problem
 * would eventually disagree. Only the question is added.
 */
function fromValidation(error: ValidationError, target?: string): ExchangeProblem {
  // The one answer most callers want here has a spelling nothing else tells
  // them, and a session that could not find it spent ten commands grepping for
  // it — or invented a model id instead, which validates and pins the agent to
  // something nobody chose (ANT-124). The canvas message is left as it is; the
  // handover's reader is the one who has to write it.
  const message =
    error.code === WORKFLOWNER_ADVISORY_CODES.AGENT_NO_MODEL_FOR_TARGET && target
      ? `${error.message} To use whatever the session is on, give the agent "models": { "${target}": { "id": "__default__" } }; to pin a model, put its exact id there instead.`
      : error.message;
  return problem(error.code, message, {
    ...(error.nodeId ? { nodeId: error.nodeId } : {}),
    ...(error.edgeId ? { edgeId: error.edgeId } : {}),
  });
}

function problem(
  code: string,
  message: string,
  extra: { nodeId?: string; edgeId?: string; field?: string },
): ExchangeProblem {
  const ask = ASKS[code];
  return {
    code,
    message,
    ...extra,
    // A code with no question of its own still has to be answerable, or the
    // handover stalls on a problem the user was never asked about. Turning the
    // message into a question is a poor substitute for writing one, which is
    // why the tests refuse to let any code Anthill already knows get this far.
    ask: ask ?? `${message} What should be done about that?`,
  };
}
