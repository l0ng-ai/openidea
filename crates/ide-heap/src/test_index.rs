//! Analyzed fixtures for the query tests.

use ide_core::CancellationToken;

use crate::analysis::{AnalyzeOptions, analyze};
use crate::error::HeapError;
use crate::index::{HeapIndex, HeapObjectRef};
use crate::progress::HeapPhase;
use crate::testing::MiniHeap;

fn no_progress(_: HeapPhase, _: u64, _: u64) -> Result<(), HeapError> {
    Ok(())
}

/// `heap` analyzed in memory, with layout sizes.
pub(crate) fn analyzed(heap: &MiniHeap) -> HeapIndex {
    analyzed_bytes(&heap.bytes())
}

pub(crate) fn analyzed_bytes(hprof: &[u8]) -> HeapIndex {
    let dir = tempfile::tempdir().unwrap();
    let dump = dir.path().join("dump.hprof");
    std::fs::write(&dump, hprof).unwrap();
    let opts = AnalyzeOptions { in_memory: true, ..AnalyzeOptions::default() };
    analyze(&dump, dir.path(), opts, &no_progress, &CancellationToken::new()).unwrap()
}

pub(crate) fn obj(index: &HeapIndex, addr: u64) -> HeapObjectRef {
    HeapObjectRef(index.ids.rank(addr).unwrap_or_else(|| panic!("{addr:#x} is not in the dump")))
}

/// The slot of the class named `name`.
pub(crate) fn slot(index: &HeapIndex, name: &str) -> u32 {
    index.classes.iter().position(|c| c.name == name).unwrap_or_else(|| panic!("no class {name}")) as u32
}
