use std::cell::Cell;
use std::collections::BTreeSet;
use std::path::PathBuf;

use super::*;
use crate::column::{Column, NONE};
use crate::files::INDEX_FILES;
use crate::hprof::{BasicType, HeapRootKind};
use crate::index::{ClassStat, HeapSummary};
use crate::shallow::SizeSource;
use crate::testing::{MiniHeap, sample};

const DUMP: &str = "dump.hprof";
const ROOT: Option<&str> = Some("java.lang.Object");
const NODE_FIELDS: [(&str, BasicType); 2] = [("next", BasicType::Object), ("v", BasicType::Long)];

fn no_progress(_: HeapPhase, _: u64, _: u64) -> Result<(), HeapError> {
    Ok(())
}

fn in_memory() -> AnalyzeOptions {
    AnalyzeOptions { in_memory: true, ..AnalyzeOptions::default() }
}

/// A temp dir holding `heap` as `dump.hprof`, the way a capture lays out its snapshot dir.
fn dump_dir(heap: &MiniHeap) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let dump = dir.path().join(DUMP);
    heap.write_to(&dump);
    (dir, dump)
}

fn analyze_with(heap: &MiniHeap, opts: AnalyzeOptions) -> HeapIndex {
    let (dir, dump) = dump_dir(heap);
    analyze(&dump, dir.path(), opts, &no_progress, &CancellationToken::new()).unwrap()
}

fn file_names(dir: &Path) -> BTreeSet<String> {
    std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect()
}

fn node(index: &HeapIndex, addr: u64) -> u32 {
    index.ids.rank(addr).unwrap_or_else(|| panic!("{addr:#x} is not in the dump"))
}

fn shallow(index: &HeapIndex, addr: u64) -> u64 {
    u64::from(index.shallow8[node(index, addr) as usize]) * 8
}

fn retained(index: &HeapIndex, addr: u64) -> u64 {
    index.retained[node(index, addr) as usize]
}

fn idom(index: &HeapIndex, addr: u64) -> u32 {
    index.idom[node(index, addr) as usize]
}

fn class<'a>(index: &'a HeapIndex, name: &str) -> &'a ClassStat {
    let mut rows = index.classes.iter().filter(|c| c.name == name);
    let row = rows.next().unwrap_or_else(|| panic!("no class {name}"));
    assert!(rows.next().is_none(), "two classes named {name}");
    row
}

fn stat(c: &ClassStat) -> (u64, u64, u64, u64) {
    (c.count, c.shallow, c.retained, c.unreachable_count)
}

fn kids_of(index: &HeapIndex, v: u32) -> &[u32] {
    &index.kids[index.kids_start[v as usize] as usize..index.kids_start[v as usize + 1] as usize]
}

const H: u64 = 0x1000;
const N1: u64 = 0x1100;
const N2: u64 = 0x1200;
const N3: u64 = 0x1300;
const L: u64 = 0x1400;
const R: u64 = 0x1500;
const W: u64 = 0x1600;
const N4: u64 = 0x1700;

#[test]
fn sample_retained_sizes() {
    let index = analyze_with(&sample(), in_memory());
    let shallows: Vec<u64> = [H, N1, L, W, R].iter().map(|&a| shallow(&index, a)).collect();
    assert_eq!(shallows, [24, 24, 32, 24, 32]);
    let retained_sizes: Vec<u64> = [L, N3, N1, N2, H, W].iter().map(|&a| retained(&index, a)).collect();
    assert_eq!(retained_sizes, [32, 56, 24, 24, 72, 24]);
    let root = index.root();
    assert_eq!(
        [idom(&index, N1), idom(&index, N2), idom(&index, N3), idom(&index, L)],
        [node(&index, H), node(&index, H), root, node(&index, N3)]
    );
    assert_eq!((idom(&index, R), idom(&index, N4)), (NONE, NONE));
    assert_eq!((retained(&index, R), retained(&index, N4)), (0, 0));

    // Children by retained size descending, ties by node.
    assert_eq!(kids_of(&index, node(&index, H)), [node(&index, N1), node(&index, N2)]);
    let top = kids_of(&index, root);
    assert_eq!(top[..2], [node(&index, H), node(&index, N3)]);
    assert!(top.windows(2).all(|p| (index.retained[p[0] as usize], p[1]) > (index.retained[p[1] as usize], p[0])));
    assert_eq!(index.retained[root as usize], top.iter().map(|&k| index.retained[k as usize]).sum::<u64>());
}

