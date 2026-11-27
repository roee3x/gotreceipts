---
name: gotreceipts
description: How to work in a repository guarded by the GotReceipts merge gate (it has a gotreceipts.json file). Use before pushing, before merging a pull request, when a push or a merge is refused, when a "gotreceipts" command prints REFUSED, FAIL or CANNOT RUN, or when "gh pr merge" or "git push --no-verify" is denied.
---

# Working behind the GotReceipts gate

This repository has a merge gate. A commit may enter a guarded branch only when it has a **record**: proof that the checks ran on that exact commit and passed. You make the record by running the gate. Saying that the tests pass is not a record.

## The loop

1. Commit your work. The gate does not run while there are uncommitted changes.
2. Run the gate for the branch the commit should enter: `gotreceipts gate --for <target branch>`. Without `--for`, it runs the level of the branch you are on.
3. Read the last line. `VERDICT: PASS`: push. `VERDICT: FAIL`: read which check failed, fix the code, commit, and run the gate again.
4. Merge a pull request with `gotreceipts merge <number>`. Never with `gh pr merge`.

A record belongs to one commit. Every new commit needs its own gate run. That includes a commit that only merges the target branch into yours.

## Reading the answers

Every command ends with a `VERDICT:` line or a `CANNOT RUN` line, and with one of three exit codes.

| Exit code | Meaning | What to do |
|---|---|---|
| 0 | Pass | Go on |
| 1 | Refused, or a check failed | The last lines say why, and what to run next. Do that |
| 2 | Could not run | Something is missing or broken. Fix that first. It is never a pass |

What the common answers mean:

- **"there is no record for this commit"**: run the gate on that commit.
- **"its level is below"** the level that is needed: the target branch needs a higher level. Run `gotreceipts gate --for <target branch>`.
- **"it is older than"** the hours a record counts for, or **"it was made under a different policy"**: run the gate again.
- **"a newer run failed after it"**: a later run on the same commit failed. A check that passes only sometimes is a failing check. Find out why it failed. Do not run it again and again until it passes.
- **"the merged result would not be what was tested"**: the target branch holds changes that your commit does not contain. Merge the target branch into yours, run the gate on the new commit, push, and merge again.
- **"there are uncommitted changes"**: the gate could not run. Commit or stash, then run it.
- **"this commit changes the policy file"**: the commit holds another policy than the branch it wants to enter. It is judged by the policy that is already on that branch, so the change does not help it pass. Tell the user that the commit changes the policy.

## Rules

- **Fix the code, never the gate.** Do not edit `gotreceipts.json`, the command of a check, the number of tests a check expects, a hook or a CI workflow to make a failure go away. If you believe the gate itself is wrong, stop and tell the user why. Editing the policy on your branch would not help anyway: a commit is judged by the policy that is already on the branch it wants to enter.
- **Never go around it.** No `git push --no-verify`. No `gh pr merge`, and no merge through the API. No writing or editing files under `.git/gotreceipts`. No uninstalling the hooks.
- **Never report a pass you did not see.** Quote the `VERDICT:` line. If a command could not run, say that it could not run.
- **Do not delete or weaken a test to get to green.** A gate that passes because a check was removed has not passed.
- If you are blocked and nothing above helps, stop and ask the user. "I am blocked, and this is why" is a good report.

## Commands

| Command | What it does |
|---|---|
| `gotreceipts gate` | Runs the checks on the current commit and writes the record |
| `gotreceipts verify [commit] --for <branch>` | Says whether a commit has a valid record. Runs nothing |
| `gotreceipts merge <number>` | Merges a pull request, only when its commit has its record |
| `gotreceipts policy --for <branch>` | Shows the policy a commit must pass to enter that branch: the levels, their checks, and which branch needs which level |
| `gotreceipts doctor` | Shows what is enforced in this clone, and what is not |
