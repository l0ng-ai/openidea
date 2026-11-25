use super::*;
use crate::hprof::BasicType;
use crate::test_index::{analyzed, analyzed_bytes, obj, slot};
use crate::testing::{HprofWriter, MiniHeap, sample, sample_with_string};

const H: u64 = 0x1000;
const N1: u64 = 0x1100;
const N3: u64 = 0x1300;
const L: u64 = 0x1400;
const W: u64 = 0x1600;
const N4: u64 = 0x1700;

fn addresses(page: &HeapObjectPage) -> Vec<&str> {
    page.rows.iter().map(|r| r.address.as_str()).collect()
}

fn retained(page: &HeapObjectPage) -> Vec<u64> {
    page.rows.iter().map(|r| r.retained).collect()
}

fn path(index: &HeapIndex, addr: u64) -> Option<Vec<(String, HeapEdge)>> {
    let path = index.path_to_root(obj(index, addr))?;
    assert_eq!((path.omitted, path.omitted_after), (0, 0));
    Some(path.steps.into_iter().map(|s| (s.object.address, s.via)).collect())
}

fn field(name: &str) -> HeapEdge {
    HeapEdge::Field { name: name.to_owned() }
}

fn root(root: HeapRootKind, thread: Option<&str>) -> HeapEdge {
    HeapEdge::Root { root, thread: thread.map(str::to_owned) }
}

#[test]
fn top_level_dominators_sorted_by_retained() {
    let index = analyzed(&sample());
    let page = index.dominated(None, None, 0, 10);
    assert_eq!(addresses(&page), ["0x1000", "0x1300", "0x1600"]);
    assert_eq!(retained(&page), [72, 56, 24]);
    // The class objects, rooted as sticky classes, are left out.
    assert_eq!(page.total, 3);
    assert_eq!(addresses(&index.dominated(None, None, 1, 1)), ["0x1300"]);
}

#[test]
fn children_of_holder() {
    let index = analyzed(&sample());
    let page = index.dominated(Some(obj(&index, H)), None, 0, 10);
    assert_eq!(addresses(&page), ["0x1100", "0x1200"]);
    assert_eq!(retained(&page), [24, 24]);
    assert_eq!(page.total, 2);
    assert!(page.rows.iter().all(|r| !r.has_children && r.class_name == "Node"));
    let n3 = index.object_row(obj(&index, N3)).unwrap();
    assert!(n3.has_children);
    assert_eq!(index.dominated(Some(n3.object), None, 0, 10).rows[0].class_name, "long[]");
}

#[test]
fn largest_of_class() {
    let index = analyzed(&sample());
    let node = slot(&index, "Node");
    let page = index.dominated(None, Some(node), 0, 2);
    assert_eq!(addresses(&page), ["0x1300", "0x1100"]);
    assert_eq!(retained(&page), [56, 24]);
    assert_eq!(page.total, 3);
    assert_eq!(addresses(&index.dominated(None, Some(node), 2, 2)), ["0x1200"]);
    assert!(index.dominated(None, Some(node), 3, 2).rows.is_empty());
    // Within a parent's children.
    assert_eq!(addresses(&index.dominated(Some(obj(&index, H)), Some(node), 1, 5)), ["0x1200"]);
    assert_eq!(index.dominated(Some(obj(&index, H)), Some(slot(&index, "Holder")), 0, 5).total, 0);
}

#[test]
fn object_row_describes_object() {
    let index = analyzed(&sample());
    let row = index.object_row(obj(&index, N3)).unwrap();
    assert_eq!(
        row,
        HeapObjectRow {
            object: obj(&index, N3),
            class_name: "Node".to_owned(),
            address: "0x1300".to_owned(),
            shallow: 24,
            retained: 56,
            has_children: true,
            preview: None,
        }
    );
    let unreachable = index.object_row(obj(&index, N4)).unwrap();
    assert_eq!((unreachable.retained, unreachable.has_children), (0, false));

    let holder = &index.class_info[slot(&index, "Holder") as usize];
    let class_object = obj(&index, holder.id);
    let row = index.object_row(class_object).unwrap();
    assert_eq!((row.class_name.as_str(), row.preview.as_deref()), ("java.lang.Class", Some("Holder")));
}

