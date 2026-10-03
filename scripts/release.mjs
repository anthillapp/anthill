#!/usr/bin/env node
/**
 * The branch model's facts, computed rather than remembered (RELEASING.md).
 *
 *   npm run release -- status         where new work branches from and which PRs go where
 *   npm run release -- gate           CI: may this pull request merge into master?
 *   npm run release -- landed <sha>   after a release or hotfix PR merged: is master that commit?
 *   npm run release -- tagged         release workflow: is the pushed tag a released master commit?
 *
 * master is the stable channel: Linux and Windows build it from source, and a
 * plugin installed from GitHub runs the server committed there. So master
 * receives only a release branch or a hotfix branch, and only the exact commit
 * that was verified. The squash merge makes a new commit; what has to match is
 * its tree, and `gate` checks that before the merge, `landed` after it.
 */

import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/;
const RELEASE = /^release\/(\d+\.\d+\.\d+)$/;
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

function nextPatch(version) {
  const [a, b, c] = parse(version);
  return `${a}.${b}.${c + 1}`;
}

// ------------------------------------------------------------------ status

function status() {
  git("fetch", "--quiet", "--prune", "origin", "+refs/heads/master:refs/remotes/origin/master", "+refs/heads/release/*:refs/remotes/origin/release/*");
  const stable = versionAt("origin/master");
  const tag = `v${stable}`;
  const tagTree = tryGit("rev-parse", `${tag}^{tree}`);
  const lines = [`master          ${stable}`];
  if (!tagTree) lines.push(`                tag ${tag} does not exist yet`);
  else if (tagTree === tree("origin/master")) lines.push(`                identical to ${tag}`);
  else lines.push(`                NOT identical to ${tag}: master holds changes no release verified`);

  const branches = git("for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin/release/")
    .split("\n")
    .map((name) => RELEASE.exec(name)?.[1])
    .filter((v) => v && compare(v, stable) > 0)
    .sort(compare);

  if (branches.length === 0) {
    const next = nextPatch(stable);
    lines.push(
      "active release  none",
      "",
      `Create it from master before branching anything:`,
      `  git push origin origin/master:refs/heads/release/${next}`,
    );
  } else {
    if (branches.length > 1) lines.push(`WARNING: more than one release branch is ahead of master: ${branches.map((v) => `release/${v}`).join(", ")}`);
    const active = branches[0];
    const branch = `release/${active}`;
    const frozen = versionAt(`origin/${branch}`) === active;
    lines.push(
      `active release  ${branch} (${frozen ? `frozen: version is ${active}, only fixes for this release` : `open: version still ${versionAt(`origin/${branch}`)}, features and fixes`})`,
      `                tip ${git("rev-parse", `origin/${branch}`)}`,
      "",
      `New work:  git switch -c <branch> origin/${branch}`,
      `PR base:   ${branch}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// -------------------------------------------------------------------- gate

/**
 * Run by .github/workflows/release-gate.yml on every pull request into master.
 * A pull request into master must come from this repository's release/<v> or
 * hotfix/<name> branch, carry a higher version than master, name the verified
 * commit in its description, and squash into exactly that commit's tree.
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
  const release = RELEASE.exec(HEAD_REF);
  if (fromFork || !(release || HOTFIX.test(HEAD_REF))) {
    die(
      `${fromFork ? `${HEAD_REPO}:` : ""}${HEAD_REF} cannot merge into master.\n` +
        "master receives only release/<version> and hotfix/<name> branches of this repository.\n" +
        "Retarget this pull request to the active release branch (npm run release -- status; RELEASING.md).",
    );
  }

  git("fetch", "--quiet", "--no-tags", "origin", "+refs/heads/master:refs/remotes/origin/master");
  if (!tryGit("cat-file", "-e", `${HEAD_SHA}^{commit}`)) git("fetch", "--quiet", "--no-tags", "origin", HEAD_SHA);
  const stable = versionAt("origin/master");
  const version = versionAt(HEAD_SHA);
  if (release && version !== release[1]) {
    problems.push(`package.json on ${HEAD_REF} says ${version}; the branch is not frozen at ${release[1]} (npm run version:set -- ${release[1]}).`);
  }
  if (!parse(version) || compare(version, stable) <= 0) {
    problems.push(`The version (${version}) must be higher than master's (${stable}).`);
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
  if (!tryGit("cat-file", "-e", `${sha}^{commit}`)) die(`${sha} is not in this clone; fetch the release branch first.`);
  if (tree(head) !== tree(sha)) die(`master (${head}) is not the verified commit's tree. Do not tag; find what differs: git diff ${sha} ${head}`);
  const version = versionAt(head);
  const tag = `v${version}`;
  if (tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`)) die(`${tag} already exists.`);
  process.stdout.write(
    `master ${head} is the verified commit's tree, version ${version}.\n\n` +
      `Tag it (this publishes the macOS release):\n  git tag ${tag} ${head} && git push origin ${tag}\n`,
  );
}

// ------------------------------------------------------------------ tagged

/** Run by the release workflow: a tag is only ever a released master commit. */
function tagged() {
  const ref = process.env.GITHUB_REF ?? "";
  if (!ref.startsWith("refs/tags/")) {
    process.stdout.write(`${ref || "No ref"} is not a tag: nothing to check.\n`);
    return;
  }
  const tag = ref.slice("refs/tags/".length);
  git("fetch", "--quiet", "--no-tags", "origin", "+refs/heads/master:refs/remotes/origin/master");
  const problems = [];
  if (tryGit("merge-base", "--is-ancestor", "HEAD", "origin/master") === undefined) {
    problems.push(`${tag} is not on master. Tags go on the master commit a verified release or hotfix became (RELEASING.md).`);
  }
  const version = versionAt("HEAD");
  if (tag !== `v${version}`) problems.push(`${tag} does not match package.json's version ${version}.`);
  if (problems.length) die(problems.join("\n"));
  process.stdout.write(`${tag} is on master and matches the version.\n`);
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
  case "tagged":
    tagged();
    break;
  default:
    die("usage: npm run release -- status | gate | landed <sha> | tagged");
}
