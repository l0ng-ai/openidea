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
//! `php_fixture/*` runs on `fixtures/php-app`. `php_laravel/*` runs on
//! laravel/framework from the corpora (`PHP_CORPUS_DIR`, default
//! `../php-corpus` next to the workspace; `scripts/php-corpus.sh`) and is
//! skipped when the corpus isn't there: cold index under 30 s, warm start
//! under 2 s, and the request latencies on `Eloquent/Builder.php`
//! (2.5k lines).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use criterion::{Criterion, SamplingMode, black_box, criterion_group, criterion_main};
use ide_core::{CancellationToken, DocId, IdeEvent, Pos, SharedSink};
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, EngineState, PhpEngine};
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
        root: canonical(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-app")),
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
