/**
 * The launch window is where Anthill opens, and every route leaves from it.
 *
 * The Orchestrator card is gone: offering a finished mode and an unfinished one
 * as equal choices was never a real choice, and it pushed the thing people
 * actually come back for — their workflows — off the first screen.
 */

import { useCallback, useEffect, useState } from "react";
import type { PendingRun } from "@anthill/live";

import { HowItWorksScreen } from "./explain/HowItWorksScreen.js";
import { explainerDue, markExplainerSeen } from "./explain/first-run.js";
import { LaunchWindow } from "./LaunchWindow.js";
import { SettingsScreen } from "./settings/SettingsScreen.js";
import { WorkflowScreen } from "./workflow/WorkflowScreen.js";

type Start =
  | { kind: "templates" }
  | { kind: "prompt" }
  | { kind: "open"; path?: string; live?: PendingRun };

export function Root() {
  const [start, setStart] = useState<Start | null>(null);
  /**
   * The explainer is a screen at the launcher's own level, not a dialog over
   * it: it answers what the product is, which is a question you ask before
   * you are inside anything. It is also where a first start lands, so the
   * first thing a new author reads is the same thing the link shows later —
   * one explainer, not two that can drift apart.
   */
  const [explaining, setExplaining] = useState(() => explainerDue());
  /**
   * Settings is a screen, and it remembers where it came from.
   *
   * It was a modal over whatever was showing, which is what let a card nested
   * inside it own the page instead. As a screen it has somewhere to be — and
   * something to return to: you opened it from the middle of something, and
   * dropping you on the launch window afterwards would lose that.
   *
   * `null` means Settings is closed; otherwise it holds the screen to go back
   * to, which is why a closed Settings and one opened from the launcher are
   * different values.
   */
  const [settingsFrom, setSettingsFrom] = useState<"launch" | "workflow" | null>(null);
  const openSettings = useCallback(() => {
    setSettingsFrom((current) => current ?? (start ? "workflow" : "launch"));
  }, [start]);
  useEffect(() => window.anthill.onOpenSettings(openSettings), [openSettings]);

  const leaveExplainer = () => {
    markExplainerSeen();
    setExplaining(false);
  };

  const screen = explaining ? (
    <HowItWorksScreen
      onBack={leaveExplainer}
      onCreate={() => {
        leaveExplainer();
        setStart({ kind: "templates" });
      }}
    />
  ) : start ? (
    <WorkflowScreen start={start} onExit={() => setStart(null)} onSettings={openSettings} />
  ) : (
    <LaunchWindow
      onNewWorkflow={() => setStart({ kind: "templates" })}
      onFromPrompt={() => setStart({ kind: "prompt" })}
      onOpen={(path) => setStart({ kind: "open", ...(path ? { path } : {}) })}
      // A row Anthill is following opens straight onto its session: that is
      // what the author clicked it for.
      onOpenLive={(path, run) => setStart({ kind: "open", path, live: run })}
      onExplain={() => setExplaining(true)}
      onSettings={openSettings}
    />
  );

  /*
    The screen behind Settings is hidden, not unmounted.

    Settings is a screen and takes the window, but the thing it was opened
    from is a workflow someone is in the middle of — with edits that have not
    been saved and an undo history that only exists in that component. Swapping
    it out would throw both away for the sake of reading a preference.

    `display: contents` rather than a wrapper with layout of its own, so the
    screen's own flex chain reaches the root unchanged when it is showing.
  */
  return (
    <>
      <div style={{ display: settingsFrom ? "none" : "contents" }}>{screen}</div>
      {settingsFrom ? <SettingsScreen onLeave={() => setSettingsFrom(null)} /> : null}
    </>
  );
}

export default Root;
