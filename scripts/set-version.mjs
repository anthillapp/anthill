#!/usr/bin/env node
/**
 * Set Anthill's version everywhere it is written, at once.
 *
 * `npm run version:set -- 0.7.9`
 *
 * A release used to move the version by hand, and hands missed places: the
 * marketplace entry sat at 0.7.0 from its first day while the plugin manifest
 * beside it reached 0.7.6, and the skill's own frontmatter stopped at 0.7.3
 * (ANT-120). `claude plugin tag` already calls a plugin.json that disagrees
 * with its marketplace entry an error. This writes every one of them from the
 * same argument, and `apps/mcp/src/versions.test.ts` fails if any drifts.
 *
 * What it writes:
 *   - `version` in the root package.json and every workspace's package.json
 *     (they depend on each other by `*`, so nothing else refers to it);
 *   - the Claude Code plugin manifest and its marketplace entry;
 *   - the Claude Code skill's frontmatter `version:`;
 *   - the Codex plugin manifest, as `<version>+codex.<UTC timestamp>` — the
 *     build suffix is what makes Codex treat a reinstall as new, so a fresh
 *     one is minted each time.
 *
 * It does not touch package-lock.json; run `npm install` afterwards.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.trim();

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  process.stderr.write("usage: npm run version:set -- <major.minor.patch>\n");
  process.exit(2);
}

const changed = [];

/**
 * Replace the one `"version": "…"` a file carries, in place.
 *
 * In place rather than parsed and re-serialised: the files keep their own
 * layout, so a version bump is a one-line diff in each and nothing else. Each
 * of these files has exactly one `version` key — a second would be a file this
 * script does not understand, and it stops rather than guesses.
 */
function setVersion(path, next) {
  const full = join(ROOT, path);
  const text = readFileSync(full, "utf8");
  const found = text.match(/"version":\s*"([^"]*)"/g) ?? [];
  if (found.length !== 1) {
    process.stderr.write(`${path} has ${found.length} "version" keys; expected exactly one\n`);
    process.exit(1);
  }
  const current = /"version":\s*"([^"]*)"/.exec(text)[1];
  const value = typeof next === "function" ? next(current) : next;
  if (value === current) return;
  writeFileSync(full, text.replace(/("version":\s*")[^"]*(")/, `$1${value}$2`));
  changed.push(path);
}

const packages = ["package.json"];
for (const group of ["apps", "packages"]) {
  for (const name of readdirSync(join(ROOT, group))) {
    const path = join(group, name, "package.json");
    if (existsSync(join(ROOT, path))) packages.push(path);
  }
}
for (const path of packages) setVersion(path, version);

setVersion("plugins/anthill-claude/.claude-plugin/plugin.json", version);
setVersion(".claude-plugin/marketplace.json", version);

// A new build suffix only when the version itself moved: re-running the
// script for the same version is then a no-op, as it is everywhere else.
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
setVersion("plugins/anthill-codex/.codex-plugin/plugin.json", (current) =>
  current.split("+")[0] === version ? current : `${version}+codex.${stamp}`,
);

const skill = "plugins/anthill-claude/skills/workflow/SKILL.md";
const text = readFileSync(join(ROOT, skill), "utf8");
if (!/^version:/m.test(text)) {
  process.stderr.write(`${skill} has no version: line in its frontmatter\n`);
  process.exit(1);
}
const next = text.replace(/^version:\s*.*$/m, `version: ${version}`);
if (next !== text) {
  writeFileSync(join(ROOT, skill), next);
  changed.push(skill);
}

process.stdout.write(
  changed.length === 0
    ? `Everything already says ${version}.\n`
    : `Set ${version} in ${changed.length} file(s): ${changed.join(", ")}.\nRun npm install to update package-lock.json.\n`,
);
