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

  /**
   * How many workflows have been handed to this window from outside it.
   *
   * A coding harness puts a workflow in front of the author without anybody
   * here clicking anything, and the workflow screen opens the file it was
   * given once, on arrival. Routing a second one at a screen that has already
   * done that would change the route and show the old document, so the count
   * is the screen's key and a handover mounts a new one. Whether there were
   * unsaved edits to lose was settled before the route arrived: main asked.
   */
  const [handedOver, setHandedOver] = useState(0);
  const openHandedOver = useCallback((path: string) => {
    setStart({ kind: "open", path });
    setHandedOver((count) => count + 1);
    // Settings takes the window, and a workflow opened underneath it would be
    // an answer of "yes, show me" that nothing visibly happened about. The
    // question of whether to interrupt was already put and already answered.
    setSettingsFrom(null);
  }, []);

  useEffect(() => window.anthill.onOpenWorkflow(openHandedOver), [openHandedOver]);

  /*
    A handover that arrived before this page existed is collected rather than
    pushed, because a message sent to a page that has not mounted reaches
    nobody — and a link followed from a cold start is exactly that case. Main
    hands it over once, so StrictMode's second run of this effect gets nothing.

    A main process older than this page has never heard of the channel and
    rejects, which is the one thing there is to do about it: there is no
    handover to collect from a process that cannot receive one.
  */
  useEffect(() => {
    void window.anthill
      .pendingWorkflowOpen()
      .then((path) => {
        if (path) openHandedOver(path);
      })
      .catch(() => undefined);
  }, [openHandedOver]);

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
    <WorkflowScreen
      key={handedOver}
      start={start}
      onExit={() => setStart(null)}
      onSettings={openSettings}
    />
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
