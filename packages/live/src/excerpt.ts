/**
 * What an agent's own message may look like on the Live Session page.
 *
 * Anthill showed none of it, which was a defensible starting position and a bad
 * one to stay at: a feed of tool names alone cannot tell a session that is
 * working from one that is stuck asking a question nobody sees, and the reader
 * ends up going to the terminal to find out — at which point the page has
 * failed at the one thing it is for.
 *
 * So one line of what the agent said, and the line is built by removing things
 * rather than by choosing them:
 *
 * - the model's own reasoning never arrives here at all. `thinking` and
 *   `redacted_thinking` blocks are dropped by name in the observers, before
 *   this function is reached, and this function is only ever given text the
 *   agent addressed to the person watching;
 * - fenced code is dropped, and so are indented code lines. Code is the part
 *   of a message most likely to carry a key or a chunk of somebody's file, and
 *   the part least worth reading in a one-line summary — and pasted file
 *   content that never got a fence usually arrives indented;
 * - anything shaped like a credential is cut out of what remains: known token
 *   prefixes, key=value assignments whose key says secret, PEM blocks, JWTs,
 *   long runs of hex or base64. The shape is redacted, not the word — a
 *   sentence *about* a token survives, the token does not;
 * - the user's home directory is folded to `~`, so a path can be shown without
 *   naming the account it belongs to;
 * - the correlation markers are dropped, because they are Anthill's own
 *   plumbing and repeating them back is noise;
 * - what is left keeps its line breaks and is cut to a length that cannot
 *   accidentally become a transcript. The lines are the same lines either
 *   way: which lines survive is the privacy decision, and joining them with a
 *   newline rather than a space changes only whether the page can show a list
 *   as a list. Runs of blank lines collapse to one, so the cap still buys the
 *   same amount of actual content.
 *
 * Still not a *guarantee* — an agent can write a secret in prose no filter can
 * recognise. It is a hard limit on how much is kept plus the removal of every
 * secret-shaped thing Anthill knows how to see, and the page says exactly
 * that, rather than claiming more.
 */

import { withoutStepTags, type RunMarker } from "./marker.js";

/** As much of a message as Anthill will keep. The card clamps further to show. */
export const MESSAGE_EXCERPT_LIMIT = 600;

const FENCE = /^\s*(```|~~~)/;

/** A line that is code by indentation: four spaces or a tab deep. */
const INDENTED_CODE = /^(?: {4}|\t)/;

/**
 * Things shaped like credentials, replaced with `[redacted]` wherever they
 * appear in a kept line. Shapes, not words: the rule is that a token itself
 * never survives, however the sentence around it reads.
 */
const SECRET_SHAPES: RegExp[] = [
  // Known token prefixes: Anthropic/OpenAI, GitHub, Slack, AWS, Google.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // A JWT: three dot-joined base64url segments, the first spelling {"alg".
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // An assignment whose key admits what it is. The key survives; the value goes.
  /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?\b(\s*[:=]\s*)("[^"]+"|'[^']+'|\S+)/gi,
  // Authorization headers.
  /\b(bearer|basic)\s+[A-Za-z0-9+/_=.-]{16,}/gi,
  // PEM material, should a single line of it survive the fence rules.
  /-----BEGIN [A-Z ]+-----.*/g,
  // Long unbroken hex or base64: key material has this shape, prose does not.
  /\b[0-9a-fA-F]{32,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/** `/Users/<name>/...` and `/home/<name>/...` fold to `~`, unnaming the account. */
const HOME_DIR = /(?:\/Users|\/home)\/[^\s/]+/g;

function redact(line: string): string {
  let out = line.replace(HOME_DIR, "~");
  for (const shape of SECRET_SHAPES) out = out.replace(shape, (match, key?: string, sep?: string) =>
    // Assignment shapes keep their key so the sentence still reads.
    typeof key === "string" && typeof sep === "string" ? `${key}${sep}[redacted]` : "[redacted]",
  );
  return out;
}

/**
 * One line of a message, or nothing if there is nothing worth keeping.
 *
 * `marker` is passed so the run's own step announcements can be removed by
 * their exact text rather than by guessing at a shape.
 */
export function messageExcerpt(
  text: string,
  marker: Pick<RunMarker, "runId" | "nonce">,
): string | undefined {
  const kept: string[] = [];
  let inFence = false;

  // The step tag each message opens with is plumbing too (ANT-163).
  for (const raw of withoutStepTags(text).split("\n")) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Unfenced file content usually arrives indented; treat it as the code it is.
    if (INDENTED_CODE.test(raw)) continue;

    const line = redact(raw).trim();
    // A blank line is a paragraph break, and the only whitespace worth
    // keeping. Leading ones are trimmed off the whole result below.
    if (!line) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    // Anthill's own plumbing: the step markers it asked the agent to print,
    // and the marker block it put at the top of the prompt.
    if (line.includes(marker.runId) || line.includes(marker.nonce)) continue;
    if (line.startsWith("ANTHILL-STEP") || line.startsWith("anthill-")) continue;
    if (line === "<!--" || line === "-->") continue;

    kept.push(line);
  }

  const joined = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!joined) return undefined;
  return joined.length > MESSAGE_EXCERPT_LIMIT
    ? `${joined.slice(0, MESSAGE_EXCERPT_LIMIT).trimEnd()}…`
    : joined;
}
