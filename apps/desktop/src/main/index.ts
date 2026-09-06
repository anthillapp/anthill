/**
 * Anthill desktop shell — Electron main process.
 *
 * Owns the window and every privileged capability: filesystem dialogs, git
 * inspection, the run store, and spawning agent CLIs. The renderer runs with
 * `nodeIntegration: false` / `contextIsolation: true` and can only reach these
 * through the channels declared in `../shared/ipc.ts`.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import { dirname, join, resolve, sep } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import {
  captureGitStatus,
  hasUncommittedChanges,
  selectWorkspace,
} from "@anthill/workspace";
import { parseWorkflow } from "@anthill/workflow-schema";
import { checkWorkflowCompatibility, migrateWorkflow } from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";

import type { GlobalAgentInput } from "../shared/ipc.js";
import {
  IPC_CONTRACT,
  IpcChannel,
  LIVE_EVENTS_CHANNEL,
  LIVE_SNAPSHOT_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  PROMPT_DRAFT_STAGE_CHANNEL,
  RUN_EVENT_CHANNEL,
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
  type StartRunRequest,
  type StartRunResponse,
  type WorkspaceInfo,
  type WorkspaceStatus,
} from "../shared/ipc.js";
import { createServices, detectRuntimes, startRun, type RunServices } from "./services.js";
import { detectInterpreters, runDraft, signInToInterpreter } from "./interpreters.js";
import { readCodexModels } from "./codex-models.js";
import { readCodexAgentSupport } from "./codex-capability.js";
import { adoptUserPath } from "./user-path.js";
import { desktopUserDataPath } from "./user-data.js";
import { LiveSessionService, type LiveSessionSnapshot } from "./live/service.js";
import { ObservationSetupService } from "./live/setup.js";
import { AgentLibraryStore } from "./agent-library.js";
import { PendingRunStore } from "./live/store.js";
import {
  forgetRecent,
  listRecents,
  rememberRecent,
} from "./recents.js";

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
const USER_DATA_DIR = desktopUserDataPath(app.getPath("appData"), app.isPackaged);
app.setName("Anthill");
app.setPath("userData", USER_DATA_DIR);

// Startup failures in the main process are otherwise invisible — the app just
// sits there with no window and no message. Surface them loudly.
process.on("uncaughtException", (error) => {
  console.error("[anthill] uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[anthill] unhandled rejection:", reason);
});

let mainWindow: BrowserWindow | null = null;
let services: RunServices | null = null;

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
let agents: AgentLibraryStore | undefined;

/**
 * `~` is a shell convenience, not a path. Agents write it constantly, and
 * `existsSync("~/x")` is false for every one of them.
 */
function expandHome(path: string): string {
  if (path === "~") return app.getPath("home");
  return path.startsWith("~/") ? join(app.getPath("home"), path.slice(2)) : path;
}

function agentLibrary(): AgentLibraryStore {
  agents ??= new AgentLibraryStore(join(app.getPath("userData"), "global-agents.json"));
  return agents;
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
    { journalDir: join(app.getPath("userData"), "live-observations") },
    (runId, events) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(LIVE_EVENTS_CHANNEL, { runId, events });
      }
    },
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
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

    void (async () => {
      if (!(await isWorkflowDirty(window))) {
        allowCloseWithUnsavedWorkflow = true;
        window.close();
        return;
      }

      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        buttons: ["Cancel", "Discard changes"],
        defaultId: 0,
        cancelId: 0,
        message: "This workflow has unsaved changes.",
        detail: "Closing now discards everything since the last save.",
      });
      if (response !== 1) return;

      allowCloseWithUnsavedWorkflow = true;
      workflowDirty = false;
      window.close();
    })();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
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
    async (): Promise<IpcCapabilities> => ({ contract: IPC_CONTRACT, channels: [...registered] }),
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
    if (window && !window.isDestroyed() && (await isWorkflowDirty(window))) {
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        buttons: ["Cancel", "Restart and discard changes"],
        defaultId: 0,
        cancelId: 0,
        message: "This workflow has unsaved changes.",
        detail: "Restarting now discards everything since the last save.",
      });
      if (response !== 1) return false;
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

  handle(
    IpcChannel.workflowSave,
    async (_event, request: SaveWorkflowRequest): Promise<{ path: string } | null> => {
      let path = request.path;
      if (!path) {
        const result = await dialog.showSaveDialog({
          title: "Save workflow",
          // New saves get the ".workflow.json" suffix. The open side matches
          // any ".json", so anything saved under an earlier convention keeps
          // opening normally.
          defaultPath: `${request.workflow.name || "workflow"}.workflow.json`,
          filters: [{ name: "Workflow JSON", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath) return null;
        path = result.filePath;
      }
      await writeFile(path, `${JSON.stringify(request.workflow, null, 2)}\n`, "utf8");
      // Saving is how a workflow gets into the launch window's list in the first
      // place: a workflow drafted from a prompt has never been opened from a file.
      await rememberRecent(path);
      return { path };
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
  handle(IpcChannel.recentsList, async () => listRecents());
  handle(IpcChannel.recentsForget, async (_event, path: string) => forgetRecent(path));

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
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

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
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

void app.whenReady().then(async () => {
  // Register handlers and show the window BEFORE opening the run store, so a
  // storage failure surfaces as a visible error instead of an app that starts
  // with no window and no message.
  applyAppIcon();
  applyMenu();
  registerIpcHandlers();
  createWindow();

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

app.on("before-quit", () => {
  live?.stop();
  services?.approvals.abandonAll("The application is shutting down.");
  void services?.store.close?.();
});
