use super::*;
use crate::column::Store;
use crate::graph::build_graph;
use crate::progress::HeapPhase;
use crate::testing::{HprofWriter, MiniHeap, sample};

const ROOT: Option<&str> = Some("java.lang.Object");

fn no_progress(_: HeapPhase, _: u64, _: u64) -> Result<(), HeapError> {
    Ok(())
}

fn graph_of(heap: &MiniHeap) -> HeapGraph {
    build_graph(&heap.bytes(), &Store::Ram, &no_progress, &CancellationToken::new()).unwrap()
}

fn model(g: &HeapGraph, layout: VmLayout, histogram: Option<&[HistogramEntry]>) -> ShallowModel {
    ShallowModel::new(g, layout, histogram, &CancellationToken::new()).unwrap()
}

fn size_at(g: &HeapGraph, m: &ShallowModel, addr: u64) -> u64 {
    m.size_of(g, g.ids.rank(addr).unwrap_or_else(|| panic!("{addr:#x} is not in the graph")))
}

fn slot_at(g: &HeapGraph, addr: u64) -> u32 {
    g.types[g.ids.rank(addr).unwrap() as usize]
}

fn entry(name: &str, instances: u64, bytes: u64) -> HistogramEntry {
    HistogramEntry { name: name.to_owned(), instances, bytes }
}

fn flags(flags: &str, java_major: u32) -> VmLayout {
    VmLayout::from_vm_flags(flags, java_major)
}

const SHAPES: [&str; 9] = ["A", "B", "C", "D", "E", "F", "G", "H", "Node"];

/// One instance of each shape, 0x100 apart so no address gap qualifies.
fn shapes() -> MiniHeap {
    use BasicType::{Byte, Int, Long, Object, Short};
    let mut heap = MiniHeap::new();
    heap.class("A", ROOT, &[("f", Byte)])
        .class("B", ROOT, &[("f", Long)])
        .class("C", ROOT, &[("i", Int), ("l", Long), ("b", Byte)])
        .class("D", Some("C"), &[("s", Short), ("o", Object)])
        .class("E", ROOT, &[("a", Object), ("b", Object), ("c", Object)])
        .class("F", Some("A"), &[("g", Byte)])
        .class("G", ROOT, &[])
        .class("H", Some("B"), &[("i", Int)])
        .class("Node", ROOT, &[("l", Long), ("a", Object), ("b", Object)]);
    for (i, name) in SHAPES.iter().enumerate() {
        heap.object(0x1000 + i as u64 * 0x100, name, &[]);
    }
    heap
}

fn shape_sizes(layout: VmLayout) -> Vec<u64> {
    let g = graph_of(&shapes());
    let m = model(&g, layout, None);
    (0..SHAPES.len() as u64).map(|i| size_at(&g, &m, 0x1000 + i * 0x100)).collect()
}

// `jcmd <pid> VM.flags` of `-Xmx1g` and `-Xmx40g` runs (the flags that matter here).
const J8_11_1G: &str = "-XX:MaxHeapSize=1073741824 -XX:+UseCompressedClassPointers -XX:+UseCompressedOops";
const J8_11_40G: &str = "-XX:MaxHeapSize=42949672960";
const J21_25_1G: &str = "-XX:MaxHeapSize=1073741824 -XX:SoftMaxHeapSize=1073741824 -XX:+UseCompressedOops";
const J21_25_40G: &str = "-XX:MaxHeapSize=42949672960 -XX:SoftMaxHeapSize=42949672960";
/// `-Xmx40g -XX:+UseCompressedOops`: the JVM warns and turns them off.
const J21_40G_OFF: &str = "-XX:MaxHeapSize=42949672960 -XX:SoftMaxHeapSize=42949672960 -XX:-UseCompressedOops";
const J25_COMPACT: &str = "-XX:MaxHeapSize=1073741824 -XX:+UseCompressedOops -XX:+UseCompactObjectHeaders";

