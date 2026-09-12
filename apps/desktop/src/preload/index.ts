/**
 * Preload script: the only bridge between the sandboxed renderer and main.
 *
 * Exposes exactly the methods declared in `AnthillApi` — no `ipcRenderer`, no
 * Node globals, nothing else. Every argument crosses as structured-clone data.
 */

import { contextBridge, ipcRenderer, webFrame } from "electron";

import type { GlobalAgentInput } from "../shared/ipc.js";
import type { InterpreterId } from "@anthill/workflow";
import {
  IPC_CONTRACT,
  IpcChannel,
  LIVE_EVENTS_CHANNEL,
  LIVE_SNAPSHOT_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  SAVE_WORKFLOW_CHANNEL,
  PROMPT_DRAFT_STAGE_CHANNEL,
  RUN_EVENT_CHANNEL,
  type AnthillApi,
  type ApprovalResponse,
  type ExportWorkflowRequest,
  type LiveObserveRequest,
  type ObservationEvent,
  type LiveSnapshot,
  type MarkerCli,
  type PromptDraftRequest,
  type PromptDraftStage,
  type RunEvent,
  type SaveWorkflowRequest,
  type StartRunRequest,
} from "../shared/ipc.js";

const api: AnthillApi = {
  // Stamped in, not asked for: this is the age of the preload itself, and it
  // has to be readable even when main answers nothing at all.
  contract: IPC_CONTRACT,
  capabilities: () => ipcRenderer.invoke(IpcChannel.appCapabilities),
  relaunch: () => ipcRenderer.invoke(IpcChannel.appRelaunch),
  selectWorkspace: () => ipcRenderer.invoke(IpcChannel.workspaceSelect),
  workspaceStatus: (rootPath: string) =>
    ipcRenderer.invoke(IpcChannel.workspaceStatus, rootPath),
  openWorkflow: (path?: string) => ipcRenderer.invoke(IpcChannel.workflowOpen, path),
  saveWorkflow: (request: SaveWorkflowRequest) =>
    ipcRenderer.invoke(IpcChannel.workflowSave, request),
  detectRuntimes: () => ipcRenderer.invoke(IpcChannel.runtimesDetect),
  startRun: (request: StartRunRequest) =>
    ipcRenderer.invoke(IpcChannel.runStart, request),
  listRuns: () => ipcRenderer.invoke(IpcChannel.runList),
  getRun: (runId: string) => ipcRenderer.invoke(IpcChannel.runGet, runId),
  respondToApproval: (response: ApprovalResponse) =>
    ipcRenderer.invoke(IpcChannel.approvalRespond, response),
  exportWorkflow: (request: ExportWorkflowRequest) =>
    ipcRenderer.invoke(IpcChannel.workflowExport, request),
  setWorkflowDirty: (dirty: boolean) =>
    ipcRenderer.invoke(IpcChannel.workflowSetDirty, dirty),
  listRecentPlans: () => ipcRenderer.invoke(IpcChannel.recentsList),
  forgetRecentWorkflow: (path: string) => ipcRenderer.invoke(IpcChannel.recentsForget, path),
  chooseRunFolder: () => ipcRenderer.invoke(IpcChannel.folderChoose),
  signInToInterpreter: (id: InterpreterId) =>
    ipcRenderer.invoke(IpcChannel.interpreterSignIn, id),
  pathsExist: (paths: string[]) => ipcRenderer.invoke(IpcChannel.pathsCheck, paths),
  revealPath: (path: string) => ipcRenderer.invoke(IpcChannel.pathReveal, path),
  detectInterpreters: () => ipcRenderer.invoke(IpcChannel.interpretersDetect),
  codexModels: () => ipcRenderer.invoke(IpcChannel.codexModels),
  piModels: () => ipcRenderer.invoke(IpcChannel.piModels),
  draftFromPrompt: (request: PromptDraftRequest) =>
    ipcRenderer.invoke(IpcChannel.promptDraft, request),
  cancelPromptDraft: () => ipcRenderer.invoke(IpcChannel.promptDraftCancel),
  onPromptDraftStage: (listener: (stage: PromptDraftStage) => void) => {
    const handler = (_event: unknown, stage: PromptDraftStage) => listener(stage);
    ipcRenderer.on(PROMPT_DRAFT_STAGE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(PROMPT_DRAFT_STAGE_CHANNEL, handler);
    };
  },
  liveObserve: (request: LiveObserveRequest) =>
    ipcRenderer.invoke(IpcChannel.liveObserve, request),
  liveSnapshot: () => ipcRenderer.invoke(IpcChannel.liveSnapshot),
  liveCancel: (runId: string) => ipcRenderer.invoke(IpcChannel.liveCancel, runId),
  liveDismiss: (runId: string) => ipcRenderer.invoke(IpcChannel.liveDismiss, runId),
  liveLookAgain: (runId: string) => ipcRenderer.invoke(IpcChannel.liveLookAgain, runId),
  agentsList: () => ipcRenderer.invoke(IpcChannel.agentsList),
  agentsCreate: (input: GlobalAgentInput) => ipcRenderer.invoke(IpcChannel.agentsCreate, input),
  agentsUpdate: (id: string, input: Partial<GlobalAgentInput>) =>
    ipcRenderer.invoke(IpcChannel.agentsUpdate, id, input),
  agentsDuplicate: (id: string) => ipcRenderer.invoke(IpcChannel.agentsDuplicate, id),
  agentsRemove: (id: string) => ipcRenderer.invoke(IpcChannel.agentsRemove, id),
  liveEvents: (runId: string) => ipcRenderer.invoke(IpcChannel.liveEvents, runId),
  onLiveEvents: (
    listener: (payload: { runId: string; events: ObservationEvent[] }) => void,
  ) => {
    const handler = (_event: unknown, payload: { runId: string; events: ObservationEvent[] }) =>
      listener(payload);
    ipcRenderer.on(LIVE_EVENTS_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIVE_EVENTS_CHANNEL, handler);
    };
  },
  onOpenSettings: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(OPEN_SETTINGS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(OPEN_SETTINGS_CHANNEL, handler);
  },
  onSaveWorkflow: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(SAVE_WORKFLOW_CHANNEL, handler);
    return () => ipcRenderer.removeListener(SAVE_WORKFLOW_CHANNEL, handler);
  },
  onLiveSnapshot: (listener: (snapshot: LiveSnapshot) => void) => {
    const handler = (_event: unknown, snapshot: LiveSnapshot) => listener(snapshot);
    ipcRenderer.on(LIVE_SNAPSHOT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(LIVE_SNAPSHOT_CHANNEL, handler);
    };
  },
  liveSetupStatus: () => ipcRenderer.invoke(IpcChannel.liveSetupStatus),
  liveSetupDismiss: () => ipcRenderer.invoke(IpcChannel.liveSetupDismiss),
  liveSetupInstall: (harness: MarkerCli) =>
    ipcRenderer.invoke(IpcChannel.liveSetupInstall, harness),
  liveSetupDisable: (harness: MarkerCli) =>
    ipcRenderer.invoke(IpcChannel.liveSetupDisable, harness),
  onRunEvent: (listener: (event: RunEvent) => void) => {
    const handler = (_event: unknown, payload: RunEvent) => listener(payload);
    ipcRenderer.on(RUN_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(RUN_EVENT_CHANNEL, handler);
    };
  },
};

/**
 * The application itself never zooms.
 *
 * A pinch over the canvas zooms the workflow; a pinch anywhere else should do
 * nothing at all. The canvas already calls `preventDefault` on its own
 * gestures, but that only covers the element it listens on — this closes the
 * rest of the window, including the pinch-to-zoom Chromium would otherwise
 * apply to the whole page and the accidental ⌘-scroll that goes with it.
 *
 * Text scaling is a legitimate accessibility need and belongs to the operating
 * system's display settings, not to a gesture that also means "zoom this
 * diagram" two hundred pixels away.
 */
webFrame.setVisualZoomLevelLimits(1, 1);

contextBridge.exposeInMainWorld("anthill", api);
