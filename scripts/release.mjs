#!/usr/bin/env node
/**
 * The branch model's facts, computed rather than remembered (RELEASING.md).
 *
 *   npm run release -- status         where new work branches from, and whether stage is behind master
 *   npm run release -- gate           CI: may this pull request merge into master?
 *   npm run release -- landed <sha>   after a release or hotfix PR merged: is master that commit?
 *   npm run release -- released       release workflow: the tag a push to master releases, if any
 *
 * master is the stable channel: Linux and Windows build it from source, and a
 * plugin installed from GitHub runs the server committed there. The next
 * release collects in `stage`, one long-lived branch whose number is decided
 * only when the release is frozen. master receives only stage or a hotfix
 * branch, merged with a merge commit, and only the exact commit that was
 * verified. The merge makes a new commit; what has to match is its tree, and
 * `gate` checks that before the merge, `landed` after it.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/;
const STAGE = "stage";
const HOTFIX = /^hotfix\/[0-9A-Za-z._-]+$/;
const VERIFIED = /^Verified commit:\s*`?([0-9a-f]{40})`?\s*$/im;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
}

function has(rev) {
  return tryGit("cat-file", "-e", `${rev}^{commit}`) !== undefined;
}

function die(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return m ? m.slice(1).map(Number) : undefined;
}

function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function versionAt(rev) {
  const text = tryGit("show", `${rev}:package.json`);
  return text ? JSON.parse(text).version : undefined;
}

function tree(rev) {
  return git("rev-parse", `${rev}^{tree}`);
}

/**
 * What merging `rev` into master would give: "same" when the merge's tree is
 * exactly `rev`'s, "behind" when master holds changes `rev` lacks (a hotfix
 * not yet brought into stage), "conflict" when they cannot merge at all.
 */
function mergeIntoMaster(rev) {
  const merged = tryGit("merge-tree", "--write-tree", "origin/master", rev);
  if (merged === undefined) return "conflict";
  return merged.split("\n")[0] === tree(rev) ? "same" : "behind";
}

// ------------------------------------------------------------------ status

