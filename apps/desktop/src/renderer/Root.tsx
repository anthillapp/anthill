/**
 * The launch window is where Anthill opens, and every route leaves from it.
 *
 * The Orchestrator card is gone: offering a finished mode and an unfinished one
 * as equal choices was never a real choice, and it pushed the thing people
 * actually come back for — their workflows — off the first screen.
 */

import { useState } from "react";
import type { PendingRun } from "@anthill/live";

import { HowItWorksScreen } from "./explain/HowItWorksScreen.js";
import { explainerDue, markExplainerSeen } from "./explain/first-run.js";
import { LaunchWindow } from "./LaunchWindow.js";
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

  const leaveExplainer = () => {
    markExplainerSeen();
    setExplaining(false);
  };

  if (explaining) {
    return (
      <HowItWorksScreen
        onBack={leaveExplainer}
        onCreate={() => {
          leaveExplainer();
          setStart({ kind: "templates" });
        }}
      />
    );
  }

  if (start) {
    return (
      <WorkflowScreen
        start={start}
        onExit={() => setStart(null)}
      />
    );
  }

  return (
    <LaunchWindow
      onNewWorkflow={() => setStart({ kind: "templates" })}
      onFromPrompt={() => setStart({ kind: "prompt" })}
      onOpen={(path) => setStart({ kind: "open", ...(path ? { path } : {}) })}
      // A row Anthill is following opens straight onto its session: that is
      // what the author clicked it for.
      onOpenLive={(path, run) => setStart({ kind: "open", path, live: run })}
      onExplain={() => setExplaining(true)}
    />
  );
}

export default Root;
