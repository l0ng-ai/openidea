# Contributing to OpenIDEA

These rules apply to everyone, and to any coding agent working on their behalf.
Project layout, coding rules, commands and checks are in [AGENTS.md](AGENTS.md).

## Issues

- One problem or request per issue. Use the issue forms.
- Bugs: steps that reproduce the problem from a fresh start. A minimal sample
  project is the fastest way to get a fix.
- Features: state the problem and the acceptance criteria. A feature is ready to
  build once a maintainer labels it `planned`.
- Labels track status: `needs-info` waits on the reporter, `needs-decision` waits
  on a maintainer, `planned` is accepted, `needs-acceptance` has a fix waiting to be
  checked.

## Pull requests

- One issue per PR, linked with `Closes #123`. Feature PRs need a `planned` issue.
  Docs, CI and pure refactors may skip the issue.
- Reproduce the problem first, or write a test that fails before the fix.
- Fix the cause, and check whether the same cause breaks anything nearby.
- Keep the diff focused. Unrelated refactors go in their own PR.
- Title: [Conventional Commits](https://www.conventionalcommits.org/), e.g.
  `fix(editor): keep the caret visible after folding`.
- Fill in the template. Keep the description short and in plain words. If it
  doesn't fit in a few sentences, the PR is probably too big.
- **How it was verified** is required: the commands you ran and their results,
  and what else the change could affect. UI changes need before/after screenshots;
  multi-step interactions need a recording.
- If a change needs a product decision you can't make, ask in the issue and stop
  rather than guessing.

Plugins: pull requests here add or change official plugins (`plugins/official/`)
and the plugin API. Community plugins live in their authors' repositories and
are listed through [l0ng-ai/openidea-plugins](https://github.com/l0ng-ai/openidea-plugins);
see [`plugins/README.md`](plugins/README.md) § 8.1.

A check on each PR adds `needs-info` when the issue link or the verification
section is missing, and removes it once they're filled in.
