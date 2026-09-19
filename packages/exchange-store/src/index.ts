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

/*
 * What the two importers actually import, and nothing else.
 *
 * The store's answers reach them through `ExchangeStore`, so the layout, the
 * record parsers, the problem builder and the path helpers are internal: this
 * package exists to be the only thing that knows where a handover is kept, and
 * an exported `revisionPath` is an invitation to know it elsewhere. Anything
 * needed from here later can be exported then, against a caller — which is not
 * true the other way round, because an export nothing imports still has to be
 * kept working.
 */
export {
  ExchangeStore,
  type AddRevisionResult,
  type Eligibility,
  type EligibilityRefusal,
  type ExchangeWorkflow,
} from "./store.js";

export {
  type Binding,
  type InboxDrop,
  type RevisionAuthor,
  type StoredRevision,
} from "./records.js";

export { EXCHANGE_STORE_PROBLEM_CODES } from "./problems.js";

export { defaultDataDir } from "./data-dir.js";
