//! How many references to each ObjectID the JVM handed the link, so `DisposeObjects` returns
//! exactly those. One reference too many released aborts the JVM.

use std::collections::HashMap;

/// Most ids in one `VirtualMachine.DisposeObjects` packet.
pub const DISPOSE_CHUNK: usize = 1000;

#[derive(Default)]
pub(crate) struct Ledger {
    counts: HashMap<u64, u32>,
}

impl Ledger {
    /// One reference per occurrence, as the JVM counts them.
    pub fn record(&mut self, ids: &[u64]) {
        for &id in ids {
            let count = self.counts.entry(id).or_default();
            // `DisposeObjects` takes an `int`; stopping short only leaks.
            *count = (*count + 1).min(i32::MAX as u32);
        }
    }

    /// Everything recorded so far, by id, and forgets it.
    pub fn drain(&mut self) -> Vec<(u64, u32)> {
        let mut entries: Vec<_> = self.counts.drain().collect();
        entries.sort_unstable();
        entries
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.counts.is_empty()
    }

    /// Forgets everything without releasing it.
    pub fn clear(&mut self) {
        self.counts.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_every_occurrence_and_drains_once() {
        let mut ledger = Ledger::default();
        ledger.record(&[7, 3, 7]);
        ledger.record(&[7]);
        assert_eq!(ledger.drain(), vec![(3, 1), (7, 3)]);
        assert!(ledger.is_empty());
        assert_eq!(ledger.drain(), vec![]);
    }

    #[test]
    fn count_stops_at_the_largest_jdwp_int() {
        let mut ledger = Ledger::default();
        ledger.counts.insert(5, i32::MAX as u32);
        ledger.record(&[5]);
        assert_eq!(ledger.drain(), vec![(5, i32::MAX as u32)]);
    }
}
