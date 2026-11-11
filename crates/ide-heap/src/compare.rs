//! Class-by-class differences between two snapshots.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::index::HeapIndex;

/// One class name in two snapshots; a side without the name has zeros.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeapClassDiff {
    pub name: String,
    pub base_count: u64,
    pub count: u64,
    pub base_shallow: u64,
    pub shallow: u64,
    pub base_retained: u64,
    pub retained: u64,
    /// Several classes have this name on one side or both, so the sides cannot be matched: each
    /// side shows the sum over its classes, and there is no difference to show.
    pub ambiguous: bool,
}

/// Joined by class name, the only key two dumps share. By the change in retained size
/// descending (none for an ambiguous name), then by name.
pub fn compare(base: &HeapIndex, current: &HeapIndex) -> Vec<HeapClassDiff> {
    let mut by_name: HashMap<String, HeapClassDiff> = HashMap::new();
    for (index, is_base) in [(base, true), (current, false)] {
        for row in index.class_rows() {
            let diff = by_name.entry(row.name).or_insert_with_key(|name| HeapClassDiff {
                name: name.clone(),
                base_count: 0,
                count: 0,
                base_shallow: 0,
                shallow: 0,
                base_retained: 0,
                retained: 0,
                ambiguous: false,
            });
            let (count, shallow, retained) = if is_base {
                (&mut diff.base_count, &mut diff.base_shallow, &mut diff.base_retained)
            } else {
                (&mut diff.count, &mut diff.shallow, &mut diff.retained)
            };
            *count = count.saturating_add(row.count);
            *shallow = shallow.saturating_add(row.shallow);
            *retained = retained.saturating_add(row.retained);
            diff.ambiguous |= row.ambiguous;
        }
    }
    let change = |d: &HeapClassDiff| if d.ambiguous { 0 } else { d.retained.abs_diff(d.base_retained) };
    let mut diffs: Vec<HeapClassDiff> = by_name.into_values().collect();
    diffs.sort_by(|a, b| change(b).cmp(&change(a)).then_with(|| a.name.cmp(&b.name)));
    diffs
}

#[cfg(test)]
mod tests;
