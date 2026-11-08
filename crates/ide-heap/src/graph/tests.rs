use std::cell::RefCell;

use proptest::prelude::*;

use super::*;
use crate::hprof::{HeapRecord, record_at};
use crate::testing::{HprofWriter, MiniHeap, sample};

const H: u64 = 0x1000;
const N1: u64 = 0x1100;
const N2: u64 = 0x1200;
const N3: u64 = 0x1300;
const L: u64 = 0x1400;
const R: u64 = 0x1500;
const W: u64 = 0x1600;
const N4: u64 = 0x1700;

fn no_progress(_: HeapPhase, _: u64, _: u64) -> Result<(), HeapError> {
    Ok(())
}

fn build(bytes: &[u8]) -> Result<HeapGraph, HeapError> {
    build_graph(bytes, &Store::Ram, &no_progress, &CancellationToken::new())
}

fn index(g: &HeapGraph, id: u64) -> u32 {
    g.ids.rank(id).unwrap_or_else(|| panic!("{id:#x} is not in the graph"))
}

fn class(g: &HeapGraph, name: &str) -> (u32, u64) {
    let slot = g.classes.iter().position(|c| c.name == name).unwrap_or_else(|| panic!("no class {name}"));
    (slot as u32, g.classes[slot].id)
}

/// Targets of `id`'s edges, as ids, in edge order.
fn out_of(g: &HeapGraph, id: u64) -> Vec<u64> {
    g.out_edges(index(g, id)).iter().map(|&t| g.ids.id_at(t)).collect()
}

fn root_targets(g: &HeapGraph) -> Vec<u64> {
    g.out_edges(g.root).iter().map(|&t| g.ids.id_at(t)).collect()
}

fn assert_csr(g: &HeapGraph) {
    let n = g.ids.len();
    assert_eq!(g.root, n);
    assert_eq!(g.out_start.len(), n as usize + 2);
    assert_eq!(g.out_start[0], 0);
    assert!(g.out_start.windows(2).all(|w| w[0] <= w[1]), "out_start is not monotone");
    assert_eq!(g.out_start[n as usize + 1] as usize, g.out.len());
    assert!(g.out.iter().all(|&t| t < n), "edge to a node outside the objects");
    assert_eq!((g.types.len(), g.lens.len(), g.offsets.len()), (n as usize, n as usize, n as usize));
    let slots = g.classes.len() as u32 + PRIM_SLOTS;
    assert!(g.types.iter().all(|&t| t < slots), "type outside the slots");
    for c in &g.classes {
        let mut steps = 0;
        let mut cursor = c.super_index;
        while let Some(s) = cursor {
            steps += 1;
            assert!(steps <= g.classes.len(), "super chain of {} does not end", c.name);
            cursor = g.classes[s as usize].super_index;
        }
    }
}

#[test]
fn edges_follow_fields_and_skip_weak_referents() {
    let g = build(&sample().bytes()).unwrap();
    assert_csr(&g);
    let (_, holder) = class(&g, "Holder");
    let (_, node) = class(&g, "Node");
    let (_, weak) = class(&g, "java.lang.ref.WeakReference");
    assert_eq!(out_of(&g, H), [N1, N2, holder]);
    assert_eq!(out_of(&g, N1), [N3, node]);
    assert_eq!(out_of(&g, N3), [L, node]);
    assert_eq!(out_of(&g, W), [weak]);
    assert_eq!(out_of(&g, N4), [node]);
    assert_eq!(out_of(&g, L), Vec::<u64>::new());
    assert_eq!(g.weak_edges_skipped, 1);
    let (reference, _) = class(&g, "java.lang.ref.Reference");
    assert_eq!(g.classes[reference as usize].weak_field, Some(0));
    assert!(g.classes.iter().filter(|c| c.name != "java.lang.ref.Reference").all(|c| c.weak_field.is_none()));
}

#[test]
fn object_arrays_skip_null_and_unknown() {
    let mut heap = sample();
    heap.array_of(0x1800, "[Ljava.lang.Object;", &[N2, 0, 0x9990, N1, 0xDEAD_BEEF]);
    let g = build(&heap.bytes()).unwrap();
    assert_csr(&g);
    assert_eq!(out_of(&g, R), [N1]);
    assert_eq!(out_of(&g, 0x1800), [N2, N1]);
}

