/**
 * Redacting what looks like a credential, wherever Anthill keeps a value.
 *
 * Its own module so that what the hooks keep (hook-payload.ts) and what a
 * tool card names (tool-target.ts) redact by one definition (ANT-301).
 */

/**
 * Values that look like credentials, whatever they are attached to.
 *
 * Two kinds, kept apart because they redact differently. A *named* value —
 * `--token=x`, `PASSWORD=x` — keeps its name, because "the command set
 * AWS_SECRET_ACCESS_KEY" is useful and "the command set something" is not. A
 * *recognisable* value is the secret itself, so the whole match goes; an
 * earlier version tried to infer which was which from the capture group and
 * put vendor keys straight back into the output.
 */
const NAMED_SECRET: readonly RegExp[] = [
  /\b([A-Za-z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|credential|auth)[A-Za-z0-9_-]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
];

const RECOGNISABLE_SECRET: readonly RegExp[] = [
  // Vendor-shaped keys, which need no name beside them to be recognised.
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{30,})/g,
  // An authorization header. The scheme word is matched explicitly: with a
  // bare `\S+` after the colon, `Authorization: Bearer eyJ…` consumed the word
  // "Bearer" and left the token itself in the output.
  /\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*(?:(?:Bearer|Basic|Token|Digest)\s+)?\S+/gi,
  // And the scheme on its own, which is how it usually appears in a command.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Anything shaped like a private key block.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Replace anything that looks like a credential.
 *
 * Exported because the same text is redacted on the way in and checked on the
 * way out; one definition means the two cannot disagree.
 */
export function redactSecrets(value: string): string {
  let out = value;
  // Recognisable values first. `Authorization` contains "auth", so the named
  // rule below matches it and takes only the next token — which for
  // `Authorization: Bearer eyJ…` is the word "Bearer", leaving the token
  // itself behind. Consuming the whole header first avoids that.
  for (const pattern of RECOGNISABLE_SECRET) out = out.replace(pattern, "[redacted]");
  for (const pattern of NAMED_SECRET) {
    out = out.replace(pattern, (_match, name: string) => `${name}=[redacted]`);
  }
  return out;
}
