/**
 * The IPC contract between the Electron main process and the renderer.
 *
 * This file is the single source of truth for both sides and must not import
 * anything from `electron`, `node:*`, or the renderer — it is pure types plus
 * channel-name constants, so it can be safely pulled into either bundle.
 *
 * Security boundary: the renderer has no Node integration. Everything that
 * touches the filesystem, git, or spawns an agent CLI happens in main and is
 * reachable only through the channels named here.
 */

import type { Workflow, WorkflowRun, NodeRun } from "@anthill/workflow-schema";
import type { AgentModels, InterpreterId } from "@anthill/workflow";
import type { LiveSessionState, MarkerCli, ObservationEvent, PendingRun } from "@anthill/live";
import type { ExchangeSource, ExchangeProblem, HandoverMode, RevisionState } from "@anthill/workflow-exchange";

export type { LiveSessionState, MarkerCli, ObservationEvent, PendingRun };

/* ------------------------------------------------------------------ */
/* Request/response channels (renderer -> main, via ipcRenderer.invoke) */
/* ------------------------------------------------------------------ */

export const IpcChannel = {
  appCapabilities: "app:capabilities",
  appRelaunch: "app:relaunch",
  workspaceSelect: "workspace:select",
  workspaceStatus: "workspace:status",
  workflowOpen: "workflow:open",
  workflowPendingOpen: "workflow:pending-open",
  workflowOpened: "workflow:opened",
  exchangeRead: "exchange:read",
  exchangeReady: "exchange:ready",
  exchangeRevoke: "exchange:revoke",
  liveWorkflow: "live:workflow",
  workflowSave: "workflow:save",
  runtimesDetect: "runtimes:detect",
  runStart: "run:start",
  runList: "run:list",
  runGet: "run:get",
  approvalRespond: "approval:respond",
  workflowExport: "workflow:export",
  workflowSetDirty: "workflow:set-dirty",
  recentsList: "recents:list",
  recentsForget: "recents:forget",
  interpretersDetect: "interpreters:detect",
  codexModels: "codex:models",
  piModels: "pi:models",
  promptDraft: "prompt:draft",
  promptDraftCancel: "prompt:draft-cancel",
  liveObserve: "live:observe",
  liveSnapshot: "live:snapshot",
  liveCancel: "live:cancel",
  liveDismiss: "live:dismiss",
  liveLookAgain: "live:look-again",
  agentsList: "agents:list",
  agentsCreate: "agents:create",
  agentsUpdate: "agents:update",
  agentsDuplicate: "agents:duplicate",
  agentsRemove: "agents:remove",
  assistantThreadRead: "assistant:thread-read",
  assistantThreadWrite: "assistant:thread-write",
  assistantThreadClear: "assistant:thread-clear",
  settingsRead: "settings:read",
  settingsWrite: "settings:write",
  notificationsProbe: "settings:notifications-probe",
  liveEvents: "live:events",
  liveSetupStatus: "live-setup:status",
  liveSetupDismiss: "live-setup:dismiss",
  liveSetupInstall: "live-setup:install",
  liveSetupDisable: "live-setup:disable",
  folderChoose: "folder:choose",
  interpreterSignIn: "interpreters:sign-in",
  pathsCheck: "paths:check",
  pathReveal: "path:reveal",
} as const;

/* ------------------------------------------------------------------ */
/* Process compatibility                                               */
/* ------------------------------------------------------------------ */

/**
 * What this build of the contract offers.
 *
 * Three pieces of Anthill are loaded from three different places and can end up
 * at three different ages. The renderer comes from the dev server or the bundle
 * and is always current. The preload is read from disk every time a window
 * loads, so it changes the moment someone rebuilds. The main process is loaded
 * once when the app starts and then stays as it was — which is how a renderer
 * asking for a channel a running main has never heard of becomes possible.
 *
 * That mismatch used to be invisible: `ipcRenderer.invoke` on an unregistered
 * channel rejects, a rejection nobody awaited is swallowed, and a feature just
 * quietly showed nothing. Bump this whenever a channel is added, and the
 * renderer can find out before it subscribes to something that will never fire.
 *
 * A channel whose shape or meaning changes counts as much as a new one. The
 * hazard is the same — a renderer talking to a main process that answers a
 * different question — and it is harder to see, because both sides still have
 * the channel and nothing rejects.
 */
export const IPC_CONTRACT = 19;

