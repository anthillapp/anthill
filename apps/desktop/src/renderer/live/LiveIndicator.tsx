/**
 * The header's one claim about what is happening outside Anthill.
 *
 * There is no button here that does anything to the user's session, because
 * Anthill cannot: it did not start the agent and holds no connection to it. The
 * indicator reports what Anthill has found on this machine, and the only action
 * it offers is to stop Anthill's own observation.
 *
 * The states are drawn apart deliberately. A confident match pulses red; a
 * match Anthill is unsure of never does, and says so in words as well —
 * "Ambiguous session" is a different thing from "Live session", and the
 * moment those two look alike the indicator has started lying.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CLI_LABEL,
  statusLabel,
  type LiveSessionState,
  type PendingRun,
} from "@anthill/live";
import type { LiveSnapshot } from "../../shared/ipc.js";

import { interpreterLogo } from "../workflow/interpreter-logos.js";
import { relative, useNow } from "./elapsed.js";
import { PresenceChip } from "./PresenceChip.js";
import { mostRelevant, presenceKey, runsFor } from "./presence.js";

/** How each state is drawn, and whether it may claim a live match. */
const TONE: Record<LiveSessionState, "waiting" | "live" | "unsure" | "done" | "bad" | "none"> = {
  idle: "none",
  pending_after_copy: "waiting",
  detected_live: "live",
  ambiguous_match: "unsure",
  observation_lost: "unsure",
  completed: "done",
  failed: "bad",
};

export type LiveIndicatorProps = {
  /**
   * The workflow this indicator sits on. Only runs started from it are shown:
   * a chip on a canvas is a claim about the canvas it is on.
   */
  workflowId?: string;
  /**
   * Called instead of opening the popover when there is a session to look at.
   *
   * A live session navigates, and so does one that finished: the CLI recorded
   * that the turn ended, the journal holds the whole run, and the page settles
   * the last announced step rather than leaving it running. What does not
   * navigate is `observation_lost`, `ambiguous_match` and `failed` — those are
   * statements about what Anthill does *not* know, and a page built for a
   * session it is following would have nothing honest to put on them.
   */
  onOpenSession?: (
    run: PendingRun,
    capability?: { available: boolean; note: string },
  ) => void;
};

export function LiveIndicator({ workflowId, onOpenSession }: LiveIndicatorProps = {}) {
  const now = useNow();
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  /** Set when observation cannot be reached at all, rather than being idle. */
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  /**
   * Where to draw the popover, in viewport coordinates.
   *
   * It has to leave the header to be drawn at all: the top bar clips its
   * overflow, so a popover positioned inside it is trimmed to the bar's own
   * height. Portalled to the body and anchored to the chip instead.
   */
  const [spot, setSpot] = useState<{ top: number; right: number } | null>(null);

  const place = useCallback(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (box) setSpot({ top: box.bottom + 8, right: window.innerWidth - box.right });
  }, []);

  useEffect(() => {
    let live = true;

    window.anthill
      .liveSnapshot()
      .then((next) => {
        if (live) setSnapshot(next);
      })
      .catch(() => {
        // A rejection here means the running process does not serve this
        // channel. Swallowing it is what made the whole feature look absent
        // rather than broken, so it becomes a state the chip can show.
        if (live) setBroken(true);
      });

    let off: (() => void) | undefined;
    try {
      off = window.anthill.onLiveSnapshot(setSnapshot);
    } catch {
      if (live) setBroken(true);
    }

    return () => {
      live = false;
      off?.();
    };
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.current?.contains(target) || popover.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const runs = snapshot?.runs ?? [];
  const mine = runsFor(runs, workflowId);
  const run = mostRelevant(mine);

  // Being unable to ask is not the same as there being nothing to show, and
  // the header is the only place a user would ever find out.
  if (broken) {
    return (
      <div className="live-indicator" ref={anchor}>
        <button className="live-chip tone-bad" onClick={() => setOpen((current) => !current)}>
          <span className="live-dot tone-unsure" aria-hidden="true" />
          <span className="live-chip-label">Live session unavailable</span>
        </button>
        {open ? (
          <div className="live-popover" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0 }}>
            <p className="live-pop-note">
              Anthill cannot reach its own observation service, so it cannot say whether a
              session is running. Quit Anthill and open it again.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  if (!run) return null;

  if (snapshot?.storageError) return (
    <div className="live-indicator" role="alert" title={snapshot.storageError}>
      <span className="live-chip tone-bad">Activity not saved. Retrying.</span>
    </div>
  );

  const tone = TONE[run.state];
  /** Live splits into receiving and quiet, which the raw state cannot say. */
  const presence = presenceKey(run, now);
  /** Whether there is a session page worth opening for this run. */
  const readable = (tone === "live" || tone === "done") && onOpenSession !== undefined;
  const capability = snapshot?.capabilities.find((item) => item.cli === run.selectedCli);

  return (
    <div className="live-indicator" ref={anchor}>
      <PresenceChip
        run={run}
        presence={presence}
        title={readable ? "Open the session view" : run.statusMessage}
        onClick={() => {
          if (readable && onOpenSession) {
            const capability = snapshot?.capabilities.find(
              (item) => item.cli === run.selectedCli,
            );
            onOpenSession(
              run,
              capability ? { available: capability.available, note: capability.note } : undefined,
            );
          }
          else setOpen((current) => !current);
        }}
      />
      {/* How many runs are open at all. Dropping this would hide from the
          author that the chip is speaking for only one of several. */}
      {mine.length > 1 ? <span className="live-count">{mine.length}</span> : null}

      {open && spot
        ? createPortal(
            <div className="live-popover" ref={popover} style={{ top: spot.top, right: spot.right }}>
          <header>
            <img src={interpreterLogo(run.selectedCli)} alt="" width={16} height={16} />
            <strong>{statusLabel(run)}</strong>
          </header>

          <p className="live-pop-note">{run.statusMessage}</p>

          <dl>
            <dt>Workflow</dt>
            <dd>{run.workflowName ?? "—"}</dd>
            <dt>Anthill run</dt>
            <dd>
              <code>{run.anthillRunId}</code>
            </dd>
            <dt>Session</dt>
            <dd>
              {run.detectedSessionId ? (
                <code>{run.detectedSessionId}</code>
              ) : (
                <span className="quiet">not identified yet</span>
              )}
            </dd>
            <dt>Evidence</dt>
            <dd>
              {run.evidenceChannel ? (
                <>
                  <code>{run.evidenceChannel}</code>
                  {run.confidence ? <span className={`conf conf-${run.confidence}`}>{run.confidence}</span> : null}
                </>
              ) : (
                <span className="quiet">none yet</span>
              )}
            </dd>
            <dt>Last seen</dt>
            <dd>{relative(run.lastObservedAt, now)}</dd>
          </dl>

          {capability && !capability.available ? (
            <p className="live-pop-note warn">{capability.note}</p>
          ) : null}

          <p className="live-pop-foot">
            Anthill is not running this session. It only reads the records{" "}
            {CLI_LABEL[run.selectedCli]} writes on this machine, and never the model's private
            reasoning.
          </p>

              <div className="live-pop-actions">
                {run.state === "completed" || run.state === "failed" ? (
                  <button
                    onClick={() => void window.anthill.liveDismiss(run.anthillRunId).then(setSnapshot)}
                  >
                    Dismiss
                  </button>
                ) : (
                  <button
                    onClick={() => void window.anthill.liveCancel(run.anthillRunId).then(setSnapshot)}
                    title="Only Anthill stops observing this workflow. Your Codex or Claude Code session continues unchanged."
                  >
                    Stop observing in Anthill
                  </button>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
