# GotReceipts

> You shall not vibe.

A merge gate for AI coding agents. No receipt, no merge.

An agent will happily tell you "all tests pass". GotReceipts asks for the receipt: a record, tied to the exact commit, showing that the checks really ran and really passed. If there is no record, there is no merge.

## Status

Under construction. There is nothing to install yet.

- `main` only moves when a release has passed every gate. That rule is the product, so this repo follows it.
- Day-to-day work happens on the `version/*` branches.

## What it will do

- Run a project's real checks and write a pass or fail record bound to the exact commit.
- Refuse an upward merge that has no fresh passing record.
- Ask for the owner's signed approval on the branches that matter.
- Guard its own configuration, so that "fix the gate" is never the easy way to go green.

## How this is built

With the assistance of AI coding agents (Claude Code), designed, directed, and heavily supervised by one human, and held to the same gate this repo ships.

## Maintenance

One maintainer, best effort.

## License

[MIT](LICENSE)
