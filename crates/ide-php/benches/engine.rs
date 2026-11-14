//! `cargo bench -p ide-php`: the native PHP engine's performance budgets
//! (roadmap phase 6.3, checked by `pnpm perf:rust` against
//! `perf/budgets.json`):
//!
//! - cold index (no cache) and warm start (cache from an earlier run): open
//!   the engine and wait until it is ready,
//! - hover and completion right after a keystroke (the parse and the type
//!   cache are both stale), under 50 ms,
//! - diagnostics after an edit: from the change until the background run
//!   has inspected the new version (debounce included), under 300 ms.
//!
//! `php_fixture/*` runs on `fixtures/php-library`. `php_laravel/*` runs on
//! laravel/framework from the corpora (`PHP_CORPUS_DIR`, default
//! `../php-corpus` next to the workspace; `scripts/php-corpus.sh`) and is
//! skipped when the corpus isn't there: cold index under 30 s, warm start
//! under 2 s, and the request latencies on `Eloquent/Builder.php`
//! (2.5k lines).
//!
//! The Laravel support budgets (roadmap phase 8.21): `php_laravel_app/*` on
//! `fixtures/laravel-app` (with `fixtures/laravel-stubs` as its `vendor/`),
//! and `php_laravel_real/*` on a real application with `vendor/` when
//! `LARAVEL_APP_DIR` points to one (skipped otherwise):
//!
//! - `model_cold`: the whole project model (`PhpEngine::laravel_model`)
//!   after `PhpEngine::forget_laravel_model`, so `composer.json`, `ide.json`
//!   and the module manifests are read again and no part is stored, under
//!   2 s (400 ms on the real application, phase 9.4),
//! - `model_warm_start`: the same in a new session on the cache of an
//!   earlier one, which stored the parts read from single files (phase 9.4),
//!   under 150 ms on the real application,
//! - `model_warm`: the same right after a keystroke in a route file, under
//!   200 ms,
//! - `string_completion`: completion in `route('…')` right after a
//!   keystroke, under 50 ms,
//! - `route_hints`: the route hints of the whole route file right after a
//!   keystroke, under 100 ms,
//! - `inspect_code`: batch Inspect Code (`PhpEngine::inspect_files`, in
//!   parallel since phase 9.4) over the application's own PHP files and
//!   Blade templates (not `vendor/`), every built-in inspection on, under
//!   20 s on the real application.
//!
//! These run with no inspections, so nothing builds the model in the
//! background: each timed request pays for what it rebuilds.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use criterion::{Criterion, SamplingMode, black_box, criterion_group, criterion_main};
use ide_core::{CancellationToken, DocId, IdeEvent, Pos, Range, SharedSink};
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, EngineState, PhpEngine};
use ide_php::inspect::Inspections;
use ide_php::project::LayoutConfig;
use ide_php::stubs::StubFilter;

/// Indexing laravel takes seconds; anything over this is a hang.
const WAIT: Duration = Duration::from_secs(600);

/// A project and the edit, hover and completion the request benches make
/// in one of its files.
struct Workload {
    group: &'static str,
    root: PathBuf,
    /// The file opened in the editor, relative to `root`.
    file: &'static str,
    /// Hover on the first occurrence of `.0`, `.1` bytes into it.
    hover: (&'static str, usize),
    /// The statement after which a line is typed.
    anchor: &'static str,
    /// The line typed for completion, which completes at its end.
    typed: &'static str,
    /// Whether to time cold index and warm start too.
    startup: bool,
}

fn fixture() -> Workload {
    Workload {
        group: "php_fixture",
        root: canonical(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-library")),
        file: "src/Library.php",
        hover: ("->save($book)", 2),
        anchor: "$lent = $book->withAvailability(false);",
        typed: "        $lent->",
        startup: true,
    }
}

fn laravel() -> Option<Workload> {
    let base = std::env::var_os("PHP_CORPUS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../php-corpus"));
    let root = base.join("laravel-framework");
    if !root.join("composer.json").is_file() {
        eprintln!("php_laravel: no corpus at {} (scripts/php-corpus.sh), skipped", root.display());
        return None;
    }
    Some(Workload {
        group: "php_laravel",
        root: canonical(&root),
        file: "src/Illuminate/Database/Eloquent/Builder.php",
        hover: ("$this->query->whereIn(", 14),
        anchor: "$this->query->whereIn($this->model->getQualifiedKeyName(), $id);",
        typed: "                $this->query->",
        startup: true,
    })
}

fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Opens the engine on `root` with its cache in `cache` and waits until the
/// indexes are up to date.
fn open_engine(root: &Path, cache: &Path) -> Arc<PhpEngine> {
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let config = EngineConfig {
        cache_dir: cache.join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.to_path_buf(), ..LayoutConfig::default() },
        stubs: StubFilter::default(),
    };
    let engine = PhpEngine::open(config, sink).expect("engine opens");
    assert!(engine.wait_idle(WAIT), "indexing {} timed out", root.display());
    assert_eq!(engine.status().state, EngineState::Ready, "{}", root.display());
    engine
}

