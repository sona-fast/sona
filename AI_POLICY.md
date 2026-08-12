# AI policy

This repository's code is written with AI assistance, and this file is the
honest record of what that means. It is linked from the /ai page that every
site running Sona serves.

## The blanket rule

Assume every commit in this repository was written with AI assistance unless
it says otherwise. There are no per-commit AI markers and there never have
been: not because they were removed, but because the authorship line is the
one that matters. Every commit is authored by a person who reviewed and
approved it, and that person is accountable for it.

Branches named `claude/...` are the coding agent's working branches. Their
presence on a merge subject means the change came through the agent workflow;
their absence on a commit means nothing.

## How the work happens

Most code here is written by Claude Code (Anthropic's coding agent), working
from designs and decisions made by the maintainer. Debugging and test
development happen the same way. Every change runs the automated test suite
and a set of review passes, one of which is a second AI model reviewing the
first one's work and one of which is CodeRabbit, a third-party review
service. A human approves every merge and every deploy. There is no review
team behind this repository; there is one maintainer and a set of tools.

## Rules the agents work under

These rules predate this file and bind every agent session that touches this
project:

- Any state-changing operation on a live deployment (database writes,
  deploys, DNS, cloud resources) requires the maintainer's explicit approval
  for that specific operation, each time. Reading logs and data for debugging
  is permitted; changing anything is not, without a fresh yes.
- Pushes to the default branch require per-push approval. Nothing lands
  because an agent decided it should.
- Agents may not send messages, publish content, or take outward-facing
  actions on the maintainer's behalf; drafts only.
- File-editing agents work in isolated git worktrees, and their changes are
  reviewed before they reach the main working tree.

## What AI is never used for

No artwork, images, audio, or video in this repository or on sites running
it are AI-generated as a matter of policy. The software ships almost no
media of its own (a favicon and a test fixture, both hand-drawn SVG), and
the content each site displays is chosen by its operator. The upstream
project's stance: AI writes code and text here; it does not make art.

## Contributions

If you contribute to this repository, the same standard applies to you:
disclose AI assistance in your pull request, understand the change you're
submitting well enough to explain it, and expect your art assets (if any)
to be human-made.
