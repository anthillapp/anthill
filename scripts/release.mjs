#!/usr/bin/env node
/**
 * The branch model's facts, computed rather than remembered (RELEASING.md).
 *
 *   npm run release -- status         where new work branches from and which PRs go where
 *   npm run release -- gate           CI: may this pull request merge into master?
 *   npm run release -- landed <sha>   after a release or hotfix PR merged: is master that commit?
 *   npm run release -- released       release workflow: the tag a push to master releases, if any
 *   npm run release -- next-branch    release workflow, after publishing: open <version>-next, retire the old one
 *
 * master is the stable channel: Linux and Windows build it from source, and a
 * plugin installed from GitHub runs the server committed there. The next
 * release collects in `<master's version>-next` — named after the release it
 * follows, because which number comes next (patch, minor, major) is decided
 * only at the freeze. master receives only that branch or a hotfix branch, and
 * only the exact commit that was verified. The squash merge makes a new
 * commit; what has to match is its tree, and `gate` checks that before the
 * merge, `landed` after it.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/;
const NEXT = /^(\d+\.\d+\.\d+)-next$/;
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

// ------------------------------------------------------------------ status

function status() {
  git("fetch", "--quiet", "--prune", "origin", "+refs/heads/master:refs/remotes/origin/master", "+refs/heads/*-next:refs/remotes/origin/*-next");
  const stable = versionAt("origin/master");
  const tag = `v${stable}`;
  const tagTree = tryGit("rev-parse", `${tag}^{tree}`);
  const lines = [`master          ${stable}`];
  if (!tagTree) lines.push(`                tag ${tag} does not exist yet`);
  else if (tagTree === tree("origin/master")) lines.push(`                identical to ${tag}`);
  else lines.push(`                NOT identical to ${tag}: master holds changes no release verified`);

  const branch = `${stable}-next`;
  const others = git("for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin/")
    .split("\n")
    .filter((name) => NEXT.test(name) && name !== branch);

  if (!tryGit("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) {
    lines.push("next release    none");
    if (others.length) {
      // A hotfix moved master's version on; the branch keeps its work under its old name.
      lines.push("", `${others.join(", ")} predates master's ${stable}. Rename it (GitHub retargets its pull requests):`);
      for (const old of others) lines.push(`  gh api -X POST repos/{owner}/{repo}/branches/${old}/rename -f new_name=${branch}`);
    } else {
      lines.push("", "Create it from master before branching anything:", `  git push origin origin/master:refs/heads/${branch}`);
    }
  } else {
    const version = versionAt(`origin/${branch}`);
    const frozen = compare(version, stable) > 0;
    lines.push(
      `next release    ${branch} (${frozen ? `frozen at ${version}: only fixes for this release` : "open: features and fixes"})`,
      `                tip ${git("rev-parse", `origin/${branch}`)}`,
      "",
      `New work:  git switch -c <branch> origin/${branch}`,
      `PR base:   ${branch}`,
    );
    if (others.length) lines.push(`WARNING: stale next branches: ${others.join(", ")}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// -------------------------------------------------------------------- gate

/**
 * Run by .github/workflows/release-gate.yml on every pull request into master.
 * A pull request into master must come from this repository's
 * `<master's version>-next` or `hotfix/<name>` branch, carry a higher version
 * than master, name the verified commit in its description, and squash into
 * exactly that commit's tree.
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
  const next = NEXT.exec(HEAD_REF);
  if (fromFork || !(next || HOTFIX.test(HEAD_REF))) {
    die(
      `${fromFork ? `${HEAD_REPO}:` : ""}${HEAD_REF} cannot merge into master.\n` +
        "master receives only the <version>-next branch and hotfix/<name> branches of this repository.\n" +
        "Retarget this pull request to the next-release branch (npm run release -- status; RELEASING.md).",
    );
  }

  git("fetch", "--quiet", "--no-tags", "origin", "+refs/heads/master:refs/remotes/origin/master");
  if (!has(HEAD_SHA)) git("fetch", "--quiet", "--no-tags", "origin", HEAD_SHA);
  const stable = versionAt("origin/master");
  const version = versionAt(HEAD_SHA);
  if (next && next[1] !== stable) {
    problems.push(`${HEAD_REF} follows ${next[1]}, but master is ${stable}: rename it to ${stable}-next and verify it against master.`);
  }
  if (!parse(version) || compare(version, stable) <= 0) {
    problems.push(`The version (${version}) must be higher than master's (${stable}): freeze the branch first (npm run version:set -- <version>).`);
  }

  const verified = VERIFIED.exec(PR_BODY)?.[1];
  if (!verified) {
    problems.push("The description has no `Verified commit: <40-character sha>` line.");
  } else if (verified !== HEAD_SHA) {
    problems.push(`The verified commit is ${verified}, but the branch is at ${HEAD_SHA}. A change after verification is verified again (RELEASING.md).`);
  }

  const merged = tryGit("merge-tree", "--write-tree", "origin/master", HEAD_SHA);
  if (merged === undefined) {
    problems.push(`${HEAD_REF} conflicts with master. Bring master's changes into the branch through a pull request, then verify the result.`);
  } else if (merged.split("\n")[0] !== tree(HEAD_SHA)) {
    problems.push(
      `master holds changes ${HEAD_REF} does not (a hotfix not yet in the release branch, or a hotfix branch behind master). ` +
        "The squash would ship a tree nobody verified: bring them into the branch through a pull request, then verify the result.",
    );
  }

  if (problems.length) die(problems.join("\n"));
  process.stdout.write(`${HEAD_REF} ${version}: squashing it into master gives exactly the tree of ${HEAD_SHA}.\n`);
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

// ------------------------------------------------------------- next-branch

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Run by the release workflow once a release is published: the next release
 * starts collecting in `<released version>-next`.
 *
 * A `*-next` branch whose tree is the released commit's is the release itself,
 * squashed into master (the gate allows no other squash): its open pull
 * requests move to the new branch and it is deleted. Moving a pull request
 * does not rebase it; its author drops the old branch's commits (RELEASING.md,
 * *After the release*). A `*-next` branch with any other tree holds work no
 * release has shipped — what a hotfix leaves behind — and is renamed instead
 * (GitHub moves its pull requests), never deleted; bringing master into it is
 * then a pull request (*Hotfixes*, step 5). The new branch is made from the
 * released commit only when nothing was renamed to it.
 */
