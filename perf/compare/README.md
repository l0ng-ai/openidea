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

| Metric | How |
|---|---|
| `window_s` | first visible window whose title matches `window_title` (the project name) |
| `ready_s` | the process tree's CPU stays under `--quiet-cores` for `--quiet-secs`, after the window and any `ready_after` markers |
| markers | first/last time a log line matches, e.g. OpenIDEA `indexed`, IDEA `exit dumb mode` |
| `peak_rss_mb`, `rss_mb`, `uss_mb`, `pss_mb` | summed over every process the app started (WebView2/WebKit, jdtls, language servers, the JVM) |
| `total_cpu_s`, `idle_cpu_pct` | CPU time until ready; CPU while idle for `--idle-secs` |
| `exit_s` | until every process has exited |
| `cache_mb`, install size | `cache_dirs`, `install_dir` |

Apps run interleaved, rotating the order, after `--warmup` discarded runs.
Output goes to `results/<time>-<project>/`: `report.md` (median, min–max),
`results.json`, and each run's stdout.

## Fair runs

- Release builds only; a running instance of the same executable (a
  `pnpm tauri dev` build too) would take over the launch, so the script refuses.
- IDEA: open the project once by hand and trust it; turn off *Reopen projects
  on startup* and *Confirm before exiting*; note the version, `-Xmx` and whether
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
  attributed through `responsibility_get_pid_responsible_for_pid`.
- Linux: windows via `wmctrl` (X11). Without it `window_s` is skipped and
  readiness counts from launch.
