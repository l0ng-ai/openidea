//! `cargo bench -p ide-heap`: whole-dump analysis and the dominator tree at a million objects.

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use ide_core::CancellationToken;
use ide_heap::testing::{MiniHeap, XorShift};
use ide_heap::{AnalyzeOptions, BasicType, HeapError, HeapPhase, HeapRootKind, Store, analyze, dominators};

const CHAINS: u64 = 100_000;
const CHAIN_LEN: u64 = 5;
const NODES: u64 = CHAINS * CHAIN_LEN;
/// Every object takes one slot: node `k` at slot `2k`, its payload at `2k + 1`.
const BASE: u64 = 0x1_0000_0000;
const SLOT: u64 = 0x20;

fn node_addr(k: u64) -> u64 {
    BASE + 2 * k * SLOT
}

fn payload_addr(k: u64) -> u64 {
    node_addr(k) + SLOT
}

/// 100k rooted chains of five `Node { next, payload }`, each node with its own `byte[16]`. Every
/// seventh node points at the payload of the same position in the next chain instead, so that
/// payload has two owners and its own one is garbage: 1M objects in all.
fn million_objects() -> MiniHeap {
    let mut heap = MiniHeap::new();
    heap.class("Node", Some("java.lang.Object"), &[("next", BasicType::Object), ("payload", BasicType::Object)]);
    for k in 0..NODES {
        let next = if (k + 1) % CHAIN_LEN == 0 { 0 } else { node_addr(k + 1) };
        let payload = if k % 7 == 0 { payload_addr((k + CHAIN_LEN) % NODES) } else { payload_addr(k) };
        heap.object(node_addr(k), "Node", &[("next", next), ("payload", payload)]);
        heap.prim(payload_addr(k), BasicType::Byte, 16);
        if k % CHAIN_LEN == 0 {
            heap.root(HeapRootKind::JniGlobal, node_addr(k));
        }
    }
    heap
}

/// CSR of a random tree on `nodes` nodes rooted at 0 plus `extra` random edges, targets of each
/// node in scrambled order.
fn random_graph(nodes: u32, extra: u32, seed: u64) -> (Vec<u32>, Vec<u32>) {
    let mut rng = XorShift::new(seed);
    let mut edges: Vec<(u32, u32)> = (1..nodes).map(|v| (rng.below(v), v)).collect();
    edges.extend((0..extra).map(|_| (rng.below(nodes), rng.below(nodes))));
    for i in (1..edges.len()).rev() {
        edges.swap(i, rng.below(i as u32 + 1) as usize);
    }
    let mut start = vec![0u32; nodes as usize + 1];
    for &(from, _) in &edges {
        start[from as usize + 1] += 1;
    }
    for v in 0..nodes as usize {
        start[v + 1] += start[v];
    }
    let mut cursor = start.clone();
    let mut out = vec![0u32; edges.len()];
    for &(from, to) in &edges {
        out[cursor[from as usize] as usize] = to;
        cursor[from as usize] += 1;
    }
    (start, out)
}

fn no_progress(_: HeapPhase, _: u64, _: u64) -> Result<(), HeapError> {
    Ok(())
}

fn bench(c: &mut Criterion) {
    let dir = tempfile::tempdir().expect("temp dir");
    let hprof = dir.path().join("dump.hprof");
    million_objects().write_to(&hprof);
    let (start, out) = random_graph(1_000_000, 500_000, 0x5EED_D0D0);
    let cancel = CancellationToken::new();
    let opts = AnalyzeOptions { in_memory: true, ..AnalyzeOptions::default() };
    let summary = analyze(&hprof, dir.path(), opts, &no_progress, &cancel).expect("analyze").summary;
    assert_eq!(summary.objects, 2 * NODES, "{summary:?}");
    assert_eq!(summary.unreachable_objects, NODES.div_ceil(7), "{summary:?}");

    let mut g = c.benchmark_group("heap");
    g.sample_size(10);
    g.bench_function("index_1m_objects", |b| {
        b.iter(|| {
            let opts = AnalyzeOptions { in_memory: true, ..AnalyzeOptions::default() };
            let index = analyze(&hprof, dir.path(), opts, &no_progress, &cancel).expect("analyze");
            black_box(index.summary.objects)
        })
    });
    g.bench_function("dominators_1m_random", |b| {
        b.iter(|| {
            let d = dominators(&start, &out, 0, &Store::Ram, &no_progress, &cancel).expect("dominators");
            black_box(d.reachable)
        })
    });
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
