import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

import { parseWorkflow } from "@anthill/workflow-schema";
import {
  checkWorkflowCompatibility,
  INTERPRETERS,
  migrateWorkflow,
  type InterpreterId,
} from "@anthill/workflow";
import type { Workflow } from "@anthill/workflow-schema";

import {
  IPC_CONTRACT,
  IpcChannel,
  PROMPT_DRAFT_STAGE_CHANNEL,
  LIVE_SNAPSHOT_CHANNEL,
  LIVE_EVENTS_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  OPEN_WORKFLOW_CHANNEL,
  SAVE_WORKFLOW_CHANNEL,
  type IpcCapabilities,
  type AnthillApi,
  type WorkspaceInfo,
  type StartRunRequest,
  type SaveWorkflowRequest,
  type ExportWorkflowRequest,
  type ApprovalResponse,
  type PromptDraftRequest,
  type LiveObserveRequest,
  type GlobalAgentInput,
  type MarkerCli,
} from "../../desktop/src/shared/ipc.js";
import { createServices, type RunServices } from "../../desktop/src/main/services.js";
import { destinationInside, FileGrants, FolderGrants, writeAllOrNothing } from "../../desktop/src/main/safe-write.js";
import {
  detectInterpreters,
  runDraft,
  type DraftRunOptions,
} from "../../desktop/src/main/interpreters.js";
import { readCodexModels } from "../../desktop/src/main/codex-models.js";
import { readPiModels } from "../../desktop/src/main/pi-models.js";
import { readCodexAgentSupport } from "../../desktop/src/main/codex-capability.js";
import { adoptUserPath } from "../../desktop/src/main/user-path.js";
import {
  nameInSavedFile,
  saveDestination,
  type SavedRecord,
} from "../../desktop/src/main/save-destination.js";
import { AgentLibraryStore } from "../../desktop/src/main/agent-library.js";
import { LiveSessionService } from "../../desktop/src/main/live/service.js";
import { ObservationSetupService } from "../../desktop/src/main/live/setup.js";
import { PendingRunStore } from "../../desktop/src/main/live/store.js";
import {
  forgetRecent,
  listRecents,
  rememberRecent,
  setRecentsPaths,
} from "../../desktop/src/main/recents.js";
import type { Paths } from "./paths.js";
import { reportPath } from "./report.js";

/**
 * The CLI's answer to the desktop's preload: it maps every `IpcChannel`
 * onto the same pure-Node service modules the desktop main process uses
 * (`services.ts`, `interpreters.ts`, `user-path.ts`, `save-destination.ts`,
 * `codex-models.ts`, `codex-capability.ts`, `agent-library.ts`, `live/*`),
 * and broadcasts the push channels over the WebSocket.
 *
 * Where the desktop uses dialogs, the CLI returns `null`/cancelled:
 * `chooseRunFolder` and the folder-choose variants have no dialog to ask.
 *
 * The contract is shared, not copied: the channel names and the `AnthillApi`
 * shape come from `apps/desktop/src/shared/ipc.ts`, so a renderer written
 * for Electron runs against the CLI unchanged.
 */
export type BridgeOptions = {
  paths: Paths;
  /** The workspace the CLI was started with, if any. */
  workspace?: string;
  /** Broadcast a push-channel message to every connected client. */
  broadcast(message: unknown): void;
  /**
   * Register the handler for messages arriving from a client (the server's
   * `onMessage`). `reply` sends a message back to the client that sent it;
   * the bridge answers request channels with `reply` (a unicast) and uses
   * `broadcast` only for push channels, which every client should see.
   */
  onMessage(
    handler: (message: unknown, reply: (message: unknown) => void) => void,
  ): void;
  /**
   * Print a line to the author's console (defaults to `console.log`). The
   * sign-in flow uses it to surface a command there is no portable way to
   * run on the author's behalf.
   */
  notify?: (message: string) => void;
};

