/**
 * `@anthill/workflow-exchange` — the contract a coding harness hands a workflow
 * over on.
 *
 * A harness the user started somewhere else designs a workflow and submits it
 * to Anthill. This package is the shape that submission has, the rules it must
 * satisfy before a person is asked to approve it, and the words both sides use
 * to describe where it stands. It is what stops the MCP server and the app
 * disagreeing about any of those three.
 *
 * Pure, and deliberately so. No filesystem, no process, no clock, and no
 * ambient globals: the renderer imports it to describe state, and a Node
 * builtin reached for here would be pulled into the Vite bundle. Durable state
 * is `@anthill/exchange-store`'s job, and it depends on this package rather
 * than the other way round.
 *
 * - `./contracts`     the wire shapes and the problem vocabulary
 * - `./submission`    reading untrusted JSON into a `DraftSubmission`
 * - `./completeness`  what has to be true before a handover may happen
 * - `./digest`        the content hash that tells one revision from another
 * - `./state`         the prose the app and the server both say
 */

export const PACKAGE_NAME = "@anthill/workflow-exchange";

export {
  EXCHANGE_PROBLEM_CODES,
  EXCHANGE_VERSION,
  HANDOVER_MODES,
  SESSION_ID_MAX_LENGTH,
  isHandoverMode,
  isSessionId,
  isSourceHarness,
  type DraftSubmission,
  type ExchangeProblem,
  type ExchangeProblemCode,
  type ExchangeSource,
  type HandoverMode,
  type RevisionState,
  type SourceHarness,
} from "./contracts.js";

export {
  checkExchangeVersion,
  checkSessionId,
  readSubmission,
  readWorkflowDocument,
  type ReadSubmissionResult,
} from "./submission.js";

export { checkCompleteness } from "./completeness.js";

export { canonicalJson, revisionDigest } from "./digest.js";

export { describeState, type StateDescription } from "./state.js";
export { WORKFLOW_FORMAT_VERSION } from "@anthill/workflow";
