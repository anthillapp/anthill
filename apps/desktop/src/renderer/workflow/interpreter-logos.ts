/**
 * The official marks for the CLIs Anthill can ask to draft a workflow.
 *
 * Imported as assets rather than redrawn as SVG paths: these are other
 * people's logos, and an approximation of someone's mark is worse than no mark.
 * Vite fingerprints and inlines them, so nothing is fetched at runtime — the
 * app makes no network requests of its own.
 */

import type { InterpreterId } from "@anthill/workflow";

import claudeCode from "../assets/claude-code.webp";
import codex from "../assets/codex.webp";

export const INTERPRETER_LOGOS: Record<InterpreterId, string> = {
  "claude-code": claudeCode,
  codex,
};