#[test]
fn sample_class_table() {
    let index = analyze_with(&sample(), in_memory());
    assert_eq!(stat(class(&index, "Node")), (3, 72, 104, 1));
    assert_eq!(stat(class(&index, "Holder")), (1, 24, 72, 0));
    assert_eq!(stat(class(&index, "long[]")), (1, 32, 32, 0));
    assert_eq!(stat(class(&index, "java.lang.ref.WeakReference")), (1, 24, 24, 0));
    let objects = class(&index, "java.lang.Object[]");
    assert_eq!((objects.count, objects.unreachable_count), (0, 1));
    // Indexed by type slot, primitive array slots included.
    assert_eq!(index.classes.len(), index.class_info.len() + crate::graph::PRIM_SLOTS as usize);
    let slot = index.types[node(&index, H) as usize] as usize;
    assert_eq!(index.classes[slot].name, "Holder");
    assert_eq!(index.class_info[slot].name, "Holder");
}

#[test]
fn sample_summary() {
    let index = analyze_with(&sample(), in_memory());
    let s = &index.summary;
    assert_eq!(
        (s.reachable_objects, s.reachable_bytes, s.unreachable_objects, s.unreachable_bytes, s.weak_edges_skipped),
        (6, 152, 2, 56, 1)
    );
    assert_eq!(s.objects, 8);
    assert_eq!(s.classes, 7);
    assert_eq!(s.size_source, SizeSource::Layout);
}

#[test]
fn sample_gc_parents() {
    let index = analyze_with(&sample(), in_memory());
    let parent = |addr| index.gc_parent[node(&index, addr) as usize];
    let root = index.root();
    assert_eq!(index.gc_parent[root as usize], root);
    assert_eq!([parent(H), parent(N3), parent(W)], [root; 3]);
    assert_eq!([parent(N1), parent(L)], [node(&index, H), node(&index, N3)]);
    assert_eq!((parent(R), parent(N4)), (NONE, NONE));
    assert_eq!(index.roots[&node(&index, N3)], (HeapRootKind::JavaFrame, Some(1)));
}

#[test]
fn cycle_is_retained_once() {
    let mut heap = MiniHeap::new();
    heap.class("Node", ROOT, &NODE_FIELDS)
        .object(0xA000, "Node", &[("next", 0xB000)])
        .object(0xB000, "Node", &[("next", 0xA000)])
        .root(HeapRootKind::JniGlobal, 0xA000);
    let index = analyze_with(&heap, in_memory());
    assert_eq!((retained(&index, 0xA000), retained(&index, 0xB000)), (48, 24));
    assert_eq!(class(&index, "Node").retained, 48);
}