#[test]
fn super_root_points_at_each_root_once() {
    let mut heap = sample();
    heap.root(HeapRootKind::JniGlobal, H).root(HeapRootKind::MonitorUsed, H).root(HeapRootKind::JniLocal, 0x9990);
    let g = build(&heap.bytes()).unwrap();
    assert_csr(&g);
    let targets = root_targets(&g);
    assert_eq!(targets.iter().filter(|&&t| t == H).count(), 1);
    assert!(targets.contains(&N3) && targets.contains(&W));
    assert!(!targets.contains(&N1) && !targets.contains(&R) && !targets.contains(&N4));
    let classes = g.classes.iter().filter(|c| c.id != 0).count();
    assert_eq!(targets.len(), 3 + classes, "H, N3, W and every sticky class");
    let mut sorted = targets.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), targets.len());

    let h = index(&g, H);
    let of_h: Vec<_> = g.roots.iter().filter(|r| r.0 == h).map(|r| (r.1, r.2)).collect();
    assert_eq!(of_h, [(HeapRootKind::JniGlobal, None), (HeapRootKind::MonitorUsed, None)]);
    assert!(g.roots.contains(&(index(&g, N3), HeapRootKind::JavaFrame, Some(1))));
    assert!(g.roots.iter().all(|r| r.0 < g.root));
}

#[test]
fn class_dump_edges_cover_statics() {
    let mut w = HprofWriter::new();
    w.string(1, "java/lang/Object")
        .load_class(0x100, 1)
        .class(0x100, 0, &[], &[])
        .string(2, "Config")
        .string(3, "INSTANCE")
        .string(4, "EMPTY")
        .string(5, "LOST")
        .load_class(0x200, 2)
        .class_with_loader(0x200, 0x100, 0x1200, &[], &[(3, N1), (4, 0), (5, 0x9990)])
        .instance(N1, 0x100, &[])
        .instance(0x1200, 0x100, &[]);
    let g = build(&w.finish()).unwrap();
    assert_csr(&g);
    assert_eq!(out_of(&g, 0x200), [0x100, 0x1200, N1]);
    assert_eq!(out_of(&g, 0x100), Vec::<u64>::new());
    let (config, _) = class(&g, "Config");
    let info = &g.classes[config as usize];
    let statics: Vec<_> = info.statics.iter().map(|(n, id)| (n.as_str(), *id)).collect();
    assert_eq!(statics, [("INSTANCE", N1), ("EMPTY", 0), ("LOST", 0x9990)]);
    assert_eq!(info.super_index, Some(class(&g, "java.lang.Object").0));
}

#[test]
fn missing_class_is_an_error() {
    let mut w = HprofWriter::new();
    w.string(1, "java/lang/Object").load_class(0x100, 1).class(0x100, 0, &[], &[]).instance(N1, 0x999, &[]);
    let bytes = w.finish();
    let at = instance_offset(&bytes, N1);
    let err = build(&bytes).err().unwrap();
    assert!(matches!(err, HeapError::MissingClass { id: 0x999, at: a } if a == at as u64), "{err:?}");

    let mut w = HprofWriter::new();
    w.obj_array(0x10, 0x999, &[]);
    assert!(matches!(build(&w.finish()), Err(HeapError::MissingClass { id: 0x999, .. })));
}

fn instance_offset(bytes: &[u8], id: u64) -> usize {
    let header = crate::hprof::parse_header(bytes).unwrap();
    let mut found = None;
    crate::hprof::scan(bytes, &header, &mut |r| {
        if let crate::hprof::Record::Heap { at, record: HeapRecord::Instance { id: i, .. } } = r
            && i == id
        {
            found = Some(at);
        }
        Ok(())
    })
    .unwrap();
    found.unwrap()
}

#[test]
fn cancel_during_linking_returns_cancelled() {
    let bytes = sample().bytes();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let result = build_graph(&bytes, &Store::Ram, &no_progress, &cancelled);
    assert!(matches!(result, Err(HeapError::Cancelled)));

    let cancel = CancellationToken::new();
    let phases = RefCell::new(Vec::new());
    let result = build_graph(
        &bytes,
        &Store::Ram,
        &|phase, done, total| {
            phases.borrow_mut().push((phase, done, total));
            if phase == HeapPhase::Linking {
                cancel.cancel();
            }
            Ok(())
        },
        &cancel,
    );
    assert!(matches!(result, Err(HeapError::Cancelled)));
    let phases = phases.into_inner();
    assert_eq!(phases.first(), Some(&(HeapPhase::Reading, 0, bytes.len() as u64)));
    assert_eq!(phases.last(), Some(&(HeapPhase::Linking, 0, 15)), "stops at the first Linking report");
}

