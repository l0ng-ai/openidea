//! HotSpot `.hprof` heap-dump reading and analysis for the debugger's JVM Memory view.

mod column;
mod error;
mod hprof;
mod ids;
mod reader;
/// Fixture builders shared by this crate's tests and by dependants' tests and benches; not API.
#[doc(hidden)]
pub mod testing;

pub use column::{Column, NONE, Pod, Store};
pub use error::HeapError;
pub use hprof::{
    BasicType, ClassDump, HeapRecord, HeapRootKind, HprofHeader, Record, parse_header, record_at, scan, scan_segment,
};
pub use ids::{IdMap, IdMapBuilder};