#[test]
fn refs_that_name_no_object_answer_nothing() {
    let index = analyzed(&sample());
    let node = slot(&index, "Node");
    for bad in [index.root(), index.root() + 1, u32::MAX] {
        let bad = HeapObjectRef(bad);
        assert_eq!(index.object_row(bad), None);
        assert_eq!(index.path_to_root(bad), None);
        assert_eq!(index.dominated(Some(bad), None, 0, 10), HeapObjectPage { rows: Vec::new(), total: 0 });
        assert_eq!(index.dominated(Some(bad), Some(node), 0, 10).total, 0);
    }
    for bad in [index.classes.len() as u32, u32::MAX] {
        assert_eq!(index.dominated(None, Some(bad), 0, 10).total, 0);
    }
}

#[test]
fn path_to_root_names_fields_and_root() {
    let index = analyzed(&sample());
    assert_eq!(
        path(&index, L),
        Some(vec![("0x1400".to_owned(), field("next")), ("0x1300".to_owned(), root(HeapRootKind::JavaFrame, None))])
    );
    assert_eq!(
        path(&index, N1),
        Some(vec![("0x1100".to_owned(), field("a")), ("0x1000".to_owned(), root(HeapRootKind::JniGlobal, None))])
    );
    assert_eq!(path(&index, W), Some(vec![("0x1600".to_owned(), root(HeapRootKind::JniGlobal, None))]));
    assert_eq!(path(&index, N4), None);
}

/// A rooted linked list of `len` Nodes from `0x100000`, each held by the next one's `next`.
fn chain(len: u64) -> HeapIndex {
    let mut heap = sample();
    for i in 0..len {
        let next = if i == 0 { 0 } else { 0x10_0000 + (i - 1) * 0x20 };
        heap.object(0x10_0000 + i * 0x20, "Node", &[("next", next)]);
    }
    heap.root(HeapRootKind::JniGlobal, 0x10_0000 + (len - 1) * 0x20);
    analyzed(&heap)
}

#[test]
fn path_of_an_object_deep_in_a_linked_list_keeps_both_ends() {
    let index = chain(3000);
    let path = index.path_to_root(obj(&index, 0x10_0000)).unwrap();
    assert_eq!((path.steps.len(), path.omitted, path.omitted_after), (1000, 2000, 500));
    let address = |i: usize| path.steps[i].object.address.clone();
    assert_eq!([address(0), address(499)], ["0x100000", "0x103e60"]);
    // The step after the gap is the one 2000 nodes further up.
    assert_eq!([address(500), address(999)], ["0x113880", "0x1176e0"]);
    assert_eq!(path.steps[999].via, root(HeapRootKind::JniGlobal, None));
    assert!(path.steps[..999].iter().all(|s| s.via == field("next")));
}

#[test]
fn path_of_exactly_a_thousand_steps_is_whole() {
    let index = chain(1000);
    let path = index.path_to_root(obj(&index, 0x10_0000)).unwrap();
    assert_eq!((path.steps.len(), path.omitted, path.omitted_after), (1000, 0, 0));
}

#[test]
fn path_skips_the_weak_referent() {
    let mut heap = sample();
    heap.object(0x1c00, "java.lang.ref.WeakReference", &[("referent", 0x1d00), ("queue", 0x1d00)])
        .object(0x1d00, "Node", &[])
        .root(HeapRootKind::JniGlobal, 0x1c00);
    let index = analyzed(&heap);
    assert_eq!(path(&index, 0x1d00).unwrap()[0].1, field("queue"));
}