#[test]
fn progress_error_stops_the_build() {
    let bytes = sample().bytes();
    let fail = |phase, _, total| {
        if phase == HeapPhase::Linking {
            Err(HeapError::NotEnoughDiskSpace { needed: total * 90, available: 0 })
        } else {
            Ok(())
        }
    };
    let result = build_graph(&bytes, &Store::Ram, &fail, &CancellationToken::new());
    assert!(matches!(result, Err(HeapError::NotEnoughDiskSpace { needed: 1350, available: 0 })));
}

#[test]
fn progress_reads_bytes_then_links_objects() {
    let bytes = sample().bytes();
    let phases = RefCell::new(Vec::new());
    let g = build_graph(
        &bytes,
        &Store::Ram,
        &|phase, done, total| {
            phases.borrow_mut().push((phase, done, total));
            Ok(())
        },
        &CancellationToken::new(),
    )
    .unwrap();
    let phases = phases.into_inner();
    let len = bytes.len() as u64;
    let objects = u64::from(g.root);
    assert_eq!(objects, 15, "7 classes and 8 objects");
    assert_eq!(phases.first(), Some(&(HeapPhase::Reading, 0, len)));
    assert!(phases.contains(&(HeapPhase::Reading, len, len)));
    let linking: Vec<_> = phases.iter().filter(|p| p.0 == HeapPhase::Linking).collect();
    assert_eq!(linking.first(), Some(&&(HeapPhase::Linking, 0, objects)));
    assert_eq!(linking.iter().filter(|p| ***p == (HeapPhase::Linking, 0, objects)).count(), 1, "{linking:?}");
    assert_eq!(linking.last(), Some(&&(HeapPhase::Linking, objects, objects)));
    assert!(phases.iter().all(|&(_, done, total)| done <= total));
}

#[test]
fn types_lengths_and_offsets() {
    let bytes = sample().bytes();
    let g = build(&bytes).unwrap();
    let (holder, holder_id) = class(&g, "Holder");
    let (node, _) = class(&g, "Node");
    let (array, _) = class(&g, "[Ljava.lang.Object;");
    let (java_lang_class, _) = class(&g, "java.lang.Class");
    assert_eq!(g.class_slot, java_lang_class);
    let ty = |id| g.types[index(&g, id) as usize];
    let len = |id| g.lens[index(&g, id) as usize];
    assert_eq!([ty(H), ty(N1), ty(R), ty(holder_id)], [holder, node, array, java_lang_class]);
    assert_eq!(ty(L), g.prim_slot(BasicType::Long));
    assert_eq!(g.prim_type(ty(L)), Some(BasicType::Long));
    assert_eq!(g.prim_type(holder), None);
    assert_eq!(g.prim_type(g.classes.len() as u32 + PRIM_SLOTS), None);
    assert_eq!(g.prim_slot(BasicType::Boolean), g.classes.len() as u32);
    assert_eq!(g.prim_slot(BasicType::Long), g.classes.len() as u32 + PRIM_SLOTS - 1);
    assert_eq!([len(H), len(L), len(R), len(holder_id)], [0, 2, 3, 0]);
    for i in 0..g.root {
        let id = match record_at(&bytes, g.offsets[i as usize] as usize, g.id_size).unwrap() {
            HeapRecord::Class(c) => c.id,
            HeapRecord::Instance { id, .. } | HeapRecord::ObjectArray { id, .. } => id,
            HeapRecord::PrimitiveArray { id, .. } => id,
            other => panic!("offset of object {i} points at {other:?}"),
        };
        assert_eq!(id, g.ids.id_at(i));
    }
    assert_eq!((g.id_size, g.timestamp_ms), (8, 1_700_000_000_000));
    let holder_info = &g.classes[holder as usize];
    let fields: Vec<_> = holder_info.fields.iter().map(|(n, t)| (n.as_str(), *t)).collect();
    assert_eq!(fields, [("a", BasicType::Object), ("b", BasicType::Object)]);
    assert_eq!(holder_info.super_index, Some(class(&g, "java.lang.Object").0));
    assert_eq!(g.classes[class(&g, "java.lang.Object").0 as usize].super_index, None);
}

#[test]
fn dump_without_java_lang_class_gets_a_synthetic_slot() {
    let mut w = HprofWriter::new();
    w.string(1, "java/lang/Object").load_class(0x100, 1).class(0x100, 0, &[], &[]).instance(N1, 0x100, &[]);
    let g = build(&w.finish()).unwrap();
    assert_csr(&g);
    assert_eq!(g.classes.len(), 2);
    let synthetic = &g.classes[g.class_slot as usize];
    assert_eq!((synthetic.id, synthetic.name.as_str(), synthetic.super_index), (0, "java.lang.Class", None));
    assert_eq!(g.types[index(&g, 0x100) as usize], g.class_slot);
    assert_eq!(g.types[index(&g, N1) as usize], 0);
}

