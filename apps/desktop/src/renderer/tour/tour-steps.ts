/**
 * The canvas tour's hints, and when the tour is due (ANT-141).
 *
 * Every hint names a place the reader can see — its visible label where it
 * has one — and says in one sentence what it is for and how to use it. Each
 * is anchored by `data-tour` on the real control; a hint whose control is not
 * there is skipped, never pointed at empty space.
 *
 * The last hint follows what the toolbar actually holds. A workflow made here
 * ends on **Prompt**; one a coding session handed over has no Prompt, and its
 * next step is **Save**, which is what that session is waiting for. Either
 * way the tour ends on the real next step and never on a control that is gone.
 */

export type TourStep = {
  anchor: string;
  title: string;
  text: string;
  /** For an anchor that stands for more than one control, copy per `data-tour-kind`. */
  kinds?: Record<string, { title: string; text: string }>;
};

export const CANVAS_TOUR: TourStep[] = [
  {
    anchor: "library",
    title: "Block library",
    text: "Blocks are steps. Click one, or drag it onto the canvas, to add it to the workflow.",
  },
  {
    anchor: "block",
    title: "Block",
    text: "A block is one step of the work. Click it to select it; to connect it, click a port on its edge, then the block it leads to.",
  },
  {
    anchor: "inspector",
    title: "Selected block",
    text: "The selected block's task, agent and outputs are edited here.",
  },
  {
    anchor: "lib-agents",
    title: "Agents",
    text: "Agents carry out the steps. Open this tab to edit a profile; a selected block's Assign field gives it one.",
  },
  {
    anchor: "describe",
    title: "Describe a change",
    text: "Or describe a change in words: an AI model in your coding tool proposes the edit, and nothing changes until you apply it.",
  },
  {
    anchor: "next-step",
    title: "Prompt",
    text: "When the workflow is ready, Prompt gives you the prompt that hands it to your coding agent.",
    kinds: {
      prompt: {
        title: "Prompt",
        text: "When the workflow is ready, Prompt gives you the prompt that hands it to your coding agent.",
      },
      save: {
        title: "Save",
        text: "When the workflow is ready, save it, then tell the coding session that handed it over to go.",
      },
    },
  },
];

/*
 * Due only once it has been asked for: finishing onboarding asks for it, and
 * Show tips asks again. A returning user — who met Anthill before there was a
 * tour — never has it asked for, so an update does not interrupt them.
 */
const DUE_KEY = "anthill.canvas-tour-due";

export function tourDue(): boolean {
  try {
    return window.localStorage.getItem(DUE_KEY) !== null;
  } catch {
    return false;
  }
}

export function askForTour(): void {
  try {
    window.localStorage.setItem(DUE_KEY, new Date().toISOString());
  } catch {
    // Without storage there is no tour to replay; nothing else depends on it.
  }
}

/** Finished or skipped: both count as seen. */
export function markTourSeen(): void {
  try {
    window.localStorage.removeItem(DUE_KEY);
  } catch {
    // The worst case is seeing it again.
  }
}
