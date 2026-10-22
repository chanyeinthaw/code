---
name: sync-fork
description: Sync this fork's t3code-main mirror with upstream/main, trial-rebase main while preserving its custom changes, verify parity, and promote the trial with a dated backup. Use for the fork-sync workflow, not ordinary feature rebases.
---

# Sync the fork and trial-rebase main

Default to `origin` for the fork, `upstream` for the source repository, `t3code-main` for the base,
and `main` for the customization and GitHub default branch. Confirm their URLs and refs before using them.
Honor different branches or a trial-only scope when the user specifies them.

## Capture the starting state

1. Read the repository's `AGENTS.md` instructions.
2. Inspect the working tree, remotes, branch tracking, and linked worktrees.
3. Stop if there are uncommitted changes or an unfinished Git operation. Do not stash or discard work automatically.
4. Record the original `main` SHA, original `t3code-main` SHA, their merge base, and the local commit range.
   Keep these values and any comparison reports outside the repository.
5. Choose unused names such as `trial/main-rebase-YYYYMMDD` and
   `backup/main-before-rebase-YYYYMMDD`, using the local date. Add a time suffix if needed.

Do not change a branch checked out by another worktree. Do not start or rebuild a daily-driver
client, restart shared services, or touch live databases as part of this workflow.

## Sync t3code-main without dropping fork changes

1. Fetch `t3code-main` from `origin` and `main` from `upstream`. Inspect divergence among local `t3code-main`, `origin/t3code-main`, and `upstream/main`.
2. Fast-forward local `t3code-main` when possible. A fork-only maintenance commit is not disposable.
   Preserve this project skill and other fork-only commits when upstream advances.
3. If `t3code-main` has diverged, integrate upstream on a separate trial branch first.
   Prefer a merge that preserves fork history and permits a normal push.
   If remote-only commits or conflicts make the intended result unclear, stop and ask.
   Review the merge result, then fast-forward local `t3code-main` to the verified trial result.
4. When the sync request includes the fork remote, push `t3code-main` to `origin` without force.
   If the push is rejected, fetch and inspect the new state instead of overwriting it.
5. Record the synchronized `t3code-main` SHA used for the trial rebase.

Never reset fork `t3code-main` to upstream merely to make their SHAs match.

## Rebase a copy of main

1. Create the trial branch at the recorded original `main` SHA. Leave `main` unchanged.
2. Inspect the commits to replay before rebasing onto synchronized `t3code-main`.
   Use the recorded fork point when needed to distinguish custom commits from upstream history.
   Preserve meaningful merge topology if the branch contains merges.
3. Resolve conflicts by retaining the local features and compatible upstream fixes.
   Do not accept entire files with `--ours` or `--theirs` without reviewing the lost changes.
4. Check automatically merged files for changed APIs, service dependencies, permissions, and test setup.
   Set `apps/server/package.json`'s `upstreamVersion` to the synchronized upstream server version. Provider compatibility policies use that version, not Sora's independent release version.
5. Check migration IDs against upstream. Renumber collisions and update references.
   If earlier main builds used those IDs, preserve their upgrade path and test it with isolated databases.
   Renumbering alone can reject an existing database or rerun schema creation.
6. Complete the rebase on the trial branch. Keep any compatibility fixes with the relevant custom commit when practical.

If a conflict requires a product decision, leave the trial unpromoted and ask.

## Verify parity before promotion

Compare the original custom changes with the rebased custom changes, not the complete trees.
Upstream changes make whole-tree equality the wrong test.

- Run `git range-diff` between the recorded original range and the range from synchronized `t3code-main` to the trial.
  Inspect changed or missing patches, including automatic merges.
- Compare changed paths and newly added files. Account for each removal, rename, or adaptation.
  Confirm that upstream replacing an implementation has not removed its custom behavior.
- Run focused tests for the custom features and conflict resolutions, plus scoped typechecks.
  Follow the repository's limits on checks and browser testing.
- Use the checkout's `node_modules/.bin/vp` if the global `vp` runs a different test version.
- Run `git diff --check` against synchronized `t3code-main` and confirm a clean working tree.

A clean rebase is not proof of parity. Do not promote with unexplained patch differences,
feature regressions, or unresolved check failures. Report any verification limit explicitly.

## Promote without losing the original

Promote only when the request authorizes promotion and the checks pass.
Before renaming branches, confirm that `main` still points to the recorded original SHA,
`t3code-main` still points to the tested base, and the working tree is clean.

From the checked-out trial branch, rename the original branch to the unused backup name,
then rename the trial to `main`. Do not force-update or delete the original branch.
If the second rename fails, retain both existing refs and report the state.

Verify that the backup points to the original SHA, the promoted branch contains synchronized
`t3code-main`, and the intended custom commits remain. Leave `main` checked out.

Do not push `main`, its backup, or the trial unless requested. A rewritten remote branch needs
explicit authorization and a lease tied to the inspected remote SHA, never an unconditional force push.

Report the t3code-main sync result, promoted SHA, backup name, parity findings, and check results.
Distinguish local branch changes from remote pushes.