#[test]
fn classes_without_a_name_record_get_their_address() {
    let mut w = HprofWriter::new();
    w.class(0x100, 0, &[(9, BasicType::Object)], &[])
        .instance(N1, 0x100, &N2.to_be_bytes())
        .instance(N2, 0x100, &[0; 8]);
    let g = build(&w.finish()).unwrap();
    assert_eq!(g.classes[0].name, "0x100");
    assert_eq!(g.classes[0].fields, [(String::new(), BasicType::Object)]);
    assert_eq!(out_of(&g, N1), [N2, 0x100]);
}

#[test]
fn thread_objects_map_serials_to_threads() {
    let mut heap = sample();
    heap.class("java.lang.Thread", Some("java.lang.Object"), &[])
        .object(0x2000, "java.lang.Thread", &[])
        .object(0x2100, "java.lang.Thread", &[])
        .root_in_thread(HeapRootKind::ThreadObject, 0x2000, 1)
        .root_in_thread(HeapRootKind::ThreadObject, 0x2100, 7)
        .root_in_thread(HeapRootKind::ThreadObject, 0x9990, 9);
    let g = build(&heap.bytes()).unwrap();
    let expected: HashMap<u32, u32> = [(1, index(&g, 0x2000)), (7, index(&g, 0x2100))].into();
    assert_eq!(g.thread_objects, expected);
    assert!(g.roots.contains(&(index(&g, 0x2100), HeapRootKind::ThreadObject, Some(7))));
}

#[test]
fn inherited_fields_follow_the_class_first_layout() {
    let mut heap = MiniHeap::new();
    heap.class("A", Some("java.lang.Object"), &[("a", BasicType::Object), ("n", BasicType::Int)])
        .class("Empty", Some("A"), &[])
        .class("B", Some("Empty"), &[("flag", BasicType::Byte), ("b", BasicType::Object)])
        .object(0x10, "B", &[("a", 0x20), ("b", 0x30), ("flag", 1)])
        .object(0x20, "A", &[])
        .object(0x30, "A", &[]);
    let g = build(&heap.bytes()).unwrap();
    assert_csr(&g);
    assert_eq!(out_of(&g, 0x10), [0x30, 0x20, class(&g, "B").1]);
}

#[test]
fn super_class_cycles_are_cut() {
    let mut w = HprofWriter::new();
    w.string(1, "A")
        .string(2, "B")
        .string(3, "S")
        .string(4, "f")
        .load_class(0x100, 1)
        .load_class(0x200, 2)
        .load_class(0x300, 3)
        .class(0x100, 0x200, &[(4, BasicType::Object)], &[])
        .class(0x200, 0x100, &[(4, BasicType::Object)], &[])
        .class(0x300, 0x300, &[], &[])
        .instance(0x10, 0x100, &[[0; 7].as_slice(), &[0x20], &[0; 7], &[0x30]].concat())
        .instance(0x20, 0x300, &[])
        .instance(0x30, 0x300, &[0; 64]);
    let g = build(&w.finish()).unwrap();
    assert_csr(&g);
    assert_eq!(out_of(&g, 0x10), [0x20, 0x30, 0x100]);
    assert_eq!(out_of(&g, 0x30), [0x300]);
}

#[test]
fn short_instance_data_stops_at_the_last_whole_field() {
    let mut w = HprofWriter::new();
    w.string(1, "P")
        .string(2, "x")
        .load_class(0x100, 1)
        .class(0x100, 0, &[(2, BasicType::Object), (2, BasicType::Object)], &[])
        .instance(0x10, 0x100, &[[0; 7].as_slice(), &[0x20], &[0; 5]].concat())
        .instance(0x20, 0x100, &[]);
    let g = build(&w.finish()).unwrap();
    assert_csr(&g);
    assert_eq!(out_of(&g, 0x10), [0x20, 0x100]);
}