/// The 0-based line and UTF-16 column of byte `offset`.
fn pos_of(text: &str, offset: usize) -> Pos {
    let before = &text[..offset];
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    Pos { line: before.matches('\n').count() as u32, col: before[line_start..].encode_utf16().count() as u32 }
}

fn bench(c: &mut Criterion) {
    let workloads: Vec<Workload> = std::iter::once(fixture()).chain(laravel()).collect();
    for workload in &workloads {
        bench_workload(c, workload);
    }
    for app in laravel_apps() {
        bench_laravel_app(c, &app);
    }
}

/// A Laravel application for the Laravel support benches.
struct LaravelApp {
    group: &'static str,
    root: PathBuf,
    /// The temporary copy `root` is in, for the fixture.
    _copy: Option<tempfile::TempDir>,
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// The fixture app (copied with its stub `vendor/`), and the application of
/// `LARAVEL_APP_DIR` when it is set.
fn laravel_apps() -> Vec<LaravelApp> {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let copy = tempfile::tempdir().unwrap();
    let root = canonical(copy.path()).join("laravel-app");
    copy_dir(&fixtures.join("laravel-app"), &root);
    copy_dir(&fixtures.join("laravel-stubs"), &root.join("vendor"));
    let mut out = vec![LaravelApp { group: "php_laravel_app", root, _copy: Some(copy) }];
    match std::env::var_os("LARAVEL_APP_DIR").map(PathBuf::from) {
        Some(dir) if dir.join("artisan").is_file() && dir.join("vendor").is_dir() => {
            out.push(LaravelApp { group: "php_laravel_real", root: canonical(&dir), _copy: None });
        }
        Some(dir) => eprintln!("php_laravel_real: {} has no artisan or vendor/, skipped", dir.display()),
        None => eprintln!("php_laravel_real: LARAVEL_APP_DIR isn't set, skipped"),
    }
    out
}

/// `routes/web.php` when it registers routes, else the file registering
/// the most.
fn route_file(engine: &PhpEngine, root: &Path) -> PathBuf {
    let routes = engine.laravel_routes().expect("the routes");
    let mut counts: Vec<(PathBuf, usize)> = Vec::new();
    for route in routes.routes() {
        match counts.iter_mut().find(|(path, _)| *path == route.path) {
            Some((_, count)) => *count += 1,
            None => counts.push((route.path.clone(), 1)),
        }
    }
    let web = root.join("routes").join("web.php");
    let is_web = |path: &Path| path.strip_prefix(root).is_ok_and(|rel| rel == Path::new("routes").join("web.php"));
    if let Some((path, _)) = counts.iter().find(|(path, _)| is_web(path)) {
        return path.clone();
    }
    counts.into_iter().max_by_key(|(_, count)| *count).map_or(web, |(path, _)| path)
}

fn bench_laravel_app(c: &mut Criterion, app: &LaravelApp) {
    let mut g = c.benchmark_group(app.group);
    g.sample_size(20).sampling_mode(SamplingMode::Auto).warm_up_time(Duration::from_millis(500));
    g.measurement_time(Duration::from_secs(5));
    let cache = tempfile::tempdir().unwrap();
    let engine = open_engine(&app.root, cache.path());
    engine.set_inspections(Inspections::default());
    let summary = engine.laravel_model().unwrap_or_else(|| panic!("{}: not a Laravel project", app.root.display()));
    eprintln!("{}: {summary:?}", app.group);

    // The route file open in the editor: `routes/web.php` when it has
    // routes, else the file with the most (an app whose routes come from
    // packages). A keystroke adds a statement at its end, a different one
    // each time.
    let path = route_file(&engine, &app.root);
    eprintln!("{}: route file {}", app.group, path.display());
    let original = std::fs::read_to_string(&path).expect("the route file");
    let doc = DocId(1);
    let mut version = 1;
    engine.document_opened(doc, &path, version, &original);
    assert!(engine.wait_inspections(WAIT));
    let edited = |n: u32| format!("{original}\n$bench{n} = {n};\n");

    g.bench_function("model_cold", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                engine.forget_laravel_model();
                let started = Instant::now();
                let built = engine.laravel_model();
                total += started.elapsed();
                assert!(black_box(built).is_some());
            }
            total
        })
    });

    g.bench_function("model_warm", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                version += 1;
                engine.document_changed(doc, version, &edited(version));
                assert!(engine.wait_inspections(WAIT));
                let started = Instant::now();
                let built = engine.laravel_model();
                total += started.elapsed();
                assert!(black_box(built).is_some());
            }
            total
        })
    });

    // `route('` typed on a new line after the keystroke's statement.
    g.bench_function("string_completion", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                version += 1;
                let text = format!("{}route('');\n", edited(version));
                let at = pos_of(&text, text.len() - "');\n".len());
                engine.document_changed(doc, version, &text);
                assert!(engine.wait_inspections(WAIT));
                let started = Instant::now();
                let found = engine.completion(doc, at, Some("'"), &CancellationToken::new());
                total += started.elapsed();
                assert!(found.is_some_and(|found| !found.items.is_empty()), "{}: no route names", app.group);
            }
            total
        })
    });

    g.bench_function("route_hints", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                version += 1;
                let text = edited(version);
                let end = pos_of(&text, text.len());
                engine.document_changed(doc, version, &text);
                assert!(engine.wait_inspections(WAIT));
                let started = Instant::now();
                let hints = engine.laravel_route_hints(doc, Range { start: Pos::default(), end });
                total += started.elapsed();
                assert!(black_box(hints).is_some_and(|hints| !hints.is_empty()), "{}: no route hints", app.group);
            }
            total
        })
    });

    // Inspect Code over the application's own code, every built-in
    // inspection on. Seconds per run on a real application: single runs.
    let files = own_code(&app.root);
    eprintln!("{}: Inspect Code over {} files", app.group, files.len());
    engine.set_inspections(Inspections::builtin());
    g.sample_size(10).sampling_mode(SamplingMode::Flat).warm_up_time(Duration::from_millis(1));
    g.measurement_time(Duration::from_secs(1));
    g.bench_function("inspect_code", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                let problems = std::sync::atomic::AtomicUsize::new(0);
                let started = Instant::now();
                let done = engine.inspect_files(
                    &files,
                    |path| path.as_path(),
                    |path| std::fs::read_to_string(path).ok(),
                    &CancellationToken::new(),
                    |_, found| {
                        let found = found.map_or(0, |found| found.len());
                        problems.fetch_add(found, std::sync::atomic::Ordering::Relaxed);
                    },
                );
                total += started.elapsed();
                assert!(done);
                black_box(problems.into_inner());
            }
            total
        })
    });
    engine.set_inspections(Inspections::default());

    // A new session on this cache: the parts read from single files are
    // stored (written by the worker after the builds above), so the build
    // takes them from the index database. Each run opens the engine (not
    // timed) and builds the model.
    assert!(engine.laravel_model().is_some());
    assert!(engine.wait_idle(WAIT));
    assert!(engine.laravel_stored_parts() > 0, "{}: no part stored", app.group);
    engine.shutdown();
    drop(engine);
    g.bench_function("model_warm_start", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                let engine = open_engine(&app.root, cache.path());
                engine.set_inspections(Inspections::default());
                let started = Instant::now();
                let built = engine.laravel_model();
                total += started.elapsed();
                assert!(black_box(built).is_some());
                assert!(!engine.laravel_part_loads().is_empty(), "{}: nothing taken from the store", app.group);
                engine.shutdown();
            }
            total
        })
    });

    g.finish();
}

