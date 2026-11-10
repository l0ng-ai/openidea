# PHP engine performance budgets

Phase 6.3 of the [roadmap](ROADMAP.md). The budgets are criterion benches in `crates/ide-php/benches/engine.rs`, gated by `pnpm perf:rust` against `perf/budgets.json` (`rust.php_…`, means in µs).

| Bench                                                      | Budget | Measured (2026-11-07) |
| ---------------------------------------------------------- | ------ | --------------------- |
| `php_laravel/cold_index` (empty cache → ready)             | 30 s   | 1.67 s                |
| `php_laravel/warm_start` (cache of an earlier run → ready) | 2 s    | 60 ms                 |
| `php_laravel/hover_after_keystroke`                        | 50 ms  | 2.1 ms                |
| `php_laravel/completion_after_keystroke`                   | 50 ms  | 5.7 ms                |
| `php_laravel/diagnostics_after_edit`                       | 300 ms | 214 ms                |
| `php_fixture/cold_index`                                   | 500 ms | 15 ms                 |
| `php_fixture/warm_start`                                   | 200 ms | 8.8 ms                |
| `php_fixture/hover_after_keystroke`                        | 50 ms  | 0.44 ms               |
| `php_fixture/completion_after_keystroke`                   | 50 ms  | 0.24 ms               |
| `php_fixture/diagnostics_after_edit`                       | 300 ms | 126 ms                |

Release (bench) profile on the development machine (Windows 11, 16 threads). laravel/framework is the pinned corpus from `scripts/php-corpus.sh` (3,177 PHP files); without the corpus the `php_laravel/*` benches and their budgets are skipped. The `php_fixture/*` benches use `fixtures/php-app`.

What the benches measure:

- **Cold index / warm start:** `PhpEngine::open` until `wait_idle` reports the indexes up to date.
- **Hover and completion after a keystroke:** a statement is typed in the open file first (`Eloquent/Builder.php`, 2.5k lines, or the fixture's `Library.php`), so the parse and the type cache are stale, which is the slower case. The background inspection of that edit finishes before the clock starts. Criterion reports means. The p95 of completion on the fixture is also asserted by `complete::tests::completion_on_the_fixture_is_fast`.
- **Diagnostics after an edit:** from `document_changed` until the background run has inspected the new version. This includes the 120 ms debounce and every built-in inspection.

## What it took

Diagnostics after an edit on `Eloquent/Builder.php` took 2.75 s at first. Timing each inspection showed where the time went:

- Function and class lookups that miss the index (`Illuminate\Database\Eloquent\array_merge` before the global `array_merge`, for example) fell back to scanning the open buffers. Any buffer that mentioned the name, as the file being inspected always does, was summarised again (`FileSummary::extract`) for every lookup. `PhpEngine::summary` of an open file did the same. Open documents now keep their summary per version (`PhpEngine::open_summary`), and lookups use it without copying (`shared_summary`).
- Each inspection family (members, variables, calls, control flow) and the deprecation check, through semantic spans, built its own `ExprTypes`, so every function's flow graph was built five times. `InspectionContext` now carries one `ExprTypes`, built in `run_inspections`, together with the names and summary it was built on.
- The unused-parameter check listed every subtype of the class again for each public method. It now does that once per class.

After these changes the inspections on `Builder.php` take about 80 ms.

## Laravel model and Inspect Code (phase 9.4)

The Laravel benches (`php_laravel_app/*` on the fixture app, `php_laravel_real/*` on the application in `LARAVEL_APP_DIR`) are described in [laravel.md](laravel.md#performance-phase-821). Phase 9.4 tightened and added these budgets for the real application (Monica):

| Bench                               | Budget | Monica (2026-11-11)                               |
| ----------------------------------- | ------ | ------------------------------------------------- |
| `php_laravel_real/model_cold`       | 400 ms | 230 ms (542 ms in 8.29)                           |
| `php_laravel_real/model_warm_start` | 150 ms | 129 ms                                            |
| `php_laravel_real/inspect_code`     | 20 s   | **24.3 s ✗** (74 s one file after another; 9.4.b) |

- **Cold model:** `laravel_model()` after `forget_laravel_model()`, which also drops the parts stored in the index database. The regression since 8.23 was per-provider work (every provider file parsed again by each part, one after another) and a second read of the configuration for Jetstream's computed route path. The parts of many files are now read in parallel (`PartReader::parts_of`), independent parts of the model are built at the same time, and the configuration is read once.
- **Warm start:** a new engine on the cache of an earlier session. The per-file parts (configuration keys, translations, routes, provider registrations) are stored in the index database with the content hash, size and modification time of their text, so the new session neither reads nor parses the files that didn't change.
- **Inspect Code:** `PhpEngine::inspect_files` inspects the scope's files in parallel (rayon) after building what they share, reports each as it finishes and stops on cancellation. The host's Inspect Code (`ops::analysis::inspect_code`) uses it. The bench runs every built-in inspection over the application's own PHP files and Blade templates (not `vendor/`).

`cargo run --release -p ide-php --example model_profile -- <app>` prints the time of each part of the model, cold and in a new session.

## Memory against Intelephense

`cargo test -p ide-php --release --test memory -- --ignored --nocapture` (needs the corpora and `npm i -g intelephense`) indexes laravel/framework from an empty cache with both:

|                             | Index time | Working set                                                                                                                 |
| --------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Native engine               | 2.0 s      | 74 MB when ready; 153 MB after hover, completion and the inspections on `Builder.php` (the bundled stubs load on first use) |
| Intelephense 1.18 (Node 24) | 4.6 s      | 323 MB after `indexingEnded`                                                                                                |

The engine figure is this test process's whole working set, which starts at 5 MB. The Intelephense figure is its `node` process, started directly so that no shell is measured.
