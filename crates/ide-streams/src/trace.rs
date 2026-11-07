//! Runs one trace: install the recorder (E0), run the traced chain (E1), read the
//! recording back (E2), decode it, and always remove the recorder (E3). The debugger
//! transport lives behind the two traits (spec §10).

use std::future::Future;

use ide_core::CancellationToken;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::decode::{DecodeError, DecodedTrace, E1Value, EvalFailure, Recording, classify_eval_error, decode};
use crate::generate::TracePlan;
use crate::model::{DistinctDrop, Link};
use crate::resolve::{distinct_drops, resolve};

/// Evaluates an expression in the stopped frame (DAP `evaluate`).
pub trait Evaluator {
    /// `Err` carries the adapter's error message.
    fn evaluate(&self, expression: &str) -> impl Future<Output = Result<E1Value, String>> + Send;
}

/// Reads the recorder list back from the debuggee without running any code there.
///
/// Contract for implementors:
/// - `key` is the system property name (`TracePlan::key`); the list is the `ArrayList`
///   stored under it, read through its `elementData` and `size` fields only.
/// - `entries` follow list order and hold at most `limit` elements; `total_len` is the
///   list's real `size`, so a larger value tells the decoder the read was cut short.
/// - `TraceValue::Object.id` is `ObjectReference.uniqueID()`.
/// - Boxed primitives carry their `value` field; a `String` carries its text, cut at the
///   implementor's length cap with `truncated` set.
/// - A session without a VM to inspect, or one that cannot read fields, returns
///   `ReadError::Unsupported` so the caller can fall back.
pub trait RecordingReader {
    fn read(&self, key: &str, limit: usize) -> impl Future<Output = Result<Recording, ReadError>> + Send;
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ReadError {
    #[error("the debug session cannot read the recording")]
    Unsupported,
    /// The property or list is gone, e.g. the VM was resumed and E3 ran elsewhere.
    #[error("no recording under the trace key")]
    NotFound,
    #[error("reading the recording failed: {message}")]
    Failed { message: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    pub trace: DecodedTrace,
    /// Parallel to `trace.records`.
    pub links: Vec<Link>,
    /// Drops of every `distinct` step, in step order.
    pub drops: Vec<DistinctDrop>,
    /// The recorder could not be removed; the trace itself is still valid.
    pub cleanup_failed: bool,
}

// Adjacent tagging: the payload variants wrap enums that carry their own `kind` tag.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TraceError {
    /// E0 failed: the recorder was not installed.
    #[error("installing the recorder failed: {message}")]
    Setup { message: String },
    #[error("evaluating the traced chain failed: {0:?}")]
    Eval(EvalFailure),
    #[error(transparent)]
    Read(ReadError),
    #[error(transparent)]
    Decode(DecodeError),
    #[error("cancelled")]
    Cancelled,
}

/// E3 is the last evaluation whenever E0 was sent, whatever the outcome.
pub async fn run_trace<E: Evaluator, R: RecordingReader>(
    plan: &TracePlan,
    eval: &E,
    reader: &R,
    cancel: &CancellationToken,
) -> Result<TraceResult, TraceError> {
    if cancel.is_cancelled() {
        return Err(TraceError::Cancelled);
    }
    if let Err(message) = eval.evaluate(&plan.e0).await {
        let _ = eval.evaluate(&plan.e3).await;
        return Err(TraceError::Setup { message });
    }

    let outcome = traced(plan, eval, reader, cancel).await;
    let cleanup_failed = eval.evaluate(&plan.e3).await.is_err();
    outcome.map(|(trace, links, drops)| TraceResult { trace, links, drops, cleanup_failed })
}

type Traced = (DecodedTrace, Vec<Link>, Vec<DistinctDrop>);

async fn traced<E: Evaluator, R: RecordingReader>(
    plan: &TracePlan,
    eval: &E,
    reader: &R,
    cancel: &CancellationToken,
) -> Result<Traced, TraceError> {
    if cancel.is_cancelled() {
        return Err(TraceError::Cancelled);
    }
    let e1 = eval.evaluate(&plan.e1).await;
    // A cancelled evaluate usually comes back as an error; report the cancellation.
    if cancel.is_cancelled() {
        return Err(TraceError::Cancelled);
    }
    let e1 = e1.map_err(|message| TraceError::Eval(classify_eval_error(&message)))?;

    let recording = reader.read(&plan.key, plan.budget + 2).await.map_err(TraceError::Read)?;
    let trace = decode(plan, &recording, &e1).map_err(TraceError::Decode)?;

    let kinds: Vec<_> = plan.steps.iter().skip(1).map(|s| s.kind).collect();
    let links = resolve(&kinds, &trace.records);
    let drops = plan
        .steps
        .iter()
        .filter(|s| s.label == "distinct")
        .flat_map(|s| distinct_drops(&trace.records, &links, s.index))
        .collect();
    Ok((trace, links, drops))
}
