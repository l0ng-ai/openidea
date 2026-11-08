//! HotSpot `.hprof` heap-dump reading and analysis for the debugger's JVM Memory view.

mod column;
mod dominators;
mod error;
mod graph;
mod hprof;
mod ids;
mod names;
mod progress;
mod reader;
mod shallow;
/// Fixture builders shared by this crate's tests and by dependants' tests and benches; not API.
#[doc(hidden)]
pub mod testing;

pub use column::{Column, NONE, Pod, Store};
pub use dominators::{Dominators, dominators};
pub use error::HeapError;
pub use graph::{ClassInfo, HeapGraph, PRIM_SLOTS, build_graph};
pub use hprof::{
    BasicType, ClassDump, HeapRecord, HeapRootKind, HprofHeader, Record, parse_header, record_at, scan, scan_segment,
};
pub use ids::{IdMap, IdMapBuilder};
pub use names::display_name;
pub use progress::HeapPhase;
pub use shallow::{HistogramEntry, ShallowModel, SizeSource, VmLayout};