#[test]
fn layout_from_flags() {
    let legacy = VmLayout { legacy_array_base: true, ..VmLayout::DEFAULT };
    assert_eq!(flags(J8_11_1G, 8), legacy);
    assert_eq!(flags(J8_11_1G, 11), legacy);
    assert_eq!(flags(J21_25_1G, 21), legacy);
    assert_eq!(flags(J21_25_1G, 25), VmLayout::DEFAULT);
    assert_eq!(flags(J25_COMPACT, 25), VmLayout { header: 8, length_offset: 8, ..VmLayout::DEFAULT });
    assert_eq!(flags(&format!("{J21_25_1G} -XX:+UseG1GC"), 21), legacy);
    assert_eq!(flags(&format!("{J21_25_1G} -XX:ObjectAlignmentInBytes=16"), 21), VmLayout { alignment: 16, ..legacy });
}

#[test]
fn heaps_too_big_for_compressed_oops_print_no_flag() {
    let wide_legacy = VmLayout { header: 16, ref_size: 8, length_offset: 16, legacy_array_base: true, alignment: 8 };
    assert_eq!(flags(J8_11_40G, 8), wide_legacy);
    assert_eq!(flags(J8_11_40G, 11), wide_legacy);
    // From JDK 15 compressed class pointers stay on without compressed oops.
    assert_eq!(flags(J21_25_40G, 21), VmLayout { ref_size: 8, legacy_array_base: true, ..VmLayout::DEFAULT });
    assert_eq!(flags(J21_25_40G, 25), VmLayout { ref_size: 8, ..VmLayout::DEFAULT });
    assert_eq!(flags(J21_40G_OFF, 21), flags(J21_25_40G, 21));
}

#[test]
fn layout_flag_edge_cases() {
    let legacy = VmLayout { legacy_array_base: true, ..VmLayout::DEFAULT };
    // No VM.flags (an external dump): the default layout.
    assert_eq!(flags("", 25), VmLayout::DEFAULT);
    assert_eq!(flags("", 21), legacy);
    assert_eq!(flags("-Xmx1g --add-opens=x -XX:Foo", 25), VmLayout::DEFAULT);
    // Before JDK 15 compressed class pointers are on only when the flags say so.
    assert_eq!(flags("-XX:+UseCompressedOops", 11).header, 16);
    assert_eq!(flags("-XX:+UseCompressedOops -XX:+UseCompressedClassPointers", 11).header, 12);
    assert_eq!(flags("-XX:+UseCompressedOops -XX:-UseCompressedClassPointers", 11).header, 16);
    assert_eq!(flags("-XX:+UseCompressedOops", 15).header, 12);
    let no_ccp = flags("-XX:+UseCompressedOops -XX:-UseCompressedClassPointers", 21);
    assert_eq!((no_ccp.header, no_ccp.length_offset, no_ccp.ref_size), (16, 16, 4));
    // Compact headers win over the class pointer flag; the last mention of a flag wins.
    assert_eq!(flags("-XX:-UseCompressedClassPointers -XX:+UseCompactObjectHeaders", 25).header, 8);
    assert_eq!(flags("-XX:-UseCompressedOops -XX:+UseCompressedOops", 21).ref_size, 4);
    assert_eq!(flags("-XX:+UseCompressedOops -XX:-UseCompressedOops", 21).ref_size, 8);
}

#[test]
fn object_alignment_accepts_powers_of_two_from_8_to_256() {
    for good in [8u16, 16, 32, 64, 128, 256] {
        assert_eq!(flags(&format!("-XX:ObjectAlignmentInBytes={good}"), 25).alignment, good);
    }
    for bad in ["0", "4", "7", "12", "255", "512", "abc", "", "999999999999"] {
        assert_eq!(flags(&format!("-XX:ObjectAlignmentInBytes={bad}"), 25).alignment, 8, "{bad:?}");
    }
    let wide = flags("-XX:+UseCompressedOops -XX:ObjectAlignmentInBytes=256", 21);
    assert_eq!(wide.instance_size(1), 256);
    assert_eq!(wide.instance_size(300), 512);
    assert_eq!(wide.array_size(BasicType::Byte, 1), 256);
}