function status() {
  git("fetch", "--quiet", "origin", "+refs/heads/master:refs/remotes/origin/master");
  // Fails when stage does not exist yet, which is reported below.
  tryGit("fetch", "--quiet", "origin", `+refs/heads/${STAGE}:refs/remotes/origin/${STAGE}`);
  const stable = versionAt("origin/master");
  const tag = `v${stable}`;
  const tagTree = tryGit("rev-parse", `${tag}^{tree}`);
  const lines = [`master          ${stable}`];
  if (!tagTree) lines.push(`                tag ${tag} does not exist yet`);
  else if (tagTree === tree("origin/master")) lines.push(`                identical to ${tag}`);
  else lines.push(`                NOT identical to ${tag}: master holds changes no release verified`);

  if (!tryGit("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${STAGE}`)) {
    lines.push(`${STAGE}           none`, "", "Create it from master before branching anything:", `  git push origin origin/master:refs/heads/${STAGE}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  const version = versionAt(`origin/${STAGE}`);
  const frozen = compare(version, stable) > 0;
  lines.push(
    `${STAGE}           ${frozen ? `frozen at ${version}: only fixes for this release` : "open: features and fixes"}`,
    `                tip ${git("rev-parse", `origin/${STAGE}`)}`,
  );
  const merge = mergeIntoMaster(`origin/${STAGE}`);
  if (merge !== "same") {
    lines.push(
      "",
      `WARNING: master holds changes ${STAGE} lacks (a hotfix)${merge === "conflict" ? ", and they conflict" : ""}.`,
      "Bring master into it with a merge commit (RELEASING.md, Hotfixes, step 4):",
      merge === "conflict"
        ? `  git switch -c sync/${stable} origin/${STAGE} && git merge origin/master   # then a PR into ${STAGE}`
        : `  gh pr create --base ${STAGE} --head master --title "chore: bring ${tag} into ${STAGE}"`,
    );
  }
  lines.push("", `New work:  git switch -c <branch> origin/${STAGE}`, `PR base:   ${STAGE}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

// -------------------------------------------------------------------- gate

/**
 * Run by .github/workflows/release-gate.yml on every pull request into master.
 * A pull request into master must come from this repository's `stage` or
 * `hotfix/<name>` branch, carry a higher version than master, name the
 * verified commit in its description, and merge into exactly that commit's
 * tree.
 */
function gate() {
  const { BASE_REF, HEAD_REF, HEAD_SHA, HEAD_REPO, BASE_REPO, PR_BODY = "" } = process.env;
  if (!BASE_REF || !HEAD_REF || !HEAD_SHA) die("gate needs BASE_REF, HEAD_REF and HEAD_SHA");
  if (BASE_REF !== "master") {
    process.stdout.write(`Base is ${BASE_REF}, not master: nothing to gate.\n`);
    return;
  }
  const problems = [];
  const fromFork = HEAD_REPO && BASE_REPO && HEAD_REPO !== BASE_REPO;
  if (fromFork || !(HEAD_REF === STAGE || HOTFIX.test(HEAD_REF))) {
    die(
      `${fromFork ? `${HEAD_REPO}:` : ""}${HEAD_REF} cannot merge into master.\n` +
        `master receives only the ${STAGE} branch and hotfix/<name> branches of this repository.\n` +
        `Retarget this pull request to ${STAGE} (RELEASING.md).`,
    );
  }

  git("fetch", "--quiet", "--no-tags", "origin", "+refs/heads/master:refs/remotes/origin/master");
  if (!has(HEAD_SHA)) git("fetch", "--quiet", "--no-tags", "origin", HEAD_SHA);
  const stable = versionAt("origin/master");
  const version = versionAt(HEAD_SHA);
  if (!parse(version) || compare(version, stable) <= 0) {
    problems.push(`The version (${version}) must be higher than master's (${stable}): freeze the branch first (npm run version:set -- <version>).`);
  }

  const verified = VERIFIED.exec(PR_BODY)?.[1];
  if (!verified) {
    problems.push("The description has no `Verified commit: <40-character sha>` line.");
  } else if (verified !== HEAD_SHA) {
    problems.push(`The verified commit is ${verified}, but the branch is at ${HEAD_SHA}. A change after verification is verified again (RELEASING.md).`);
  }

  const merge = mergeIntoMaster(HEAD_SHA);
  if (merge === "conflict") {
    problems.push(`${HEAD_REF} conflicts with master. Bring master's changes into the branch through a pull request, then verify the result.`);
  } else if (merge === "behind") {
    problems.push(
      `master holds changes ${HEAD_REF} does not (a hotfix not yet in ${STAGE}, or a hotfix branch behind master). ` +
        "The merge would ship a tree nobody verified: bring them into the branch through a pull request, then verify the result.",
    );
  }

  if (problems.length) die(problems.join("\n"));
  process.stdout.write(`${HEAD_REF} ${version}: merging it into master gives exactly the tree of ${HEAD_SHA}.\n`);
}

// ------------------------------------------------------------------ landed

function landed(sha) {
  if (!SHA.test(sha ?? "")) die("usage: npm run release -- landed <verified 40-character sha>");
  git("fetch", "--quiet", "--tags", "origin", "+refs/heads/master:refs/remotes/origin/master");
  const head = git("rev-parse", "origin/master");
  if (!has(sha)) die(`${sha} is not in this clone; fetch the release branch first.`);
  if (tree(head) !== tree(sha)) die(`master (${head}) is not the verified commit's tree. Find what differs: git diff ${sha} ${head}`);
  const version = versionAt(head);
  const tag = `v${version}`;
  const tagged = tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`);
  process.stdout.write(
    `master ${head} is the verified commit's tree, version ${version}.\n\n` +
      (tagged === head
        ? `${tag} is on it: the Release workflow has published it.\n`
        : `The Release workflow tags it ${tag} and publishes the macOS build. Follow it:\n  gh run list --workflow release.yml --branch master --limit 1\n`),
  );
}

// ---------------------------------------------------------------- released

/**
 * Run by the release workflow: the tag a push to master releases, written to
 * GITHUB_OUTPUT as `tag=` (empty when it releases nothing).
 *
 * master receives only a verified release or a hotfix, each with a version
 * higher than the last release, so a push whose version has no tag yet is a
 * release, and the workflow tags that commit and publishes it. A push whose
 * version is already tagged releases nothing. One whose version is lower than
 * a released one is refused: something reached master that the gate should
 * have stopped.
 */
function released() {
  const { GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_OUTPUT } = process.env;
  const answer = (tag, why) => {
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `tag=${tag}\n`);
    process.stdout.write(`${why}\n`);
  };
  if (GITHUB_EVENT_NAME !== "push" || GITHUB_REF !== "refs/heads/master") {
    answer("", `${GITHUB_EVENT_NAME ?? "No event"} on ${GITHUB_REF || "no ref"} is not a push to master: nothing to release.`);
    return;
  }
  git("fetch", "--quiet", "--tags", "--force", "origin");
  const version = versionAt("HEAD");
  if (!parse(version)) die(`package.json's version ${version} is not X.Y.Z.`);
  const tag = `v${version}`;
  if (tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`)) {
    answer("", `${tag} is already released: nothing to publish.`);
    return;
  }
  const newer = git("tag", "--list", "v*")
    .split("\n")
    .map((name) => name.slice(1))
    .filter((v) => parse(v) && compare(v, version) > 0);
  if (newer.length) die(`master is at ${version}, but v${newer.join(", v")} was already released. Nothing is published.`);
  answer(tag, `${tag} is a new release: tagging this commit and publishing it.`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "status":
    status();
    break;
  case "gate":
    gate();
    break;
  case "landed":
    landed(rest[0]);
    break;
  case "released":
    released();
    break;
  default:
    die("usage: npm run release -- status | gate | landed <sha> | released");
}
