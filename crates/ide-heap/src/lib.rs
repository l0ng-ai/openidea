//! HotSpot `.hprof` heap-dump reading and analysis for the debugger's JVM Memory view.

mod analysis;
mod column;
mod dominators;
mod error;
mod files;
mod graph;
mod hprof;
mod ids;
mod index;
mod names;
mod progress;
mod reader;
mod shallow;
/// Fixture builders shared by this crate's tests and by dependants' tests and benches; not API.
#[doc(hidden)]
pub mod testing;

pub use analysis::{AnalyzeOptions, analyze};
pub use column::{Column, NONE, Pod, Store};
pub use dominators::{Dominators, dominators};
pub use error::HeapError;
pub use graph::{ClassInfo, HeapGraph, PRIM_SLOTS, build_graph};
pub use hprof::{
    BasicType, ClassDump, HeapRecord, HeapRootKind, HprofHeader, Record, parse_header, record_at, scan, scan_segment,
};
pub use ids::{IdMap, IdMapBuilder};
pub use index::{ClassStat, HeapIndex, HeapSummary};
pub use names::display_name;
pub use progress::HeapPhase;
pub use shallow::{HistogramEntry, ShallowModel, SizeSource, VmLayout};