#[test]
fn instance_sizes_match_the_jvm() {
    let at = |sizes: &[u64], name: &str| sizes[SHAPES.iter().position(|n| *n == name).unwrap()];

    let coops = shape_sizes(flags(J21_25_1G, 21));
    for (name, size) in
        [("A", 16), ("B", 24), ("C", 32), ("D", 32), ("E", 24), ("F", 16), ("G", 16), ("H", 24), ("Node", 32)]
    {
        assert_eq!(at(&coops, name), size, "{name} with compressed oops");
    }
    let wide = shape_sizes(flags(J21_25_40G, 21));
    for (name, size) in [("D", 40), ("E", 40), ("Node", 40)] {
        assert_eq!(at(&wide, name), size, "{name} without compressed oops");
    }
    let compact = shape_sizes(flags(J25_COMPACT, 25));
    for (name, size) in [("G", 8), ("B", 16), ("C", 24), ("D", 32), ("Node", 24)] {
        assert_eq!(at(&compact, name), size, "{name} with compact headers");
    }
}

#[test]
fn instance_size_bounds() {
    assert_eq!(VmLayout::DEFAULT.instance_size(0), 16);
    assert_eq!(flags("-XX:+UseCompactObjectHeaders", 25).instance_size(0), 8);
    assert_eq!(flags("-XX:ObjectAlignmentInBytes=16", 21).instance_size(1), 16);
    assert_eq!(flags("-XX:ObjectAlignmentInBytes=16", 21).instance_size(8), 32);
}

#[test]
fn array_sizes() {
    let d = VmLayout::DEFAULT;
    assert_eq!(d.array_size(BasicType::Long, 2), 32);
    assert_eq!(d.array_size(BasicType::Byte, 5), 24);
    assert_eq!(d.array_size(BasicType::Object, 3), 32);
    let compact = flags("-XX:+UseCompactObjectHeaders", 25);
    assert_eq!(compact.array_size(BasicType::Byte, 5), 24);
    assert_eq!(compact.array_size(BasicType::Int, 1), 16);
    assert_eq!(compact.array_size(BasicType::Long, 1), 24);
    assert_eq!(flags("-XX:-UseCompressedClassPointers", 21).array_size(BasicType::Byte, 1), 32);
    assert_eq!(flags("-XX:-UseCompressedClassPointers", 25).array_size(BasicType::Byte, 1), 24);
    assert_eq!(flags("-XX:-UseCompressedClassPointers", 25).array_size(BasicType::Long, 1), 32);
    // Empty arrays and the largest length fit.
    assert_eq!(d.array_size(BasicType::Int, 0), 16);
    assert_eq!(d.array_size(BasicType::Long, u64::from(u32::MAX)), 16 + 8 * u64::from(u32::MAX));
}

#[test]
fn arrays_in_the_graph_follow_the_layout() {
    let g = graph_of(&sample());
    let m = model(&g, VmLayout::DEFAULT, None);
    assert_eq!(size_at(&g, &m, 0x1400), 32, "long[2]");
    assert_eq!(size_at(&g, &m, 0x1500), 32, "Object[3]");
    assert_eq!(size_at(&g, &m, 0x1100), 24, "Node");
    let wide = model(&g, flags("-XX:-UseCompressedOops", 21), None);
    assert_eq!(size_at(&g, &wide, 0x1500), 40, "Object[3] with 8-byte references");
    assert_eq!(m.size_of(&g, g.root), 0, "the super-root has no size");
    assert_eq!(m.source, SizeSource::Layout);
}

#[test]
fn histogram_wins_for_instances() {
    use BasicType::Int;
    let fields: Vec<_> = (0..23).map(|i| (format!("f{i}"), Int)).collect();
    let fields: Vec<(&str, BasicType)> = fields.iter().map(|(n, t)| (n.as_str(), *t)).collect();
    let mut heap = MiniHeap::new();
    heap.class("java.lang.Thread", ROOT, &fields)
        .class("Plain", ROOT, &[("f", Int)])
        .object(0x1000, "java.lang.Thread", &[])
        .object(0x1100, "Plain", &[]);
    let g = graph_of(&heap);

    let without = model(&g, VmLayout::DEFAULT, None);
    assert_eq!(size_at(&g, &without, 0x1000), 104);

    let histogram = [entry("java.lang.Thread", 13, 1560), entry("Unrelated", 2, 64)];
    let with = model(&g, VmLayout::DEFAULT, Some(&histogram));
    assert_eq!(with.source, SizeSource::Jvm);
    assert_eq!(size_at(&g, &with, 0x1000), 120);
    assert_eq!(size_at(&g, &with, 0x1100), 16, "no row: layout");
}