export type IpcCapabilities = {
  /** The main process's own contract number. */
  contract: number;
  /** Every channel the running main process actually registered a handler for. */
  channels: string[];
  /**
   * Which shell is serving the renderer.
   *
   * The renderer is the same bundle in both shells; this is how it finds
   * out whether the harness it is about to instruct can reach the Anthill
   * CLI. The CLI shell says `cli`, and its prompts therefore tell the
   * harness to report through `anthill run` / `anthill step`. The desktop
   * shell says `desktop`, and its prompts keep the printed marker lines.
   * Additive: an old renderer that does not read it is unaffected, and an
   * old main process that does not send it is read as `desktop`.
   */
  shell?: "desktop" | "cli";
};

/**
 * The channels the Live Session page needs before it can promise anything.
 *
 * Named here rather than in the page so that adding a channel and forgetting to
 * require it is a change in one file, not a silent gap in another.
 */
export const LIVE_SESSION_CHANNELS: readonly string[] = [
  IpcChannel.liveSnapshot,
  IpcChannel.liveEvents,
  IpcChannel.liveLookAgain,
];

/** Push channel (main -> renderer). Carries every `RunEvent`. */
export const RUN_EVENT_CHANNEL = "run:event";

/** Push channel (main -> renderer). Coarse progress for one drafting run. */
export const PROMPT_DRAFT_STAGE_CHANNEL = "prompt:draft-stage";

/** Push channel (main -> renderer). The current state of every observed run. */
export const LIVE_SNAPSHOT_CHANNEL = "live:snapshot-changed";

/** Push channel (main -> renderer). One run's observed activity, as it grows. */
export const LIVE_EVENTS_CHANNEL = "live:events-changed";

/**
 * The user asked for Settings, from the menu bar rather than from the page.
 *
 * Live Observation moved into the Prompt flow, where it is offered in the
 * order it is needed. Managing it afterwards — inspect, repair, disable — is a
 * different job with no place in that flow, so it is reached deliberately
 * through ⌘, instead.
 */
export const OPEN_SETTINGS_CHANNEL = "app:open-settings";

/**
 * The File menu asking the focused window to save what it has open.
 *
 * Save lives in the menu rather than in a renderer key handler so that one
 * press is one save: an accelerator is consumed before the page sees the key,
 * which also settles ⌘S never reaching the browser's own Save Page (ANT-59).
 */
export const SAVE_WORKFLOW_CHANNEL = "app:save-workflow";

/**
 * A workflow a harness handed over, ready for the page to show.
 *
 * Nobody in the renderer asked for this one: it arrives because a coding tool
 * put a workflow in the exchange, or because the user followed an `anthill://`
 * link. The payload is the path of the working copy, so the page opens it
 * through the ordinary Open route and nothing about loading a document has to
 * know where it came from.
 *
 * A push alone would not do, because a page that has not mounted yet cannot be
 * sent anything and a link is at its most likely on a cold start. So main holds
 * what it could not deliver and the page collects it with
 * `IpcChannel.workflowPendingOpen` when it is ready; this channel carries
 * everything that arrives afterwards, while the page is up and listening.
 */
export const OPEN_WORKFLOW_CHANNEL = "app:open-workflow";

/* ------------------------------------------------------------------ */
/* Payload shapes                                                      */
/* ------------------------------------------------------------------ */

/** Serializable view of the selected workspace. */
/** A reusable agent profile from the global library. Identity is the issued
 * id — never the name — and nothing about a profile executes anything. */
