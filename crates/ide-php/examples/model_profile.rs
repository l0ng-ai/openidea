//! Where the Laravel project model's time goes (roadmap phase 9.4):
//! `cargo run --release -p ide-php --example model_profile -- <app dir>`
//! opens the engine on a Laravel application (its index cached in
//! `target/model-profile`), builds the model cold a few times
//! (`PhpEngine::forget_laravel_model` first), then opens new sessions on the
//! same cache (the parts stored by the first) and builds it there. Each
//! prints the time of every part, in the order `PhpEngine::laravel_model`
//! builds them.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ide_core::{IdeEvent, SharedSink};
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use ide_php::inspect::Inspections;
use ide_php::project::LayoutConfig;
use ide_php::stubs::StubFilter;

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
    engine.set_inspections(Inspections::default());
    engine
}

/// Builds every part of the model, timing each.
fn steps(engine: &PhpEngine, totals: &mut Vec<(&'static str, Duration)>) {
    let mut step = |name: &'static str, f: &dyn Fn()| {
        let at = Instant::now();
        f();
        let took = at.elapsed();
        match totals.iter_mut().find(|(n, _)| *n == name) {
            Some((_, total)) => *total += took,
            None => totals.push((name, took)),
        }
    };
    let all = Instant::now();
    step("facts", &|| drop(engine.resolver().laravel()));
    step("project", &|| drop(engine.laravel()));
    step("routes", &|| drop(engine.laravel_routes()));
    step("views", &|| drop(engine.laravel_views()));
    step("blade", &|| drop(engine.laravel_blade()));
    step("config", &|| drop(engine.laravel_config()));
    step("translations", &|| drop(engine.laravel_translations()));
    step("env", &|| drop(engine.laravel_env()));
    step("assets", &|| drop(engine.laravel_assets()));
    step("auth", &|| drop(engine.laravel_auth()));
    step("artisan", &|| drop(engine.laravel_artisan()));
    step("livewire", &|| drop(engine.laravel_livewire()));
    step("inertia", &|| drop(engine.laravel_inertia()));
    step("rest (registrations, models)", &|| {
        let _ = engine.laravel_model();
    });
    let took = all.elapsed();
    step("total", &|| ());
    totals.last_mut().expect("total").1 += took;
}

fn print(title: &str, totals: &[(&str, Duration)], runs: u32) {
    eprintln!("{title}");
    for (name, total) in totals {
        eprintln!("{name:>30}: {:>8.1} ms", total.as_secs_f64() * 1000.0 / f64::from(runs));
    }
}

fn main() {
    let root = std::env::args_os().nth(1).map(PathBuf::from).expect("usage: model_profile <app dir>");
    let root = dunce::canonicalize(&root).expect("the app dir");
    let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/model-profile");
    let started = Instant::now();
    let engine = open(&root, &cache);
    eprintln!("indexed in {:?}", started.elapsed());
    let first = Instant::now();
    let summary = engine.laravel_model().expect("a Laravel project");
    eprintln!("first build {:?}: {summary:?}", first.elapsed());

    let runs = 5;
    let mut totals = Vec::new();
    for _ in 0..runs {
        engine.forget_laravel_model();
        steps(&engine, &mut totals);
    }
    print("cold (after forget_laravel_model):", &totals, runs);
    let mut whole = Duration::ZERO;
    for _ in 0..runs {
        engine.forget_laravel_model();
        let at = Instant::now();
        engine.laravel_model().expect("the model");
        whole += at.elapsed();
    }
    eprintln!("cold laravel_model(): {:.1} ms", whole.as_secs_f64() * 1000.0 / f64::from(runs));

    // New sessions on the same cache, with the parts stored.
    let _ = engine.laravel_model();
    assert!(engine.wait_idle(WAIT));
    eprintln!("stored parts: {}", engine.laravel_stored_parts());
    engine.shutdown();
    drop(engine);
    let mut totals = Vec::new();
    let sessions = 3;
    for _ in 0..sessions {
        let engine = open(&root, &cache);
        steps(&engine, &mut totals);
        eprintln!(
            "warm start: {} parts loaded, {} read",
            engine.laravel_part_loads().len(),
            engine.laravel_part_reads().len()
        );
        engine.shutdown();
    }
    print("warm start (a new session, parts stored):", &totals, sessions);
    let mut whole = Duration::ZERO;
    for _ in 0..sessions {
        let engine = open(&root, &cache);
        let at = Instant::now();
        engine.laravel_model().expect("the model");
        whole += at.elapsed();
        engine.shutdown();
    }
    eprintln!("warm start laravel_model(): {:.1} ms", whole.as_secs_f64() * 1000.0 / f64::from(sessions));
}
