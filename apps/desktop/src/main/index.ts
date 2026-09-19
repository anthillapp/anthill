/**
 * Anthill desktop shell — Electron main process.
 *
 * Owns the window and every privileged capability: filesystem dialogs, git
 * inspection, the run store, and spawning agent CLIs. The renderer runs with
 * `nodeIntegration: false` / `contextIsolation: true` and can only reach these
 * through the channels declared in `../shared/ipc.ts`.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell } from "electron";
import { dirname, join, resolve, sep } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";

import {
  captureGitStatus,
  hasUncommittedChanges,
  selectWorkspace,
} from "@anthill/workspace";
import { parseWorkflow } from "@anthill/workflow-schema";
import { checkWorkflowCompatibility, migrateWorkflow } from "@anthill/workflow";
import { ExchangeStore } from "@anthill/exchange-store";
import { MARKER_VERSION, workflowSteps } from "@anthill/live";
import type { Workflow } from "@anthill/workflow-schema";

import type { GlobalAgentInput } from "../shared/ipc.js";
import {
  IPC_CONTRACT,
  IpcChannel,
  LIVE_EVENTS_CHANNEL,
  LIVE_SNAPSHOT_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  OPEN_WORKFLOW_CHANNEL,
  SAVE_WORKFLOW_CHANNEL,
  PROMPT_DRAFT_STAGE_CHANNEL,
  RUN_EVENT_CHANNEL,
  type AppSettings,
  type ApprovalResponse,
  type IpcCapabilities,
  type LiveObserveRequest,
  type ExportWorkflowRequest,
  type ExportWorkflowResponse,
  type InterpreterInfo,
  type MarkerCli,
  type ObservationSetupActionResult,
  type ObservationSetupStatus,
  type PromptDraftRequest,
  type PromptDraftResponse,
  type OpenWorkflowResult,
  type RunEvent,
  type SaveWorkflowRequest,
  type SaveWorkflowResult,
  type StartRunRequest,
  type StartRunResponse,
  type WorkspaceInfo,
  type WorkspaceStatus,
} from "../shared/ipc.js";
import { createServices, detectRuntimes, startRun, type RunServices } from "./services.js";
import { detectInterpreters, runDraft, signInToInterpreter } from "./interpreters.js";
import { readCodexModels } from "./codex-models.js";
import { readPiModels } from "./pi-models.js";
import { readCodexAgentSupport } from "./codex-capability.js";
import { adoptUserPath } from "./user-path.js";
import { isRealLoadFailure, loadFailureUrl } from "./load-failure.js";
import {
  nameInSavedFile,
  saveDestination,
  type SavedRecord,
} from "./save-destination.js";
import { dataDirectoryRefusal, desktopUserDataPath, desktopDataDirectory } from "./user-data.js";
import { ExchangeInbox, type OpenOutcome, type OpenPermission } from "./exchange/inbox.js";
import { writeWorkingCopy } from "./exchange/working-copy.js";
import { exchangeDestination, saveExchangeCopy, readExchangeView, readyExchangeRevision, revokeExchangeRevision, boundWorkflow } from "./exchange/documents.js";
import { workflowIdFromLink, linksFromArgv, SerialDrain, WindowOperations, WorkflowDelivery } from "./exchange/deep-link.js";
import { REPORT_LOG } from "./live/observers/cli-report.js";
import { LiveSessionService, type LiveSessionSnapshot } from "./live/service.js";
import { ObservationSetupService } from "./live/setup.js";
import { AgentLibraryStore } from "./agent-library.js";
import { AssistantThreadStore } from "./assistant-threads.js";
import { SettingsStore } from "./settings.js";
import { PendingRunStore } from "./live/store.js";
import { WorkflowStatusStore } from "./live/workflow-status.js";
import {
  forgetRecent,
  listRecents,
  rememberRecent,
  setRecentsPaths,
} from "./recents.js";

// Startup failures in the main process are otherwise invisible — the app just
// sits there with no window and no message. Surface them loudly.
//
// Installed above everything, including the choice of data directory below,
// because that choice is itself the earliest thing that can refuse to happen:
// a `--data-dir` this build will not accept, or one the filesystem will not
// create, threw out of module evaluation with these handlers six lines beneath
// it and no window anywhere, and the app died without printing a word.
process.on("uncaughtException", (error) => {
  console.error("[anthill] uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[anthill] unhandled rejection:", reason);
});

/**
 * The name the operating system shows: the dock, the menu bar, the About item.
 *
 * Without this Electron falls back to its own name. It fixes the About panel
 * and everything that asks the app what it is called; the name beside the
 * Apple menu and the Dock's tooltip come from the running bundle instead, so
 * in a dev run those keep saying Electron and only packaging changes them.
 *
 * Where the data lives is decided here and nowhere else. `userData` is
 * otherwise derived from whatever the app is currently called, so a rename —
 * `setName`, a `productName` in package.json, a packaged bundle — moves every
 * path underneath it: the recent list, the live-session records, the
 * observation journals, the run store. The app then comes up looking like a
 * fresh install to somebody with months of work in the old directory.
 *
 * So the location is written out literally rather than read back from the
 * app. Reading it first and pinning what came back was the earlier form of
 * this, and it only worked while nothing renamed the app *before* this file
 * ran: a packaged build does exactly that, and the read would have captured
 * the new, empty directory and pinned the app to it (ANT-13).
 *
 * Packaged builds retain that existing location without a migration. Dev
 * builds use desktop-dev so QA cannot share stores or the instance lock with
 * the installed app. Select this before taking the lock or creating stores.
 */
const USER_DATA_DIR = chooseDataDirectory();
app.setName("Anthill");
app.setPath("userData", USER_DATA_DIR);

/**
 * The data directory, or a box saying why there is not going to be one.
 *
 * `dialog.showErrorBox` is the one dialog Electron allows before `ready`,
 * which is exactly where this is — long before a window exists and before any
 * store has been opened. Nothing else in the app could carry this message: a
 * refusal here means there is nowhere to write, so there will be no window and
 * no page to put a notice in.
 */
