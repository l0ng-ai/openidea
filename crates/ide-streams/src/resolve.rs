//! Links recorded elements across steps by time order and identity (spec §10.4).

use std::collections::HashMap;

use crate::model::{BoxKind, DistinctDrop, Link, Record, StepKind, TraceValue};

/// What a reordering step preserves: the primitive's value for boxes (each `peek`
/// re-boxes, so their ids say nothing), the object id otherwise.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Key<'a> {
    Null,
    Boxed(BoxKind, &'a str),
    Id(u64),
}

fn identity_key(value: &TraceValue) -> Key<'_> {
    match value {
        TraceValue::Null => Key::Null,
        TraceValue::Boxed { class, value, .. } => Key::Boxed(*class, value),
        TraceValue::Object { id, .. } | TraceValue::Str { id, .. } => Key::Id(*id),
    }
}

/// Value equality that needs no debuggee call; `None` when only `equals` can tell.
fn equality_key(value: &TraceValue) -> Option<EqKey<'_>> {
    match value {
        TraceValue::Null => Some(EqKey::Null),
        TraceValue::Boxed { class, value, .. } => Some(EqKey::Boxed(*class, value)),
        TraceValue::Str { value, truncated: false, .. } => Some(EqKey::Text(value)),
        TraceValue::Str { truncated: true, .. } | TraceValue::Object { .. } => None,
    }
}

