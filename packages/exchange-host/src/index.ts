/**
 * `@anthill/exchange-host` — the app side of the exchange protocol.
 *
 * `@anthill/workflow-exchange` says what a handover is and
 * `@anthill/exchange-store` is where one is kept; this package is what an
 * Anthill that shows handovers does with them: it reads the inbox, puts each
 * handed-over workflow in front of the user, and follows the runs bound to it.
 * Two programs are such an Anthill — the desktop app and the web shell — and
 * both import it, so a handover means the same thing in either.
 *
 * It imports no Electron. Whatever needs a window (asking the user, focusing,
 * pushing to a page) comes in through `InboxEffects` and `WindowOperations`,
 * which each program supplies.
 *
 * - `./inbox`         polls the inbox and consumes display and bind requests
 * - `./documents`     exchange views, saved revisions and bound workflows
 * - `./working-copy`  the file a handed-over revision is opened from
 * - `./deep-link`     `anthill://workflow/<id>` links and delivering them to a page
 */

export {
  ExchangeInbox,
  type BoundRun,
  type InboxEffects,
  type OpenOutcome,
  type OpenPermission,
} from "./inbox.js";
export { boundWorkflow, exchangeDestination, readExchangeView, saveExchangeCopy } from "./documents.js";
export { captureSavedRevision, writeWorkingCopy } from "./working-copy.js";
export {
  SerialDrain,
  WindowOperations,
  WorkflowDelivery,
  linksFromArgv,
  workflowIdFromLink,
  type Delivery,
} from "./deep-link.js";
