//! False-positive count of the call and type inspections (lenient mode) on the corpora.
//!
//! Indexes each corpus with the engine, inspects its PHP files (every `step`-th one, see
//! `PHP_UNDEF_STEP`) and lists what `PhpMethodParametersCountMismatch`, `PhpUnknownNamedArgument`,
//! `PhpParams`, `PhpIncompatibleReturnType` and `PhpFieldAssignmentTypeMismatch` report, grouped by
//! message with the first place, for review.
//! Classes whose hierarchy reaches a class the corpus doesn't contain (the corpora are cloned
//! without `vendor/`) count as accepting anything, so every entry is either a real
//! problem or a false positive.
//!
//! The report goes to `target/php-differential/calls-types.md`. Ignored: it needs the
//! corpora (`scripts/php-corpus.sh`).
//!
//! ```text
//! cargo test -p ide-php --test calls_types -- --ignored --exact corpus --nocapture
//! ```
//!
//! Environment: `PHP_CORPUS_DIR` (default `../php-corpus` next to the workspace),
//! `PHP_DIFF_CORPUS` (comma-separated corpus directory names, default all three) and
//! `PHP_UNDEF_STEP` (inspect every n-th file, default 1).

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ide_core::{CancellationToken, DocId, IdeEvent, SharedSink};
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use ide_php::project::LayoutConfig;
use ide_php::stubs::StubFilter;

const INSPECTIONS: [&str; 5] = [
    "PhpMethodParametersCountMismatch",
    "PhpUnknownNamedArgument",
    "PhpParams",
    "PhpIncompatibleReturnType",
    "PhpFieldAssignmentTypeMismatch",
];

/// A corpus: its directory and the folders inspected.
const CORPORA: [(&str, &[&str]); 3] =
    [("laravel-framework", &["src"]), ("symfony", &["src"]), ("wordpress", &["wp-admin", "wp-includes"])];

fn corpus_root() -> PathBuf {
    std::env::var_os("PHP_CORPUS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../php-corpus"))
}

fn php_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            php_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "php") {
            out.push(path);
        }
    }
}

/// Inspects one corpus; returns `(files, reports)`.
fn run(dir: &str, folders: &[&str], root: &Path, step: usize, report: &mut String) -> (usize, usize) {
    let cache = tempfile::tempdir().unwrap();
    let config = EngineConfig {
        cache_dir: cache.path().join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.to_path_buf(), ..LayoutConfig::default() },
        stubs: StubFilter::default(),
    };
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let started = Instant::now();
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(Duration::from_secs(3600)), "indexing {dir}");
    let indexed = started.elapsed();
    let mut files = Vec::new();
    for folder in folders {
        php_files(&root.join(folder), &mut files);
    }
    files.sort();
    // `message` → `(count, first file:line)`.
    let mut found: BTreeMap<String, (usize, String)> = BTreeMap::new();
    let mut inspected_files = 0;
    let started = Instant::now();
    for (i, path) in files.iter().enumerate().filter(|(i, _)| i % step == 0) {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        let trace = std::env::var_os("PHP_UNDEF_TRACE").is_some();
        if trace {
            eprintln!("{}", path.display());
        }
        let doc = DocId(i as u32 + 1);
        engine.document_opened(doc, path, 1, &text);
        let file_started = Instant::now();
        let inspected = engine.inspect(doc, &CancellationToken::new()).unwrap();
        if trace && file_started.elapsed() > Duration::from_secs(1) {
            eprintln!("  slow: {:.1?}", file_started.elapsed());
        }
        engine.document_closed(doc);
        inspected_files += 1;
        let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        for problem in inspected.problems.iter().filter(|p| INSPECTIONS.contains(&p.inspection)) {
            let line = problem.range.start.line + 1;
            let entry = found.entry(problem.message.clone()).or_insert((0, format!("{rel}:{line}")));
            entry.0 += 1;
        }
    }
    let inspected = started.elapsed();
    engine.shutdown();
    let total: usize = found.values().map(|(n, _)| n).sum();
    writeln!(
        report,
        "## {dir}\n\nIndexed in {indexed:.1?}; inspected {inspected_files} files in {inspected:.1?}. Reported: {total}.\n",
    )
    .unwrap();
    let mut list: Vec<_> = found.iter().collect();
    list.sort_by(|a, b| b.1.0.cmp(&a.1.0).then(a.0.cmp(b.0)));
    for (message, (n, at)) in list {
        writeln!(report, "- {message} ×{n} (first: `{at}`)").unwrap();
    }
    writeln!(report).unwrap();
    (inspected_files, total)
}

#[test]
#[ignore = "needs the corpora (scripts/php-corpus.sh)"]
fn corpus() {
    let root = corpus_root();
    let wanted: Option<Vec<String>> =
        std::env::var("PHP_DIFF_CORPUS").ok().map(|v| v.split(',').map(|s| s.trim().to_owned()).collect());
    let step: usize = std::env::var("PHP_UNDEF_STEP").ok().and_then(|s| s.parse().ok()).unwrap_or(1).max(1);
    let mut report = String::from("# Call and type problems on the corpora\n\n");
    writeln!(report, "Every {step}. file inspected; corpora have no `vendor/`.\n").unwrap();
    let mut ran = 0;
    for (dir, folders) in CORPORA {
        if wanted.as_ref().is_some_and(|w| !w.iter().any(|d| d == dir)) {
            continue;
        }
        let path = root.join(dir);
        if !path.is_dir() {
            eprintln!("skipping {}: not found", path.display());
            continue;
        }
        let path = dunce::canonicalize(path).unwrap();
        let (files, total) = run(dir, folders, &path, step, &mut report);
        eprintln!("{dir}: {files} files, {total} reported");
        ran += 1;
    }
    assert!(ran > 0, "no corpus under {}", root.display());
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/php-differential");
    std::fs::create_dir_all(&out).unwrap();
    let name = match &wanted {
        Some(w) if w.len() == 1 => format!("calls-types-{}.md", w[0]),
        _ => "calls-types.md".to_owned(),
    };
    std::fs::write(out.join(&name), &report).unwrap();
    eprintln!("report: {}", out.join(&name).display());
}
