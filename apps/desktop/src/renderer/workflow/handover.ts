/**
 * What a handed-over workflow's toolbar and notice card say, worked out once.
 *
 * Two surfaces read this — the pill and the floating notice — and they
 * contradicted each other the last time each worked it out for itself: a
 * toolbar reading "No problems" beside a red problem chip on the canvas. So
 * the whole state is derived here, from the exchange's own answer plus the one
 * thing only the editor knows (whether the last automatic save landed), and
 * the components render what they are handed.
 *
 * There was a third surface: a `Ready for agent` button, and a model of when
 * it could be pressed. It is gone. It claimed to hold work back and could not
 * — nothing here has a hook on anybody's repository, so withholding a revision
 * withheld the run record and not the work — while reliably producing a
 * workflow the user had edited and could not hand over without a second,
 * separate act. What decides whether work starts is the user's answer in the
 * conversation.
 *
 * Nothing here decides anything. Anthill watches a handover; it starts, stops
 * and steers no session, and no string below may suggest otherwise.
 */

import type { PendingRun } from "@anthill/live";
import type { ExchangeView } from "../../shared/ipc.js";

/**
 * The four states, which are not the three `describeState` names.
 *
 * `describeState` is the vocabulary shared with the MCP server, which reads it
 * out to the agent, and it knows nothing about observation — so its one `bound`
 * covers both "a run pinned this revision" and "that run is reporting
 * progress". Those are different claims and they are drawn apart, in words and
 * in colour, because a binding is never evidence a session is alive. The split
 * is made here rather than in `describeState` for that reason: adding liveness
 * to it would mix what the agent is told with what we have observed.
 */
export type HandoverTone = "bound" | "running";

export type HandoverPill = { label: string; tone: HandoverTone; title: string };

export type HandoverNoticeModel = {
  text: string;
  /** Red is only ever a save that did not land. A finished run is not a fault. */
  tone: "warning" | "error";
};

export type HandoverModel = {
  /**
   * What a session is doing with this workflow, when one is.
   *
   * Absent before any run, and that absence is the point. There were two more
   * states here — `Draft` and `Ready` — reporting whether the graph was fit to
   * hand over. The Save button says that now, by being blocked or not, and
   * says it where the user is about to act rather than in a badge they have to
   * read and interpret (ANT-116).
   *
   * What is left is not readiness. `Bound` and `Running` report a session,
   * which the button says nothing about and which cannot be learned any other
   * way.
   */
  pill?: HandoverPill;
  notice?: HandoverNoticeModel;
};

export type HandoverInput = {
  view: ExchangeView;
  /**
   * The problems that block a prompt, counted once for the whole screen.
   *
   * Passed in rather than recomputed: the pill, the canvas chips and the
   * inspector each derived their own count once, and they disagreed on screen
   * at the same time.
   */
  problemCount: number;
  /** What the last automatic save did not manage to write, if it failed. */
  saveError?: string;
  runs: PendingRun[];
};

function pillFor(input: HandoverInput): HandoverPill | undefined {
  const { view } = input;
  const bound = view.bindings[0];
  if (view.state !== "bound" || !bound) return undefined;

  /*
   * "Running" is earned by the session's own reports arriving, and by nothing
   * else. A binding is a revision being pinned, which happens before a session
   * has done anything at all — and often before one starts.
   */
  const live = input.runs.some(
    (run) => run.anthillRunId === bound.runId && run.state === "detected_live",
  );
  return live
    ? {
        label: `Running revision ${bound.revision}`,
        tone: "running",
        title: "The session's own progress reports are arriving.",
      }
    : {
        label: `Bound to revision ${bound.revision}`,
        tone: "bound",
        title: `A run pinned revision ${bound.revision}. Binding alone is not evidence that the external session is running.`,
      };
}

const SAVE_FAILED =
  "The last change was not saved, so what is on screen is not what a session would be given. " +
  "Nothing is lost from the canvas. Fix the reason below and it will be written again.";

function noticeFor(input: HandoverInput): HandoverNoticeModel | undefined {
  const { view } = input;

  /*
   * A save that did not land outranks everything else here.
   *
   * It is the one state where the canvas and the exchange disagree, and the
   * only one a person has to act on before anything they do has an effect. It
   * is also the only red in this feature.
   */
  if (input.saveError) {
    return { tone: "error", text: `${SAVE_FAILED} ${input.saveError}` };
  }

  /*
   * A run has already taken a copy of this graph.
   *
   * Editing is allowed and does nothing to that run: it froze its revision at
   * the moment it bound, and it keeps it. Saying so is the whole notice —
   * a reader who is not told will expect their change to reach the session,
   * and it never will.
   */
  const diverged = view.bindings.find((binding) => binding.revision !== view.revision);
  if (diverged) {
    return {
      tone: "warning",
      text:
        `A session is working from revision ${diverged.revision}; what is on your canvas is revision ${view.revision}. ` +
        "Editing did not change what that session is doing, and will not. Changes apply only to future sessions.",
    };
  }

  if (view.bindings.length > 0) {
    return {
      tone: "warning",
      text:
        "This workflow has already been run. The session that ran it keeps the graph it started from, " +
        "so changes here apply only to future sessions.",
    };
  }

  return undefined;
}

export function handoverModel(input: HandoverInput): HandoverModel {
  const pill = pillFor(input);
  const notice = noticeFor(input);
  return { ...(pill ? { pill } : {}), ...(notice ? { notice } : {}) };
}