export type Bridge = {
  /** What the running CLI can actually do (the `app:capabilities` answer). */
  capabilities(): Promise<IpcCapabilities>;
  /**
   * Handle one request/response channel. `channel` is an `IpcChannel` value;
   * `args` are the structured-clone arguments the renderer sent.
   */
  handle(channel: string, ...args: unknown[]): Promise<unknown>;
  /** Subscribe to a push channel. Returns an unsubscribe function. */
  on(channel: string, listener: (payload: unknown) => void): () => void;
  /** The full `AnthillApi`, for the parts the renderer calls directly. */
  api: AnthillApi;
  /** Shut the bridge down (abort any in-flight draft, drop subscriptions). */
  close(): Promise<void>;
};

/** A one-shot push: broadcast to every client, and to any local subscriber. */
type Push = (channel: string, payload: unknown) => void;

export async function createBridge(options: BridgeOptions): Promise<Bridge> {
  const { paths, workspace } = options;
  const notify = options.notify ?? console.log;

  // The recents store is the one reused module that used to read its location
  // from a host API; point it at the CLI's data dir and home.
  setRecentsPaths({ userData: paths.userData, home: paths.home });

  // Adopt the user's shell PATH so the runtimes the CLI detects are the ones
  // the user actually has (the desktop does the same at startup).
  void adoptUserPath().catch(() => false);

  // Only legacy history uses this store, never drafting or passive observation.
  let historyLoading: Promise<RunServices> | undefined;
  function history(): Promise<RunServices> {
    historyLoading ??= createServices(join(paths.userData, "runs")).catch((error) => {
      historyLoading = undefined;
      throw error;
    });
    return historyLoading;
  }
  /**
   * The legacy history, when there is one that opens.
   *
   * From the page's side a store that will not open — a corrupt file, a
   * native binding this build cannot load — is the same fact as no store at
   * all: there is no snapshot for the run either way. It did not use to be:
   * the rejection crossed to the renderer, and `LiveSessionPage` asks for the
   * snapshot *before* falling back to the open workflow, so a manually pasted
   * session drew an error and a Retry that re-ran the same failing open.
   *
   * Reported once, and `history()` clears its own cache on the way out, so a
   * store that becomes readable later is opened later.
   */
  async function historyIfReadable(): Promise<RunServices | undefined> {
    if (!existsSync(join(paths.userData, "runs", "runs.db"))) return undefined;
    return history().catch((error) => {
      console.warn("Anthill: the legacy run history could not be opened:", error);
      return undefined;
    });
  }
  const exportGrants = new FolderGrants();
  const workflowFiles = new FileGrants();
  if (workspace) await exportGrants.grant(workspace);

  // The lazy singletons, created on first use and kept out of `services`:
  // nothing about observing for a session should be able to stop a Workflow
  // from starting. They read the records the user's own CLIs write.
  let live: LiveSessionService | undefined;
  let liveSetup: ObservationSetupService | undefined;
  let agents: AgentLibraryStore | undefined;

  function liveService(): LiveSessionService {
    live ??= new LiveSessionService(
      new PendingRunStore(join(paths.userData, "live-sessions.json")),
      (snapshot) => push(LIVE_SNAPSHOT_CHANNEL, snapshot),
      () => new Date().toISOString(),
      {
        journalDir: join(paths.userData, "live-observations"),
        // The report file lives in the CLI's own data directory: with
        // `--data-dir X`, the observer reads reports from `X`, exactly where
        // `anthill run --data-dir X` writes them, instead of falling back
        // to the default directory.
        reportLogPath: reportPath(paths),
      },
      (runId, events) => push(LIVE_EVENTS_CHANNEL, { runId, events }),
    );
    return live;
  }

  function liveSetupService(): ObservationSetupService {
    liveSetup ??= new ObservationSetupService({
      prefsPath: join(paths.userData, "live-observation-setup.json"),
      // The hook handler is bundled with the CLI's main-process output: it is
      // a runtime script path, not an import, so the CLI compiles it (it is
      // in the CLI tsconfig's include) and points the marker at the compiled
      // module. If it is absent, `ObservationSetupService` reports "not found"
      // rather than failing the boot.
      hookHandlerPath: join(__dirname, "../../desktop/src/main/live/hook-handler.js"),
    });
    return liveSetup;
  }

  function agentLibrary(): AgentLibraryStore {
    agents ??= new AgentLibraryStore(join(paths.userData, "global-agents.json"));
    return agents;
  }

  // `~` is a shell convenience, not a path. Agents write it constantly, and
  // `existsSync("~/x")` is false for every one of them.
  function expandHome(path: string): string {
    if (path === "~") return paths.home;
    return path.startsWith("~/") ? join(paths.home, path.slice(2)) : path;
  }

  // A push: broadcast to every connected client, and to any local subscriber
  // registered through `on`. Listeners are typed by the channel (the renderer
  // knows what a `run:event` payload is), so `on` accepts any listener shape
  // and narrows it back to `unknown` when storing.
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();
  const push: Push = (channel, payload) => {
    options.broadcast({ channel, payload });
    const set = subscribers.get(channel);
    if (set) for (const listener of set) listener(payload);
  };

  // The in-flight prompt draft, so `prompt:draft-cancel` can abort it.
  let draftAbort: AbortController | undefined;
  // Whether the open workflow has unsaved changes (the editor reports it).
  let workflowDirty = false;

  // The channels the running CLI registered a handler for, for
  // `app:capabilities`. Filled as the map is built.
  const registered: string[] = [];

  // The channel -> handler map. Each handler takes the structured-clone args
  // the renderer sent and returns the structured-clone result.
  const handlers: Record<string, (args: unknown[]) => Promise<unknown>> = {};
  const register = (
    channel: string,
    handler: (args: unknown[]) => Promise<unknown>,
  ): void => {
    handlers[channel] = handler;
    registered.push(channel);
  };

  // The dialog channels resolve from `--workspace` or return null/cancelled:
  register(IpcChannel.appCapabilities, async () => ({
    contract: IPC_CONTRACT,
    channels: [...registered],
    shell: "cli",
  }));

  // No relaunch in the CLI: there is nothing to restart. Returning false lets
  // the renderer say "the restart did not happen" rather than waiting forever.
  register(IpcChannel.appRelaunch, async () => false);

  register(IpcChannel.workflowOpen, async (args) => {
    const requested = args[0];
    if (typeof requested === "string" && requested) {
      if (!await workflowFiles.has(requested) && !(await openWorkflowCandidates()).includes(requested)) {
        return { ok: false as const, error: "Choose a workflow from the configured workspace or recent files." };
      }
      return openWorkflowAt(requested);
    }
    // No path: the desktop shows a file dialog. The CLI has no dialog to show,
    // so it offers the candidates it knows about — the recents and the workflow
    // files in the configured workspace — and lets the renderer pick one.
    const candidates = await openWorkflowCandidates();
    return candidates.length > 0
      ? { ok: false as const, cancelled: true as const, candidates }
      : { ok: false as const, cancelled: true as const };
  });

  /*
    Nothing hands a workflow to the CLI shell.

    The exchange is read by the desktop's main process, and an `anthill://`
    link is delivered by an operating system to an application it registered —
    neither reaches a page served over HTTP. The channel is answered all the
    same, because the renderer is one bundle in two shells and a method only
    one of them offers is the shape of bug `web-bridge-launch.test.ts` exists
    for. `undefined` is the honest answer: nothing is waiting, and nothing ever
    will be here.
  */
  register(IpcChannel.workflowPendingOpen, async () => undefined);
  register(IpcChannel.workflowOpened, async () => undefined);
  // Desktop owns exchange handover. The web shell must refuse approval rather
  // than claim a decision it has nowhere to persist.
  register(IpcChannel.exchangeRead, async () => undefined);
  register(IpcChannel.liveWorkflow, async () => ({ ok: false, error: "Bound revisions are available in Anthill desktop." }));

  /**
   * The workflow files the CLI can name: the recents (most recent first), then
   * the `.workflow.json` files in the configured workspace. Deduplicated, the
   * first (most recent) occurrence kept. The CLI's answer to the desktop's
   * file dialog, which the renderer turns into a picker.
   */
  async function openWorkflowCandidates(): Promise<string[]> {
    const found: string[] = [];
    for (const recent of await listRecents()) {
      found.push(recent.path);
    }
    if (workspace) {
      const { readdir } = await import("node:fs/promises");
      try {
        const root = resolve(workspace);
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".workflow.json")) {
            found.push(join(root, entry.name));
          }
        }
      } catch {
        // The workspace is not readable; the recents are still offered.
      }
    }
    return [...new Set(found)];
  }

  register(IpcChannel.workflowSave, async (args) => {
    const request = args[0] as SaveWorkflowRequest;
    if (request.path && !await workflowFiles.has(request.path)) {
      return { kind: "failed" as const, error: "Open this workflow before saving changes to its file." };
    }
    const { readFile, access } = await import("node:fs/promises");
    // What the last successful save left behind, read from the file itself.
    const saved: SavedRecord = request.path
      ? await readFile(request.path, "utf8").then(
          (contents) => {
            const name = nameInSavedFile(contents);
            return name === undefined
              ? ({ kind: "unreadable" } as const)
              : ({ kind: "named", name } as const);
          },
          (error: NodeJS.ErrnoException) =>
            error?.code === "ENOENT"
              ? ({ kind: "missing" } as const)
              : ({ kind: "unreadable" } as const),
        )
      : ({ kind: "missing" } as const);

    const destination = saveDestination(
      request.workflow.name ?? "",
      request.path,
      saved,
    );
    let path: string;
    if (destination.kind === "ask") {
      if (!request.path) {
        // A new save: there is no remembered path, so derive one under the
        // configured workspace. Without a workspace there is nowhere to go.
        if (!workspace) return { kind: "cancelled" as const };
        path = join(resolve(workspace), basename(destination.suggested));
      } else if (saved.kind === "missing") {
        // The saved file was deleted on purpose. Recreating it silently would
        // undo that, so the save is cancelled, like a cancelled dialog.
        return { kind: "cancelled" as const };
      } else {
        // Renamed since the last save: the suggested path is next to the old
        // file (a new file, not a recreation), so it goes there. A rename is
        // not a decision to move house.
        path = destination.suggested;
      }
      // Never overwrite a file the author has not asked to replace: a web
      // save has no dialog to warn about it.
      try {
        await access(path);
        return { kind: "cancelled" as const };
      } catch {
        // The path does not exist; the write is safe.
      }
    } else {
      // A "write" destination: the remembered path, which holds (the name
      // matched and the file is there), so the write goes where it went last
      // time.
      path = destination.path;
    }
    try {
      const safe = await destinationInside(dirname(path), basename(path));
      if (!safe.ok) throw new Error(safe.reason);
      const written = await writeAllOrNothing([{ path: safe.path, relative: basename(path), content: `${JSON.stringify(request.workflow, null, 2)}\n` }]);
      if (!written.ok) throw new Error(written.error);
      await workflowFiles.grant(path);
      await rememberRecent(path);
      return { kind: "saved" as const, path };
    } catch (error) {
      return {
        kind: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  register(IpcChannel.runList, async () => (await historyIfReadable())?.store.listRuns() ?? []);

  register(IpcChannel.runGet, async (args) =>
    (await historyIfReadable())?.store.getRun(String(args[0])));

  register(IpcChannel.recentsList, async () => listRecents());
  register(IpcChannel.recentsForget, async (args) => forgetRecent(String(args[0])));

  register(IpcChannel.folderChoose, async () =>
    workspace ? resolve(workspace) : null,
  );

  register(IpcChannel.interpreterSignIn, async (args) => {
    const id = String(args[0]);
    const item = INTERPRETERS.find((candidate) => candidate.id === id);
    if (!item) return { ok: false, error: `Unknown interpreter: ${id}` };
    // The CLI is the author's terminal: surface the command here rather than
    // opening a second terminal. There is no portable way to open a terminal
    // on Linux, and the author is already in one. The sign-in is the
    // author's own; Anthill only hands over the exact command.
    notify(
      `Sign in to ${item.label}: run \`${item.signIn}\` in this terminal, then come back.`,
    );
    return { ok: true };
  });

  register(IpcChannel.pathsCheck, async (args) =>
    Object.fromEntries(
      (Array.isArray(args[0]) ? args[0] : [])
        .filter((path): path is string => typeof path === "string")
        .slice(0, 200)
        .map((path) => [path, existsSync(expandHome(path))]),
    ),
  );

  register(IpcChannel.pathReveal, async (args) => {
    if (typeof args[0] !== "string") return false;
    const target = expandHome(args[0]);
    if (!existsSync(target)) return false;
    // Reveal, never open: open the containing directory in the file manager
    // (`xdg-open` on a directory opens it; it never executes the file). Best
    // effort — if no file manager is available, the path still exists and the
    // renderer can show it.
    revealInFileManager(dirname(target));
    return true;
  });

  /**
   * Best-effort, non-blocking: open a directory in the default file manager.
   * A no-op when no file manager is available (there is no portable way to
   * guarantee one on Linux). Never executes the file — it opens the folder.
   */
  function revealInFileManager(dir: string): void {
    try {
      const child = spawn("xdg-open", [dir], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // No file manager; the reveal is a no-op.
    }
  }

  register(IpcChannel.interpretersDetect, async () => detectInterpreters());

  register(IpcChannel.codexModels, async () => {
    const models = await readCodexModels();
    if (!models) return undefined;
    return { ...models, agentSupport: await readCodexAgentSupport() };
  });

  // Read-only, and nothing is run: pi lists its models on request and keeps
  // no cache file, so the catalogue is asked for live and a missing CLI
  // leaves it `undefined` rather than an empty list.
  register(IpcChannel.piModels, async () => {
    return await readPiModels();
  });

  register(IpcChannel.promptDraft, async (args) => {
    const request = args[0] as PromptDraftRequest;
    draftAbort?.abort();
    draftAbort = new AbortController();
    const options: DraftRunOptions = {
      interpreterId: request.interpreterId,
      instruction: request.instruction,
      signal: draftAbort.signal,
      onStage: (stage) => push(PROMPT_DRAFT_STAGE_CHANNEL, stage),
    };
    return runDraft(options);
  });

  register(IpcChannel.promptDraftCancel, async () => {
    draftAbort?.abort();
    draftAbort = undefined;
  });

  register(IpcChannel.liveObserve, async (args) => {
    const request = args[0] as LiveObserveRequest;
    const service = liveService();
    await service.start();
    return service.startObservation(request);
  });

  register(IpcChannel.liveSnapshot, async () => liveService().start());
  register(IpcChannel.liveCancel, async (args) =>
    liveService().cancelObservation(String(args[0])),
  );
  register(IpcChannel.liveDismiss, async (args) =>
    liveService().dismiss(String(args[0])),
  );
  register(IpcChannel.liveLookAgain, async (args) =>
    liveService().lookAgain(String(args[0])),
  );

  register(IpcChannel.agentsList, async () => agentLibrary().load());
  register(IpcChannel.agentsCreate, async (args) =>
    agentLibrary().create(args[0] as GlobalAgentInput),
  );
  register(IpcChannel.agentsUpdate, async (args) =>
    agentLibrary().update(String(args[0]), args[1] as Partial<GlobalAgentInput>),
  );
  register(IpcChannel.agentsDuplicate, async (args) =>
    agentLibrary().duplicate(String(args[0])),
  );
  register(IpcChannel.agentsRemove, async (args) =>
    agentLibrary().remove(String(args[0])),
  );

  register(IpcChannel.liveEvents, async (args) =>
    liveService().events(String(args[0])),
  );

  register(IpcChannel.liveSetupStatus, async () => liveSetupService().status());
  register(IpcChannel.liveSetupDismiss, async () => liveSetupService().dismiss());
  register(IpcChannel.liveSetupInstall, async (args) =>
    liveSetupService().install(args[0] as MarkerCli),
  );
  register(IpcChannel.liveSetupDisable, async (args) =>
    liveSetupService().disable(args[0] as MarkerCli),
  );

  register(IpcChannel.workflowSetDirty, async (args) => {
    workflowDirty = Boolean(args[0]);
  });

  register(IpcChannel.workflowExport, async (args) => {
    const request = args[0] as ExportWorkflowRequest;
    // A root the author has already chosen is not asked for again; otherwise
    // the CLI's `--workspace` is the repository, or there is none to write into.
    const chosen = request.root ?? (workspace ? resolve(workspace) : undefined);
    if (!chosen) return { ok: false as const, cancelled: true as const };

    const root = await exportGrants.resolveGranted(chosen);
    if (!root) return { ok: false as const, error: "Export is limited to the configured workspace." };
    try {
      const entries = [...request.files];
      if (request.prompt) {
        entries.push({ path: "anthill-prompt.md", content: request.prompt });
      }
      const files = [];
      for (const file of entries) {
        const destination = await destinationInside(root, file.path);
        if (!destination.ok) return { ok: false as const, error: destination.reason };
        files.push({ path: destination.path, relative: file.path, content: file.content });
      }
      const result = await writeAllOrNothing(files);
      return result.ok ? { ...result, directory: root } : result;
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  async function openWorkflowAt(path: string) {
    try {
      const { readFile } = await import("node:fs/promises");
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));

      // Compatibility is checked before schema parsing on purpose: a workflow
      // from a newer build may not satisfy this build's schema at all, and
      // "Invalid workflow: nodes.0.type ..." would hide the real reason.
      const original = checkWorkflowCompatibility(parsed);
      if (!original.ok && original.reason === "too-new") {
        return { ok: false as const, error: original.message };
      }

      // The migration brings an older workflow current; its notes say what
      // changed. The file on disk is untouched until the author saves.
      const migration = migrateWorkflow(parsed);

      // Compatibility is re-checked on the upgraded workflow: a workflow the
      // migration brought current is current, and telling the author to go and
      // fix it by hand as well would contradict the note saying it was upgraded.
      const compatibility = checkWorkflowCompatibility(migration.workflow);
      const notice = [
        ...migration.notes,
        ...(compatibility.ok ? [] : [compatibility.message]),
      ];

      const workflow = parseWorkflow(migration.workflow);
      await workflowFiles.grant(path);
      await rememberRecent(path);
      return {
        ok: true as const,
        opened: {
          path,
          workflow,
          notice: notice.length > 0 ? notice.join(" ") : undefined,
        },
      };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // The dispatcher: an incoming WS message is { id, channel, args }. Dispatch
  // to the handler map and answer over the unicast `reply` (a response to one
  // tab's request is not a message for the others; push channels use
  // `broadcast`).
  options.onMessage((message, reply) => {
    const call = message as { id?: unknown; channel?: unknown; args?: unknown[] };
    if (
      typeof call !== "object" ||
      call === null ||
      typeof call.channel !== "string"
    ) {
      return;
    }
    const { id, channel } = call;
    const args = Array.isArray(call.args) ? call.args : [];
    void (async () => {
      const handler = handlers[channel];
      if (!handler) {
        reply({ id, channel, error: `No handler for channel "${channel}".` });
        return;
      }
      try {
        const result = await handler(args);
        reply({ id, channel, result });
      } catch (error) {
        reply({
          id,
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  // `handle` and `on`, defined here so both the `api` object and the returned
  // `Bridge` share them.
  const handle = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers[channel];
    if (!handler) {
      return Promise.reject(new Error(`No handler for channel "${channel}".`));
    }
    return handler(args);
  };
  const on = (
    channel: string,
    listener: (payload: any) => void,
  ): (() => void) => {
    let set = subscribers.get(channel);
    if (!set) {
      set = new Set();
      subscribers.set(channel, set);
    }
    const stored = listener as (payload: unknown) => void;
    set.add(stored);
    return () => {
      set?.delete(stored);
    };
  };

  // The full `AnthillApi`, built from the channel map. A renderer written for
  // the Electron preload runs against this unchanged: every method is the same
  // channel call, and every subscription is the same push channel. `handle`
  // returns `Promise<unknown>` (the WS boundary is untyped), so the object is
  // cast once at the end rather than per method.
  const api = {
    contract: IPC_CONTRACT,
    capabilities: () => handle(IpcChannel.appCapabilities),
    relaunch: () => handle(IpcChannel.appRelaunch),
    openWorkflow: (path?: string) => handle(IpcChannel.workflowOpen, path),
    pendingWorkflowOpen: () => handle(IpcChannel.workflowPendingOpen),
    workflowOpened: (path, id, outcome) => handle(IpcChannel.workflowOpened, path, id, outcome),
    exchangeRead: (path, id) => handle(IpcChannel.exchangeRead, path, id),
    liveWorkflow: (runId) => handle(IpcChannel.liveWorkflow, runId),
    // No delivery id: this shell's pushes carry one payload, and nothing here
    // waits to be told a page opened a document. The desktop's acknowledgement
    // handshake exists for the exchange, which this shell refuses outright, so
    // a page that answers without an id is answering about nothing.
    onOpenWorkflow: (listener: (path: string, deliveryId?: number) => void) =>
      on(OPEN_WORKFLOW_CHANNEL, (path) => listener(path as string)),
    saveWorkflow: (request: SaveWorkflowRequest) =>
      handle(IpcChannel.workflowSave, request),
    onSaveWorkflow: (listener: () => void) =>
      on(SAVE_WORKFLOW_CHANNEL, () => listener()),
    listRuns: () => handle(IpcChannel.runList),
    getRun: (runId: string) => handle(IpcChannel.runGet, runId),
    exportWorkflow: (request: ExportWorkflowRequest) =>
      handle(IpcChannel.workflowExport, request),
    setWorkflowDirty: (dirty: boolean) =>
      handle(IpcChannel.workflowSetDirty, dirty),
    listRecentPlans: () => handle(IpcChannel.recentsList),
    forgetRecentWorkflow: (path: string) =>
      handle(IpcChannel.recentsForget, path),
    chooseRunFolder: () => handle(IpcChannel.folderChoose),
    signInToInterpreter: (id: InterpreterId) =>
      handle(IpcChannel.interpreterSignIn, id),
    pathsExist: (paths: string[]) => handle(IpcChannel.pathsCheck, paths),
    revealPath: (path: string) => handle(IpcChannel.pathReveal, path),
    detectInterpreters: () => handle(IpcChannel.interpretersDetect),
    codexModels: () => handle(IpcChannel.codexModels),
    piModels: () => handle(IpcChannel.piModels),
    draftFromPrompt: (request: PromptDraftRequest) =>
      handle(IpcChannel.promptDraft, request),
    cancelPromptDraft: () => handle(IpcChannel.promptDraftCancel),
    onPromptDraftStage: (listener) => on(PROMPT_DRAFT_STAGE_CHANNEL, listener),
    liveObserve: (request: LiveObserveRequest) =>
      handle(IpcChannel.liveObserve, request),
    liveSnapshot: () => handle(IpcChannel.liveSnapshot),
    liveCancel: (runId: string) => handle(IpcChannel.liveCancel, runId),
    liveDismiss: (runId: string) => handle(IpcChannel.liveDismiss, runId),
    liveLookAgain: (runId: string) => handle(IpcChannel.liveLookAgain, runId),
    agentsList: () => handle(IpcChannel.agentsList),
    agentsCreate: (input: GlobalAgentInput) =>
      handle(IpcChannel.agentsCreate, input),
    agentsUpdate: (id: string, input: Partial<GlobalAgentInput>) =>
      handle(IpcChannel.agentsUpdate, id, input),
    agentsDuplicate: (id: string) => handle(IpcChannel.agentsDuplicate, id),
    agentsRemove: (id: string) => handle(IpcChannel.agentsRemove, id),
    liveEvents: (runId: string) => handle(IpcChannel.liveEvents, runId),
    onLiveEvents: (listener) => on(LIVE_EVENTS_CHANNEL, listener),
    onLiveSnapshot: (listener) => on(LIVE_SNAPSHOT_CHANNEL, listener),
    onOpenSettings: (listener) => on(OPEN_SETTINGS_CHANNEL, () => listener()),
    liveSetupStatus: () => handle(IpcChannel.liveSetupStatus),
    liveSetupDismiss: () => handle(IpcChannel.liveSetupDismiss),
    liveSetupInstall: (harness: MarkerCli) =>
      handle(IpcChannel.liveSetupInstall, harness),
    liveSetupDisable: (harness: MarkerCli) =>
      handle(IpcChannel.liveSetupDisable, harness),
  } as AnthillApi;

  return {
    capabilities: () => Promise.resolve({
      contract: IPC_CONTRACT,
      channels: [...registered],
    }),
    handle,
    on,
    api,
    close: async () => {
      draftAbort?.abort();
      draftAbort = undefined;
      live?.stop();
      if (historyLoading) await historyLoading.then((opened) => opened.store.close?.()).catch(() => undefined);
      subscribers.clear();
    },
  };
}
