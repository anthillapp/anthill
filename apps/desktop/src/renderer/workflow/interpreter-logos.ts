/**
 * The official marks for the CLIs Anthill can ask to draft a workflow.
 *
 * Imported as assets rather than redrawn as SVG paths: these are other
 * people's logos, and an approximation of someone's mark is worse than no
 * mark. Vite fingerprints and inlines them, so nothing is fetched at runtime —
 * the app makes no network requests of its own.
 *
 * Not every CLI has an official mark in this app. Where there is none, the
 * lookup returns a neutral placeholder — a plain disc, which is not an
 * approximation of anything — rather than a broken image or a redrawn mark.
 */

import type { InterpreterId } from "@anthill/workflow";

import claudeCode from "../assets/claude-code.webp";
import codex from "../assets/codex.webp";

export const INTERPRETER_LOGOS: Partial<Record<InterpreterId, string>> = {
  "claude-code": claudeCode,
  codex,
};

/**
 * A neutral placeholder for a CLI without an official mark in this app.
 *
 * A plain disc, deliberately not a letter and not a shape: it says "no mark
 * here", and nothing about what the mark would be.
 */
const NO_MARK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#9aa0a6"/></svg>',
  );

/**
 * The mark for a CLI, or the neutral placeholder where there is none.
 *
 * Always a string, so a caller can put it in an `src` or a `background-image`
 * without a branch.
 */
export function interpreterLogo(id: InterpreterId): string {
  return INTERPRETER_LOGOS[id] ?? NO_MARK;
}