#[test]
fn histogram_rows_that_do_not_divide_or_are_empty_fall_back_to_layout() {
    let mut heap = MiniHeap::new();
    heap.class("Plain", ROOT, &[("f", BasicType::Int)]).object(0x1000, "Plain", &[]);
    let g = graph_of(&heap);
    for row in [entry("Plain", 3, 100), entry("Plain", 0, 0), entry("Plain", 0, 48), entry("Plain", 2, 0)] {
        let m = model(&g, VmLayout::DEFAULT, Some(std::slice::from_ref(&row)));
        assert_eq!(m.source, SizeSource::Jvm);
        assert_eq!(size_at(&g, &m, 0x1000), 16, "{row:?}");
    }
    // The same name twice in the histogram cannot be told apart either.
    let twice = [entry("Plain", 1, 48), entry("Plain", 1, 64)];
    assert_eq!(size_at(&g, &model(&g, VmLayout::DEFAULT, Some(&twice)), 0x1000), 16);
}

#[test]
fn histogram_matches_arrays_by_display_name_but_never_sizes_them() {
    let g = graph_of(&sample());
    let histogram = [entry("java.lang.Object[]", 1, 4096), entry("long[]", 1, 4096), entry("Node", 4, 160)];
    let m = model(&g, VmLayout::DEFAULT, Some(&histogram));
    assert_eq!(size_at(&g, &m, 0x1500), 32);
    assert_eq!(size_at(&g, &m, 0x1400), 32);
    assert_eq!(size_at(&g, &m, 0x1100), 40, "Node from the histogram");
}

#[test]
fn a_name_shared_by_several_classes_never_takes_a_histogram_size() {
    use BasicType::{Int, Long};
    let mut heap = MiniHeap::new();
    heap.class("dup.Foo", ROOT, &[("a", Int)])
        .object(0x1000, "dup.Foo", &[])
        .class("dup.Foo", ROOT, &[("a", Long), ("b", Long)])
        .object(0x1100, "dup.Foo", &[])
        .class("Solo", ROOT, &[("a", Int)])
        .object(0x1200, "Solo", &[]);
    let g = graph_of(&heap);
    let histogram = [entry("dup.Foo", 2, 80), entry("Solo", 1, 48)];
    let m = model(&g, VmLayout::DEFAULT, Some(&histogram));

    assert_eq!(size_at(&g, &m, 0x1000), 16, "first dup.Foo uses its layout");
    assert_eq!(size_at(&g, &m, 0x1100), 32, "second dup.Foo uses its layout");
    assert_eq!(size_at(&g, &m, 0x1200), 48, "Solo still takes its histogram size");
    let (first, second, solo) = (slot_at(&g, 0x1000), slot_at(&g, 0x1100), slot_at(&g, 0x1200));
    assert_ne!(first, second);
    assert!(m.is_ambiguous(first) && m.is_ambiguous(second));
    assert!(!m.is_ambiguous(solo));
    let ambiguous: Vec<_> = (0..g.classes.len() as u32).filter(|&s| m.is_ambiguous(s)).collect();
    assert_eq!(ambiguous.len(), 2, "no other class is flagged");
    assert!(!m.is_ambiguous(u32::MAX), "slots past the classes are never ambiguous");
}

#[test]
fn ambiguity_covers_array_classes_and_ignores_the_source() {
    let mut heap = MiniHeap::new();
    heap.class("[Lx.Y;", ROOT, &[]).class("[Lx/Y;", ROOT, &[]).class("Solo", ROOT, &[]);
    let g = graph_of(&heap);
    let m = model(&g, VmLayout::DEFAULT, None);
    let flagged: Vec<_> =
        g.classes.iter().enumerate().filter(|(i, _)| m.is_ambiguous(*i as u32)).map(|(_, c)| c.name.as_str()).collect();
    assert_eq!(flagged, ["[Lx.Y;", "[Lx.Y;"]);
}

/// A dump with three classes: `java.lang.Class` (three reference fields), `Statics` (two reference
/// statics, one null) and `Plain`; `at` is where each class object lives.
fn class_dump() -> Vec<u8> {
    use BasicType::Object;
    let mut w = HprofWriter::new();
    w.string(1, "java/lang/Class").load_class(0x100, 1).class(
        0x100,
        0,
        &[(10, Object), (11, Object), (12, Object)],
        &[],
    );
    w.string(2, "Statics").load_class(0x200, 2).class(0x200, 0, &[], &[(13, 0x300), (13, 0)]);
    w.string(3, "Plain").load_class(0x300, 3).class(0x300, 0, &[], &[]);
    w.finish()
}

