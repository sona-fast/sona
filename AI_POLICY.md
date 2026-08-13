# AI policy

This repository's code is written with AI assistance. This file records what
that means, in more detail than the /ai disclosure page that sites running
Sona can publish.

## The blanket rule

Assume every commit here was written with AI assistance unless it says
otherwise. You won't find per-commit AI markers, and there never were any. The
authorship line carries that weight instead: every commit is authored by the
person who reviewed and approved it, and that person answers for it.

Branches named `claude/...` are the coding agent's working branches. Seeing one
on a merge subject tells you the change came through the agent workflow. Not
seeing one tells you nothing.

## How the work happens

Most of the code is written by Claude Code, Anthropic's coding agent, working
from designs and decisions the maintainer makes. Debugging and test writing go
the same way. Every change runs the test suite, then a set of review passes: a
second AI model reads the first one's work, and CodeRabbit, a third-party
service, reviews the diff. A human approves every merge and clicks every
deploy. There is no review team here, just one maintainer and a set of tools.

## Rules the agents work under

These rules predate this file, and every agent session on this project works
under them:

- Any state-changing operation on a live deployment (database writes, deploys,
  DNS, cloud resources) needs the maintainer's approval for that specific
  operation, every time. Reading logs and data while debugging is fine.
  Changing anything is not, without a fresh yes.
- Pushes to the default branch need per-push approval. Nothing lands because
  an agent decided it should.
- Agents draft messages and outward-facing content. They do not send or
  publish it.
- File-editing agents work in isolated git worktrees, and someone reviews the
  diff before it reaches the main tree.

## What AI is never used for

No artwork, images, audio, or video in this repository is AI-generated, and
none appears on the upstream project's own sites. The software ships almost no
media of its own: a favicon and a test fixture, both hand-drawn SVG. What each
site displays is chosen by whoever runs it. AI writes the code and the text in
this project, and it does not make the art.

## Contributions

The same standard applies if you contribute here. Disclose AI assistance in
your pull request, and understand what you're submitting well enough to
explain it. Any art assets you bring should be human-made.
