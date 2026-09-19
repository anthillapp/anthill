/**
 * `@anthill/exchange-store` — where a handed-over workflow lives on this
 * machine.
 *
 * `@anthill/workflow-exchange` says what a handover *is*; this package is where
 * one is kept. Identity is created once, revisions are immutable and numbered,
 * readiness belongs to one revision, a binding belongs to one run, and the
 * inbox is how the server asks the app to do something. Between them they are
 * the whole of the durable state ANT-86 adds.
 *
 * Only two programs import it: the desktop's main process and the MCP server.
 * The renderer must not — it holds `node:fs`, and a filesystem import in the
 * renderer's bundle is the reason the contract is a separate, pure package.
 *
 * The invariant everything here is built on: no file this store owns is ever
 * mutated. Three processes write into the tree and no lock covers them all, so
 * every write is an exclusive create, `EEXIST` is the conflict, and the
 * conflict is detected by reading back what the winner wrote rather than
 * assumed from having lost. State is a fold over a directory listing; there is
 * no index file, because an index file is the one thing two writers would have
 * to fight over.
 *
 * - `./store`     the `ExchangeStore` class and the shapes of its answers
 * - `./records`   what is written down, and how it is read back one record at a time
 * - `./paths`     the layout, and how an id from elsewhere becomes a directory name
 * - `./disk`      every filesystem call the store makes, so the invariant is checkable
 * - `./problems`  the store's own vocabulary for refusing
 * - `./data-dir`  where the desktop keeps its data, worked out without Electron
 */

export const PACKAGE_NAME = "@anthill/exchange-store";

export {
  ExchangeStore,
  type AddRevisionResult,
  type BindResult,
  type BindRun,
  type ConsumeInboxResult,
  type CreateResult,
  type DamagedDrop,
  type DropInboxResult,
  type Eligibility,
  type EligibilityRefusal,
  type ExchangeWorkflow,
  type InboxDropInput,
  type InboxListing,
  type MarkReadyResult,
  type RevokeReadyResult,
} from "./store.js";

export {
  EXCHANGE_STORE_VERSION,
  encodeRecord,
  parseBinding,
  parseIdentity,
  parseInboxDrop,
  parseReadiness,
  parseRevision,
  parseRevocation,
  type Binding,
  type InboxDrop,
  type InboxKind,
  type RecordRead,
  type RevisionAuthor,
  type StoredIdentity,
  type StoredReadiness,
  type StoredRevision,
  type StoredRevocation,
} from "./records.js";

export {
  EXCHANGE_DIR_NAME,
  bindingPath,
  bindingsDir,
  exchangeRoot,
  identityPath,
  inboxDonePath,
  inboxDir,
  inboxDoneDir,
  inboxPath,
  keyFromInboxFileName,
  readyPath,
  revisionFromFileName,
  revisionFromReadyFileName,
  revisionFromRevokedFileName,
  revisionPath,
  revisionStem,
  revisionsDir,
  revokedPath,
  safeSegment,
  workflowDir,
  workflowSegment,
  workflowsDir,
  workingCopyPath,
} from "./paths.js";

export {
  EXCHANGE_STORE_PROBLEM_CODES,
  storeProblem,
  type ExchangeStoreProblemCode,
} from "./problems.js";

export { appDataDir, defaultDataDir, type DataDirEnvironment } from "./data-dir.js";