/// Kid extends Base, loaded by loader `0x300`; Base's static `cache` holds X; K is a rooted Kid;
/// `0x700` is a rooted `Object[] { null, Y }`. No class is rooted on its own.
fn class_edges_heap() -> Vec<u8> {
    let mut w = HprofWriter::new();
    let names = [(1, "Base"), (2, "Kid"), (3, "Ldr"), (4, "[Ljava/lang/Object;"), (5, "cache")];
    for (id, name) in names {
        w.string(id, name);
    }
    for (class, name) in [(0x100, 1), (0x200, 2), (0x400, 3), (0x800, 4)] {
        w.load_class(class, name);
    }
    w.class(0x100, 0, &[], &[(5, 0x500)])
        .class_with_loader(0x200, 0x100, 0x300, &[], &[])
        .class(0x400, 0, &[], &[])
        .class(0x800, 0, &[], &[])
        .instance(0x300, 0x400, &[])
        .instance(0x500, 0x400, &[])
        .instance(0x600, 0x200, &[])
        .obj_array(0x700, 0x800, &[0, 0x900])
        .instance(0x900, 0x400, &[])
        .root(HeapRootKind::JniGlobal, 0x600)
        .root(HeapRootKind::JniGlobal, 0x700);
    w.finish()
}

#[test]
fn path_names_statics_supers_loaders_classes_and_elements() {
    let index = analyzed_bytes(&class_edges_heap());
    let k = ("0x600".to_owned(), root(HeapRootKind::JniGlobal, None));
    assert_eq!(
        path(&index, 0x500),
        Some(vec![
            ("0x500".to_owned(), HeapEdge::Static { name: "cache".to_owned() }),
            ("0x100".to_owned(), HeapEdge::SuperClass),
            ("0x200".to_owned(), HeapEdge::ClassOf),
            k.clone(),
        ])
    );
    assert_eq!(
        path(&index, 0x300),
        Some(vec![("0x300".to_owned(), HeapEdge::ClassLoader), ("0x200".to_owned(), HeapEdge::ClassOf), k])
    );
    assert_eq!(
        path(&index, 0x900),
        Some(vec![
            ("0x900".to_owned(), HeapEdge::Element { index: 1 }),
            ("0x700".to_owned(), root(HeapRootKind::JniGlobal, None))
        ])
    );
}

fn with_main_thread(mut heap: MiniHeap, name: impl FnOnce(&mut MiniHeap, u64)) -> MiniHeap {
    heap.class("java.lang.Thread", Some("java.lang.Object"), &[("name", BasicType::Object)]);
    name(&mut heap, 0x2000);
    heap.object(0x2100, "java.lang.Thread", &[("name", 0x2000)]).root_in_thread(HeapRootKind::ThreadObject, 0x2100, 1);
    heap
}

#[test]
fn thread_name_on_java_frame_root() {
    let heap = with_main_thread(sample_with_string(), |h, at| {
        h.string(at, "main", true);
    });
    let index = analyzed(&heap);
    let steps = path(&index, L).unwrap();
    assert_eq!(steps.last().unwrap().1, root(HeapRootKind::JavaFrame, Some("main")));
    // A JNI global carries no thread.
    assert_eq!(path(&index, H).unwrap()[0].1, root(HeapRootKind::JniGlobal, None));
}

#[test]
fn jdk8_thread_name_is_a_char_array() {
    let heap = with_main_thread(sample(), |h, at| {
        let utf16: Vec<u8> = "main".encode_utf16().flat_map(u16::to_be_bytes).collect();
        h.prim_bytes(at, BasicType::Char, &utf16);
    });
    let index = analyzed(&heap);
    assert_eq!(path(&index, N3).unwrap()[0].1, root(HeapRootKind::JavaFrame, Some("main")));
}

