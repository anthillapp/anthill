/**
 * VS Code's agents, before Anthill reads their sessions.
 *
 * VS Code writes each chat session to
 * `<user data>/User/workspaceStorage/<hash>/chatSessions/<id>.jsonl`, an
 * operation log of its own that VS Code itself calls unstable. Reading it is
 * the next step (ANT-255); until then this observer reads nothing and claims
 * nothing. A run handed over from VS Code still moves: the plugin reports
 * every step through `anthill step`, which the CLI report channel follows
 * whatever the harness.
 *
 * So the capability says plainly what is and is not watched, and a poll is
 * empty — which the contract reads as "nothing new", never as "nothing there".
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PendingRun } from "@anthill/live";

import type { LiveSessionObserver, ObserverCapabilities, PollResult } from "./types.js";

/** Where VS Code keeps its per-workspace storage on this platform. */
export function vscodeWorkspaceStorage(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  const user =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Code", "User")
      : platform === "win32"
        ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User")
        : join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Code", "User");
  return join(user, "workspaceStorage");
}

export class VSCodeObserver implements LiveSessionObserver {
  readonly cli = "vscode" as const;

  constructor(private readonly root: string = vscodeWorkspaceStorage()) {}

  async detectCapabilities(): Promise<ObserverCapabilities> {
    const available = await stat(this.root).then(
      (info) => info.isDirectory(),
      () => false,
    );
    return {
      cli: this.cli,
      available,
      root: this.root,
      note: "Anthill does not read VS Code's chat sessions yet. A run handed over from VS Code shows the steps its agent reports, and nothing between them.",
      reportsCompletion: false,
      reportsFailure: false,
    };
  }

  forget(_runId: string): void {
    // Nothing is read, so nothing is remembered.
  }

  async poll(_run: PendingRun, _now: string): Promise<PollResult> {
    return { evidence: [], events: [] };
  }
}
