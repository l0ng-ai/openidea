//! How batch Inspect Code scales with threads (roadmap phase 9.4.b):
//! `cargo run --release -p ide-php --example inspect_profile -- <app dir> [threads…]`
//! opens the engine on a Laravel application (its index cached in
//! `target/inspect-profile`), then, for each thread count (default 1, 4 and
//! all cores), opens a new session on the same cache, builds the shared
//! model and runs `PhpEngine::inspect_files` over the application's own PHP
//! files and Blade templates in a rayon pool of that size, cold (empty type
//! cache), then again file by file on the same threads and on threads with
//! rayon's default 2 MB stacks (where every parse maps a stack segment of
//! its own, `syntax::stack::parser_stack`). It prints the wall times, the
//! summed time of the files (how much each file slowed down next to the
//! others) and the speed-up over one thread.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ide_core::{CancellationToken, IdeEvent, SharedSink};
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use ide_php::project::LayoutConfig;
use ide_php::stubs::StubFilter;
use ide_php::syntax::stack::PARSER_THREAD_STACK;

const WAIT: Duration = Duration::from_secs(600);

fn open(root: &Path, cache: &Path) -> Arc<PhpEngine> {
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let config = EngineConfig {
        cache_dir: cache.join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.to_path_buf(), ..LayoutConfig::default() },
        stubs: StubFilter::default(),
    };
    let engine = PhpEngine::open(config, sink).expect("engine opens");
    assert!(engine.wait_idle(WAIT));
    engine
}

/// The application's own PHP files and Blade templates, as
/// `tests/laravel_parity.rs` `real_app_inspect_code` lists them.
fn app_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = ["app", "packages", "database", "routes", "resources"]
        .iter()
        .map(|dir| root.join(dir))
        .filter(|dir| dir.is_dir())
        .collect();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let in_resources = path.starts_with(root.join("resources"));
            if path.is_dir() {
                if !["vendor", "node_modules", "storage", ".git"].contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if name.ends_with(".blade.php") || (!in_resources && name.ends_with(".php")) {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// A rayon pool of `threads`, with stacks of `stack` bytes (`None`: rayon's
/// default, 2 MB).
fn pool(threads: usize, stack: Option<usize>) -> rayon::ThreadPool {
    let builder = rayon::ThreadPoolBuilder::new().num_threads(threads);
    let builder = match stack {
        Some(size) => builder.stack_size(size),
        None => builder,
    };
    builder.build().expect("a pool")
}

/// Inspects `files` as Inspect Code does (`PhpEngine::inspect_files`), in a
/// pool of `threads` with parser-sized stacks: the wall time.
fn run(engine: &PhpEngine, files: &[(PathBuf, String)], threads: usize) -> Duration {
    let pool = pool(threads, Some(PARSER_THREAD_STACK));
    let started = Instant::now();
    let done = pool.install(|| {
        engine.inspect_files(
            files,
            |(path, _)| path.as_path(),
            |(_, text)| Some(text.clone()),
            &CancellationToken::new(),
            |_, _| {},
        )
    });
    assert!(done);
    started.elapsed()
}

/// Inspects `files` again file by file (`PhpEngine::inspect_file`) in a
/// pool of `threads` with stacks of `stack`, each file timed: the wall time
/// and the files' times summed.
fn run_timed(
    engine: &PhpEngine,
    files: &[(PathBuf, String)],
    threads: usize,
    stack: Option<usize>,
) -> (Duration, Duration) {
    use rayon::prelude::*;
    let pool = pool(threads, stack);
    let busy = AtomicU64::new(0);
    let started = Instant::now();
    pool.install(|| {
        files.par_iter().for_each(|(path, text)| {
            let at = Instant::now();
            let _ = engine.inspect_file(path, text, &CancellationToken::new());
            busy.fetch_add(at.elapsed().as_nanos() as u64, Ordering::Relaxed);
        });
    });
    (started.elapsed(), Duration::from_nanos(busy.load(Ordering::Relaxed)))
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let root = args.next().map(PathBuf::from).expect("usage: inspect_profile <app dir> [threads…]");
    let root = dunce::canonicalize(&root).expect("the app dir");
    let all = std::thread::available_parallelism().map_or(4, |n| n.get());
    let mut counts: Vec<usize> = args.filter_map(|a| a.to_str()?.parse().ok()).collect();
    if counts.is_empty() {
        counts = vec![1, 4, all];
    }
    let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/inspect-profile");
    let started = Instant::now();
    let engine = open(&root, &cache);
    eprintln!("indexed in {:?}", started.elapsed());
    let _ = engine.laravel_model();
    assert!(engine.wait_idle(WAIT));
    engine.shutdown();
    drop(engine);

    let files: Vec<(PathBuf, String)> = app_files(&root)
        .into_iter()
        .filter_map(|path| {
            let text = std::fs::read_to_string(&path).ok()?;
            Some((path, text))
        })
        .collect();
    eprintln!("{} files", files.len());
    let mut single = None;
    for threads in counts {
        let engine = open(&root, &cache);
        let _ = engine.laravel_model();
        let cold = run(&engine, &files, threads);
        let (warm, busy) = run_timed(&engine, &files, threads, Some(PARSER_THREAD_STACK));
        // As before phase 9.4.b: every parse maps a stack segment of its own.
        let (small, small_busy) = run_timed(&engine, &files, threads, None);
        let base = *single.get_or_insert(cold);
        eprintln!(
            "{threads:>3} threads: cold {:>6.2} s ({:.1}x); again {:>6.2} s (files {:>7.2} s); on 2 MB stacks {:>6.2} s (files {:>7.2} s)",
            cold.as_secs_f64(),
            base.as_secs_f64() / cold.as_secs_f64(),
            warm.as_secs_f64(),
            busy.as_secs_f64(),
            small.as_secs_f64(),
            small_busy.as_secs_f64(),
        );
        engine.shutdown();
    }
}
