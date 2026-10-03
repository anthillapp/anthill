# Anthill: instructions for coding agents

Codex reads this file directly; Claude Code reads it through `CLAUDE.md`, which
imports it. It is the one place the branch and release process is written down.
[RELEASING.md](RELEASING.md) holds only the mechanics it points to (setting the
version, the plugin bundle, refreshing installed plugins). If anything else
disagrees with this file, this file is right; fix the other one.

## Branches and releases

**master is the stable channel.** Linux and Windows users build Anthill from
source on master, and a plugin installed from GitHub runs the MCP server
committed there. macOS ships separately, as the disk image a `v<version>` tag
builds. So master receives only a release that passed its final QA, or a
hotfix, and the tag sits on exactly that master commit: every platform's
stable code is one release.

### Where work goes

- **The active release branch** is the one `release/X.Y.Z` on `origin` whose
  version is higher than the `version` in master's `package.json`. Ask, do not
  guess: `npm run release -- status` prints it, whether it is open or frozen,
  and its tip. There is one at a time.
- **Every feature and fix branch starts from it** (`git switch -c <branch>
  origin/release/X.Y.Z`) and its pull request targets it. Merge with
  **squash**. Branch names carry the issue ID; the repository's other
  conventions are unchanged.
- **Never base work on master or open a pull request into master**, except a
  release or a hotfix as described below. The required `release-gate` check
  fails anything else, and GitHub refuses a direct push to master.
- **None exists** (`status` says so): create it from master, at the next patch
  version unless the maintainer chose another number:
  `git push origin origin/master:refs/heads/release/X.Y.Z`.
- **Open or frozen.** A release branch is *open* while its `package.json` still
  carries master's version, and *frozen* once the version bump to X.Y.Z has
  merged into it. A frozen branch takes only fixes for what this release's QA
  found, and release chores. A feature that misses the freeze waits as a draft
  pull request and moves to the next release branch once that exists.

### Freeze and the release candidate

1. **Freeze** when the maintainer says the release's content is complete: a
   pull request `chore: release X.Y.Z` into `release/X.Y.Z` that sets the
   version and rebuilds the plugin bundle (RELEASING.md, step 1).
2. **The release candidate is one commit**: the branch's tip after the freeze
   merged, named by its full 40-character SHA. Final QA verifies that commit
   and nothing else. Build the pre-release app from a clean checkout where
   `git rev-parse HEAD` prints that SHA.
3. **Automated checks** run by themselves on every push to the branch, on that
   exact commit: `check`, `linux-source`, `windows-source` (CI). For macOS
   packaging, also run the Release workflow by hand on the branch
   (`gh workflow run release.yml --ref release/X.Y.Z`): it builds the disk image
   and publishes nothing.
4. **Final QA** is the pre-release end-to-end pass on that commit, run with the
   maintainer's QA procedure.
5. **A bug found in QA** is fixed by a pull request into the release branch. The
   new tip is a new candidate: the automated checks run again by themselves; rerun
   the failed scenario, every scenario touching the changed code, and the whole
   pass when the fix touches handover, observation, the plugins or the MCP
   server. Write down what was rerun and why.
6. **Anything that changes the branch after verification** — a fix, a hotfix
   brought in from master, a conflict resolution — makes a new candidate that
   is verified again before it can go to master. The gate enforces this: the
   commit named as verified must be the branch's head.

### What a check proves

Building, automated tests and end-to-end use are different evidence, and one
platform's result says nothing about another. A green macOS CI does not show
that Anthill builds or starts on Linux or Windows; a green `linux-source` does
not show that Anthill works on Linux.

| Evidence | macOS | Linux (supported: CLI) | Windows (experimental) |
| --- | --- | --- | --- |
| Builds | Release workflow by hand on the branch (disk image) | `linux-source`: README steps, `npm run build` | `windows-source`: the same |
| Automated tests | `check`: typecheck and tests on `macos-14` | `linux-source`: `npm test` | not run |
| Starts | final QA | `linux-source`: the CLI serves its page | `windows-source`: the same |
| End to end | final QA: desktop app with Codex and Claude Code | only on a real Linux machine | only on a real Windows machine |

Record every cell for the candidate as **passed**, **failed** or **not run**.
Never fill a cell from another one. macOS checks and final QA, and Linux
build, tests and start, must pass. A Windows failure does not block on its own,
but it is reported and the maintainer decides. A platform nobody used end to end
is reported as not verified end to end.

### Moving a release into master

1. Open a pull request from `release/X.Y.Z` into `master`, titled
   `chore: release X.Y.Z`. Its description has a line
   `` Verified commit: `<40-character SHA>` `` and the evidence table above.
   Public text only: no links to internal trackers or plans.
2. `release-gate` checks that the branch is a release or hotfix branch of this
   repository, that its version is X.Y.Z and higher than master's, that the
   verified commit is the head, and that the squash will be exactly that
   commit's tree. When master holds changes the branch lacks, or they conflict,
   bring master into the branch (*Hotfixes*, step 5), verify the new candidate,
   and update the line. Never resolve conflicts in GitHub's editor, on master,
   or by editing the squash.
3. The maintainer squash-merges it. Agents do not merge into master or push
   tags unless the maintainer asks for that specific merge or tag.
4. `npm run release -- landed <verified SHA>` checks that master is now that
   commit's tree and prints the tag command: `v<version>` on that master commit.
   Pushing the tag runs the Release workflow, which refuses a tag that is not on
   master or does not match the version, then builds and publishes the macOS
   disk image.
5. Refresh installed plugins (RELEASING.md, step 3).
6. Create the next release branch from master (*Where work goes*). Retarget
   every open pull request to it (`gh pr edit <n> --base release/<next>`) and
   rebase each branch onto it, dropping the old release's commits, which the
   squash replaced on master:
   `git rebase --onto origin/release/<next> $(git merge-base HEAD <verified SHA>)`.

### Hotfixes

For a released version that cannot wait for the next release:

1. Its version is the next patch after master's. If the active release branch
   already carries that number, rename the release branch to the following
   patch first (`gh api -X POST repos/{owner}/{repo}/branches/release%2F<old>/rename -f new_name=release/<new>`;
   GitHub retargets its open pull requests), and if it was frozen, set its
   version again by a pull request.
2. Branch `hotfix/<version>-<topic>` from `origin/master`. Commit the fix with
   its test, then set the version and rebuild the plugin bundle (RELEASING.md).
3. Verify the hotfix branch's tip like a candidate, scoped to the fix: the
   automated checks above, and end to end the flows the fix touches on macOS.
4. Pull request into master as in *Moving a release into master*, with its
   own `Verified commit:` line; the gate, the squash, `landed` and the tag are
   the same.
5. Bring master into the active release branch: branch
   `sync/<release version>` from the release branch, `git merge origin/master`,
   keep the release branch's own version where they conflict (rerun
   `npm run plugin:bundle` if it is frozen), and open a pull request into the
   release branch that is merged with **Create a merge commit**, never squash.
   The merge commit is what lets the release later squash into master without
   conflicts. On a frozen branch this is a new candidate (step 6 above).
