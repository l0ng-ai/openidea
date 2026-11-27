//! `cargo bench -p ide-index --bench startup`: open a persisted 20k-file
//! project and wait for the index to become idle. This is the full warm-start
//! path (columnar snapshot, directory/file manifest, lazy redb).

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use ide_core::NullSink;
use ide_index::ProjectIndex;
use ide_language::{LanguageRegistry, Syntax};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const FILES: usize = 20_000;

fn project(root: &Path) {
    for i in 0..FILES {
        let dir = root.join(format!("mod{}/src", i % 50));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("File{i}.rs")), format!("fn symbol{i}() {{}}\n")).unwrap();
    }
}

fn bench(c: &mut Criterion) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    let cache = tmp.path().join("cache");
    project(&root);

    let languages = Arc::new(LanguageRegistry::load(None).unwrap());
    let syntax = Arc::new(Syntax::new());
    let open = || {
        ProjectIndex::open(
            &root,
            &cache,
            Vec::<PathBuf>::new(),
            vec![],
            languages.clone(),
            syntax.clone(),
            Arc::new(NullSink),
        )
        .unwrap()
    };
    let first = open();
    assert!(first.wait_idle(Duration::from_secs(30)));
    drop(first);

    let mut group = c.benchmark_group("startup_20k");
    group.sample_size(10);
    group.bench_function("reopen_wait_idle", |b| {
        b.iter(|| {
            let index = open();
            assert!(index.wait_idle(Duration::from_secs(30)));
            black_box(index.status().files)
        })
    });
    group.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default().measurement_time(Duration::from_secs(3));
    targets = bench
}
criterion_main!(benches);
