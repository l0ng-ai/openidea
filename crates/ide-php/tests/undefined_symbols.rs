//! False-positive count of the undefined-symbol inspections on the corpora.
//!
//! Indexes each corpus with the engine, inspects its PHP files (every `step`-th one, see
//! `PHP_UNDEF_STEP`) and sorts what `PhpUndefinedClass`, `PhpUndefinedFunction` and
//! `PhpUndefinedConstant` report into:
//!
//! - **external**: names in a namespace the corpus doesn't own (`Doctrine\…`, `Psr\…`). The
//!   corpora are cloned without `vendor/`, so these are expected.
//! - **own**: names in the corpus's own namespaces (`Illuminate\…`, `Symfony\…`) or global
//!   ones. These are the candidates for false positives and are listed in full for review.
//!
//! The report goes to `target/php-differential/undefined-symbols.md`. Ignored: it needs the
//! corpora (`scripts/php-corpus.sh`).
//!
//! ```text
//! cargo test -p ide-php --test undefined_symbols -- --ignored --exact corpus --nocapture
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

const INSPECTIONS: [&str; 3] = ["PhpUndefinedClass", "PhpUndefinedFunction", "PhpUndefinedConstant"];

/// A corpus: its directory, the folders inspected, and the namespaces it owns.
struct Corpus {
    dir: &'static str,
    folders: &'static [&'static str],
    owns: &'static [&'static str],
}

const CORPORA: [Corpus; 3] = [
    Corpus { dir: "laravel-framework", folders: &["src"], owns: &["Illuminate"] },
    Corpus { dir: "symfony", folders: &["src"], owns: &["Symfony"] },
    Corpus { dir: "wordpress", folders: &["wp-admin", "wp-includes"], owns: &[] },
];

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

#[derive(Default)]
struct Tally {
    files: usize,
    external: BTreeMap<String, usize>,
    /// `message` → `(count, first file:line)`.
    own: BTreeMap<String, (usize, String)>,
}

/// The first namespace segment of a reported name (`''` for a global one).
fn root_namespace(name: &str) -> &str {
    let name = name.trim_start_matches('\\');
    match name.find('\\') {
        Some(i) => &name[..i],
        None => "",
    }
}

fn run(corpus: &Corpus, root: &Path, step: usize, report: &mut String) -> Tally {
    let cache = tempfile::tempdir().unwrap();
    let config = EngineConfig {
        cache_dir: cache.path().join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.to_path_buf(), ..LayoutConfig::default() },
        stubs: StubFilter::default(),
    };
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let started = Instant::now();
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(Duration::from_secs(3600)), "indexing {}", corpus.dir);
    let indexed = started.elapsed();
    let mut files = Vec::new();
    for folder in corpus.folders {
        php_files(&root.join(folder), &mut files);
    }
    files.sort();
    let mut tally = Tally::default();
    let started = Instant::now();
    for (i, path) in files.iter().enumerate().filter(|(i, _)| i % step == 0) {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        let doc = DocId(i as u32 + 1);
        engine.document_opened(doc, path, 1, &text);
        let inspected = engine.inspect(doc, &CancellationToken::new()).unwrap();
        engine.document_closed(doc);
        tally.files += 1;
        let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        for problem in inspected.problems.iter().filter(|p| INSPECTIONS.contains(&p.inspection)) {
            // `Undefined class 'Name'`: the name is what the code wrote; resolve the root
            // namespace from the text before the quotes is enough for this tally.
            let written = problem.message.split('\'').nth(1).unwrap_or_default();
            let start = problem.start as usize;
            let resolved_root = root_namespace(written);
            let external = !resolved_root.is_empty() && !corpus.owns.contains(&resolved_root)
                || written_is_imported_external(&text, written, corpus.owns);
            if external {
                *tally.external.entry(resolved_root_or_import(&text, written)).or_default() += 1;
            } else {
                let line = text[..start.min(text.len())].matches('\n').count() + 1;
                let entry = tally.own.entry(problem.message.clone()).or_insert((0, format!("{rel}:{line}")));
                entry.0 += 1;
            }
        }
    }
    let inspected = started.elapsed();
    engine.shutdown();
    let external: usize = tally.external.values().sum();
    let own: usize = tally.own.values().map(|(n, _)| n).sum();
    writeln!(
        report,
        "## {}\n\nIndexed in {indexed:.1?}; inspected {} files in {inspected:.1?}. Reported: {} external, {} own/global.\n",
        corpus.dir,
        tally.files,
        external,
        own
    )
    .unwrap();
    writeln!(report, "### External roots\n").unwrap();
    let mut roots: Vec<_> = tally.external.iter().collect();
    roots.sort_by(|a, b| b.1.cmp(a.1));
    for (root, n) in roots.iter().take(40) {
        writeln!(report, "- `{root}`: {n}").unwrap();
    }
    writeln!(report, "\n### Own or global (review for false positives)\n").unwrap();
    let mut own: Vec<_> = tally.own.iter().collect();
    own.sort_by(|a, b| b.1.0.cmp(&a.1.0).then(a.0.cmp(b.0)));
    for (message, (n, at)) in own {
        writeln!(report, "- {message} ×{n} (first: `{at}`)").unwrap();
    }
    writeln!(report).unwrap();
    tally
}