#[test]
fn deep_chain_retained_by_class() {
    // A small stack proves no pass recurses along the chain.
    std::thread::Builder::new()
        .stack_size(256 << 10)
        .spawn(|| {
            const NODES: u64 = 1_000_000;
            let addr = |i: u64| 0x10_0000 + i * 0x100;
            let mut heap = MiniHeap::new();
            heap.class("Node", ROOT, &NODE_FIELDS);
            for i in 0..NODES {
                let next = if i + 1 < NODES { addr(i + 1) } else { 0 };
                heap.object(addr(i), "Node", &[("next", next)]);
            }
            heap.root(HeapRootKind::JniGlobal, addr(0));
            let index = analyze_with(&heap, in_memory());
            assert_eq!(retained(&index, addr(0)), 24_000_000);
            assert_eq!(retained(&index, addr(NODES - 1)), 24);
            assert_eq!(class(&index, "Node").retained, 24_000_000);
            assert_eq!(index.summary.reachable_objects, NODES);
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn histogram_sizes_flow_into_retained() {
    let histogram = vec![HistogramEntry { name: "Node".to_owned(), instances: 3, bytes: 96 }];
    let index = analyze_with(&sample(), AnalyzeOptions { histogram: Some(histogram), ..in_memory() });
    assert_eq!(shallow(&index, N3), 32);
    assert_eq!(retained(&index, N3), 64);
    assert_eq!(index.summary.size_source, SizeSource::Jvm);
}

#[test]
fn vm_flags_of_an_unknown_jdk_set_the_layout() {
    // Without compressed oops a Node is 12 + 8 + 8 = 28 → 32.
    let opts = AnalyzeOptions { vm_flags: Some("-XX:MaxHeapSize=42949672960".to_owned()), ..in_memory() };
    let index = analyze_with(&sample(), opts);
    assert_eq!(shallow(&index, N4), 32);
}

#[test]
fn cancel_stops_analysis() {
    let (dir, dump) = dump_dir(&sample());
    let cancel = CancellationToken::new();
    let phases = Cell::new(Vec::new());
    let progress = |phase, _, _| {
        let mut seen = phases.take();
        seen.push(phase);
        phases.set(seen);
        if phase == HeapPhase::Dominators {
            cancel.cancel();
        }
        Ok(())
    };
    let result = analyze(&dump, dir.path(), AnalyzeOptions::default(), &progress, &cancel);
    assert!(matches!(result, Err(HeapError::Cancelled)), "{:?}", result.err());
    assert_eq!(phases.take().last(), Some(&HeapPhase::Dominators), "stops at the first check");
    // The dump the capture analyzes in place stays; every file the analysis wrote is gone.
    assert_eq!(file_names(dir.path()), BTreeSet::from([DUMP.to_owned()]));
}

#[test]
fn progress_error_stops_analysis_and_removes_its_files() {
    let (dir, dump) = dump_dir(&sample());
    // The last report, once every index file is written.
    let progress = |phase, done, _| match (phase, done) {
        (HeapPhase::Saving, 1) => Err(HeapError::NotEnoughDiskSpace { needed: 2, available: 1 }),
        _ => Ok(()),
    };
    let result = analyze(&dump, dir.path(), AnalyzeOptions::default(), &progress, &CancellationToken::new());
    assert!(matches!(result, Err(HeapError::NotEnoughDiskSpace { .. })), "{:?}", result.err());
    assert_eq!(file_names(dir.path()), BTreeSet::from([DUMP.to_owned()]));
}

#[test]
fn writes_index_files() {
    let (dir, dump) = dump_dir(&sample());
    let index = analyze(&dump, dir.path(), AnalyzeOptions::default(), &no_progress, &CancellationToken::new()).unwrap();
    let names = file_names(dir.path());
    for name in [
        "types.u32",
        "shallow8.u32",
        "retained.u64",
        "idom.u32",
        "kids_start.u32",
        "kids.u32",
        "gc_parent.u32",
        "offsets.u64",
        "summary.json",
    ] {
        assert!(names.contains(name), "{name} missing from {names:?}");
    }
    assert!(names.iter().any(|n| n.starts_with("ids.")), "{names:?}");
    // Nothing but the index files and the dump: scratch arrays are gone.
    let unexpected: Vec<_> = names.iter().filter(|n| *n != DUMP && !INDEX_FILES.contains(&n.as_str())).collect();
    assert!(unexpected.is_empty(), "{unexpected:?}");

    let summary: HeapSummary =
        serde_json::from_slice(&std::fs::read(dir.path().join("summary.json")).unwrap()).unwrap();
    assert_eq!(summary, index.summary);
    drop(index);
    let retained = Column::<u64>::open(&dir.path().join("retained.u64")).unwrap();
    let in_ram = analyze_with(&sample(), in_memory());
    assert_eq!(&*retained, &*in_ram.retained);
}