function chooseDataDirectory(): string {
  const fallback = desktopUserDataPath(app.getPath("appData"), app.isPackaged);
  try {
    const directory = desktopDataDirectory(process.argv, fallback);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  } catch (error) {
    dialog.showErrorBox("Anthill cannot start", dataDirectoryRefusal(error, fallback));
    app.exit(1);
    // `app.exit` ends the process, which the type checker has no way to know.
    throw error;
  }
}

let mainWindow: BrowserWindow | null = null;
let services: RunServices | null = null;

/**
 * A workflow handed over before there was a page ready to be told about it.
 *
 * The window exists from the moment it is constructed, but the page inside it
 * does not, and a message sent to a page that has not mounted reaches nobody.
 * So the path waits here and the renderer collects it with
 * `workflow:pending-open` once it is up. The pair is what makes a cold start
 * from an `anthill://` link work at all, and it is exactly one delivery: this
 * is cleared by whichever of the two gets there.
 */
let pendingOpenPath: string | undefined;

/**
 * Whether the page has asked for its pending workflow yet.
 *
 * The only evidence main has that there is a listener on the other end. Before
 * it, a handover is parked in `pendingOpenPath`; after it, it is pushed.
 */
let rendererListening = false;
const windowOperations = new WindowOperations();
const workflowDelivery = new WorkflowDelivery();
const pendingLinks = new Set<string>();
let closePending = false;

/**
 * Whether the open workflow has unsaved edits, as last reported over IPC.
 *
 * This is only a fallback. IPC delivery is asynchronous, so an edit followed
 * immediately by a window close could be decided on a stale value — the exact
 * case the guard exists to prevent. `isWorkflowDirty` therefore asks the renderer
 * at close time and uses this only if that fails.
 */
let workflowDirty = false;

/** Global the renderer sets synchronously on every edit. */
const DIRTY_FLAG = "window.__anthillWorkflowDirty === true";

/**
 * Read the live dirty state from the renderer.
 *
 * Falls back to the last value pushed over IPC if the page cannot be queried
 * (already destroyed, or script evaluation refused) — better to ask once too
 * often than to discard work silently.
 */
async function isWorkflowDirty(window: BrowserWindow): Promise<boolean> {
  try {
    return Boolean(await window.webContents.executeJavaScript(DIRTY_FLAG, true));
  } catch {
    return workflowDirty;
  }
}
/** Set once the user has confirmed discarding, so the retried close goes through. */
let allowCloseWithUnsavedWorkflow = false;

/**
 * Ask before something throws the open workflow's unsaved edits away.
 *
 * Three things in this process can: closing the window, restarting, and opening
 * another workflow over the top of this one. They ask the same question in the
 * same words, and each says in its own what is about to be lost — a restart
 * offered as a fix that silently discarded somebody's work would be a worse
 * fault than whatever they were restarting to cure.
 *
 * `true` means go ahead, including when there was nothing to lose.
 */
async function mayDiscardWorkflow(
  window: BrowserWindow,
  button: string,
  detail: string,
): Promise<boolean> {
  if (!(await isWorkflowDirty(window))) return true;
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Cancel", button],
    defaultId: 0,
    cancelId: 0,
    message: "This workflow has unsaved changes.",
    detail,
  });
  return response === 1;
}

/**
 * Locate the Electron-ABI build of better-sqlite3.
 *
 * The npm-installed copy is compiled for the system Node and fails to load
 * under Electron, so `scripts/fetch-electron-sqlite.mjs` keeps a separate
 * Electron build next to the app.
 *
 * In a packaged build it lands under `app.asar.unpacked/`, because the
 * `asarUnpack` glob for native addons takes them out of the archive but leaves
 * each file where it sat inside it. This used to look in `Resources/native/`
 * instead — where a file would be only if it were an `extraResource` — found
 * nothing, and returned `undefined`; better-sqlite3 then fell back to its own
 * resolution and picked up the *Node*-ABI copy that ships alongside as an
 * ordinary dependency. The app died at startup on a NODE_MODULE_VERSION
 * mismatch: the exact failure this function exists to prevent, in the one
 * build nobody runs while developing.
 *
 * Both paths are tried, so an `extraResources` layout would work too, and
 * `packaging.test.ts` holds the two in agreement.
 *
 * Returns `undefined` when there is genuinely nothing, so the fallback error
 * names the real problem rather than this function hiding it.
 */