#[derive(PartialEq, Eq, Hash)]
enum EqKey<'a> {
    Null,
    Boxed(BoxKind, &'a str),
    Text(&'a str),
}

/// Records of one step with the same key, handed out in recording order.
#[derive(Default)]
struct Bucket {
    indices: Vec<u32>,
    next: usize,
}

/// `kinds[i]` is the operation between steps `i` and `i + 1`; the result runs parallel to `records`.
pub fn resolve(kinds: &[StepKind], records: &[Record]) -> Vec<Link> {
    let mut buckets: HashMap<(u16, Key), Bucket> = HashMap::new();
    for (i, rec) in records.iter().enumerate() {
        if kinds.get(usize::from(rec.step)) == Some(&StepKind::Reorder) {
            buckets.entry((rec.step, identity_key(&rec.value))).or_default().indices.push(i as u32);
        }
    }

    let mut latest: HashMap<u16, u32> = HashMap::new();
    let mut links = Vec::with_capacity(records.len());
    for (i, rec) in records.iter().enumerate() {
        let previous = rec.step.checked_sub(1);
        let kind = previous.and_then(|p| kinds.get(usize::from(p)));
        links.push(match (previous, kind) {
            (Some(p), Some(StepKind::Sync)) => Link { parent: latest.get(&p).copied(), ambiguous: false },
            (Some(p), Some(StepKind::Reorder)) => match buckets.get_mut(&(p, identity_key(&rec.value))) {
                Some(b) => {
                    let parent = b.indices.get(b.next).copied();
                    b.next += 1;
                    Link { parent, ambiguous: b.indices.len() > 1 }
                }
                None => Link { parent: None, ambiguous: false },
            },
            _ => Link { parent: None, ambiguous: false },
        });
        latest.insert(rec.step, i as u32);
    }
    links
}

/// True when `step` started emitting before `step - 1` finished, which a real sort
/// cannot do: the source was already sorted and `sorted` passed elements through.
pub fn sorted_pass_through(records: &[Record], step: u16) -> bool {
    let Some(previous) = step.checked_sub(1) else {
        return false;
    };
    let last_previous = records.iter().rposition(|r| r.step == previous);
    let first_current = records.iter().position(|r| r.step == step);
    matches!((first_current, last_previous), (Some(c), Some(p)) if c < p)
}

/// Elements of `step - 1` that produced nothing at `step`, each with the earliest kept
/// element of that step it equals. Objects and truncated strings get `None`: only the
/// user's `equals` can compare them.
pub fn distinct_drops(records: &[Record], links: &[Link], step: u16) -> Vec<DistinctDrop> {
    let Some(previous) = step.checked_sub(1) else {
        return Vec::new();
    };
    let mut kept = vec![false; records.len()];
    for (rec, link) in records.iter().zip(links) {
        if let (true, Some(parent)) = (rec.step == step, link.parent) {
            kept[parent as usize] = true;
        }
    }

    let mut first_kept: HashMap<EqKey, u32> = HashMap::new();
    let mut drops = Vec::new();
    for (i, rec) in records.iter().enumerate().filter(|(_, r)| r.step == previous) {
        let key = equality_key(&rec.value);
        if kept[i] {
            if let Some(key) = key {
                first_kept.entry(key).or_insert(i as u32);
            }
        } else {
            let same_as = key.and_then(|k| first_kept.get(&k).copied());
            drops.push(DistinctDrop { dropped: i as u32, same_as });
        }
    }
    drops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BoxKind, TraceValue};

    fn o(id: u64) -> TraceValue {
        TraceValue::Object { id, class: "Foo".into() }
    }
    fn int(id: u64, v: i32) -> TraceValue {
        TraceValue::Boxed { id, class: BoxKind::Int, value: v.to_string() }
    }
    fn s(id: u64, text: &str) -> TraceValue {
        TraceValue::Str { id, value: text.into(), truncated: false }
    }
    fn r(step: u16, value: TraceValue) -> Record {
        Record { step, value }
    }
    fn parents(links: &[Link]) -> Vec<Option<u32>> {
        links.iter().map(|l| l.parent).collect()
    }
    use StepKind::{Reorder, Sync, Unlinked};

    #[test]
    fn sync_links_to_the_nearest_earlier_record() {
        let records = [r(0, o(1)), r(0, o(2)), r(1, o(2)), r(2, o(3)), r(0, o(4))];
        let links = resolve(&[Sync, Sync], &records);
        assert_eq!(parents(&links), [None, None, Some(1), Some(2), None]);
    }

    #[test]
    fn flat_map_children_link_to_their_element() {
        let records = [r(0, o(1)), r(1, o(5)), r(1, o(6)), r(0, o(2)), r(1, o(7))];
        let links = resolve(&[Sync], &records);
        assert_eq!(parents(&links), [None, Some(0), Some(0), None, Some(3)]);
    }

    #[test]
    fn skip_with_shared_cached_integers() {
        let records = [r(0, int(7, 1)), r(0, int(7, 1)), r(0, int(7, 1)), r(1, int(7, 1))];
        let links = resolve(&[Sync], &records);
        assert_eq!(links[3].parent, Some(2));
    }

    #[test]
    fn sorted_matches_objects_by_identity() {
        let records = [r(0, o(1)), r(0, o(2)), r(0, o(3)), r(1, o(3)), r(1, o(1)), r(1, o(2))];
        let links = resolve(&[Reorder], &records);
        assert_eq!(parents(&links), [None, None, None, Some(2), Some(0), Some(1)]);
        assert!(links.iter().all(|l| !l.ambiguous));
    }

    #[test]
    fn sorted_matches_boxes_by_value_in_order() {
        let records = [
            r(0, int(11, 300)),
            r(0, int(12, 1)),
            r(0, int(13, 300)),
            r(1, int(14, 1)),
            r(1, int(15, 300)),
            r(1, int(16, 300)),
        ];
        let links = resolve(&[Reorder], &records);
        assert_eq!(links[3], Link { parent: Some(1), ambiguous: false });
        assert_eq!(links[4], Link { parent: Some(0), ambiguous: true });
        assert_eq!(links[5], Link { parent: Some(2), ambiguous: true });
    }

    #[test]
    fn sorted_then_limit() {
        let records = [r(0, o(5)), r(0, o(3)), r(0, o(8)), r(0, o(1)), r(1, o(1)), r(2, o(1)), r(1, o(3)), r(2, o(3))];
        let links = resolve(&[Reorder, Sync], &records);
        assert_eq!(parents(&links), [None, None, None, None, Some(3), Some(4), Some(1), Some(6)]);
    }

    #[test]
    fn unlinked_ops_have_no_parents() {
        let records = [r(0, o(1)), r(1, o(1)), r(1, o(2))];
        let links = resolve(&[Unlinked], &records);
        assert_eq!(parents(&links), [None, None, None]);
    }

    #[test]
    fn pass_through_sort_is_detected() {
        let (a, b) = (o(1), o(2));
        let sorted = [r(0, a.clone()), r(1, a.clone()), r(0, b.clone()), r(1, b.clone())];
        assert!(sorted_pass_through(&sorted, 1));
        let real = [r(0, a.clone()), r(0, b.clone()), r(1, b), r(1, a)];
        assert!(!sorted_pass_through(&real, 1));
    }

    #[test]
    fn distinct_drops_find_equal_values() {
        let records = [r(0, s(1, "a")), r(1, s(1, "a")), r(0, s(2, "b")), r(1, s(2, "b")), r(0, s(3, "a"))];
        let links = resolve(&[Sync], &records);
        assert_eq!(distinct_drops(&records, &links, 1), [DistinctDrop { dropped: 4, same_as: Some(0) }]);

        let records = [r(0, o(1)), r(1, o(1)), r(0, o(2))];
        let links = resolve(&[Sync], &records);
        assert_eq!(distinct_drops(&records, &links, 1), [DistinctDrop { dropped: 2, same_as: None }]);
    }
}