#[test]
fn page_limit_is_clamped() {
    let mut heap = MiniHeap::new();
    heap.class("Node", Some("java.lang.Object"), &[("next", BasicType::Object)]);
    for k in 0..600u64 {
        let addr = 0x10_0000 + k * 0x100;
        heap.object(addr, "Node", &[]).root(HeapRootKind::JniGlobal, addr);
    }
    let index = analyzed(&heap);
    let node = slot(&index, "Node");
    let page = index.dominated(None, Some(node), 0, 10_000);
    assert_eq!((page.rows.len(), page.total), (MAX_PAGE as usize, 600));
    let top = index.dominated(None, None, 0, 10_000);
    assert_eq!((top.rows.len(), top.total), (MAX_PAGE as usize, 600));
    assert_eq!(index.dominated(None, None, 550, 10_000).rows.len(), 50);
    for (offset, limit) in [(u32::MAX, u32::MAX), (u32::MAX - 10, 100), (599, u32::MAX)] {
        let page = index.dominated(None, Some(node), offset, limit);
        assert_eq!((page.rows.len(), page.total), (usize::from(offset == 599), 600), "{offset} {limit}");
        assert!(index.dominated(None, None, offset, limit).rows.len() <= 1);
    }
}

#[test]
fn class_rows_skip_empty_slots() {
    let index = analyzed(&sample());
    let rows = index.class_rows();
    let node = rows.iter().find(|r| r.name == "Node").unwrap();
    assert_eq!(
        (node.class_index, node.count, node.shallow, node.retained, node.unreachable_count, node.ambiguous),
        (slot(&index, "Node"), 3, 72, 104, 1, false)
    );
    assert!(rows.iter().all(|r| r.count + r.unreachable_count > 0));
    assert!(!rows.iter().any(|r| r.name == "boolean[]"));
    assert!(rows.windows(2).all(|p| p[0].retained >= p[1].retained));
    assert_eq!(index.summary().objects, 8);
}

#[test]
fn class_rows_mark_names_of_several_classes() {
    let mut heap = sample();
    // `object` takes the class defined last under a name, so each Foo gets one instance.
    heap.class("Foo", Some("java.lang.Object"), &[])
        .object(0x3000, "Foo", &[])
        .class("Foo", Some("java.lang.Object"), &[])
        .object(0x3100, "Foo", &[])
        .object(0x3200, "Foo", &[]);
    let index = analyzed(&heap);
    let rows = index.class_rows();
    let foos: Vec<_> = rows.iter().filter(|r| r.name == "Foo").collect();
    assert_eq!(foos.len(), 2);
    assert!(foos.iter().all(|r| r.ambiguous));
    let mut counts: Vec<u64> = foos.iter().map(|r| r.unreachable_count).collect();
    counts.sort_unstable();
    assert_eq!(counts, [1, 2]);
    assert!(rows.iter().filter(|r| r.name != "Foo").all(|r| !r.ambiguous));
}

#[test]
fn ipc_shapes() {
    assert_eq!(json(&HeapObjectRef(7)), "7");
    assert_eq!(json(&HeapEdge::ClassOf), r#"{"kind":"classOf"}"#);
    assert_eq!(json(&HeapEdge::Element { index: 2 }), r#"{"kind":"element","index":2}"#);
    assert_eq!(
        json(&root(HeapRootKind::JavaFrame, Some("main"))),
        r#"{"kind":"root","root":"javaFrame","thread":"main"}"#
    );
    let row = HeapClassRow {
        class_index: 1,
        name: "A".to_owned(),
        count: 2,
        shallow: 3,
        retained: 4,
        unreachable_count: 5,
        ambiguous: false,
    };
    assert_eq!(
        json(&row),
        r#"{"classIndex":1,"name":"A","count":2,"shallow":3,"retained":4,"unreachableCount":5,"ambiguous":false}"#
    );
    let back: HeapObjectRef = serde_json::from_str("4294967295").unwrap();
    assert_eq!(back, HeapObjectRef(u32::MAX));
}

fn json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap()
}
