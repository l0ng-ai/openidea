//! What the index queries return over IPC.

use serde::{Deserialize, Serialize};

use crate::hprof::HeapRootKind;

/// Most rows one page of [`crate::HeapIndex::dominated`] returns.
pub const MAX_PAGE: u32 = 500;

/// An object of one snapshot: its index in the [`crate::HeapIndex`] columns. Any value may
/// arrive over IPC; queries answer an index that names no object with nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
pub struct HeapObjectRef(pub u32);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeapClassRow {
    /// Type slot, as `classIndex` in [`crate::HeapIndex::dominated`].
    pub class_index: u32,
    pub name: String,
    pub count: u64,
    pub shallow: u64,
    pub retained: u64,
    pub unreachable_count: u64,
    /// Another class has the same name (several class loaders): nothing joined by name, such as a
    /// second snapshot, can tell them apart.
    pub ambiguous: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeapObjectRow {
    pub object: HeapObjectRef,
    pub class_name: String,
    /// The object's hprof id in hex, `0x1300`.
    pub address: String,
    pub shallow: u64,
    pub retained: u64,
    /// Has children in the dominator tree.
    pub has_children: bool,
    /// The text of a `java.lang.String`, or the name of the class a class object stands for.
    pub preview: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeapObjectPage {
    pub rows: Vec<HeapObjectRow>,
    /// Rows of every page together.
    pub total: u32,
}

/// How an object is held by the next step of a path to a GC root.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapEdge {
    /// An instance field; the name is empty when the dump does not show which one.
    Field {
        name: String,
    },
    Element {
        index: u32,
    },
    Static {
        name: String,
    },
    /// From an instance to its class.
    ClassOf,
    SuperClass,
    ClassLoader,
    /// `thread` is the name of the thread whose root it is, when the dump has it.
    Root {
        root: HeapRootKind,
        thread: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeapPathStep {
    pub object: HeapObjectRow,
    /// How the next step holds this object; on the last step, the root.
    pub via: HeapEdge,
}

/// A path from an object up to its GC root. A long one keeps only the steps nearest each end.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeapRootPath {
    pub steps: Vec<HeapPathStep>,
    /// Steps left out between `steps[omitted_after - 1]` and `steps[omitted_after]`; 0 for none.
    pub omitted: u32,
    pub omitted_after: u32,
}
