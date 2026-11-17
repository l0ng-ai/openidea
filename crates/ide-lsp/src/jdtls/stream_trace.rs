//! [`StreamTracer`] over the `openidea.jvm.stream.*` commands of the JVM inspector bundle that runs
//! inside jdtls (`java/jvm-inspect`).

use super::jvm_inspect::{command_error, decode, target_json};
use crate::LspManager;
use ide_jvm_inspect::{
    AbortState, CollectedTerminal, InspectError, InspectFuture, JvmValue, StreamTracer, TraceCollected, TraceId,
    TraceState, VmTarget,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;

/// `wait` is held by the bundle for the `ms` it is given; the command times out this long after.
const WAIT_SLACK: Duration = Duration::from_secs(10);
const ABORT_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

/// Each record is previewed with at least one JDWP round trip (about 0.1 ms locally, far more
/// over a remote attach).
fn collect_timeout(records: u64) -> Duration {
    Duration::from_secs(60)
        .saturating_add(Duration::from_millis(5).saturating_mul(records.try_into().unwrap_or(u32::MAX)))
}

pub struct JdtStreamTracer {
    lsp: Arc<LspManager>,
    /// A path inside the module whose jdtls runs the debug session.
    server: PathBuf,
}

impl JdtStreamTracer {
    /// Deliberately without `JdtJvmInspector`'s turn: a `wait` that holds a JDT LS thread for
    /// seconds must not keep the memory view from reading while the trace runs.
    pub fn new(lsp: Arc<LspManager>, server: PathBuf) -> Self {
        Self { lsp, server }
    }

    async fn call<T: DeserializeOwned>(
        &self,
        op: &str,
        target: &VmTarget,
        args: Value,
        limit: Duration,
    ) -> Result<T, InspectError> {
        let command = format!("openidea.jvm.stream.{op}");
        let arguments = vec![target_json(target), args];
        let reply = timeout(limit, self.lsp.jdtls_command(&self.server, &command, arguments))
            .await
            .map_err(|_| InspectError::TimedOut)?
            .map_err(command_error)?;
        decode(reply)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Armed {
    trace_id: TraceId,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum WireState {
    Running {
        records: u64,
        dropped: u64,
        elapsed_ms: u64,
    },
    Parked {
        records: u64,
        dropped: u64,
    },
    Failed {
        #[serde(default)]
        detail: String,
    },
    Cancelled {
        #[serde(default)]
        detail: String,
    },
}

impl From<WireState> for TraceState {
    fn from(state: WireState) -> Self {
        match state {
            WireState::Running { records, dropped, elapsed_ms } => Self::Running { records, dropped, elapsed_ms },
            WireState::Parked { records, dropped } => Self::Parked { records, dropped },
            WireState::Failed { detail } => Self::Failed { detail },
            WireState::Cancelled { detail } => Self::Cancelled { detail },
        }
    }
}

#[derive(Deserialize)]
struct Stopped {
    records: u64,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum WireAbort {
    Interrupted,
    Stopped,
    Stuck {
        #[serde(default)]
        holders: Vec<Holder>,
    },
    Cancelled,
    Finished,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Holder {
    thread_id: i64,
    name: String,
}

impl From<WireAbort> for AbortState {
    fn from(state: WireAbort) -> Self {
        match state {
            WireAbort::Interrupted => Self::Interrupted,
            WireAbort::Stopped => Self::Stopped,
            WireAbort::Stuck { holders } => {
                Self::Stuck { holders: holders.into_iter().map(|h| (h.thread_id, h.name)).collect() }
            }
            WireAbort::Cancelled => Self::Cancelled,
            WireAbort::Finished => Self::Finished,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCollected {
    records: Vec<WireRecord>,
    dropped: u64,
    terminal: WireTerminal,
    skipped_breakpoints: u32,
    sequentialized: bool,
}

#[derive(Deserialize)]
struct WireRecord {
    step: u16,
    value: JvmValue,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WireTerminal {
    Value { value: JvmValue },
    Void,
    Threw { exception: JvmValue },
}

impl From<WireCollected> for TraceCollected {
    fn from(wire: WireCollected) -> Self {
        Self {
            records: wire.records.into_iter().map(|r| (r.step, r.value)).collect(),
            dropped: wire.dropped,
            terminal: match wire.terminal {
                WireTerminal::Value { value } => CollectedTerminal::Value(value),
                WireTerminal::Void => CollectedTerminal::Void,
                WireTerminal::Threw { exception } => CollectedTerminal::Threw(exception),
            },
            skipped_breakpoints: wire.skipped_breakpoints,
            sequentialized: wire.sequentialized,
        }
    }
}

impl StreamTracer for JdtStreamTracer {
    fn arm<'a>(
        &'a self,
        target: &'a VmTarget,
        thread_id: i64,
        plan: &'a Value,
        budget: u32,
        token: &'a str,
    ) -> InspectFuture<'a, TraceId> {
        Box::pin(async move {
            let args = json!({"threadId": thread_id, "plan": plan, "budget": budget, "token": token});
            Ok(self.call::<Armed>("arm", target, args, COMMAND_TIMEOUT).await?.trace_id)
        })
    }

    fn wait<'a>(&'a self, target: &'a VmTarget, trace: TraceId, ms: u32) -> InspectFuture<'a, TraceState> {
        Box::pin(async move {
            let limit = Duration::from_millis(u64::from(ms)) + WAIT_SLACK;
            let state: WireState = self.call("wait", target, json!({"traceId": trace, "ms": ms}), limit).await?;
            Ok(state.into())
        })
    }

    fn stop<'a>(&'a self, target: &'a VmTarget, trace: TraceId) -> InspectFuture<'a, u64> {
        Box::pin(async move {
            Ok(self.call::<Stopped>("stop", target, json!({"traceId": trace}), COMMAND_TIMEOUT).await?.records)
        })
    }

    fn abort<'a>(&'a self, target: &'a VmTarget, trace: TraceId) -> InspectFuture<'a, AbortState> {
        Box::pin(async move {
            let state: WireAbort = self.call("abort", target, json!({"traceId": trace}), ABORT_TIMEOUT).await?;
            Ok(state.into())
        })
    }

    fn collect<'a>(&'a self, target: &'a VmTarget, trace: TraceId, records: u64) -> InspectFuture<'a, TraceCollected> {
        Box::pin(async move {
            let limit = collect_timeout(records);
            let collected: WireCollected = self.call("collect", target, json!({"traceId": trace}), limit).await?;
            Ok(collected.into())
        })
    }

    fn release<'a>(&'a self, target: &'a VmTarget, trace: TraceId) -> InspectFuture<'a, ()> {
        Box::pin(async move {
            self.call::<Value>("release", target, json!({"traceId": trace}), COMMAND_TIMEOUT).await.map(drop)
        })
    }

    fn release_armed<'a>(&'a self, target: &'a VmTarget, token: &'a str) -> InspectFuture<'a, ()> {
        Box::pin(async move {
            // Waits for an arm still setting up: as long as an arm may take.
            self.call::<Value>("release", target, json!({"token": token}), COMMAND_TIMEOUT).await.map(drop)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_timeout_grows_with_the_records() {
        assert_eq!(collect_timeout(0), Duration::from_secs(60));
        assert_eq!(collect_timeout(50_000), Duration::from_secs(60 + 250));
        assert!(collect_timeout(u64::MAX) >= collect_timeout(50_000));
    }
}