/// The application's own PHP files and Blade templates: `app/`,
/// `packages/`, `database/`, `routes/` and the templates of `resources/`,
/// never `vendor/` or `node_modules/`.
fn own_code(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, php: bool, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
        entries.sort();
        for path in entries {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if path.is_dir() {
                if name != "vendor" && name != "node_modules" && !name.starts_with('.') {
                    walk(&path, php, out);
                }
            } else if name.ends_with(".blade.php") || (php && name.ends_with(".php")) {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    for dir in ["app", "packages", "database", "routes"] {
        walk(&root.join(dir), true, &mut out);
    }
    walk(&root.join("resources"), false, &mut out);
    out
}

fn bench_workload(c: &mut Criterion, w: &Workload) {
    let mut g = c.benchmark_group(w.group);

    if w.startup {
        // Cold index: an empty cache every time. Laravel takes seconds per
        // run, so the samples are single runs and there is no warm-up worth
        // the name.
        g.sample_size(10).sampling_mode(SamplingMode::Flat).warm_up_time(Duration::from_millis(1));
        g.measurement_time(Duration::from_secs(1));
        g.bench_function("cold_index", |b| {
            b.iter_custom(|iters| {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    let cache = tempfile::tempdir().unwrap();
                    let started = Instant::now();
                    let engine = open_engine(&w.root, cache.path());
                    total += started.elapsed();
                    black_box(engine.status().files);
                    engine.shutdown();
                }
                total
            })
        });

        // Warm start: the cache of an earlier run, nothing changed on disk.
        let cache = tempfile::tempdir().unwrap();
        open_engine(&w.root, cache.path()).shutdown();
        g.bench_function("warm_start", |b| {
            b.iter_custom(|iters| {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    let started = Instant::now();
                    let engine = open_engine(&w.root, cache.path());
                    total += started.elapsed();
                    engine.shutdown();
                }
                total
            })
        });
    }

    // The requests: one engine with the file open, as in the editor.
    g.sample_size(30).sampling_mode(SamplingMode::Auto).warm_up_time(Duration::from_millis(500));
    g.measurement_time(Duration::from_secs(5));
    let cache = tempfile::tempdir().unwrap();
    let engine = open_engine(&w.root, cache.path());
    let path = w.root.join(w.file);
    let original = std::fs::read_to_string(&path).unwrap();
    let doc = DocId(1);
    let mut version = 1;
    engine.document_opened(doc, &path, version, &original);
    assert!(engine.wait_inspections(WAIT));

    // A keystroke that changes nothing the requests look at: a statement
    // after the anchor, a different one each time.
    let anchor = original.find(w.anchor).unwrap_or_else(|| panic!("{} in {}", w.anchor, w.file)) + w.anchor.len();
    let indent: String = w.typed.chars().take_while(|c| *c == ' ').collect();
    let edited = |n: u32| format!("{}\n{indent}$bench{n} = {n};{}", &original[..anchor], &original[anchor..]);
    let hover_at = pos_of(&original, original.find(w.hover.0).expect("hover target") + w.hover.1);
    let hover_check = engine.hover(doc, hover_at);
    assert!(hover_check.is_some(), "{}: no hover at {hover_at:?}", w.group);

    g.bench_function("hover_after_keystroke", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                version += 1;
                // The edit comes after the hover target, which stays put.
                engine.document_changed(doc, version, &edited(version));
                assert!(engine.wait_inspections(WAIT));
                let started = Instant::now();
                let found = engine.hover(doc, hover_at);
                total += started.elapsed();
                assert!(found.is_some());
            }
            total
        })
    });

    let typed = format!("{}\n{}{}", &original[..anchor], w.typed, &original[anchor..]);
    let complete_at = pos_of(&typed, anchor + 1 + w.typed.len());
    g.bench_function("completion_after_keystroke", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                version += 1;
                engine.document_changed(doc, version, &typed);
                assert!(engine.wait_inspections(WAIT));
                let started = Instant::now();
                let found = engine.completion(doc, complete_at, Some(">"), &CancellationToken::new());
                total += started.elapsed();
                assert!(found.is_some_and(|found| !found.items.is_empty()));
            }
            total
        })
    });

    // From the edit until the background run published the new version's
    // diagnostics: the debounce plus every built-in inspection (the
    // default set).
    g.bench_function("diagnostics_after_edit", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                version += 1;
                let text = edited(version);
                let started = Instant::now();
                engine.document_changed(doc, version, &text);
                assert!(engine.wait_inspections(WAIT));
                total += started.elapsed();
                let inspected = engine.inspected(doc).expect("open");
                assert_eq!(inspected.version, version);
            }
            total
        })
    });

    g.finish();
    engine.shutdown();
}

criterion_group!(benches, bench);
criterion_main!(benches);