#[test]
fn class_objects_use_the_layout_even_when_the_histogram_names_them() {
    let g = build_graph(&class_dump(), &Store::Ram, &no_progress, &CancellationToken::new()).unwrap();
    let histogram = [entry("java.lang.Class", 3, 3000)];
    let by_histogram = model(&g, VmLayout::DEFAULT, Some(&histogram));
    let by_layout = model(&g, VmLayout::DEFAULT, None);
    assert_eq!(by_histogram.source, SizeSource::Jvm);
    for m in [&by_histogram, &by_layout] {
        // java.lang.Class has 12 bytes of fields: 24; Statics adds two references.
        assert_eq!(size_at(&g, m, 0x100), 24, "java.lang.Class itself");
        assert_eq!(size_at(&g, m, 0x200), 32, "two reference statics");
        assert_eq!(size_at(&g, m, 0x300), 24, "no statics");
    }
    let wide = model(&g, flags("-XX:-UseCompressedOops", 21), None);
    assert_eq!(size_at(&g, &wide, 0x200), 56, "references are 8 bytes");
}

#[test]
fn primitive_statics_add_to_the_class_object() {
    let mut g = build_graph(&class_dump(), &Store::Ram, &no_progress, &CancellationToken::new()).unwrap();
    let statics = g.classes.iter().position(|c| c.name == "Statics").unwrap();
    g.classes[statics].static_bytes = 12;
    let m = model(&g, VmLayout::DEFAULT, None);
    assert_eq!(size_at(&g, &m, 0x200), 48, "24 + 12 + 2 × 4 = 44, aligned");
}

#[test]
fn a_dump_without_java_lang_class_sizes_class_objects_as_empty_mirrors() {
    let mut w = HprofWriter::new();
    w.string(1, "Statics").load_class(0x200, 1).class(0x200, 0, &[], &[(2, 0), (2, 0), (2, 0)]);
    let g = build_graph(&w.finish(), &Store::Ram, &no_progress, &CancellationToken::new()).unwrap();
    let m = model(&g, VmLayout::DEFAULT, None);
    assert_eq!(size_at(&g, &m, 0x200), 32, "16 + 3 × 4, aligned");
}

fn one_class_two_instances(stride: u64) -> (HeapGraph, ShallowModel) {
    let mut heap = MiniHeap::new();
    heap.class("A", ROOT, &[("f", BasicType::Byte)]).object(0x1000, "A", &[]).object(0x1000 + stride, "A", &[]);
    let g = graph_of(&heap);
    let m = model(&g, VmLayout::DEFAULT, None);
    (g, m)
}

#[test]
fn address_gaps_for_external_dumps() {
    let mut heap = MiniHeap::new();
    heap.class("A", ROOT, &[("f", BasicType::Byte)])
        .class("Wide", ROOT, &[("f", BasicType::Long)])
        .class("Module", ROOT, &[("f", BasicType::Long)])
        .object(0x1000, "A", &[])
        .object(0x1018, "A", &[])
        .object(0x1030, "A", &[])
        .object(0x1048, "Module", &[])
        .object(0x2000, "Wide", &[])
        .object(0x3000, "Wide", &[]);
    let g = graph_of(&heap);
    let m = model(&g, VmLayout::DEFAULT, None);
    assert_eq!(size_at(&g, &m, 0x1000), 24, "layout says 16, the smallest gap between As is 24");
    assert_eq!(size_at(&g, &m, 0x1030), 24, "every A takes the type's size");
    assert_eq!(size_at(&g, &m, 0x1048), 24, "a single instance has no gap to trust: layout");
    assert_eq!(size_at(&g, &m, 0x2000), 24, "a gap beyond layout + 64 is not an object size: layout");
    assert_eq!(m.source, SizeSource::Layout, "one of three types agrees");
}

