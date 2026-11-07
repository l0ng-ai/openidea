---
name: issue-fix
description: Triage and fix a GitHub issue (or a user-reported bug) end to end — reproduce, find the root cause, generalise it to every sibling case, fix the class rather than the instance, verify, and open one PR. Use when given an issue URL/number or asked to fix a reported bug and open a PR ("看看这个 issue", "修一下这个 bug", "提 pr").
---

# Fix an issue: from one case to the whole class

The reported case is one sample of a defect class. A fix that only makes the
screenshot go away is not done: the next question is always "does this break for other
languages / platforms / entry points too?". Answer that before anyone asks.

Scale the workflow to the risk. For an obvious, low-risk CSS or copy fix, inspect
the cause and nearby shared styles, make the focused edit, check formatting and
verify the affected UI. Run existing targeted tests only when they cover a plausible
regression; do not add implementation-mirroring tests or default to full-suite tests,
E2E, builds, typechecking or dependency analysis. Reuse completed checks while the
diff is unchanged. A brief finding and verification note is enough; skip the formal
sibling table. Follow `AGENTS.md` for broader changes and create a PR when requested.

## 1. Read and reproduce

- `gh issue view <n> --comments` (repo `l0ng-ai/openidea`). Read attached logs/screenshots
  closely: OS, language, toolchain versions, exact error text.
- Locate the code path and confirm the claim in code, with `file:line` evidence.
  Say plainly whether it is a real bug, a missing feature, or user environment.
- Reproduce locally when possible (`fixtures/` projects, `/verify` for runtime). If the
  reporter's platform (often Windows/Linux) can't be reproduced here, say so up front.
- Do not ask for a generic environment/log checklist before trying the flow and inspecting the code.
  Record the attempt and result; ask only for a fact that actually blocks the next diagnostic step.
  Missing fields, limited time, or unavailable automation are not by themselves reasons to ask the reporter.
- Treat a maintainer-confirmed bug as an investigation task even if local reproduction fails. Distinguish
  “not reproduced here” from “not a bug”, and do not require the reporter to prove its existence again.

## 2. Name the root cause as a class

Write one sentence of the form "<mechanism> is missing/wrong, so any <X> hits it",
not "<this button> is broken". Typical classes in this codebase:

- Per-language config handled for one language only (`languages/*.toml`, `ide-sdk`).
- Platform gaps: paths, executables, shells, `.cmd`/`.exe`, separators — macOS-only code.
- Toolchain/version discovery: one probe location, no version check, no rescan.
- Two features each implementing half a flow and never joined (feature isolation →
  should go through an action/service).
- State not reset on project switch / window reuse; events not scoped per window.
- Failure surfaced as raw stderr/stack trace or retried until "crashed" instead of a
  clear status with an action.
- UI: same primitive styled differently in N places.

## 3. Sweep for siblings

Search systematically, not by memory:

- Same pattern elsewhere: `git grep` the function, the config key, the error string,
  the hard-coded path/flag. Check every `languages/*.toml` entry and every platform branch.
- Same flow for other languages/runtimes (Java ↔ Kotlin/Gradle, Python ↔ venv/uv,
  Node ↔ Deno/Bun, Go, Rust …): would they fail the same way?
- Other callers/entry points of the same flow (menu, context menu, gutter, shortcut, CLI arg).
- Neighbouring failure modes of the same mechanism (not installed / wrong version /
  installed but crashes / slow start / installed mid-session).
  For broad sweeps spawn one Explore agent with the class description, not the instance.

## 4. Decide the fix at the right altitude

- Fix the mechanism once (shared helper, action, config hook) so siblings are fixed
  by construction; don't patch each call site.
- Respect `AGENTS.md` rules (crate boundaries, no cross-feature imports, `IdeResult`,
  UTF-16). If the right fix breaks a rule, pick the rule-respecting design and say why.
- Compare with how established IDEs solve it when relevant; prefer the established answer.
- Present: root cause, sibling table, proposed fix, what's deferred. When the user leaves
  the choice to you, go ahead without asking again.

## 5. Implement and test the class

- Tests cover the class: table-driven over languages/platforms/states, not just the
  reported input. Include the reporter's case verbatim.
- Run the scoped checks (`pnpm vitest run <path>`, `cargo nextest run -p <crate>`), then
  `/verify` in the app for UI or runtime behaviour.

## 6. PR

- One branch `fix/<slug>`, one PR unless the user asks otherwise; `Fixes #<n>` in the body.
- Don't stage untracked IDE-state dirs (`.ideal/`, `.openidea/`) or screenshots.
- PR body follows `.github/pull_request_template.md`: `Closes #<n>`, then
  **What and why** (user-visible change + root cause at class level, 2–4 sentences),
  **How it was verified** (commands run and results, siblings fixed/deferred, what could break and how
  it was checked, what was not verified, e.g. "Windows not tested"; for UI changes the before/after
  screenshot paths from `/verify`), **Review focus** (optional). Short and plain.

## Report format

Reply in the user's language:

```
Root cause: <one sentence, class level>
Sibling sweep:
| Location / case | Affected? | Action |
Fixed / not covered (why) / not verified (platform)
PR: <url>
```
