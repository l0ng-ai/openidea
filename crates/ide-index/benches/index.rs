//! `cargo bench -p ide-index`: fuzzy file / symbol queries over a synthetic
//! 100k-file project (Search Everywhere budget: first results < 50 ms).

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use ide_index::SymbolFilter;
use ide_index::bench_support::SyntheticIndex;

fn bench(c: &mut Criterion) {
    let index = SyntheticIndex::new(100_000, 10);
    assert_eq!(index.file_count(), 100_000);

    let mut g = c.benchmark_group("index_100k");
    g.sample_size(20);
    for q in ["ordcon", "src/user", "PaymentService", "zzzz", "a"] {
        g.bench_function(format!("find_files/{q}"), |b| b.iter(|| black_box(index.find_files(q, 50).len())));
    }
    for q in ["util", "src/ui", "a"] {
        g.bench_function(format!("find_dirs/{q}"), |b| b.iter(|| black_box(index.find_dirs(q, 50).len())));
    }
    for q in ["OCo", "invoiceRepo", "renderView", "q"] {
        g.bench_function(format!("find_symbols/{q}"), |b| {
            b.iter(|| black_box(index.find_symbols(q, SymbolFilter::All, 50).len()))
        });
    }
    g.bench_function("find_symbols_types/UsSe", |b| {
        b.iter(|| black_box(index.find_symbols("UsSe", SymbolFilter::Types, 50).len()))
    });
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
