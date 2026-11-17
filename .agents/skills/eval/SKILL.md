---
name: eval
description: Run the code-intelligence evals (`pnpm eval`), pick the worst failing scenario, diagnose it from the attached timeline, fix it, prove the fix with before / after numbers measured on this machine without regressing other scenarios, and open one PR. Use for "跑 eval", "优化 Java 代码智能", "eval 失败了", an issue labelled `eval`, or any change to Java navigation / usages / gutter markers that needs numbers.
---

# Eval loop: measure → fix → prove

`pnpm eval` drives the production workbench in Chromium against a release `openidea-server`
with real language servers (Java / jdtls for now) and judges every scenario on what the user
sees: time to feedback, to the first result, to the final one, and the results themselves vs
`evals/<language>/golden/`. One machine, before and after: numbers from different machines or
from the nightly host don't judge a fix.

## 0. Preconditions

- `jdtls` on PATH and `JAVA_HOME` pointing at a JDK of the pinned `JAVA` version (projects
  compile against it, and the JDK scenarios' results are in its sources; jdtls itself runs on
  a newer installed JDK when it needs one). Pinned versions: `.github/tool-versions.env`. A
  mismatch prints a warning and the report records both: say so in the PR when it applies.
- First run builds `cargo build --release -p ide-host --bin openidea-server` and the perf
  bundle; later iterations of a frontend-only change can use `--no-build` after a
  `pnpm exec vite build --mode perf --outDir target/eval/dist`, a backend-only one after the
  cargo build alone.
- Run evals one at a time on this machine, with nothing heavy (builds, other evals) beside them.

## 1. Baseline on the base commit

```sh
git switch --detach origin/main     # or the fix branch's merge base
pnpm eval --save-baseline           # target/eval/baseline.json, this machine only
```

Read `target/eval/report.json`. Each verdict has `status`, `failures` (`kind`: `error`,
`timeout`, `degraded`, `correctness`, `budget`, `golden`), `regressions`, `repro` (the command
that reruns it) and, for failures, `diagnostics`: every command sent to the server in the
slowest run's window (`cmd`, `start`, `ms`, `ok`, `bytes`, `items`), background tasks, server
status changes and the server's log tail.

## 2. Pick one problem

Worst first: wrong or missing results and silent degradation, then timeouts, then the
feedback budget (100 ms), then the slowest `completeMs`. One problem per PR. Say which
scenario and metric, with its value vs budget.

## 3. Diagnose from the timeline

- Commands in the window ordered by `start`: what ran, what waited on what, what's serial
  that could overlap, which request returned many `items`/`bytes`, which failed.
- `feedbackMs` far above 16 ms with a fast `firstResultMs`: the UI shows nothing while it
  waits (a hint or popup that only appears after a delay).
- A task still running across the window: background work competing with the request.
- For the frontend side rerun with `--trace` and open `target/eval/traces/<id>@<cond>.json`
  in Chrome's Performance panel.
- Name the cause at class level (as in `issue-fix`): it usually affects sibling scenarios.

## 4. Fix, then rerun that scenario until it passes

```sh
pnpm eval --only <scenario> --condition <warm|cold>   # the verdict's `repro`
```

Correctness is enforced, so a faster answer that drops, truncates or serves stale results
fails. Don't trade a budget miss for a degraded answer.

## 5. Full suite, then PR

```sh
pnpm eval                           # vs the baseline from step 1: no new failures or regressions
```

PR per `issue-fix` §6, plus in **How it was verified** the before / after table from
`target/eval/report.md` (both on this machine, commits named) and the tool versions line.

## Guard rails

- Goldens (`evals/*/golden/`) and budgets (`evals/budgets.json`) are human-owned. Don't edit
  them, and don't run `--update-golden`, to make a scenario pass. When a golden looks wrong
  (a tool bump, a deliberate behaviour change), stop and say so: a PR that touches them gets
  `needs-decision`.
- Don't weaken a scenario's checks or timeouts in `evals/<language>/scenarios.ts` to pass.
  Adding a scenario (for a case the sweep or a user found) is fine; record its golden with
  `--update-golden --only <id>` and ask a person to review the file.
- A flaky timing (passes on rerun) is not a regression: rerun once before acting on one.