function electronSqliteBinding(): string | undefined {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, "app.asar.unpacked/native/better_sqlite3.node"),
        join(process.resourcesPath, "native/better_sqlite3.node"),
      ]
    : [
        join(__dirname, "../../native/better_sqlite3.node"),
        join(app.getAppPath(), "apps/desktop/native/better_sqlite3.node"),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Learning the author's real PATH, started at once and awaited where it counts.
 *
 * A double-clicked app is started by launchd rather than by a shell, so it
 * inherits a bare system PATH with none of the places a coding CLI lives —
 * `~/.local/bin`, Homebrew, any version manager. Every "Claude Code was not
 * found" that produces is false, and it cannot appear in development, where
 * Electron is started from a shell that already has the right PATH.
 *
 * Kicked off here rather than awaited before the window: asking a login shell
 * costs however long somebody's rc file takes, and a window that waits on that
 * is a window that looks broken. Nothing before the first "what is installed?"
 * needs it, and that question waits on this promise instead.
 *
 * It cannot fail in a way that matters — no shell, a slow one, or a strange
 * answer all leave the PATH exactly as it was.
 */
const userPath = adoptUserPath().catch(() => false);

/**
 * Passive observation of sessions the user starts themselves.
 *
 * Created on first use and kept out of `services`: nothing about observing for a
 * session should be able to stop the Workflow from starting. It holds no process
 * and can start none — it reads the records the user's own CLIs write.
 */
let live: LiveSessionService | undefined;
let liveSetup: ObservationSetupService | undefined;
let exchangeStore: ExchangeStore | undefined;
let inbox: ExchangeInbox | undefined;
let agents: AgentLibraryStore | undefined;
let assistantThreads: AssistantThreadStore | undefined;
let settingsStore: SettingsStore | undefined;
let workflowStatusStore: WorkflowStatusStore | undefined;

/**
 * `~` is a shell convenience, not a path. Agents write it constantly, and
 * `existsSync("~/x")` is false for every one of them.
 */
function expandHome(path: string): string {
  if (path === "~") return app.getPath("home");
  return path.startsWith("~/") ? join(app.getPath("home"), path.slice(2)) : path;
}

function workflowStatus(): WorkflowStatusStore {
  workflowStatusStore ??= new WorkflowStatusStore(
    join(app.getPath("userData"), "workflow-status.json"),
  );
  return workflowStatusStore;
}

function settings(): SettingsStore {
  settingsStore ??= new SettingsStore(join(app.getPath("userData"), "settings.json"));
  return settingsStore;
}

/**
 * Show one native notification.
 *
 * The whole platform half of the feature, in one place. macOS decides whether
 * it appears: there is no API that reports the permission, and it can be
 * revoked later without the app being told, so nothing here pretends to know
 * more than "this was handed over". A system that cannot show one at all says
 * so, which is the one case Settings can state as fact.
 */
function showNotification(title: string, body: string): { kind: "sent" } | { kind: "unsupported"; reason: string } {
  if (!Notification.isSupported()) {
    return { kind: "unsupported", reason: "This system has no notification centre Anthill can use." };
  }
  try {
    // Silent: a step changing is worth a glance, not a sound. The workflow's
    // name is the title, so a notification is attributable at a glance to the
    // thing it is about rather than to "Anthill" in general.
    new Notification({ title, body, silent: true }).show();
    return { kind: "sent" };
  } catch (error) {
    return {
      kind: "unsupported",
      reason: error instanceof Error ? error.message : "The notification could not be sent.",
    };
  }
}

function assistantThreadStore(): AssistantThreadStore {
  assistantThreads ??= new AssistantThreadStore(
    join(app.getPath("userData"), "assistant-threads.json"),
  );
  return assistantThreads;
}

function agentLibrary(): AgentLibraryStore {
  agents ??= new AgentLibraryStore(join(app.getPath("userData"), "global-agents.json"));
  return agents;
}

/**
 * Where workflows handed over by a coding harness are kept.
 *
 * The MCP server writes into the same tree from a separate process, which is
 * why nothing in it is ever rewritten and why this side needs no lock to read
 * it. The directory is asked for at call time like every other store's, because
 * `userData` is pinned during module evaluation and re-deriving it anywhere
 * else is how a rename once moved every store out from under the app (ANT-13).
 */
function exchange(): ExchangeStore {
  exchangeStore ??= new ExchangeStore(app.getPath("userData"));
  return exchangeStore;
}

function liveService(): LiveSessionService {
  live ??= new LiveSessionService(
    new PendingRunStore(join(app.getPath("userData"), "live-sessions.json")),
    (snapshot: LiveSessionSnapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(LIVE_SNAPSHOT_CHANNEL, snapshot);
      }
    },
    () => new Date().toISOString(),
    { journalDir: join(app.getPath("userData"), "live-observations"), reportLogPath: REPORT_LOG },
    (runId, events) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(LIVE_EVENTS_CHANNEL, { runId, events });
      }
    },
    // The preference is read here rather than inside the service, and read at
    // the moment of the transition rather than cached: turning the setting off
    // has to stop the next notification, including one whose step was already
    // being observed when the switch was flipped.
    (notice) => {
      void settings()
        .read()
        .then((current) => {
          if (current.stepNotifications) showNotification(notice.title, notice.body);
        })
        .catch(() => undefined);
    },
    // How a run ended outlives the run itself, so the launch window can still
    // colour its row a week later (ANT-84).
    (run) => void workflowStatus().remember(run).catch(() => undefined),
  );
  return live;
}

function liveSetupService(): ObservationSetupService {
  liveSetup ??= new ObservationSetupService({
    prefsPath: join(app.getPath("userData"), "live-observation-setup.json"),
    hookHandlerPath: join(__dirname, "live-hook-handler.js"),
  });
  return liveSetup;
}

/** Broadcast a run event to the renderer, if a window is still open. */
function emitRunEvent(event: RunEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(RUN_EVENT_CHANNEL, event);
  }
}

/**
 * Where the application icon is, whether this is a dev run or a packaged one.
 *
 * Unpackaged, the app runs out of `node_modules/electron`, so without this the
 * dock shows Electron's own icon and the window is indistinguishable from any
 * other Electron shell on the machine.
 */
function iconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "icon.png")]
    : [join(__dirname, "../../build/icon.png"), join(app.getAppPath(), "apps/desktop/build/icon.png")];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Put Anthill's own mark on the dock.
 *
 * macOS takes a packaged app's icon from its bundle, which does not exist in a
 * dev run — `app.dock.setIcon` is the only way to change it while the app is
 * the Electron shell. Harmless when packaging arrives: the bundle icon wins and
 * this sets the same image over the top of it.
 */
function applyAppIcon(): void {
  const path = iconPath();
  if (!path) return;
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return;
  // macOS only; elsewhere the icon rides on the window itself.
  app.dock?.setIcon(image);
}

function createWindow(): void {
  allowCloseWithUnsavedWorkflow = false;
  workflowDirty = false;
  closePending = false;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "Anthill",
    backgroundColor: "#f6f7f9",
    // Windows and Linux take the icon from the window; macOS from the dock.
    ...(process.platform === "darwin" ? {} : { icon: iconPath() }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  /*
    A window that cannot load says so.

    Both calls used to be discarded with `void`, so a failed load produced an
    empty window and nothing else — no page, no message, nothing in the app to
    read. It reads as "Anthill is broken" when the usual cause in development
    is that `electron-vite`'s dev server has stopped answering and the window
    was restarted against it.

    `did-fail-load` rather than the promise alone, because it also catches a
    reload that fails later — pressing ⌘R against a server that is still down
    has to say the same thing rather than blanking the window again. The guard
    stops the error page's own load from being treated as another failure.
  */
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  let showingFailure = false;
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (showingFailure || !isRealLoadFailure(errorCode, isMainFrame)) return;
      showingFailure = true;
      void mainWindow
        ?.loadURL(
          loadFailureUrl({
            url: validatedURL || rendererUrl || "the app's own files",
            error: errorDescription || `error ${errorCode}`,
            dev: Boolean(rendererUrl),
          }),
        )
        .finally(() => {
          showingFailure = false;
        });
    },
  );

  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Ask before throwing away an unsaved workflow. `close` is cancellable; `closed`
  // is too late.
  // Always cancel the first close and decide asynchronously, because the only
  // trustworthy dirty state lives in the renderer and reading it is async.
  mainWindow.on("close", (event) => {
    if (allowCloseWithUnsavedWorkflow) return;

    const window = mainWindow;
    if (!window) return;

    event.preventDefault();
    if (closePending) return;
    closePending = true;
    void windowOperations.run(async () => {
      if (window.isDestroyed()) return;
      const mayClose = await mayDiscardWorkflow(
        window,
        "Discard changes",
        "Closing now discards everything since the last save.",
      );
      if (!mayClose) return;

      allowCloseWithUnsavedWorkflow = true;
      workflowDirty = false;
      window.close();
    }).finally(() => {
      closePending = false;
      // A link queued behind a cancelled close still needs delivery.
      void drainLinks();
    });
  });

  // Every load starts a page that has not asked for its pending workflow yet,
  // so anything handed over before it does has to wait in main rather than be
  // sent to nobody. A reload counts: the page that was listening is gone.
  mainWindow.webContents.on("did-start-loading", () => {
    rendererListening = false;
    workflowDelivery.reset();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererListening = false;
    workflowDelivery.reset();
  });
}

