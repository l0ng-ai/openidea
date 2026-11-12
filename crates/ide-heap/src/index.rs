//! The result of analyzing a heap dump: per-object columns, the class table and the summary.

mod fields;
mod path;
mod queries;
mod rows;

use std::collections::HashMap;
use std::path::Path;

use memmap2::Mmap;
use serde::{Deserialize, Serialize};

use crate::column::Column;
use crate::error::HeapError;
use crate::files::SUMMARY_FILE;
use crate::graph::ClassInfo;
use crate::hprof::HeapRootKind;
use crate::ids::IdMap;
use crate::shallow::SizeSource;

pub(crate) use self::fields::{id_value, instance_fields};
pub use self::rows::{
    HeapClassRow, HeapEdge, HeapObjectPage, HeapObjectRef, HeapObjectRow, HeapPathStep, HeapRootPath, MAX_PAGE,
};

/// Counts over instances and arrays; class objects (class dumps) are left out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeapSummary {
    /// `reachable_objects + unreachable_objects`.
    pub objects: u64,
    pub reachable_objects: u64,
    pub reachable_bytes: u64,
    pub unreachable_objects: u64,
    pub unreachable_bytes: u64,
    /// Class dumps in the dump.
    pub classes: u32,
    pub weak_edges_skipped: u64,
    pub size_source: SizeSource,
    pub analysis_ms: u32,
}

/// One row of the class table, for one type slot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassStat {
    /// [`crate::display_name`] of the class (`long[]` for a primitive array slot).
    pub name: String,
    /// Reachable instances.
    pub count: u64,
    /// Shallow bytes of the reachable instances.
    pub shallow: u64,
    /// Bytes the reachable instances retain together: the sum of the retained sizes of those
    /// with no instance of the same type above them in the dominator tree.
    pub retained: u64,
    pub unreachable_count: u64,
}

/// Columns are indexed by node: objects `0..root`, then the super-root `root`. Columns of the
/// objects only (`types`, `offsets`) have no entry for the root.
pub struct HeapIndex {
    /// The dump, for [`crate::record_at`] at `offsets[v]`.
    pub hprof: Mmap,
    pub ids: IdMap,
    /// Type slot of each object, as in [`crate::HeapGraph::types`].
    pub types: Column<u32>,
    pub offsets: Column<u64>,
    /// Shallow size in units of 8 bytes, rounded up.
    pub shallow8: Column<u32>,
    /// Retained bytes; 0 for unreachable objects, every reachable byte for the root.
    pub retained: Column<u64>,
    /// Immediate dominator; [`crate::NONE`] for unreachable objects, `root` for the root.
    pub idom: Column<u32>,
    /// Children of node `v` in the dominator tree are `kids[kids_start[v]..kids_start[v + 1]]`,
    /// by retained size descending, then by node.
    pub kids_start: Column<u32>,
    pub kids: Column<u32>,
    /// Parent on a shortest path from the root (BFS over strong edges); [`crate::NONE`] for
    /// unreachable objects, `root` for the root.
    pub gc_parent: Column<u32>,
    /// By type slot: class slots, then the primitive array slots.
    pub classes: Vec<ClassStat>,
    /// By class slot, as in [`crate::HeapGraph::classes`].
    pub class_info: Vec<ClassInfo>,
    /// Type slot of class objects.
    pub class_slot: u32,
    /// Object → kind and thread serial of its first root record.
    pub roots: HashMap<u32, (HeapRootKind, Option<u32>)>,
    /// Thread serial → thread object.
    pub thread_objects: HashMap<u32, u32>,
    pub id_size: u8,
    pub summary: HeapSummary,
}

impl HeapIndex {
    /// The super-root, whose children in both trees are the rooted objects.
    pub fn root(&self) -> u32 {
        self.ids.len()
    }
}

pub(crate) fn write_summary(dir: &Path, summary: &HeapSummary) -> Result<(), HeapError> {
    let json = serde_json::to_vec_pretty(summary).map_err(std::io::Error::from)?;
    std::fs::write(dir.join(SUMMARY_FILE), json)?;
    Ok(())
}

#[cfg(test)]
mod tests;
