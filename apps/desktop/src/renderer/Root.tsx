/**
 * The launch window is where Anthill opens, and every route leaves from it.
 *
 * The Orchestrator card is gone: offering a finished mode and an unfinished one
 * as equal choices was never a real choice, and it pushed the thing people
 * actually come back for — their workflows — off the first screen.
 *
 * The one exception to "every route leaves from it" is the very first start,
 * which lands on onboarding and arrives here when that is finished.
 */

import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import type { PendingRun } from "@anthill/live";

import { HowItWorksScreen } from "./explain/HowItWorksScreen.js";
import { FromSessionScreen } from "./handoff/FromSessionScreen.js";
import { markOnboardingSeen, onboardingDue } from "./explain/first-run.js";
import { Onboarding } from "./onboarding/Onboarding.js";
import { askForLaunchTour, askForTour } from "./tour/tour-steps.js";
import { LaunchWindow } from "./LaunchWindow.js";
import { SettingsScreen, type PageId } from "./settings/SettingsScreen.js";
import { WorkflowScreen } from "./workflow/WorkflowScreen.js";
import { UnsupportedWindowsProvider } from "./windows/unsupported-windows.js";
import { WindowsGate } from "./windows/WindowsGate.js";

type Start =
  | { kind: "templates" }
  | { kind: "prompt" }
  | { kind: "open"; path?: string; live?: PendingRun; deliveryId?: number };

export function Root() {
  const [start, setStart] = useState<Start | null>(null);
  /**
   * The explainer is a screen at the launcher's own level, not a dialog over
   * it: it answers what the product is, which is a question you ask before
   * you are inside anything. It opens from its link; a first start lands on
   * onboarding instead (ANT-140).
   */
  const [explaining, setExplaining] = useState(false);
  /**
   * Onboarding: shown once, on the first start, and again from Welcome tour.
   * Finishing it — from either page — goes to the launch window, which for a
   * machine with no workflows is the first-run card.
   */
  const [onboarding, setOnboarding] = useState(() => onboardingDue());
  /**
   * "From a coding session" — a screen at the launcher's level, like the
   * explainer, because it is reached from both and returns to the launcher.
   */
  const [fromSession, setFromSession] = useState(false);
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
  /** The page Settings opens on, when it was asked for about one thing. */
  const [settingsPage, setSettingsPage] = useState<PageId | undefined>();
  const openSettings = useCallback(() => {
    setSettingsPage(undefined);
    setSettingsFrom((current) => current ?? (start ? "workflow" : "launch"));
  }, [start]);
  const openPluginSettings = useCallback(() => {
    setSettingsPage("plugins");
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
   * is the screen's key and a handover mounts a new one. Consent is checked
   * here, against the document present when the message actually arrives.
   */
  const [handedOver, setHandedOver] = useState(0);
  const openHandedOver = useCallback((path: string, deliveryId?: number) => {
    const dirty = (window as unknown as Record<string, unknown>).__anthillWorkflowDirty === true;
    if (dirty) {
      // The acknowledgement timeout measures a page opening, not the time a
      // person needs to decide. Neither phase reports the document as shown.
      void window.anthill.workflowOpened(path, deliveryId, "confirming");
      if (!window.confirm("This workflow has unsaved changes.\n\nOpening the handed-over workflow discards everything since the last save.")) {
        void window.anthill.workflowOpened(path, deliveryId, "declined");
        return;
      }
      void window.anthill.workflowOpened(path, deliveryId, "opening");
    }
    // No await or deferred render between permission and replacement: a new
    // edit must not sneak into the document the user just agreed to discard.
    flushSync(() => {
      setStart({ kind: "open", path, deliveryId });
      setHandedOver((count) => count + 1);
      setSettingsFrom(null);
      setExplaining(false);
      setFromSession(false);
      // A workflow handed over mid-onboarding means the plugin already works;
      // the tour has nothing left to say, now or on the next start.
      setOnboarding((showing) => {
        if (showing) markOnboardingSeen();
        return false;
      });
    });
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

  const leaveExplainer = () => setExplaining(false);

  const finishOnboarding = () => {
    markOnboardingSeen();
    // The tour follows onboarding: its launch-screen part on the screen this
    // opens onto (ANT-144), its canvas part on the first workflow opened
    // after it (ANT-141). Asked for here, so someone who met Anthill before
    // the tour existed is never interrupted by it.
    askForLaunchTour();
    askForTour();
    setOnboarding(false);
  };

  const screen = onboarding ? (
    <Onboarding onFinish={finishOnboarding} onSettings={openPluginSettings} />
  ) : fromSession ? (
    <FromSessionScreen onBack={() => setFromSession(false)} onSettings={openPluginSettings} />
  ) : explaining ? (
    <HowItWorksScreen
      onBack={leaveExplainer}
      onCreate={() => {
        leaveExplainer();
        setStart({ kind: "templates" });
      }}
      onFromSession={() => {
        leaveExplainer();
        setFromSession(true);
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
      onFromSession={() => setFromSession(true)}
      onWelcomeTour={() => setOnboarding(true)}
      // The launch window replays its own part of the tour on the spot; the
      // canvas part is asked for here and plays on the next workflow opened.
      // Show tips no longer carries the author off into whatever they had open
      // last — they asked about the screen they are on (ANT-144).
      onShowTips={askForTour}
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
    <UnsupportedWindowsProvider>
      <div style={{ display: settingsFrom ? "none" : "contents" }}>{screen}</div>
      {settingsFrom ? (
        <SettingsScreen
          onLeave={() => setSettingsFrom(null)}
          {...(settingsPage ? { initialPage: settingsPage } : {})}
        />
      ) : null}
      {/* Over whatever screen opened first, once per version, on Windows only. */}
      <WindowsGate />
    </UnsupportedWindowsProvider>
  );
}

export default Root;