export type GlobalAgentProfile = {
  id: string;
  name: string;
  /**
   * The model chosen for each coding tool, for the tools somebody has answered
   * for.
   *
   * A library profile has no harness of its own — it is written before there is
   * a workflow to put it in — so it can hold a Claude Code answer, a Codex
   * answer, both, or neither, and the two are never translated into each
   * other's terms. Absent means nobody has answered for that tool, which is a
   * different fact from answering "inherit". See `agent-models.ts` in
   * @anthill/workflow.
   */
  models?: AgentModels;
  /**
   * A stored answer the author has to settle, kept verbatim.
   *
   * Not guessed at and not dropped: it is their own choice, and the only
   * honest thing to do with one whose meaning is ambiguous is show it back
   * and ask.
   */
  modelNeedsReview?: string;
  role?: string;
  description?: string;
  /**
   * Shipped with Anthill rather than written here.
   *
   * Provenance, not a kind: a ready-made profile opens and edits exactly like
   * one somebody wrote, and this changes only which group it is listed under.
   * The alternative — copying it on click — produced two rows with the same
   * name after one click and left the original permanently uncorrectable.
   */
  starter?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GlobalAgentInput = {
  name: string;
  /**
   * The whole per-tool bag, replaced rather than merged.
   *
   * The absence of a tool's key is the message — "nobody has answered for this
   * one" — and a patch that only ever added keys could not send it. An empty
   * bag clears the lot.
   */
  models?: AgentModels;
  role?: string;
  description?: string;
};

export type WorkspaceInfo = {
  rootPath: string;
  activePath: string;
  mode: string;
  git?: {
    repositoryRoot: string;
    branch?: string;
  };
};

export type WorkspaceStatus = {
  /** Raw `git status --porcelain` output; `undefined` outside a git repo. */
  status?: string;
  /** True when the workspace has uncommitted changes. Always false outside git. */
  dirty: boolean;
};

/** One runtime adapter and whether it can actually be used on this machine. */
export type RuntimeInfo = {
  id: string;
  displayName: string;
  available: boolean;
  version?: string;
  reason?: string;
};

export type OpenedWorkflow = {
  path: string;
  workflow: Workflow;
  /** Set when the workflow loaded but predates this build's format. */
  notice?: string;
};

/**
 * Opening can fail for a reason the user needs explained — a workflow from a newer
 * build, or a file that is not a workflow at all. Returned rather than thrown so
 * the renderer can show the real reason instead of a generic schema error.
 *
 * `cancelled` with `candidates` is the CLI's answer to the desktop's file
 * dialog: there is no dialog to show, so the CLI offers the workflow files it
 * knows about (the recents and the files in the configured workspace) and the
 * renderer lets the author pick one. A `cancelled` without `candidates` is a
 * genuine cancellation (the desktop's dialog was dismissed).
 */
export type OpenWorkflowResult =
  | { ok: true; opened: OpenedWorkflow }
  | { ok: false; cancelled: true; candidates?: string[] }
  | { ok: false; error: string };

export type SaveWorkflowRequest = {
  workflow: Workflow;
  /**
   * Where the last successful save went, if it went anywhere.
   *
   * Not a promise to write there: the main process asks for a destination
   * when that answer no longer holds — the file has gone, or the workflow has
   * been renamed since (ANT-57).
   */
  path?: string;
};

export type ExchangeView = {
  workflowId: string;
  source: ExchangeSource;
  mode: HandoverMode;
  /** What is true of the head revision — the one the editor has open. */
  state: RevisionState;
  revision: number;
  digest: string;
  /**
   * The revision an approval still stands on, when one does.
   *
   * Reported separately from `state`, and not only when the two agree. Under
   * an approval gate, approving revision 1 and then editing leaves the head at
   * revision 2 with nothing approving it — which `state` correctly calls a
   * draft — while the approval of revision 1 is untouched and is still what a
   * new run would be given. Saying only "draft" told the user nothing was
   * authorised while something was.
   */
  approved?: {
    revision: number;
    at?: string;
    /**
     * Whether taking it back would change what an agent may be given.
     *
     * Only an approval gate turns an approval into permission, so only there
     * does withdrawing one mean anything: under show-and-go the head revision
     * is eligible however this reads, and a control offered there would
     * promise an effect it does not have. Decided here rather than in the
     * page, because the store is where the rule lives and a page that
     * re-derived it would eventually derive it differently.
     */
    withdrawable: boolean;
    /**
     * The revision an approval would fall back to if this one were withdrawn.
     *
     * Absent when withdrawing this one leaves nothing approved, which is the
     * case the page used to describe as if it were the only one. Approving
     * twice with an edit between them leaves two approvals standing, and the
     * older one becomes what an agent may take the moment the newer is taken
     * back. Carried here rather than worked out in the page, because the store
     * is what will act on it.
     */
    below?: number;
  };
  problems: ExchangeProblem[];
  bindings: { runId: string; revision: number }[];
};
export type ExchangeReadyRequest = { path: string; workflowId: string; revision: number; digest: string };
/**
 * Taking an approval back, named by the revision it stands on.
 *
 * No digest, unlike approving: the revision being withdrawn is usually not the
 * one the editor has open — that is the whole situation this answers — so
 * there is no head content to check the request against. What is checked is
 * that the revision named is the approval the page was showing when the user
 * decided, so a stale panel cannot withdraw one they never saw.
 */
export type ExchangeRevokeRequest = { path: string; workflowId: string; revision: number };
export type ExchangeReadyResult = { ok: true } | { ok: false; error: string };
export type BoundWorkflowResult =
  | { ok: true; workflow: Workflow; revision: number; digest: string }
  | { ok: false; error: string };

/**
 * How a save ended, in the three ways an author can be told apart.
 *
 * A bare path-or-null could not distinguish "you cancelled the dialog" from
 * "the disk refused it", so the editor had nothing true to show for either and
 * showed nothing at all (ANT-58). Failure carries its reason because a message
 * the author can act on is the whole point of reporting one.
 */
export type SaveWorkflowResult =
  | { kind: "saved"; path: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };

export type StartRunRequest = {
  workflow: Workflow;
  /** Working directory agent nodes run in, unless a node overrides it. */
  workspacePath: string;
};

export type StartRunResponse =
  | { ok: true; runId: string }
  | { ok: false; error: string };

export type ApprovalDecision = "approved" | "rejected";

export type ApprovalResponse = {
  runId: string;
  nodeId: string;
  decision: ApprovalDecision;
};

/** A run plus the workflow snapshot it started from. */
export type StoredRunView = WorkflowRun & {
  snapshot: Record<string, unknown>;
};

/* ------------------------------------------------------------------ */
/* Workflow                                                             */
/* ------------------------------------------------------------------ */

/** One generated file, as produced by `@anthill/workflow`. */
export type WorkflowFile = {
  /** Repository-relative path, e.g. `.claude/agents/reviewer.md`. */
  path: string;
  content: string;
};

export type ExportWorkflowRequest = {
  files: WorkflowFile[];
  /** Written alongside the agent files when set, so the prompt is kept too. */
  prompt?: string;
  /**
   * Where to write, when the author has already said. Absent asks them.
   *
   * A repository chosen once and remembered is the whole point: a harness only
   * offers agents that were on disk before its session began, so the files have
   * to be written every time the prompt is copied — and a folder dialog on
   * every copy is a step someone skips exactly once.
   */
  root?: string;
};

export type ExportWorkflowResponse =
  | { ok: true; directory: string; written: string[] }
  | { ok: false; error: string }
  | { ok: false; cancelled: true };

/* ------------------------------------------------------------------ */
/* Events (main -> renderer)                                           */
/* ------------------------------------------------------------------ */

export type RunEvent =
  | { type: "run-created"; run: WorkflowRun }
  | { type: "node-updated"; runId: string; nodeRun: NodeRun }
  | { type: "run-updated"; run: WorkflowRun }
  | {
      type: "run-finished";
      run: WorkflowRun;
      /** Populated when the run ended in `failed`/`cancelled`. */
      failure?: { code: string; message: string; nodeId: string };
    }
  | {
      type: "approval-requested";
      runId: string;
      nodeId: string;
      context: Record<string, unknown>;
    };

/**
 * A workflow this machine has open recently, as the launch window shows it.
 *
 * `meta` is read from the file rather than cached, so a workflow edited elsewhere
 * still describes itself correctly.
 */
export type RecentWorkflow = {
  path: string;
  /** The workflow's own id, so a live observation can be matched to its file. */
  workflowId?: string;
  /**
   * How this workflow's last observed run ended, when one did and Anthill
   * still remembers it.
   *
   * Only ever an ending — finished, failed, or observation lost. Anything
   * being watched right now comes from the live snapshot instead, so the two
   * never argue: this answers only for a workflow with no live run left.
   *
   * It exists because the live store is a working set that drops a settled run
   * a day later, which turned every row grey a day after it was last used
   * (ANT-84).
   */
  lastRun?: { state: LiveSessionState; at: string };
  /**
   * Step id → step name, for the workflows in this list.
   *
   * Carried because the launch window has no workflow loaded and still has to say
   * *which* step a live session is on. The file is parsed here anyway; a
   * handful of names costs nothing next to reading it twice.
   */
  steps?: Record<string, string>;
  /**
   * The global library profiles this workflow holds a copy of.
   *
   * So the agent library can say which workflows would be left holding an
   * orphaned copy before a profile is deleted, without opening every file
   * again at the moment the question is asked.
   */
  libraryAgentIds?: string[];
  /** Home-relative, because `~/workflows/x.json` is readable and the full path is not. */
  displayPath: string;
  name: string;
  /** "5 blocks · 2 agents · Claude Code". */
  meta: string;
  modifiedAt: string;
};

/**
 * A local CLI Anthill can ask to draft a workflow from a prompt.
 *
 * `command` is the exact invocation, shown to the author before anything runs;
 * `boundary` says in plain words what that invocation can and cannot do. Both
 * are carried in the contract rather than written in the renderer so the UI
 * cannot describe a command different from the one main actually runs.
 */
export type InterpreterInfo = {
  id: InterpreterId;
  label: string;
  command: string;
  boundary: string;
  available: boolean;
  /**
   * Whether the CLI says somebody is signed in. Absent when the question could
   * not be answered — which is not the same as a no, and must not be shown as
   * one.
   */
  signedIn?: boolean;
  version?: string;
  /** Why it cannot be used, when it cannot. */
  reason?: string;
};

/** One model Codex offers, as Codex's own catalogue describes it. */
export type CodexModelOption = {
  /** The slug written into an agent file's `model`. */
  id: string;
  label: string;
  hint?: string;
  /** The reasoning levels this model supports, in Codex's own order. */
  efforts: { id: string; hint?: string }[];
  defaultEffort?: string;
};

/**
 * What Codex last listed for this machine.
 *
 * Evidence about the account rather than about a version — but it is a cache
 * with a timestamp, not a live check, so `fetchedAt` travels with it and the
 * screen says when Codex last looked instead of claiming a model is available
 * now.
 */
export type CodexModelCatalog = {
  models: CodexModelOption[];
  fetchedAt?: string;
  /**
   * Whether the `codex` on this PATH reads `.codex/agents/*.toml` at all.
   *
   * Not a version comparison — the binary is asked about itself. `unknown` is
   * a real answer and never means "no": telling somebody to update software
   * that is already fine is the one wrong direction here.
   */
  agentSupport: "supported" | "unsupported" | "unknown";
};

/** One model pi offers, as `pi --list-models` reports it. */
export type PiModelOption = {
  /** The pattern written to `--model`: `provider/model`. */
  id: string;
  label: string;
  /**
   * The thinking levels this model can run at.
   *
   * pi's levels are fixed by `--thinking`, not per-model, so a thinking-
   * capable model offers the whole set and a non-thinking one offers none.
   * `off` is omitted — it is the same as the UI's "inherit".
   */
  efforts: { id: string; hint?: string }[];
};

/**
 * What pi listed for this machine.
 *
 * Read live with `pi --list-models` — pi keeps no model cache file, so there
 * is no `fetchedAt` and no stale-cache caveat. `undefined` (not an empty
 * list) when the CLI could not be reached.
 */
export type PiModelCatalog = {
  models: PiModelOption[];
};

/** The preferences Anthill keeps for this machine. Documented in main/settings.ts. */
export type AppSettings = {
  /** Native notification on a confidently observed move to a new step. Off by default. */
  stepNotifications: boolean;
};

/**
 * What happened when a test notification was sent.
 *
 * "sent" means the app handed it to the system, which is everything it can
 * know — whether it appeared is the thing the author is being asked to look
 * for.
 */
export type NotificationProbe = { kind: "sent" } | { kind: "unsupported"; reason: string };

export type PromptDraftRequest = {
  interpreterId: InterpreterId;
  /** The full drafting instruction, built in the renderer from the author's prompt. */
  instruction: string;
};

/**
 * How far a drafting run has got, as far as main can honestly say.
 *
 * Coarse on purpose. The CLI's own output is not relayed: it is the model's
 * working, and showing it would both leak reasoning and imply that Anthill has
 * recognised parts of a workflow before any valid draft exists.
 */
export type PromptDraftStage = "preparing" | "analyzing" | "replying";

/** The CLI's raw reply. Parsing and validation happen in `@anthill/workflow`. */
export type PromptDraftResponse =
  | { ok: true; reply: string; command: string }
  | { ok: false; error: string; command: string; cancelled?: undefined }
  /** The author cancelled. Not an error, and not shown as one. */
  | { ok: false; cancelled: true; command: string; error?: undefined };

/* ------------------------------------------------------------------ */
/* Live session auto-detection                                         */
/*                                                                     */
/* Anthill does not run anything here. The user copies a prompt, starts */
/* it themselves in their own CLI, and Anthill recognises the session   */
/* afterwards from the records that CLI writes locally. Nothing in this */
/* contract can start, stop, or steer a session, because Anthill has no */
/* such power over one it did not launch.                              */
/* ------------------------------------------------------------------ */

/** What one local CLI does and does not expose for observation. */
export type LiveObserverCapabilities = {
  cli: MarkerCli;
  available: boolean;
  root: string;
  note: string;
  reportsCompletion: boolean;
  reportsFailure: boolean;
};

export type LiveSnapshot = {
  /** Runs worth showing, newest first. */
  runs: PendingRun[];
  capabilities: LiveObserverCapabilities[];
};

/**
 * Start observing for the session a copied prompt will produce.
 *
 * Sent immediately before the prompt reaches the clipboard, so the record
 * exists even if the app is closed between the copy and the paste.
 */
export type LiveObserveRequest = {
  anthillRunId: string;
  correlationNonce: string;
  selectedCli: MarkerCli;
  promptVersion: string;
  /** A hash of the copied prompt. The prompt itself is never sent or stored. */
  bootstrapPromptHash: string;
  workflowId?: string;
  workflowName?: string;
  /**
   * The steps the marker named, as they were called when the prompt was copied.
   *
   * Sent because the workflow lives in the editor and a run outlives the screen
   * that started it: without these a transition can only be reported as a block
   * id, which is not something to put in a notification.
   */
  steps?: { id: string; name: string }[];
};

/* ------------------------------------------------------------------ */
/* Local observation setup                                             */
/*                                                                     */
/* This is setup for passive observation hooks only. The install/disable */
/* calls mutate local CLI hook configuration after explicit user action; */
/* they do not start agents, attach to sessions, or change permissions.  */
/* ------------------------------------------------------------------ */

export type ObservationHarnessSetup = {
  id: MarkerCli;
  label: string;
  cliCommand: string;
  cliAvailable: boolean;
  version?: string;
  reason?: string;
  /**
   * Verified working: the entries are present *and* the handler ran.
   *
   * Only this earns the enabled state. Entries in a config file prove the
   * install wrote them, not that the harness can run what they point at.
   */
  hookInstalled: boolean;
  /** The entries are in the config file, whatever running them does. */
  hookEntriesPresent: boolean;
  /** Why the handler could not run, when entries are present but it cannot. */
  hookProblem?: string;
  /**
   * When an event from this harness last arrived in the hook log.
   *
   * The difference between a hook that runs and a hook the harness runs. A
   * command Anthill can execute, in a config file nothing reads, passes every
   * other check here and delivers nothing.
   */
  hookLastEventAt?: string;
  /** When Anthill wrote these entries, so silence can be given a length. */
  hookInstalledAt?: string;
  configPath: string;
  hookHandlerPath: string;
  installerAction: string;
  installCommand: string;
  hookCommands: string[];
  eventCategories: string[];
  localDataBoundary: string;
  changes: string[];
};

export type ObservationSetupStatus = {
  dismissed: boolean;
  trigger: string;
  harnesses: ObservationHarnessSetup[];
};

export type ObservationSetupActionResult =
  | { ok: true; status: ObservationSetupStatus; message: string; backupPath?: string }
  | { ok: false; status: ObservationSetupStatus; error: string; backupPath?: string };

/* ------------------------------------------------------------------ */
/* The API surface exposed on `window.anthill` by the preload script   */
/* ------------------------------------------------------------------ */

export interface AnthillApi {
  /**
   * The contract version of the preload that answered, as a plain value.
   *
   * Read synchronously and without touching main, so a renderer newer than the
   * preload is detectable even when nothing can be invoked at all.
   */
  readonly contract: number;
  /**
   * What the running main process can actually do.
   *
   * Rejects when main is older than the preload that called it — which is the
   * signal the caller wants, not a failure to hide.
   */
  capabilities(): Promise<IpcCapabilities>;
  /**
   * Quit and start Anthill again, so a stale main process is replaced.
   *
   * Goes through the same unsaved-workflow guard as closing the window: a workflow with
   * unsaved edits asks first, and a refusal leaves the app running. Returns
   * `false` when the restart did not happen, so the caller can say so rather
   * than waiting for something that is not coming.
   */
  relaunch(): Promise<boolean>;
  selectWorkspace(): Promise<WorkspaceInfo | null>;
  workspaceStatus(rootPath: string): Promise<WorkspaceStatus>;
  /** With a path, opens that workflow; without one, asks the author to pick. */
  openWorkflow(path?: string): Promise<OpenWorkflowResult>;
  /**
   * The workflow Anthill was asked to show before this page could show one.
   *
   * Also announces that the page is listening. Current desktop builds retain
   * requests in their source queues and push them with delivery IDs after this
   * handshake; an older host may instead return a pending path once.
   */
  pendingWorkflowOpen(): Promise<string | undefined>;
  workflowOpened(path: string, deliveryId?: number, outcome?: "shown" | "declined" | "confirming" | "opening"): Promise<void>;
  exchangeRead(path: string, workflowId: string): Promise<ExchangeView | undefined>;
  exchangeReady(request: ExchangeReadyRequest): Promise<ExchangeReadyResult>;
  exchangeRevoke(request: ExchangeRevokeRequest): Promise<ExchangeReadyResult>;
  liveWorkflow(runId: string): Promise<BoundWorkflowResult>;
  /**
   * A workflow a harness handed over while the page was up. Returns the
   * unsubscribe.
   *
   * The path of a working copy, to be opened through `openWorkflow`. Whether
   * the user wants this interruption is checked by the renderer immediately
   * before navigation, not against a stale document in main.
   */
  onOpenWorkflow(listener: (path: string, deliveryId?: number) => void): () => void;
  saveWorkflow(request: SaveWorkflowRequest): Promise<SaveWorkflowResult>;
  /** File ▸ Save, or ⌘S. Returns the unsubscribe. */
  onSaveWorkflow(listener: () => void): () => void;
  detectRuntimes(): Promise<RuntimeInfo[]>;
  startRun(request: StartRunRequest): Promise<StartRunResponse>;
  listRuns(): Promise<WorkflowRun[]>;
  getRun(runId: string): Promise<StoredRunView | undefined>;
  respondToApproval(response: ApprovalResponse): Promise<void>;
  /** Ask the user for a folder, then write the generated workflow files into it. */
  exportWorkflow(request: ExportWorkflowRequest): Promise<ExportWorkflowResponse>;
  /**
   * Ask for a folder without writing anything into it.
   *
   * Naming the repository and writing to it are separate moments now: the
   * author picks first and sees what is about to be put there, and only the
   * copy actually writes. `null` means they closed the dialog.
   */
  chooseRunFolder(): Promise<string | null>;
  /**
   * Tell the main process whether the open workflow has unsaved edits, so closing
   * the window can ask before discarding them. The renderer cannot block a
   * window close on its own.
   */
  setWorkflowDirty(dirty: boolean): Promise<void>;
  /** Workflows opened recently, newest first. Ones that have gone are left out. */
  listRecentPlans(): Promise<RecentWorkflow[]>;
  /** Drop one from the list. The file itself is untouched. */
  forgetRecentWorkflow(path: string): Promise<void>;
  /**
   * Which of these paths exist on this machine.
   *
   * Asked by the message renderer about paths an *agent* wrote, so that a path
   * is only offered as clickable when there is something there to show. The
   * renderer never touches the filesystem itself; it asks, and main answers
   * with nothing but booleans.
   */
  /**
   * Open the author's terminal on this CLI's own sign-in command.
   *
   * Anthill does not sign anyone in and never sees a credential: the command
   * belongs to the CLI, the browser flow belongs to the author, and all this
   * does is put the command in front of them in a place where they can watch
   * it and answer it. Returns whether the terminal could be opened, so a
   * failure is reported rather than silently leaving nothing to look at.
   */
  signInToInterpreter(id: InterpreterId): Promise<{ ok: boolean; error?: string }>;
  pathsExist(paths: string[]): Promise<Record<string, boolean>>;
  /**
   * Show one item in Finder. Reveal, never open.
   *
   * The distinction is the whole point. `shell.openPath` on a path an external
   * agent wrote would run whatever that path turns out to be; revealing shows
   * it in its folder and executes nothing. Returns whether it was revealed, so
   * a caller is never left believing something happened that did not.
   */
  revealPath(path: string): Promise<boolean>;
  /** Which local CLIs are installed and could draft a workflow from a prompt. */
  detectInterpreters(): Promise<InterpreterInfo[]>;
  /**
   * Codex's own model catalogue, or `undefined` when Anthill has not been told.
   *
   * `undefined` rather than an empty list: the two say different things, and
   * "Codex offers no models" is not something a missing file is evidence for.
   */
  codexModels(): Promise<CodexModelCatalog | undefined>;
  /**
   * pi's model catalogue, read live with `pi --list-models`, or `undefined`
   * when the CLI could not be reached.
   *
   * `undefined` rather than an empty list: the two say different things, and
   * "pi offers no models" is not something a missing binary is evidence for.
   */
  piModels(): Promise<PiModelCatalog | undefined>;
  /**
   * Run one drafting pass through a local CLI. Interpretation only: the process
   * gets no tools and an empty working directory, and nothing it says is
   * persisted until the author accepts the preview.
   */
  draftFromPrompt(request: PromptDraftRequest): Promise<PromptDraftResponse>;
  /** Stop the drafting run in progress. Safe to call when none is. */
  cancelPromptDraft(): Promise<void>;
  /** Subscribe to drafting progress. Returns an unsubscribe function. */
  onPromptDraftStage(listener: (stage: PromptDraftStage) => void): () => void;
  /** Subscribe to run events. Returns an unsubscribe function. */
  onRunEvent(listener: (event: RunEvent) => void): () => void;

  /* Live session auto-detection */

  /**
   * Begin passive observation for a prompt about to be copied.
   *
   * Observation only: Anthill reads local records the user's own CLI writes.
   * There is deliberately no counterpart that starts, joins, or stops a session.
   */
  liveObserve(request: LiveObserveRequest): Promise<LiveSnapshot>;
  /** Everything currently observed, plus what each local CLI can expose. */
  liveSnapshot(): Promise<LiveSnapshot>;
  /**
   * Stop observing one run.
   *
   * This stops Anthill looking. It sends nothing to the user's session, which
   * keeps running exactly as it was.
   */
  liveCancel(runId: string): Promise<LiveSnapshot>;
  /** Hide a run that has already settled. */
  liveDismiss(runId: string): Promise<LiveSnapshot>;
  /** Re-read a lost session's records. Reading only; the session is untouched. */
  liveLookAgain(runId: string): Promise<LiveSnapshot>;

  /* The global agent library: reusable profiles that exist before any
     workflow. Descriptions of intended agents — nothing here executes. */
  agentsList(): Promise<GlobalAgentProfile[]>;
  agentsCreate(input: GlobalAgentInput): Promise<GlobalAgentProfile>;
  agentsUpdate(id: string, input: Partial<GlobalAgentInput>): Promise<GlobalAgentProfile | undefined>;
  agentsDuplicate(id: string): Promise<GlobalAgentProfile | undefined>;
  agentsRemove(id: string): Promise<boolean>;
  /**
   * The assistant's thread for one workflow, oldest turn first.
   *
   * Turns cross as they were written. Main remembers them; the panel owns what
   * a turn is and checks the shape on the way back in, so a record written by
   * an older Anthill costs the malformed turns and not the conversation.
   */
  assistantThreadRead(workflowId: string): Promise<unknown[]>;
  /** Record the thread as it now stands. The whole thread, not an append. */
  assistantThreadWrite(workflowId: string, turns: unknown[]): Promise<void>;
  /** Forget one workflow's thread. Only ever called from an explicit ask. */
  assistantThreadClear(workflowId: string): Promise<void>;
  /** The preferences this machine keeps, defaults filled in. */
  settingsRead(): Promise<AppSettings>;
  /** Change some of them; the rest are left alone. Returns what they now are. */
  settingsWrite(patch: Partial<AppSettings>): Promise<AppSettings>;
  /**
   * Send one notification now, so the author can see for themselves whether
   * they arrive.
   *
   * There is no API that answers whether macOS has been told to allow these:
   * the permission is granted or refused outside the app, and can be revoked
   * later without telling it. So the honest check is to send one and look.
   */
  notificationsProbe(): Promise<NotificationProbe>;
  /**
   * Everything Anthill observed for one run, oldest first.
   *
   * The renderer folds these into the page, because the fold needs the open
   * workflow and the workflow lives there. Main serves the log; it does not interpret it.
   */
  liveEvents(runId: string): Promise<ObservationEvent[]>;
  /** Subscribe to one run's activity growing. Returns an unsubscribe function. */
  onLiveEvents(
    listener: (payload: { runId: string; events: ObservationEvent[] }) => void,
  ): () => void;
  /** Subscribe to observation changes. Returns an unsubscribe function. */
  onLiveSnapshot(listener: (snapshot: LiveSnapshot) => void): () => void;
  /** Fires when the user picks Settings… (⌘,) from the menu bar. */
  onOpenSettings(listener: () => void): () => void;

  /* Local observation setup */

  /** Read local setup state. This does not write hook configuration. */
  liveSetupStatus(): Promise<ObservationSetupStatus>;
  /** Do not show the first-diagram setup prompt again unless reopened manually. */
  liveSetupDismiss(): Promise<ObservationSetupStatus>;
  /** Enable Anthill's passive observation hook entries for one available CLI. */
  liveSetupInstall(harness: MarkerCli): Promise<ObservationSetupActionResult>;
  /** Remove only Anthill's passive observation hook entries for one CLI. */
  liveSetupDisable(harness: MarkerCli): Promise<ObservationSetupActionResult>;
}
