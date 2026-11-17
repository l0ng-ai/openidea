//! Tracing a stream chain while the program itself runs it. One trace per VM; the trace's records
//! are read back once the debuggee is suspended again.

use crate::{InspectFuture, JvmValue, VmTarget};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Assigned by the debuggee-side bundle; valid for one VM.
pub type TraceId = u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceState {
    Running {
        records: u64,
        dropped: u64,
        elapsed_ms: u64,
    },
    /// The terminal operation finished and the thread is suspended again, ready to `collect`.
    Parked {
        records: u64,
        dropped: u64,
    },
    Failed {
        detail: String,
    },
    /// Stopped or aborted before the terminal operation ran: taken down, the program untouched.
    Cancelled {
        detail: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AbortState {
    Interrupted,
    Stopped,
    /// Suspended threads that own a monitor the terminal may be waiting for: `(thread id, name)`.
    Stuck {
        holders: Vec<(i64, String)>,
    },
    /// The terminal had not started.
    Cancelled,
    /// The trace had already parked or failed.
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollectedTerminal {
    Value(JvmValue),
    Void,
    Threw(JvmValue),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceCollected {
    /// `(step, value)`: step counts the wrapped ops from 0 (the source).
    pub records: Vec<(u16, JvmValue)>,
    /// Records past the arm-time budget; counted, not kept.
    pub dropped: u64,
    pub terminal: CollectedTerminal,
    pub skipped_breakpoints: u32,
    /// A parallel chain was forced to run sequentially so that records keep their order.
    pub sequentialized: bool,
}

pub trait StreamTracer: Send + Sync {
    /// `plan` is the JSON of `ide_streams::RealRunPlan`; `budget` caps the records kept. `token`
    /// names the trace for [`release_armed`](Self::release_armed) when no reply arrives.
    fn arm<'a>(
        &'a self,
        target: &'a VmTarget,
        thread_id: i64,
        plan: &'a serde_json::Value,
        budget: u32,
        token: &'a str,
    ) -> InspectFuture<'a, TraceId>;
    /// Blocks up to `ms` milliseconds for the trace to leave `Running`.
    fn wait<'a>(&'a self, target: &'a VmTarget, trace: TraceId, ms: u32) -> InspectFuture<'a, TraceState>;
    /// Stops keeping records while the terminal keeps running; returns the records kept so far.
    fn stop<'a>(&'a self, target: &'a VmTarget, trace: TraceId) -> InspectFuture<'a, u64>;
    fn abort<'a>(&'a self, target: &'a VmTarget, trace: TraceId) -> InspectFuture<'a, AbortState>;
    /// `target.generation` must be a stop after the trace parked. `records`: how many it parked
    /// with; reading each takes a round trip to the JVM, so the time allowed grows with them.
    fn collect<'a>(&'a self, target: &'a VmTarget, trace: TraceId, records: u64) -> InspectFuture<'a, TraceCollected>;
    fn release<'a>(&'a self, target: &'a VmTarget, trace: TraceId) -> InspectFuture<'a, ()>;
    /// Releases the trace armed with `token` whose `arm` reply never came (it timed out); nothing
    /// when there is none.
    fn release_armed<'a>(&'a self, target: &'a VmTarget, token: &'a str) -> InspectFuture<'a, ()>;
}