/**
 * Open one workflow file, whoever asked for it.
 *
 * At module scope rather than inside `registerIpcHandlers`, because IPC is no
 * longer the only way a workflow gets opened: a harness can hand one over
 * through the exchange inbox, and an `anthill://` link can name one. All three
 * go through here, so a handed-over workflow is migrated, compatibility-checked
 * and reported on in exactly the words the Open command uses.
 *
 * It remembers the file in the recent list even when nobody clicked anything,
 * and that is deliberate. The recent list is how a person finds a workflow
 * again after closing it, and a workflow that arrived while they were looking
 * elsewhere is the one they are most likely to go hunting for. Nothing depends
 * on it — a link resolves through the store, which knows every handover rather
 * than the last twelve files — so this is a convenience, not a route.
 */
async function openWorkflowAt(path: string): Promise<OpenWorkflowResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));

    // Compatibility is checked before schema parsing on purpose. A workflow from
    // a newer build may not satisfy this build's schema at all, and
    // "Invalid workflow: nodes.0.type ..." would hide the real reason.
    const original = checkWorkflowCompatibility(parsed);
    if (!original.ok && original.reason === "too-new") {
      return { ok: false, error: original.message };
    }

    // Upgrade what this build knows how to upgrade, so an older workflow opens
    // as a current one rather than opening with a warning the author has to
    // work through by hand. The file on disk is untouched until they save.
    const migration = migrateWorkflow(parsed);

    // Compatibility is re-checked on the upgraded workflow: a workflow the migration
    // brought current is current, and telling the author to go and fix it by
    // hand as well would contradict the note saying it was upgraded.
    const compatibility = checkWorkflowCompatibility(migration.workflow);
    const notice = [
      ...migration.notes,
      ...(compatibility.ok ? [] : [compatibility.message]),
    ];

    const workflow = parseWorkflow(migration.workflow);
    await rememberRecent(path);
    return {
      ok: true,
      opened: {
        path,
        workflow,
        notice: notice.length > 0 ? notice.join(" ") : undefined,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Workflows handed over from outside                                 */
/* ------------------------------------------------------------------ */

/**
 * The window a handed-over workflow goes to, opening one if there is none.
 *
 * macOS keeps the app running after the last window closes, and a workflow
 * handed over then has nowhere to appear. Opening a window is the one thing in
 * this whole feature that Anthill does rather than observes, and it is what the
 * person asked their coding tool for — every other arrow points inward.
 *
 * `opened` says the window is new, which is how the caller knows there is
 * nothing in it to ask about.
 */
function workflowWindow(): { window: BrowserWindow; opened: boolean } | undefined {
  if (mainWindow && !mainWindow.isDestroyed()) return { window: mainWindow, opened: false };
  // Before `whenReady` a BrowserWindow cannot be constructed at all, and the
  // caller's answer is "not yet" rather than "never".
  if (!app.isReady()) return undefined;
  createWindow();
  return mainWindow ? { window: mainWindow, opened: true } : undefined;
}

/** Whether a workflow nobody asked for may take the screen. */
async function mayShowWorkflow(path?: string): Promise<OpenPermission> {
  const target = workflowWindow();
  if (!target) return "no_window";
  if (!rendererListening || closePending) return "no_window";
  if (path && workflowDelivery.currentPath === path) return "yes";
  return (await mayDiscardWorkflow(
    target.window,
    "Open the new workflow",
    "Opening the workflow that was just handed over discards everything since the last save.",
  ))
    ? "yes"
    : "declined";
}

/**
 * Hand a path to the page, or keep it until there is a page to hand it to.
 *
 * Which of the two happens is decided by `rendererListening` and nothing else,
 * so exactly one of the push and the pending answer ever carries a given
 * workflow. A push into a page that is still loading is silently lost, and
 * silently losing this one means a user who followed a link watching an app
 * that opened and did nothing.
 *
 * `false` says the path was parked rather than sent, so the caller can stop
 * waiting for an acknowledgement that nobody is in a position to give: a
 * parked handover is answered by the next page to ask for its pending
 * workflow, minutes later if that is how long the user takes.
 */
function handOverToRenderer(path: string): boolean {
  if (rendererListening && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(OPEN_WORKFLOW_CHANNEL, path);
    return true;
  }
  pendingOpenPath = path;
  return false;
}

/** Open a workflow the user did not pick, and put it on screen. */
async function showWorkflow(path: string): Promise<OpenOutcome> {
  const result = await openWorkflowAt(path);
  if (!result.ok) {
    return { kind: "refused", error: "error" in result ? result.error : "It could not be opened." };
  }
  const delivery = await workflowDelivery.deliver(path, () => handOverToRenderer(path));
  if (delivery === "shown") {
    mainWindow?.show();
    mainWindow?.focus();
    return { kind: "shown" };
  }
  return delivery === "parked"
    ? { kind: "parked" }
    : { kind: "unconfirmed", error: "The page did not confirm opening the workflow. The handover remains pending; reopen it from its link." };
}

function receiveLink(url: string): void {
  if (!workflowIdFromLink(url)) {
    void refuseHandover("This is not a supported anthill://workflow/<id> link. Nothing was opened.");
    return;
  }
  pendingLinks.add(url);
  if (app.isReady()) {
    workflowWindow();
    void drainLinks();
  }
}

const linkDrain = new SerialDrain(() => drainOnce());

/**
 * Deliver every link that is waiting, one at a time and once each.
 *
 * Three things call this — a link arriving, a close the user cancelled, and
 * the page asking for its pending workflow — and a pass stops in the middle
 * for a dialog, so two of them used to walk the same set at once.
 */
function drainLinks(): Promise<void> {
  return linkDrain.run();
}

async function drainOnce(): Promise<void> {
  if (!rendererListening) return;
  for (const url of [...pendingLinks]) {
    pendingLinks.delete(url);
    // The queue covers the question and the write, and is let go before the
    // renderer is waited on. It is shared with the window's close handler, and
    // ten seconds of waiting for an acknowledgement inside it is ten seconds
    // in which every close click is swallowed and every other handover is told
    // there is no window.
    const prepared = await windowOperations
      .run(async (): Promise<string | undefined> => {
        const id = workflowIdFromLink(url)!;
        const stored = await exchange().readWorkflow(id);
        if (!stored?.head || stored.problems.length) {
          await refuseHandover(`Workflow ${id} is missing or unreadable in this Anthill data directory.`);
          return undefined;
        }
        const path = exchange().workingCopyPath(id);
        const permission = await mayShowWorkflow(path);
        if (permission === "no_window") { pendingLinks.add(url); return undefined; }
        if (permission === "declined") return undefined;
        await writeWorkingCopy(path, stored.head.workflow);
        return path;
      })
      .catch(async (error) => { await refuseHandover(String(error)); return undefined; });
    if (!prepared) continue;
    const result = await showWorkflow(prepared).catch((error): OpenOutcome => ({ kind: "refused", error: String(error) }));
    // A parked handover is on its way to the next page that asks for one, so
    // saying it failed would be untrue and the user would be shown it twice.
    // Anything else the person clicked a link for is worth a sentence.
    if (result.kind === "refused" || result.kind === "unconfirmed") await refuseHandover(result.error);
  }
}

/**
 * Say that something arrived which cannot be acted on.
 *
 * A native box rather than a notice in the page, because most of what reaches
 * here is a file on disk this build cannot read — the same class of thing the
 * run store's startup failure reports this way, and the one case where there
 * may be no page to put a notice in.
 */
async function refuseHandover(message: string): Promise<void> {
  dialog.showErrorBox("Anthill could not carry out a handover", message);
}

function exchangeInbox(): ExchangeInbox {
  inbox ??= new ExchangeInbox(exchange(), {
    serialize: (work) => windowOperations.run(work),
    mayOpen: mayShowWorkflow,
    open: showWorkflow,
    refuse: refuseHandover,
    register: async (run): Promise<boolean> => {
      try {
        const service = liveService();
        // A run already registered is not registered again. The stored record
        // carries everything the observers have learned since, and putting a
        // fresh one over the top would forget that the session was ever found
        // and start waiting for it a second time.
        return await service.registerBinding({
          boundAt: run.boundAt,
          exchange: { revision: run.revision.revision, digest: run.revision.digest, ...(run.sessionId ? { sessionId: run.sessionId } : {}) },
          anthillRunId: run.runId,
          correlationNonce: run.nonce,
          selectedCli: run.harness,
          promptVersion: MARKER_VERSION,
          // The revision's digest stands in for the prompt hash. Nothing reads
          // it for its provenance; it identifies the content a run started
          // from, which is exactly what a revision digest is.
          bootstrapPromptHash: run.revision.digest,
          workflowId: run.workflowId,
          ...(run.revision.workflow.name ? { workflowName: run.revision.workflow.name } : {}),
          steps: workflowSteps(run.revision.workflow),
        });
      } catch (error) {
        console.error("[anthill] could not register a bound run:", error);
        return false;
      }
    },
  });
  return inbox;
}

/**
 * Every channel this process actually registered, in the order it did.
 *
 * Recorded rather than derived from `IpcChannel`, because the question the
 * renderer needs answered is not "what does the contract name" — both sides
 * share that file — but "what does the process that is running right now
 * actually answer". A channel added to the contract and served by a main
 * process from before the edit must not appear here.
 */
const registered: string[] = [];

/** `ipcMain.handle`, plus a note that it happened. */
function handle(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1],
): void {
  ipcMain.handle(channel, listener);
  registered.push(channel);
}

function registerIpcHandlers(): void {
  handle(
    IpcChannel.appCapabilities,
    async (): Promise<IpcCapabilities> => ({
      contract: IPC_CONTRACT,
      channels: [...registered],
      shell: "desktop",
    }),
  );

  /**
   * Restart Anthill.
   *
   * `app.relaunch()` schedules a fresh instance and `app.exit()` ends this one
   * without running the window's `close` handler — so the unsaved-workflow question
   * has to be asked here instead, or a restart offered as a fix would quietly
   * throw away the user's work.
   */
  handle(IpcChannel.appRelaunch, async (): Promise<boolean> => {
    const window = mainWindow;
    if (window && !window.isDestroyed()) {
      const mayRestart = await mayDiscardWorkflow(
        window,
        "Restart and discard changes",
        "Restarting now discards everything since the last save.",
      );
      if (!mayRestart) return false;
    }
    app.relaunch();
    // Give the reply a chance to reach the renderer before the process ends.
    setTimeout(() => app.exit(0), 100);
    return true;
  });

  handle(IpcChannel.workspaceSelect, async (): Promise<WorkspaceInfo | null> => {
    const result = await dialog.showOpenDialog({
      title: "Select a repository or working directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const context = await selectWorkspace(result.filePaths[0]);
    return {
      rootPath: context.rootPath,
      activePath: context.activePath,
      mode: context.mode,
      git: context.git
        ? { repositoryRoot: context.git.repositoryRoot, branch: context.git.branch }
        : undefined,
    };
  });

  handle(
    IpcChannel.workspaceStatus,
    async (_event, rootPath: string): Promise<WorkspaceStatus> => {
      const status = await captureGitStatus(rootPath);
      return { status, dirty: hasUncommittedChanges(status) };
    },
  );

  handle(
    IpcChannel.workflowOpen,
    async (_event, requested?: string): Promise<OpenWorkflowResult> => {
      // A path means the author picked a workflow from the launch window's list, so
      // there is nothing to ask them.
      if (requested) return openWorkflowAt(requested);

      const result = await dialog.showOpenDialog({
        title: "Open workflow",
        // Matching on the bare ".json" suffix, so a file saved by any earlier
        // build shows up here whatever double suffix it used — nothing about
        // opening needs to change when the write side emits a new one.
        filters: [{ name: "Workflow JSON", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, cancelled: true };
      }

      return openWorkflowAt(result.filePaths[0]);
    },
  );

  /*
    The page saying it is ready to be handed a workflow, and collecting
    whatever arrived while it was not.

    Taken rather than read, so the same workflow is never opened twice: React's
    StrictMode mounts every effect twice in development, and either of the two
    calls is as good as the other. Answering it is also the only evidence main
    has that there is a listener on the other end, which is what
    `handOverToRenderer` decides between pushing and parking on.
  */
  handle(IpcChannel.workflowPendingOpen, async (): Promise<string | undefined> => {
    rendererListening = true;
    const path = pendingOpenPath;
    pendingOpenPath = undefined;
    void drainLinks();
    return path;
  });
  handle(IpcChannel.workflowOpened, async (_event, path: string) => { workflowDelivery.acknowledge(path); });
  handle(IpcChannel.exchangeRead, async (_event, path: string, id: string) => readExchangeView(exchange(), path, id));
  handle(IpcChannel.exchangeReady, async (_event, request) => readyExchangeRevision(exchange(), request));
  handle(IpcChannel.exchangeRevoke, async (_event, request) => revokeExchangeRevision(exchange(), request));
  handle(IpcChannel.liveWorkflow, async (_event, runId: string) => {
    await liveService().start();
    return boundWorkflow(exchange(), liveService().registered(runId));
  });

  handle(
    IpcChannel.workflowSave,
    async (_event, request: SaveWorkflowRequest): Promise<SaveWorkflowResult> => {
      // What the last successful save left behind, read from the file itself
      // rather than tracked alongside it — see ./save-destination.ts.
      const saved: SavedRecord = request.path
        ? await readFile(request.path, "utf8").then(
            (contents) => {
              const name = nameInSavedFile(contents);
              return name === undefined
                ? ({ kind: "unreadable" } as const)
                : ({ kind: "named", name } as const);
            },
            // Gone is a fact worth acting on; unreadable for any other reason
            // — permissions, a volume playing up — is not evidence that they
            // deleted anything, so it must not provoke a dialog.
            (error: NodeJS.ErrnoException) =>
              error?.code === "ENOENT"
                ? ({ kind: "missing" } as const)
                : ({ kind: "unreadable" } as const),
          )
        : ({ kind: "missing" } as const);

      let exchangeCopy = false;
      try {
        exchangeCopy = Boolean(request.path && await exchangeDestination(exchange(), request.path, request.workflow.id));
      } catch (error) {
        return { kind: "failed", error: String(error) };
      }
      const destination = exchangeCopy && request.path
        ? { kind: "write" as const, path: request.path }
        : saveDestination(request.workflow.name ?? "", request.path, saved);
      let path = request.path;
      if (destination.kind === "ask") {
        const result = await dialog.showSaveDialog({
          title: "Save workflow",
          // New saves get the ".workflow.json" suffix. The open side matches
          // any ".json", so anything saved under an earlier convention keeps
          // opening normally.
          defaultPath: destination.suggested,
          filters: [{ name: "Workflow JSON", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath) return { kind: "cancelled" };
        path = result.filePath;
      } else {
        path = destination.path;
      }
      try {
        if (await exchangeDestination(exchange(), path, request.workflow.id)) {
          await saveExchangeCopy(exchange(), path, request.workflow);
        } else {
          await writeFile(path, `${JSON.stringify(request.workflow, null, 2)}\n`, "utf8");
        }
      } catch (error) {
        // Reported rather than thrown, so the editor can say what went wrong
        // and keep the unsaved work rather than losing the answer in a
        // rejected IPC call (ANT-58).
        return {
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      // Saving is how a workflow gets into the launch window's list in the first
      // place: a workflow drafted from a prompt has never been opened from a file.
      await rememberRecent(path);

      return { kind: "saved", path };
    },
  );

  handle(IpcChannel.runtimesDetect, async () => {
    if (!services) return [];
    return detectRuntimes(services.runtimes);
  });

  handle(
    IpcChannel.runStart,
    async (_event, request: StartRunRequest): Promise<StartRunResponse> => {
      if (!services) return { ok: false, error: "Run services are not ready yet." };
      try {
        const runId = await startRun(
          services,
          request.workflow as Workflow,
          request.workspacePath,
          emitRunEvent,
        );
        return { ok: true, runId };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  handle(IpcChannel.runList, async () => {
    if (!services) return [];
    return services.store.listRuns();
  });

  handle(IpcChannel.runGet, async (_event, runId: string) => {
    if (!services) return undefined;
    return services.store.getRun(runId);
  });

  handle(
    IpcChannel.approvalRespond,
    async (_event, response: ApprovalResponse): Promise<void> => {
      services?.approvals.respond(response.runId, response.nodeId, response.decision);
    },
  );

  // The launch window's list of what was open recently.
  /*
    The list, with each row's last known outcome attached.

    Joined here rather than inside `listRecents` because the two answer
    different questions from different places: that one is about files on disk,
    this one is about what Anthill observed. A row whose workflow is being
    watched right now is coloured from the live snapshot instead — the renderer
    prefers the live run, so these two can never contradict each other.
  */
  handle(IpcChannel.recentsList, async () => {
    const [rows, endings] = await Promise.all([listRecents(), workflowStatus().all()]);
    return rows.map((row) => {
      const ending = row.workflowId ? endings[row.workflowId] : undefined;
      return ending ? { ...row, lastRun: { state: ending.state, at: ending.at } } : row;
    });
  });

  handle(IpcChannel.recentsForget, async (_event, path: string) => {
    // Taking a row off the list takes its dot with it: this record is only
    // ever read through that list, so one left behind could never be asked
    // about again.
    const row = (await listRecents()).find((item) => item.path === path);
    await forgetRecent(path);
    if (row?.workflowId) await workflowStatus().forget(row.workflowId);
  });

  /*
    Paths an agent wrote about, and showing one on disk.

    Two handlers rather than one, because they answer different questions and
    only the second does anything. The renderer asks which paths are real so it
    can offer only those as clickable, and gets back nothing but booleans — it
    never learns anything about a path it did not already have.

    Reveal, never open. `shell.openPath` on a path an external agent wrote
    would run whatever that path turns out to be — an app bundle, a script, an
    installer — which is exactly the capability the message renderer exists to
    withhold. `showItemInFolder` selects the item in Finder and executes
    nothing.
  */
  // Naming a folder is not writing to it: the author picks here, sees what is
  // about to be put there, and only the copy writes.
  handle(IpcChannel.folderChoose, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: "Choose the repository the session will run in",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return resolve(result.filePaths[0]);
  });

  // Opens the author's terminal on the CLI's own login command. Anthill never
  // sees a credential; the id is looked up in a table, so nothing that crosses
  // this channel becomes a command.
  handle(IpcChannel.interpreterSignIn, async (_event, id: string) =>
    signInToInterpreter(id),
  );

  handle(IpcChannel.pathsCheck, async (_event, paths: string[]) =>
    Object.fromEntries(
      (Array.isArray(paths) ? paths : [])
        .filter((path): path is string => typeof path === "string")
        .slice(0, 200)
        .map((path) => [path, existsSync(expandHome(path))]),
    ),
  );
  handle(IpcChannel.pathReveal, async (_event, path: string) => {
    if (typeof path !== "string") return false;
    const target = expandHome(path);
    // Checked here rather than trusted from the renderer: the renderer's own
    // check is about what to draw, and a path can stop existing between the
    // drawing and the click.
    if (!existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });

  // Prompt-to-Workflow. Detection and drafting only — nothing here runs a workflow.
  handle(IpcChannel.interpretersDetect, async (): Promise<InterpreterInfo[]> => {
    await userPath;
    return detectInterpreters();
  });

  // Read-only, and nothing is run: Codex keeps its own model catalogue on this
  // machine, and a hand-kept copy in Anthill's source would go stale on
  // somebody else's release schedule.
  handle(IpcChannel.codexModels, async () => {
    await userPath;
    const [catalog, agentSupport] = await Promise.all([
      readCodexModels(),
      readCodexAgentSupport(),
    ]);
    // The catalogue and the capability are separate questions: a CLI too old
    // for custom agents still lists its models perfectly well, and the screen
    // needs to offer the choice while saying it will not be applied.
    return { models: catalog?.models ?? [], ...(catalog?.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}), agentSupport };
  });

  // Read-only, and nothing is run: pi lists its models on request and keeps
  // no cache file, so the catalogue is asked for live and a missing CLI
  // leaves it `undefined` rather than an empty list.
  handle(IpcChannel.piModels, async () => {
    await userPath;
    return await readPiModels();
  });

  // One drafting run at a time, which is what the screen offers. Held here so
  // the cancel channel has something to abort.
  let drafting: AbortController | null = null;

  handle(
    IpcChannel.promptDraft,
    async (event, request: PromptDraftRequest): Promise<PromptDraftResponse> => {
      drafting?.abort();
      const controller = new AbortController();
      drafting = controller;
      try {
        return await runDraft({
          interpreterId: request.interpreterId,
          instruction: request.instruction,
          signal: controller.signal,
          onStage: (stage) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send(PROMPT_DRAFT_STAGE_CHANNEL, stage);
            }
          },
        });
      } finally {
        if (drafting === controller) drafting = null;
      }
    },
  );

  handle(IpcChannel.promptDraftCancel, async () => {
    drafting?.abort();
  });

  /* ---------------------------------------------------------------- */
  /* Live session auto-detection                                       */
  /* ---------------------------------------------------------------- */

  handle(IpcChannel.liveObserve, async (_event, request: LiveObserveRequest) => {
    const service = liveService();
    await service.start();
    return service.startObservation(request);
  });
  handle(IpcChannel.liveSnapshot, async () => liveService().start());
  handle(IpcChannel.liveCancel, async (_event, runId: string) =>
    liveService().cancelObservation(runId),
  );
  handle(IpcChannel.liveDismiss, async (_event, runId: string) =>
    liveService().dismiss(runId),
  );
  handle(IpcChannel.liveLookAgain, async (_event, runId: string) =>
    liveService().lookAgain(runId),
  );

  // The global agent library. Descriptions of intended agents; nothing runs.
  handle(IpcChannel.agentsList, async () => agentLibrary().load());
  handle(IpcChannel.agentsCreate, async (_event, input: GlobalAgentInput) =>
    agentLibrary().create(input),
  );
  handle(IpcChannel.agentsUpdate, async (_event, id: string, input: Partial<GlobalAgentInput>) =>
    agentLibrary().update(id, input),
  );
  handle(IpcChannel.agentsDuplicate, async (_event, id: string) =>
    agentLibrary().duplicate(id),
  );
  handle(IpcChannel.agentsRemove, async (_event, id: string) => agentLibrary().remove(id));

  /*
    The assistant's thread, per workflow.

    Read and written whole: the panel owns what a turn is and what the thread
    currently contains, and this side only remembers it faithfully. Clearing is
    its own channel because it is its own decision — closing the panel must
    never reach it (ANT-82).
  */
  handle(IpcChannel.assistantThreadRead, async (_event, workflowId: string) =>
    assistantThreadStore().read(workflowId),
  );
  handle(IpcChannel.assistantThreadWrite, async (_event, workflowId: string, turns: unknown[]) =>
    assistantThreadStore().write(workflowId, Array.isArray(turns) ? turns : []),
  );
  handle(IpcChannel.assistantThreadClear, async (_event, workflowId: string) =>
    assistantThreadStore().clear(workflowId),
  );

  handle(IpcChannel.settingsRead, async () => settings().read());
  handle(IpcChannel.settingsWrite, async (_event, patch: Partial<AppSettings>) =>
    settings().write(patch ?? {}),
  );
  // Sent on demand, because "are notifications allowed" has no answer to read:
  // the author is being asked to look at their own screen.
  handle(IpcChannel.notificationsProbe, async () =>
    showNotification(
      "Anthill notifications are on",
      "This is what a step transition will look like.",
    ),
  );
  handle(IpcChannel.liveEvents, async (_event, runId: string) =>
    liveService().events(runId),
  );

  handle(
    IpcChannel.liveSetupStatus,
    async (): Promise<ObservationSetupStatus> => liveSetupService().status(),
  );
  handle(
    IpcChannel.liveSetupDismiss,
    async (): Promise<ObservationSetupStatus> => liveSetupService().dismiss(),
  );
  handle(
    IpcChannel.liveSetupInstall,
    async (_event, harness: MarkerCli): Promise<ObservationSetupActionResult> =>
      liveSetupService().install(harness),
  );
  handle(
    IpcChannel.liveSetupDisable,
    async (_event, harness: MarkerCli): Promise<ObservationSetupActionResult> =>
      liveSetupService().disable(harness),
  );

  handle(IpcChannel.workflowSetDirty, async (_event, dirty: boolean) => {
    workflowDirty = Boolean(dirty);
    if (!workflowDirty) allowCloseWithUnsavedWorkflow = false;
  });

  handle(
    IpcChannel.workflowExport,
    async (_event, request: ExportWorkflowRequest): Promise<ExportWorkflowResponse> => {
      // A root the author has already chosen is not asked for again. The
      // dialog is the consent; asking on every copy would turn a decision into
      // a chore, and a chore into a step that gets skipped.
      let chosen = request.root;
      if (!chosen) {
        const result = await dialog.showOpenDialog({
          title: "Choose the repository to write the workflow into",
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { ok: false, cancelled: true };
        }
        chosen = result.filePaths[0];
      }

      const root = resolve(chosen);
      const written: string[] = [];

      try {
        const entries = [...request.files];
        if (request.prompt) {
          entries.push({ path: "anthill-prompt.md", content: request.prompt });
        }

        for (const file of entries) {
          const destination = resolve(root, file.path);
          // Generated paths are ours, but never let a crafted workflow write
          // outside the folder the user actually chose.
          if (destination !== root && !destination.startsWith(root + sep)) {
            return { ok: false, error: `Refusing to write outside the chosen folder: ${file.path}` };
          }
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, file.content, "utf8");
          written.push(file.path);
        }
        return { ok: true, directory: root, written };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

/*
  One instance, enforced.

  Two Anthills sharing one userData folder are two writers on every store this
  app owns: both observe the same sessions, and each appends journal events
  with its own fingerprint set — which is how one run's journal ended up with
  every event of a session recorded twice, interleaved. The second instance
  hands its argv to the first and exits; the first responds by fronting its
  window, which is what the person double-clicking again actually wanted.
*/
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    for (const link of linksFromArgv(argv)) receiveLink(link);
    workflowWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// macOS can deliver this before ready; only the window work is deferred.
app.on("open-url", (event, url) => { event.preventDefault(); receiveLink(url); });
for (const url of linksFromArgv(process.argv)) receiveLink(url);

/**
 * The menu bar, for the one item that has to live there.
 *
 * macOS puts Settings under the app menu with ⌘, and people look for it there
 * rather than on a page. Live Observation used to be managed from a button in
 * the workflow header; that button is gone, because setting it up belongs in
 * the handover where the deadline is, and managing it afterwards belongs
 * somewhere reachable at any time from anywhere.
 *
 * Built from roles so every standard item keeps its standard behaviour, and
 * the app menu's own title comes from the bundle — which is why the packaged
 * build says Anthill and a dev run says Electron (ANT-13).
 */
function applyMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: "appMenu",
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Settings…",
            accelerator: "CmdOrCtrl+,",
            click: () => {
              BrowserWindow.getAllWindows()[0]?.webContents.send(OPEN_SETTINGS_CHANNEL);
            },
          },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        // Spelled out rather than taken from the role, because the role's File
        // menu has no Save in it. Save is a menu item and not a key handler in
        // the page so that one press is exactly one save, and so the shortcut
        // is written down where people look for it (ANT-59).
        label: "File",
        submenu: [
          {
            label: "Save",
            accelerator: "CmdOrCtrl+S",
            // The window the menu fired for, so a second window saves its own
            // document and not whatever happens to be first in the list.
            click: (_item, window) => {
              const target =
                window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow();
              target?.webContents.send(SAVE_WORKFLOW_CHANNEL);
            },
          },
          { type: "separator" },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

void app.whenReady().then(async () => {
  if (app.isPackaged) app.setAsDefaultProtocolClient("anthill");
  else if (process.argv[1]) app.setAsDefaultProtocolClient("anthill", process.execPath, [resolve(process.argv[1])]);
  // Register handlers and show the window BEFORE opening the run store, so a
  // storage failure surfaces as a visible error instead of an app that starts
  // with no window and no message.
  applyAppIcon();
  applyMenu();
  setRecentsPaths({ userData: app.getPath("userData"), home: app.getPath("home") });
  registerIpcHandlers();
  createWindow();

  // Reading what a coding harness left in the exchange, from here on. Started
  // after the window so the first workflow it finds has somewhere to go.
  exchangeInbox().start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  try {
    services = await createServices(
      join(app.getPath("userData"), "runs"),
      emitRunEvent,
      electronSqliteBinding(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to initialize run services:", error);
    dialog.showErrorBox(
      "Anthill could not start its run store",
      `Workflows cannot be executed until this is resolved.\n\n${message}`,
    );
  }
});

app.on("window-all-closed", () => {
  // Unblock any run parked on an approval so the engine can unwind cleanly.
  services?.approvals.abandonAll("The application is shutting down.");
  if (process.platform !== "darwin") app.quit();
});

// before-quit can still be cancelled by the unsaved-workflow dialog.
app.on("will-quit", () => {
  inbox?.stop();
  live?.stop();
  services?.approvals.abandonAll("The application is shutting down.");
  void services?.store.close?.();
});
