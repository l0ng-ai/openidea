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
    /// dump add up to `class_row`'s share of the histogram, or 0 when no value gets within 5%: a
    /// histogram of other mirrors than these (a different JVM stop) must not skew the sizes.
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
    ) -> Result<u64, HeapError> {
        if class_row.instances == 0 {
            return Ok(0);
        }
        // Mirrors without a class dump (primitive types) have no statics.
        let class_typed = count_slot(graph, graph.class_slot, cancel)?;
        let bare = class_typed.saturating_sub(self.dumped.len() as u64);
        let mirrors = self.dumped.len() as u64 + bare;
        if mirrors == 0 {
            return Ok(0);
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
        Ok(if error * 100 <= target * MAX_FIT_ERROR_PERCENT { best } else { 0 })
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