#[test]
fn address_gaps_are_taken_within_layout_and_layout_plus_64() {
    for (stride, expected) in [(8, 16), (16, 16), (24, 24), (80, 80), (88, 16)] {
        let (g, m) = one_class_two_instances(stride);
        assert_eq!(size_at(&g, &m, 0x1000), expected, "stride {stride}");
        assert_eq!(
            m.source,
            if expected == stride && stride >= 16 { SizeSource::AddressGaps } else { SizeSource::Layout }
        );
    }
}

/// `used` types with two instances 16 bytes apart (the layout size), `far` types with two
/// instances 0x1000 apart (a gap that is no object size) and `single` types with one instance.
fn types_by_gap_use(used: usize, far: usize, single: usize) -> SizeSource {
    let mut heap = MiniHeap::new();
    for i in 0..used + far + single {
        let name = format!("T{i}");
        heap.class(&name, ROOT, &[("f", BasicType::Byte)]);
        let base = 0x10_0000 * (i as u64 + 1);
        heap.object(base, &name, &[]);
        if i < used {
            heap.object(base + 16, &name, &[]);
        } else if i < used + far {
            heap.object(base + 0x1000, &name, &[]);
        }
    }
    let g = graph_of(&heap);
    model(&g, VmLayout::DEFAULT, None).source
}

#[test]
fn address_gap_source_needs_ninety_percent_of_the_types_that_have_a_gap() {
    assert_eq!(types_by_gap_use(10, 0, 0), SizeSource::AddressGaps);
    assert_eq!(types_by_gap_use(9, 1, 0), SizeSource::AddressGaps);
    assert_eq!(types_by_gap_use(8, 2, 0), SizeSource::Layout);
    // Types with one instance have no gap: they count neither for nor against.
    assert_eq!(types_by_gap_use(9, 1, 5), SizeSource::AddressGaps);
    assert_eq!(types_by_gap_use(8, 2, 5), SizeSource::Layout);
    assert_eq!(types_by_gap_use(10, 0, 400), SizeSource::AddressGaps);
    assert_eq!(types_by_gap_use(0, 0, 3), SizeSource::Layout, "no type has a gap");
    assert_eq!(types_by_gap_use(0, 2, 0), SizeSource::Layout);
    assert_eq!(types_by_gap_use(0, 0, 0), SizeSource::Layout, "nothing to size");
}

/// A dump of `java.lang.Class` (three reference fields, so 24 bytes of layout) and one class per
/// entry of `statics`: `(reference statics, primitive static bytes)`. Class `i` is at `0x1000 + 0x100 × i`.
fn mirror_heap(statics: &[(usize, u64)]) -> (HeapGraph, Vec<u64>) {
    use BasicType::Object;
    let mut w = HprofWriter::new();
    w.string(1, "java/lang/Class").load_class(0x100, 1).class(
        0x100,
        0,
        &[(10, Object), (11, Object), (12, Object)],
        &[],
    );
    let mut addrs = Vec::new();
    for (i, &(refs, _)) in statics.iter().enumerate() {
        let (addr, name_id) = (0x1000 + 0x100 * i as u64, 100 + i as u64);
        w.string(name_id, &format!("C{i}")).load_class(addr, name_id).class(addr, 0, &[], &vec![(13, 0); refs]);
        addrs.push(addr);
    }
    let mut g = build_graph(&w.finish(), &Store::Ram, &no_progress, &CancellationToken::new()).unwrap();
    for (i, &(_, bytes)) in statics.iter().enumerate() {
        let class = g.classes.iter().position(|c| c.name == format!("C{i}")).unwrap();
        g.classes[class].static_bytes = bytes;
    }
    (g, addrs)
}

/// What HotSpot would make of those classes if it added `injected` bytes to every mirror.
fn expected_mirrors(statics: &[(usize, u64)], injected: u64) -> Vec<u64> {
    statics.iter().map(|&(refs, bytes)| (24 + bytes + 4 * refs as u64 + injected).next_multiple_of(8)).collect()
}

const MIRROR_STATICS: [(usize, u64); 8] = [(0, 0), (3, 0), (1, 12), (6, 8), (2, 0), (9, 24), (0, 4), (4, 1)];

