# GotReceipts

> You shall not vibe.

A merge gate for AI coding agents. No receipt, no merge.

An agent will happily tell you "all tests pass". GotReceipts asks for the receipt: a record, tied to the exact commit, showing that the checks really ran and really passed. If there is no record, there is no merge.

## Status

Version 0.2, "the bouncer". Version 0.1 made the receipt. This version asks for it at the door: a push or a merge of a commit without a valid record is refused.

Not guarded yet: the policy file itself. An agent that edits it can still loosen its own gate. That is version 0.3.

- `main` only moves when a release has passed every gate. That rule is the product, so this repo follows it.
- Day-to-day work happens on the `version/*` branches.

## The three doors

A commit can enter a branch in three ways. Each has its own guard.

| Door | Guard | Without a valid record |
|---|---|---|
| `git push` | A git hook | The push is refused |
| Merging a pull request | The command `gotreceipts merge` | Nothing is merged |
| The agent calling `gh pr merge` by itself | A Claude Code hook | The command is stopped, and the agent is told to use `gotreceipts merge` |

`gotreceipts install` puts the two hooks in place, together with a short skill that tells the agent how to work with the gate. `gotreceipts doctor` shows what is enforced in a clone, and what is not.

## Commands

| Command | What it does |
|---|---|
| `gotreceipts gate` | Runs the checks of one gate level on the current commit and writes a record of the result |
| `gotreceipts verify` | Says whether a commit has a record that is good enough. Runs nothing |
| `gotreceipts merge` | Merges a pull request on GitHub, only when its commit has its record, and only that commit |
| `gotreceipts install` | Puts the hooks and the skill into this clone. `gotreceipts uninstall` takes them out again |
| `gotreceipts doctor` | Reports what is enforced in this clone, and what is not. Changes nothing |
| `gotreceipts policy` | Checks the policy file and shows what the gate will do |
| `gotreceipts words` | Fails if a file, a file path or a commit message contains a word from your private list |

Every command answers with one of three exit codes: `0` pass, `1` refused, `2` could not run. "Could not run" is never treated as a pass.

## The receipt

```
$ gotreceipts gate
gotreceipts gate: level G0 on commit 1a2b3c4 (branch feature/thing)
2 checks to run: build, tests

[1/2] build: npm run build
[1/2] build: PASS (exit code 0, 4.2 s)

[2/2] tests: npm test
[2/2] tests: FAIL (exit code 0, but the output shows a count of 0, and at least 1 is needed, 1.1 s)

Record: .git/gotreceipts/records/1a2b3c4…/G0.json
VERDICT: FAIL (level G0, commit 1a2b3c4)
```

That second check is the reason this tool exists. The test command exited with `0`. It also ran zero tests.

## At the door

### A push

```
$ git push origin feature/thing
gotreceipts pre-push: 1 branch to check
  feature/thing: commit 1a2b3c4 needs level G0: REFUSED (there is no record for this commit)
VERDICT: REFUSED (the pushed commit has no valid record). Nothing was pushed.
To make a record:
  gotreceipts gate --for feature/thing
```

After a gate run that passes, the same push goes through:

```
$ git push origin feature/thing
gotreceipts pre-push: 1 branch to check
  feature/thing: commit 1a2b3c4 needs level G0: PASS (G0 record, passed 0.0 hours ago)
VERDICT: PASS (1 pushed commit has a valid record)
```

- The hook checks the exact commit that is pushed.
- A branch that the policy sets no level for is let through, and named.
- When the hook cannot check, it blocks the push.
- A hook that was already there is never overwritten. It is kept, and it runs first. `gotreceipts uninstall` puts it back.

### A merge

A merge on GitHub passes no git hook. So the tool has its own merge command. It works through the GitHub CLI (`gh`) and holds no token of its own.

```
$ gotreceipts merge 19
gotreceipts merge: pull request #19, feature/skill into version/0.2
  commit 4e80974 needs level G1
  G2 record, passed 0.1 hours ago, under the current policy
  the merged result holds exactly the files of commit 4e80974
  asking GitHub to merge commit 4e80974, and no other
  merged as 4703218, which holds exactly the tested files
VERDICT: MERGED (pull request #19, commit 4e80974 into version/0.2)
```

That is the tool merging one of its own pull requests. Before it asks GitHub for anything, two things must hold:

1. The head commit of the pull request has a valid record, at the level of the target branch.
2. The merged result would hold exactly the files that were tested. If the target branch has moved on, the merge is refused: bring the branch up to date, run the gate on the new commit, and merge again.

Then it tells GitHub to merge that commit and no other. If the pull request changed in the meantime, GitHub refuses. After the merge, the tool compares what was merged with what was tested, and says so loudly when they differ.

### The agent

An agent that is used to `gh pr merge` will reach for it. With the Claude Code hook installed, the command is stopped before it runs, and the agent reads this:

```
gotreceipts: merging a pull request directly is not allowed in this repository.
Run "gotreceipts merge <pull request number>" instead. It checks that the commit
has a valid record, and then merges exactly that commit. If it refuses, do what
its last lines say. Do not look for another way to merge.
```

The same merge through `gh api` is stopped too, and so is `git push --no-verify`.

- The hook knows a short list of commands, on purpose. Stopping a known command is reliable. Guessing what any shell line will do is not.
- It is the early "no". The git hook and the merge command are the checkpoints.
- The skill tells the agent the loop, how to read a refusal, and the rule "fix the code, never the gate". The tool enforces. The skill explains.

## The policy file

One file, `gotreceipts.json`, at the top of the repository. It says which checks belong to which level, and which level a commit needs before it may enter a branch.

```json
{
  "schema": 1,
  "levels": [
    {
      "name": "G0",
      "checks": [
        { "name": "build", "run": "npm run build" },
        {
          "name": "tests",
          "run": "npm test",
          "expect": { "count": { "pattern": "(\\d+) passed", "atLeast": 1 } }
        }
      ]
    },
    {
      "name": "G1",
      "checks": [{ "name": "end-to-end", "run": "npm run e2e", "timeoutMinutes": 20 }]
    }
  ],
  "tiers": [
    { "branch": "main", "level": "G1" },
    { "branch": "feature/*", "level": "G0" }
  ]
}
```

- A level also runs every check of the levels before it.
- A check can say what its output must show: a line that must appear, and a count that must reach a minimum. Exit code `0` alone is not trusted.
- A setting the tool does not know is an error. It is never skipped in silence.

## What the gate will not accept

- **Loose changes.** The gate refuses to run when the folder has uncommitted changes, because its result is a statement about one exact commit.
- **A check that changes what it checks.** If the commit or the files differ after the run, the gate fails.
- **A check that never ends.** Every check has a time limit. Past it, the check and everything it started are stopped.
- **A check that went missing.** The checks are listed before they run, and each one gets a result: pass, fail or skipped.

## When a receipt counts

`gotreceipts verify`, the push hook and the merge command all ask the same question. A commit is accepted only when all of these hold:

1. The record is of this exact commit.
2. It passed.
3. Its level is the needed one, or a higher one.
4. It was made under the policy as it is now.
5. It is still fresh: 24 hours, unless the policy says otherwise.
6. No newer run of the same commit failed a check that the level needs. A flaky check cannot be re-run until it passes once.

## What it does not stop

A gate that hides its limits is worse than no gate. `gotreceipts doctor` prints its own list in every clone. This is the full one:

- **`git push --no-verify`, typed by a person.** That option skips every git hook. Git is built that way.
- **The merge button on GitHub.** It does not pass through the tool. Branch rules with a required CI check cover that door.
- **A clone where `gotreceipts install` never ran.** Hooks do not come with a clone.
- **A record written by hand.** A record is a plain file inside the `.git` folder. It is evidence that a later step can check. It is not protection against someone who forges it on purpose.
- **A policy file that was edited.** The policy is read from the working folder.
- **A merge by a command the agent hook does not know**, such as a script or an alias.
- **Other coding agents, in part.** The git hook and the merge command work whoever pushes or merges. The agent hook and the skill are for Claude Code only.

A guard on the policy file, signed approval, and a CI job that re-runs the gate are planned for version 0.3.

## This repo uses it on itself

The [`gotreceipts.json`](gotreceipts.json) at the top of this repository is the real one.

- CI builds the tool and then runs `gotreceipts gate` with it, on Linux and Windows, and reads the record back with `gotreceipts verify`.
- The hooks and the skill are installed in the maintainer's clone, so every push passes the push hook.
- Since version 0.2, pull requests into `develop` and the `version/*` branches are merged with `gotreceipts merge`.
- Merges into `main` are made by the maintainer on GitHub, behind branch rules and a required CI check.

| Level | Adds | Runs |
|---|---|---|
| G0 | Type check, build, tests | In CI and locally |
| G1 | Pack the package, install it in an empty folder, run it, and set up a repository with it | In CI and locally |
| G2 | The private-word check | Locally only: the word list is private, so it is not in this repository |

## Run it from source

It needs Node 22 or newer, and git. The merge command also needs the GitHub CLI (`gh`).

```
git clone https://github.com/roee3x/gotreceipts.git
cd gotreceipts
npm ci
npm run build
node dist/cli.js --help
```

To try it on a repository of your own, add a `gotreceipts.json` there, and run this in it:

```
node <the folder you cloned into>/dist/cli.js install
```

## What comes next

- **0.3, the lock.** A guard on the gate's own configuration, so that "fix the gate" is never the easy way to go green. The owner's signed approval on the branches that matter. A CI job that re-runs the gate.
- **0.4, the stacks.** Ready-made policies for pnpm and Turborepo, Python, and Unity.

## How this is built

With the assistance of AI coding agents (Claude Code), designed, directed, and heavily supervised by one human, and held to the same gate this repo ships.

## Maintenance

One maintainer, best effort.

## License

[MIT](LICENSE)
