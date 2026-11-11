use super::*;
use crate::hprof::HeapRootKind;
use crate::test_index::analyzed;
use crate::testing::{MiniHeap, sample, sample_with_two_more_nodes};

fn diff<'a>(diffs: &'a [HeapClassDiff], name: &str) -> &'a HeapClassDiff {
    let mut rows = diffs.iter().filter(|d| d.name == name);
    let row = rows.next().unwrap_or_else(|| panic!("no diff for {name}"));
    assert!(rows.next().is_none(), "two diffs for {name}");
    row
}

fn sort_key(d: &HeapClassDiff) -> u64 {
    if d.ambiguous { 0 } else { d.retained.abs_diff(d.base_retained) }
}

fn assert_sorted(diffs: &[HeapClassDiff]) {
    assert!(diffs.windows(2).all(|p| (sort_key(&p[1]), &p[0].name) < (sort_key(&p[0]), &p[1].name)), "{diffs:#?}");
}

#[test]
fn compare_counts_by_class() {
    let base = analyzed(&sample());
    let mut current = sample_with_two_more_nodes();
    current
        .class("Extra", Some("java.lang.Object"), &[])
        .object(0x4000, "Extra", &[])
        .root(HeapRootKind::JniGlobal, 0x4000);
    let diffs = compare(&base, &analyzed(&current));
    let node = diff(&diffs, "Node");
    assert_eq!((node.base_count, node.count), (3, 5));
    assert_eq!(node.shallow - node.base_shallow, 48);
    assert_eq!((node.base_retained, node.retained), (104, 152));
    assert!(!node.ambiguous);
    let extra = diff(&diffs, "Extra");
    assert_eq!((extra.base_count, extra.base_shallow, extra.base_retained, extra.count), (0, 0, 0, 1));
    assert_eq!(diffs[0].name, "Node");
    let holder = diff(&diffs, "Holder");
    assert_eq!((holder.base_count, holder.count, holder.base_retained, holder.retained), (1, 1, 72, 72));
    assert_sorted(&diffs);

    // A class only in the base snapshot.
    let gone = compare(&analyzed(&current), &base);
    let extra = diff(&gone, "Extra");
    assert_eq!((extra.base_count, extra.count, extra.shallow, extra.retained), (1, 0, 0, 0));
    assert_sorted(&gone);
}

fn two_foos(extra: bool) -> MiniHeap {
    let mut heap = sample();
    heap.class("Foo", Some("java.lang.Object"), &[])
        .object(0x3000, "Foo", &[])
        .class("Foo", Some("java.lang.Object"), &[])
        .object(0x3100, "Foo", &[]);
    if extra {
        heap.object(0x3200, "Foo", &[]);
    }
    for addr in [0x3000, 0x3100, 0x3200] {
        heap.root(HeapRootKind::JniGlobal, addr);
    }
    heap
}

#[test]
fn compare_gives_no_diff_for_a_name_of_several_classes() {
    let diffs = compare(&analyzed(&two_foos(false)), &analyzed(&two_foos(true)));
    let foo = diff(&diffs, "Foo");
    assert!(foo.ambiguous);
    assert_eq!((foo.base_count, foo.count), (2, 3));
    assert!(diffs.iter().filter(|d| d.name != "Foo").all(|d| !d.ambiguous));
    assert_sorted(&diffs);

    // Ambiguous on one side only is still ambiguous.
    let diffs = compare(&analyzed(&sample()), &analyzed(&two_foos(false)));
    let foo = diff(&diffs, "Foo");
    assert!(foo.ambiguous);
    assert_eq!((foo.base_count, foo.count), (0, 2));
}