#[test]
fn id_size_4_dump_links() {
    let mut w = HprofWriter::with_id_size(4);
    w.string(1, "Node")
        .string(2, "next")
        .load_class(0x100, 1)
        .class(0x100, 0, &[(2, BasicType::Object)], &[(2, 0x20)])
        .instance(0x10, 0x100, &0x20u32.to_be_bytes())
        .instance(0x20, 0x100, &[0; 4])
        .obj_array(0x30, 0x100, &[0x10, 0, 0x20])
        .root(HeapRootKind::JniGlobal, 0x30);
    let g = build(&w.finish()).unwrap();
    assert_csr(&g);
    assert_eq!(g.id_size, 4);
    assert_eq!(out_of(&g, 0x10), [0x20, 0x100]);
    assert_eq!(out_of(&g, 0x30), [0x10, 0x20]);
    assert_eq!(out_of(&g, 0x100), [0x20]);
    assert_eq!(root_targets(&g), [0x30]);
}

#[test]
fn dir_store_keeps_types_and_offsets_only() {
    let dir = tempfile::tempdir().unwrap();
    // The id map's own files (`ids.*`) depend on its layout; MiniHeap's class ids are unaligned.
    let names = || {
        let mut names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|name| !name.starts_with("ids."))
            .collect();
        names.sort();
        names
    };
    let g =
        build_graph(&sample().bytes(), &Store::Dir(dir.path().to_path_buf()), &no_progress, &CancellationToken::new())
            .unwrap();
    assert_eq!(out_of(&g, H).len(), 3);
    let kept = ["offsets.u64", "types.u32"];
    assert!(dir.path().join("ids.sorted.u64").exists());
    #[cfg(unix)]
    assert_eq!(names(), kept);
    drop(g);
    assert_eq!(names(), kept);
}

#[test]
fn empty_dump_has_only_the_super_root() {
    let g = build(&HprofWriter::new().finish()).unwrap();
    assert_csr(&g);
    assert_eq!((g.root, g.out.len(), g.classes.len()), (0, 0, 1));
    assert_eq!(g.class_slot, 0);
}

#[test]
fn edge_count_past_u32_is_too_large() {
    let cancel = CancellationToken::new();
    let mut counts = [0, 2, 0, 3, 1];
    assert_eq!(accumulate(&mut counts, &cancel).unwrap(), 6);
    assert_eq!(counts, [0, 2, 2, 5, 6]);
    let mut full = [0, u32::MAX - 1, 1];
    assert_eq!(accumulate(&mut full, &cancel).unwrap(), u32::MAX);
    let mut over = [0, u32::MAX, 1];
    assert!(matches!(accumulate(&mut over, &cancel), Err(HeapError::TooLarge)));
    cancel.cancel();
    assert!(matches!(accumulate(&mut [0, 1], &cancel), Err(HeapError::Cancelled)));
}

/// A class with `fields` instance fields, every one named by the same `name_len`-byte UTF8 record.
fn shared_long_field_names(name_len: usize, fields: usize) -> Vec<u8> {
    let mut w = HprofWriter::new();
    let long = "f".repeat(name_len);
    w.string(1, "java/lang/Object").load_class(0x100, 1).class(0x100, 0, &[], &[]);
    w.string(2, "Wide").string(3, &long).load_class(0x200, 2);
    w.class(0x200, 0x100, &vec![(3, BasicType::Int); fields], &[]);
    w.finish()
}

#[test]
fn names_that_would_decode_far_larger_than_the_file_are_refused() {
    // 128 MiB of names from a file of about 70 KB.
    let bytes = shared_long_field_names(32 << 10, 4000);
    assert!(bytes.len() < 100 << 10, "{}", bytes.len());
    let err = build(&bytes).err().expect("refused");
    assert!(matches!(err, HeapError::NamesTooLarge), "{err:?}");
}

#[test]
fn a_name_longer_than_the_jvm_allows_is_refused() {
    let mut w = HprofWriter::new();
    w.string(1, &"C".repeat(70_000)).load_class(0x100, 1).class(0x100, 0, &[], &[]);
    assert!(matches!(build(&w.finish()), Err(HeapError::NamesTooLarge)));
}

#[test]
fn real_sized_names_shared_by_many_fields_are_fine() {
    let g = build(&shared_long_field_names(40, 4000)).unwrap();
    assert_eq!(g.classes[class(&g, "Wide").0 as usize].fields.len(), 4000);
}

proptest! {
    #[test]
    fn build_graph_never_panics_on_mutated_dumps(flips in proptest::collection::vec((0usize..4096, any::<u8>()), 1..12)) {
        let mut bytes = sample().bytes();
        for (pos, value) in flips {
            let at = pos % bytes.len();
            bytes[at] = value;
        }
        if let Ok(g) = build(&bytes) {
            assert_csr(&g);
        }
    }
}