/// Whether an unqualified or relative written name comes from a `use` of a namespace the
/// corpus doesn't own (`use Psr\Log\LoggerInterface;` … `LoggerInterface`).
fn written_is_imported_external(text: &str, written: &str, owns: &[&str]) -> bool {
    imported_fqn(text, written).is_some_and(|fqn| {
        let root = root_namespace(&fqn);
        !root.is_empty() && !owns.contains(&root)
    })
}

fn resolved_root_or_import(text: &str, written: &str) -> String {
    match imported_fqn(text, written) {
        Some(fqn) => root_namespace(&fqn).to_owned(),
        None => root_namespace(written).to_owned(),
    }
}

/// The imported name a written name's first segment stands for, read from the file's `use`
/// lines (good enough for a tally).
fn imported_fqn(text: &str, written: &str) -> Option<String> {
    if written.starts_with('\\') {
        return None;
    }
    let first = written.split('\\').next()?;
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("use ") else { continue };
        let rest = rest.trim_start_matches("function ").trim_start_matches("const ").trim_end_matches(';').trim();
        let (fqn, alias) = match rest.split_once(" as ") {
            Some((fqn, alias)) => (fqn.trim(), alias.trim()),
            None => (rest, rest.rsplit('\\').next().unwrap_or(rest)),
        };
        if alias.eq_ignore_ascii_case(first) {
            return Some(fqn.trim_start_matches('\\').to_owned());
        }
    }
    None
}

#[test]
#[ignore = "needs the corpora (scripts/php-corpus.sh)"]
fn corpus() {
    let root = corpus_root();
    let wanted: Option<Vec<String>> =
        std::env::var("PHP_DIFF_CORPUS").ok().map(|v| v.split(',').map(|s| s.trim().to_owned()).collect());
    let step: usize = std::env::var("PHP_UNDEF_STEP").ok().and_then(|s| s.parse().ok()).unwrap_or(1).max(1);
    let mut report = String::from("# Undefined symbols on the corpora\n\n");
    writeln!(report, "Every {step}. file inspected; corpora have no `vendor/`.\n").unwrap();
    let mut ran = 0;
    for corpus in &CORPORA {
        if wanted.as_ref().is_some_and(|w| !w.iter().any(|d| d == corpus.dir)) {
            continue;
        }
        let dir = root.join(corpus.dir);
        if !dir.is_dir() {
            eprintln!("skipping {}: not found", dir.display());
            continue;
        }
        let dir = dunce::canonicalize(dir).unwrap();
        let tally = run(corpus, &dir, step, &mut report);
        eprintln!(
            "{}: {} files, {} external, {} own/global",
            corpus.dir,
            tally.files,
            tally.external.values().sum::<usize>(),
            tally.own.values().map(|(n, _)| n).sum::<usize>()
        );
        ran += 1;
    }
    assert!(ran > 0, "no corpus under {}", root.display());
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/php-differential");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("undefined-symbols.md"), &report).unwrap();
    eprintln!("report: {}", out.join("undefined-symbols.md").display());
}

#[test]
fn import_reading() {
    let text = "<?php\nuse Psr\\Log\\LoggerInterface;\nuse Doctrine\\ORM as Orm;\nuse function Foo\\bar;\n";
    assert_eq!(imported_fqn(text, "LoggerInterface").as_deref(), Some("Psr\\Log\\LoggerInterface"));
    assert_eq!(imported_fqn(text, "Orm\\Entity").as_deref(), Some("Doctrine\\ORM"));
    assert_eq!(imported_fqn(text, "bar").as_deref(), Some("Foo\\bar"));
    assert_eq!(imported_fqn(text, "\\Other"), None);
    assert!(written_is_imported_external(text, "LoggerInterface", &["Symfony"]));
    assert_eq!(root_namespace("\\Doctrine\\ORM\\X"), "Doctrine");
}
