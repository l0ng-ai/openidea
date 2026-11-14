//! `cargo bench -p ide-search`: Find in Files over a synthetic 5 000-file
//! project (~60 MB of source) on disk, as the UI issues it while typing.

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use ide_core::CancellationToken;
use ide_search::{SearchQuery, SearchScope, search};
use std::sync::atomic::{AtomicU32, Ordering};

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for f in 0..5_000u32 {
        let sub = dir.path().join(format!("src/module{}", f % 50));
        std::fs::create_dir_all(&sub).unwrap();
        let mut text = String::with_capacity(12 << 10);
        for i in 0..300u32 {
            text.push_str(&format!(
                "    fun handle{i}(order: Order{f}) = repository.save(order.copy(total = order.total + {i}))\n"
            ));
        }
        if f % 97 == 0 {
            text.push_str("    // TODO: InvoiceReconciler should batch these\n");
        }
        std::fs::write(sub.join(format!("File{f}.kt")), text).unwrap();
    }
    dir
}

fn query(pattern: &str, is_regex: bool) -> SearchQuery {
    SearchQuery {
        pattern: pattern.into(),
        is_regex,
        case_sensitive: false,
        whole_word: false,
        include: vec![],
        exclude: vec![],
        scope: SearchScope::Project,
        max_matches: 0,
        context: Default::default(),
    }
}

fn run(root: &std::path::Path, q: &SearchQuery) -> u32 {
    let files = AtomicU32::new(0);
    search(root, q, &|_| None, &CancellationToken::new(), &|_| {
        files.fetch_add(1, Ordering::Relaxed);
    })
    .unwrap();
    files.into_inner()
}

fn bench(c: &mut Criterion) {
    let dir = project();
    let root = dir.path();
    let mut g = c.benchmark_group("search_5k");
    g.sample_size(15);
    // Rare literal: the common Find in Files case (few hits, whole tree scanned).
    let rare = query("InvoiceReconciler", false);
    assert_eq!(run(root, &rare), 52);
    g.bench_function("literal", |b| b.iter(|| black_box(run(root, &rare))));
    let regex = query(r"Invoice\w+ should", true);
    g.bench_function("regex", |b| b.iter(|| black_box(run(root, &regex))));
    // Hits everywhere: stops at the 10 000-match default limit.
    let dense = query("repository.save", false);
    g.bench_function("dense_limit", |b| b.iter(|| black_box(run(root, &dense))));
    g.finish();
}

// No .ignore file: the query's subtree masks must prevent traversal themselves.
fn excluded_subtrees(c: &mut Criterion) {
    let dir = tempfile::tempdir().unwrap();
    for module in 0..100 {
        let root = dir.path().join(format!("modules/m{module}"));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.go"), "needle").unwrap();
        for dependency in 0..50 {
            let dep = root.join(format!("node_modules/dep{dependency}/lib"));
            std::fs::create_dir_all(&dep).unwrap();
            std::fs::write(dep.join("index.js"), "needle").unwrap();
        }
    }
    let q = SearchQuery { exclude: vec!["**/node_modules/**".into()], ..query("needle", false) };
    assert_eq!(run(dir.path(), &q), 100);
    let mut group = c.benchmark_group("search_excluded_subtrees");
    group.sample_size(15);
    group.bench_function("5k_dependencies", |b| b.iter(|| black_box(run(dir.path(), &q))));
    group.finish();
}

criterion_group!(benches, bench, excluded_subtrees);
criterion_main!(benches);