function nextBranch() {
  const { RELEASED_SHA, GITHUB_REPOSITORY } = process.env;
  if (!SHA.test(RELEASED_SHA ?? "") || !GITHUB_REPOSITORY) die("next-branch needs RELEASED_SHA and GITHUB_REPOSITORY");
  const repo = `repos/${GITHUB_REPOSITORY}`;
  const version = versionAt(RELEASED_SHA);
  if (!parse(version)) die(`No X.Y.Z version at ${RELEASED_SHA}.`);
  const branch = `${version}-next`;
  const releasedTree = tree(RELEASED_SHA);
  const heads = gh("api", "--paginate", `${repo}/branches`, "--jq", ".[].name").split("\n").filter(Boolean);
  let exists = heads.includes(branch);

  for (const old of heads.filter((name) => NEXT.test(name) && name !== branch)) {
    const oldTree = gh("api", `${repo}/branches/${old}`, "--jq", ".commit.commit.tree.sha");
    if (oldTree !== releasedTree) {
      if (exists) {
        process.stdout.write(`WARNING: ${old} holds unreleased work and ${branch} already exists. Left as it is; sort it out by hand.\n`);
        continue;
      }
      gh("api", "-X", "POST", `${repo}/branches/${old}/rename`, "-f", `new_name=${branch}`);
      exists = true;
      process.stdout.write(
        `Renamed ${old} to ${branch}: it holds work this release did not ship. ` +
          `Bring master into it through a sync/${version} pull request (RELEASING.md, Hotfixes, step 5).\n`,
      );
      continue;
    }
    if (!exists) {
      gh("api", "-X", "POST", `${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${RELEASED_SHA}`);
      exists = true;
      process.stdout.write(`Created ${branch} at ${RELEASED_SHA}.\n`);
    }
    const open = gh("pr", "list", "--repo", GITHUB_REPOSITORY, "--base", old, "--state", "open", "--json", "number", "--jq", ".[].number")
      .split("\n")
      .filter(Boolean);
    for (const number of open) {
      gh("api", "-X", "PATCH", `${repo}/pulls/${number}`, "-f", `base=${branch}`);
      process.stdout.write(`Moved #${number} from ${old} to ${branch}.\n`);
    }
    gh("api", "-X", "DELETE", `${repo}/git/refs/heads/${old}`);
    process.stdout.write(`Deleted ${old}: it is in master as the release.\n`);
  }

  if (!exists) {
    gh("api", "-X", "POST", `${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${RELEASED_SHA}`);
    process.stdout.write(`Created ${branch} at ${RELEASED_SHA}.\n`);
  }
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
  case "next-branch":
    nextBranch();
    break;
  default:
    die("usage: npm run release -- status | gate | landed <sha> | released | next-branch");
}
