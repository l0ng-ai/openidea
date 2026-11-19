# IDE comparison

`pnpm perf` measures OpenIDEA from inside its webview. This measures any IDE
from the outside, the same way for each, so OpenIDEA can be compared with
IntelliJ IDEA (or anything else listed in `apps.toml`).

```sh
pip install -r perf/compare/requirements.txt
python perf/compare/bench.py ~/src/spring-petclinic --runs 10
python perf/compare/bench.py ~/src/spring-petclinic --runs 5 --wipe-caches   # cold index
```

Each run launches the app on the project, waits until it is ready, idles,
closes it, and records:

| Metric                                      | How                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `window_s`                                  | first visible window whose title matches `window_title` (the project name)                                            |
| `ready_s`                                   | the process tree's CPU stays under `--quiet-cores` for `--quiet-secs`, after the window and any `ready_after` markers |
| markers                                     | first/last time a log line matches, e.g. OpenIDEA `indexed`, IDEA `exit dumb mode`                                    |
| `peak_rss_mb`, `rss_mb`, `uss_mb`, `pss_mb` | summed over every process the app started (WebView2/WebKit, jdtls, language servers, the JVM)                         |
| `total_cpu_s`, `idle_cpu_pct`               | CPU time until ready; CPU while idle for `--idle-secs`                                                                |
| `exit_s`                                    | until every process has exited                                                                                        |
| `cache_mb`, install size                    | `cache_dirs`, `install_dir`                                                                                           |

Apps run interleaved, rotating the order, after `--warmup` unaggregated runs.
Every attempt, including warmups and failed launches, is retained in
`results/<time>-<project>-<unique>/`: `report.md`, `results.json`, and each
launched run's stdout. Reports are refreshed before and after each attempt
and on errors or interruption; separate invocations never overwrite each other.

The table shows median (min–max) and **valid/attempted** measured-trial counts
for every fixed metric, even when there are zero valid values. Only completely
valid trials enter aggregates; failed trials retain partial measurements and
explicit reasons in JSON and the attempts table. Warmups never enter medians
but a failed warmup still fails the suite. An empty or incomplete suite is not
successful.

Startup timeout, early exit/crash, observation/access errors, invalid or missing
required metrics, quit-command errors, forced termination, and interruption
produce a nonzero exit. JSON records `status`, `reasons`, `warmup`, and
`metric_status` (`valid`, `missing`, `invalid`, or `unsupported`). Nonfinite
numeric evidence is preserved as an `invalid_number` object, never JSON NaN.
Unsupported window observation, non-Linux PSS, and unconfigured cache directories
are explicit exclusions rather than missing required values. Unobserved optional
log markers do not fail a trial; `ready_after` markers are required.

`--runs` must be positive; `--warmup` and `--cooldown` may be zero. Other
durations and the CPU threshold must be finite and positive, and the quiet
period cannot exceed the startup timeout.

Shutdown always runs after a launch, including observation errors and Ctrl-C.
`--close-timeout` bounds the quit command plus graceful wait; each forced cleanup
has at most two additional seconds to reap processes. `--command-timeout`
(default 60 seconds) bounds `--drop-os-cache`, including interactive commands.
Only processes attributed to the launch are terminated; preexisting instances
are refused, never killed. Configured `daemons` remain explicitly excluded from
shutdown and forced cleanup. POSIX launch-owned process groups retain orphaned
children; on Windows discovery uses the recorded process ancestry.

Run the small process-fixture regressions without launching an installed IDE:

```sh
python -m unittest discover -s perf/compare -p 'test_bench.py'
```

## Fair runs

- Release builds only; a running instance of the same executable (a
  `pnpm tauri dev` build too) would take over the launch, so the script refuses.
- IDEA: open the project once by hand and trust it; turn off _Reopen projects
  on startup_ and _Confirm before exiting_; note the version, `-Xmx` and whether
  Shared Indexes were on.
- Same machine, power plan and plugged in; exclude the project and caches from
  antivirus scanning, or neither.
- `--drop-os-cache` runs a command before each launch for a cold OS cache:
  `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches` (Linux), `sudo purge`
  (macOS), `RAMMap64.exe -Et` (Windows, admin).
- Typing latency is not covered: measure it on screen with Typometer for both.

## Platform notes

- Windows: windows via `user32`, closed with `WM_CLOSE`.
- macOS: windows via Quartz (`pyobjc-framework-Quartz`; titles need Screen
  Recording permission). WebKit helpers are children of launchd and are
  attributed through `responsibility_get_pid_responsible_for_pid`. Without that
  API, unrelated WebKit processes are not guessed by name/start time or killed.
- Linux: windows via `wmctrl` (X11). Without it `window_s` is skipped and
  readiness counts from launch.
