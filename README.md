# GotReceipts

> You shall not vibe.

A merge gate for AI coding agents. No receipt, no merge.

An agent will happily tell you "all tests pass". GotReceipts asks for the receipt: a record, tied to the exact commit, showing that the checks really ran and really passed. If there is no record, there is no merge.

## Status

Version 0.1, "the receipt". The two commands everything else stands on are working: one makes the receipt, the other checks it. Nothing is blocked yet. That is version 0.2.

- `main` only moves when a release has passed every gate. That rule is the product, so this repo follows it.
- Day-to-day work happens on the `version/*` branches.

## What works today

| Command | What it does |
|---|---|
| `gotreceipts gate` | Runs the checks of one gate level on the current commit and writes a record of the result |
| `gotreceipts verify` | Says whether a commit has a record that is good enough. Runs nothing |
| `gotreceipts policy` | Checks the policy file and shows what the gate will do |
| `gotreceipts words` | Fails if a file, a file path or a commit message contains a word from your private list |

Every command answers with one of three exit codes: `0` pass, `1` refused, `2` could not run. "Could not run" is never treated as a pass.

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

`gotreceipts verify` accepts a commit only when all of these hold:

1. The record is of this exact commit.
2. It passed.
3. Its level is the needed one, or a higher one.
4. It was made under the policy as it is now.
5. It is still fresh: 24 hours, unless the policy says otherwise.
6. No newer run of the same commit failed a check that the level needs. A flaky check cannot be re-run until it passes once.

## What a receipt is not

A record is a plain file inside the `.git` folder. Anyone who can write there can write one by hand. In this version it is evidence that a later step can check. It is not protection against someone who forges it on purpose. Signed approval, and a CI job that re-runs the gate, are planned for that.

## This repo uses it on itself

The [`gotreceipts.json`](gotreceipts.json) at the top of this repository is the real one. CI builds the tool and then runs `gotreceipts gate` with it, on Linux and Windows, and reads the record back with `gotreceipts verify`.

| Level | Adds | Runs |
|---|---|---|
| G0 | Type check, build, tests | In CI and locally |
| G1 | Pack the package, install it in an empty folder, run it | In CI and locally |
| G2 | The private-word check | Locally only: the word list is private, so it is not in this repository |

## Run it from source

It needs Node 22 or newer, and git.

```
git clone https://github.com/roee3x/gotreceipts.git
cd gotreceipts
npm ci
npm run build
node dist/cli.js --help
```

## What comes next

- **0.2, the bouncer.** Hooks that refuse an upward push or merge without a fresh record, a merge command pinned to the tested commit, and an install command.
- **0.3, the lock.** A guard on the gate's own configuration, so that "fix the gate" is never the easy way to go green. The owner's signed approval on the branches that matter.
- **0.4, the stacks.** Ready-made policies for pnpm and Turborepo, Python, and Unity.

## How this is built

With the assistance of AI coding agents (Claude Code), designed, directed, and heavily supervised by one human, and held to the same gate this repo ships.

## Maintenance

One maintainer, best effort.

## License

[MIT](LICENSE)
