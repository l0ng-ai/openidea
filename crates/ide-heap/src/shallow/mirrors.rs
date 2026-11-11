//! Sizes of class objects (mirrors): the `java.lang.Class` instance plus the class's statics, plus
//! the fields HotSpot injects into every mirror and leaves out of the class dump.

use ide_core::CancellationToken;

use super::{HistogramEntry, VmLayout};
use crate::error::HeapError;
use crate::graph::HeapGraph;
use crate::progress::CHECK_EVERY;

/// Largest injected byte count (per mirror, a multiple of 4) the histogram fit tries.
const MAX_INJECTED: u64 = 128;
/// How far, in percent of the histogram's total, the best fit may be off before the row is taken
/// for something else than the mirrors of this dump.
const MAX_FIT_ERROR_PERCENT: u128 = 5;

/// Bytes HotSpot injects into every mirror (`klass`, `array_klass`, `oop_size`,
/// `static_oop_field_count`, and oops such as `protection_domain`) without listing them in the class
/// dump, as measured by comparing the dump with `GC.class_histogram` on JDK 8, 11, 21, 23 and 25,
/// with and without compressed oops. Each X is the best fit in steps of 4; the real value is
/// within a few bytes (statics padding). `None` for a reference size the table does not cover.
pub(super) fn injected_mirror_bytes(java_major: u32, ref_size: u8) -> Option<u64> {
    match (ref_size, java_major) {
        // 8, 11, 21 and 23 measure 36; 25 is the first JDK that shows 28.
        (4, ..=24) => Some(36),
        (4, 25..) => Some(28),
        // 8, 11 and 21 measure 44; 23 is the first to show 40 and 25 the first to show 32.
        (8, ..=22) => Some(44),
        (8, 23..=24) => Some(40),
        (8, 25..) => Some(32),
        _ => None,
    }
}

/// Used when the JVM is unknown (a dump without `VM.flags`): the midpoint of the measured values
/// with 4-byte references, 36 and 28.
const UNKNOWN_JVM_INJECTED: u64 = 32;

/// The injected bytes per mirror the layout implies, without looking at a histogram.
pub(super) fn injected_by_table(layout: VmLayout) -> u64 {
    layout.java_major.and_then(|major| injected_mirror_bytes(major, layout.ref_size)).unwrap_or(UNKNOWN_JVM_INJECTED)
}

pub(super) struct Mirrors {
    /// `(node, size before alignment)` of every class dump that is an object of the graph, by node.
    dumped: Vec<(u32, u64)>,
}

impl Mirrors {
    /// `instance` is the layout size of `java.lang.Class`, the base of every mirror.
    pub(super) fn collect(graph: &HeapGraph, instance: u64, layout: VmLayout) -> Self {
        let mut dumped: Vec<(u32, u64)> = graph
            .classes
            .iter()
            .filter(|class| class.id != 0)
            .filter_map(|class| {
                let node = graph.ids.rank(class.id)?;
                let references = class.statics.len() as u64 * u64::from(layout.ref_size);
                Some((node, instance + class.static_bytes + references))
            })
            .collect();
        dumped.sort_unstable_by_key(|&(node, _)| node);
        Self { dumped }
    }

    /// `(node, size)` of each class object when HotSpot adds `injected` bytes to every mirror.
    pub(super) fn sizes(&self, layout: VmLayout, injected: u64) -> Vec<(u32, u64)> {
        self.dumped.iter().map(|&(node, bytes)| (node, layout.align(bytes + injected))).collect()
    }

    /// The injected bytes per mirror (a multiple of 4, at most 128) that make the mirrors of this
    /// dump add up to `class_row`'s share of the histogram, or `None` when no value gets within 5%:
    /// a histogram of other mirrors than these (a different JVM stop) must not skew the sizes.
    ///
    /// The fit compares averages, since the histogram also counts mirrors the dump has no class
    /// dump for (primitive types, classes only archived by CDS). Every mirror still gets the same
    /// extra bytes, never the average size, because statics make mirror sizes differ.
    pub(super) fn fit_injected(
        &self,
        graph: &HeapGraph,
        layout: VmLayout,
        instance: u64,
        class_row: &HistogramEntry,
        cancel: &CancellationToken,
    ) -> Result<Option<u64>, HeapError> {
        if class_row.instances == 0 {
            return Ok(None);
        }
        // Mirrors without a class dump (primitive types) have no statics.
        let class_typed = count_slot(graph, graph.class_slot, cancel)?;
        let bare = class_typed.saturating_sub(self.dumped.len() as u64);
        let mirrors = self.dumped.len() as u64 + bare;
        if mirrors == 0 {
            return Ok(None);
        }
        let target = u128::from(class_row.bytes) * u128::from(mirrors) / u128::from(class_row.instances);
        let total = |injected: u64| -> u128 {
            let dumped: u128 = self.dumped.iter().map(|&(_, bytes)| u128::from(layout.align(bytes + injected))).sum();
            dumped + u128::from(bare) * u128::from(layout.align(instance + injected))
        };
        let (best, error) = (0..=MAX_INJECTED)
            .step_by(4)
            .map(|injected| (injected, total(injected).abs_diff(target)))
            .min_by_key(|&(injected, error)| (error, injected))
            .unwrap_or((0, u128::MAX));
        Ok((error * 100 <= target * MAX_FIT_ERROR_PERCENT).then_some(best))
    }
}

fn count_slot(graph: &HeapGraph, slot: u32, cancel: &CancellationToken) -> Result<u64, HeapError> {
    let mut count = 0;
    for chunk in graph.types.chunks(CHECK_EVERY as usize) {
        if cancel.is_cancelled() {
            return Err(HeapError::Cancelled);
        }
        count += chunk.iter().filter(|&&ty| ty == slot).count() as u64;
    }
    Ok(count)
}
