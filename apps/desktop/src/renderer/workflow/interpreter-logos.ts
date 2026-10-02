/**
 * The official marks for the CLIs Anthill can ask to draft a workflow.
 *
 * Imported as assets rather than redrawn as SVG paths: these are other
 * people's logos, and an approximation of someone's mark is worse than no
 * mark. Vite fingerprints and inlines them, so nothing is fetched at runtime —
 * the app makes no network requests of its own.
 *
 * `pi.svg` is the file Pi's own project publishes (`https://pi.dev/logo.svg`,
 * the one its README points at), an SVG rather than a raster because that is
 * the form its owner publishes it in. Its three paths are byte-identical to
 * that file; the one thing changed is the `viewBox`, tightened from the
 * published `0 0 800 800` to the artwork's own bounds. That crops transparent
 * margin and nothing else, and it is what lets the mark fill its box the way
 * the other two — square tiles with no margin of their own — fill theirs.
 * Without it Pi's mark renders about a fifth smaller than its neighbours and
 * reads as unfinished, which is the complaint this was fixing.
 *
 * Not every CLI has an official mark in this app. Where there is none, the
 * lookup returns a neutral placeholder — a plain disc, which is not an
 * approximation of anything — rather than a broken image or a redrawn mark.
 * Every CLI Anthill offers today has one; VS Code, a harness without a CLI of
 * its own here, has the placeholder until its mark is added the same way.
 */

import type { HarnessTarget } from "@anthill/workflow-schema";

import claudeCode from "../assets/claude-code.webp";
import codex from "../assets/codex.webp";
import pi from "../assets/pi.svg";

export const INTERPRETER_LOGOS: Partial<Record<HarnessTarget, string>> = {
  "claude-code": claudeCode,
  codex,
  pi,
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
export function interpreterLogo(id: HarnessTarget): string {
  return INTERPRETER_LOGOS[id] ?? NO_MARK;
}

/**
 * The same mark, as a CSS `background-image` value.
 *
 * It exists because of a trap that only springs in a packaged build. A small
 * SVG is inlined by the bundler as a percent-encoded data URI, and that
 * encoding leaves single quotes in it (`viewBox='…'`) — which are illegal
 * inside an unquoted `url(...)`. A call site writing ``url(${interpreterLogo(id)})``
 * therefore produces a declaration the browser throws away, and no mark
 * appears. In development the same import is an ordinary file URL with no
 * quotes in it, so the bug is invisible until the app is built.
 *
 * Quoting here rather than at each call site means the next one cannot get it
 * wrong. Double quotes, with any of their own escaped, because the encodings
 * involved produce single quotes and never double ones.
 */
export function interpreterLogoBackground(id: HarnessTarget): string {
  return `url("${interpreterLogo(id).replace(/"/g, "%22")}")`;
}