#[test]
fn class_objects_get_the_injected_bytes_the_histogram_implies() {
    let (g, addrs) = mirror_heap(&MIRROR_STATICS);
    // java.lang.Class itself and the eight classes.
    let mut sizes = expected_mirrors(&MIRROR_STATICS, 36);
    let java_lang_class = 24 + 36;
    let total = sizes.iter().sum::<u64>() + (java_lang_class as u64).next_multiple_of(8);
    sizes.insert(0, (java_lang_class as u64).next_multiple_of(8));
    let histogram = [entry("java.lang.Class", 9, total)];
    let m = model(&g, VmLayout::DEFAULT, Some(&histogram));
    assert_eq!(m.source, SizeSource::Jvm);
    assert_eq!(size_at(&g, &m, 0x100), sizes[0]);
    for (i, &addr) in addrs.iter().enumerate() {
        assert_eq!(size_at(&g, &m, addr), sizes[i + 1], "class {i}");
    }
    let spread: Vec<_> = addrs.iter().map(|&a| size_at(&g, &m, a)).collect();
    assert!(spread.iter().any(|&s| s != spread[0]), "statics still make the mirrors differ: {spread:?}");
}

#[test]
fn injected_bytes_are_found_for_every_multiple_of_four() {
    let (g, addrs) = mirror_heap(&MIRROR_STATICS);
    for injected in (0..=128).step_by(4) {
        let total =
            expected_mirrors(&MIRROR_STATICS, injected).iter().sum::<u64>() + (24 + injected).next_multiple_of(8);
        let histogram = [entry("java.lang.Class", 9, total)];
        let m = model(&g, VmLayout::DEFAULT, Some(&histogram));
        let got: Vec<_> = addrs.iter().map(|&a| size_at(&g, &m, a)).collect();
        assert_eq!(got, expected_mirrors(&MIRROR_STATICS, injected), "injected {injected}");
    }
}

#[test]
fn the_fit_tolerates_mirrors_the_dump_has_no_class_for() {
    let (g, addrs) = mirror_heap(&MIRROR_STATICS);
    // The histogram counts the same average mirror 90 times more often (CDS-archived classes).
    let total = expected_mirrors(&MIRROR_STATICS, 28).iter().sum::<u64>() + (24u64 + 28).next_multiple_of(8);
    let histogram = [entry("java.lang.Class", 9 * 91, total * 91)];
    let m = model(&g, VmLayout::DEFAULT, Some(&histogram));
    let got: Vec<_> = addrs.iter().map(|&a| size_at(&g, &m, a)).collect();
    assert_eq!(got, expected_mirrors(&MIRROR_STATICS, 28));
}

#[test]
fn a_histogram_row_that_cannot_describe_these_mirrors_adds_nothing() {
    let (g, addrs) = mirror_heap(&MIRROR_STATICS);
    let plain = expected_mirrors(&MIRROR_STATICS, 0);
    for row in [
        entry("java.lang.Class", 9, 9 * 5000),
        entry("java.lang.Class", 9, 9),
        entry("java.lang.Class", 0, 0),
        entry("Something.Else", 9, 9 * 100),
    ] {
        let m = model(&g, VmLayout::DEFAULT, Some(std::slice::from_ref(&row)));
        let got: Vec<_> = addrs.iter().map(|&a| size_at(&g, &m, a)).collect();
        assert_eq!(got, plain, "{row:?}");
    }
    let twice = [entry("java.lang.Class", 9, 9 * 60), entry("java.lang.Class", 9, 9 * 60)];
    let m = model(&g, VmLayout::DEFAULT, Some(&twice));
    assert_eq!(size_at(&g, &m, addrs[0]), plain[0], "two rows of the name cannot be told apart");
}

#[test]
fn without_a_histogram_class_objects_get_no_injected_bytes() {
    let (g, addrs) = mirror_heap(&MIRROR_STATICS);
    let m = model(&g, VmLayout::DEFAULT, None);
    let got: Vec<_> = addrs.iter().map(|&a| size_at(&g, &m, a)).collect();
    assert_eq!(got, expected_mirrors(&MIRROR_STATICS, 0));
}

#[test]
fn cancelled_token_stops_the_model() {
    let g = graph_of(&sample());
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(ShallowModel::new(&g, VmLayout::DEFAULT, None, &cancel), Err(HeapError::Cancelled)));
    let histogram = [entry("Node", 1, 24)];
    assert!(matches!(ShallowModel::new(&g, VmLayout::DEFAULT, Some(&histogram), &cancel), Err(HeapError::Cancelled)));
}
