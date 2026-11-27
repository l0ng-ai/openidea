//! Java Stream Debugger: the stream chains around a debugger stop, and traces of a chain's real run.
//! `ide_streams` finds the chains and links what the run recorded; `ide_dap` runs the trace.

use crate::Host;
use crate::ops::Channel;
use ide_command::command;
use ide_core::{CancellationToken, DebugSessionId, IdeError, IdeResult, LanguageId, Range, RequestId};
use ide_dap::{StackFrame, TraceRun};
pub use ide_dap::{TracePhase, TraceProgress, TraceUnavailable};
pub use ide_jvm_inspect::{AbortState, JvmValue};
use ide_jvm_inspect::{CollectedTerminal, TraceCollected};
use ide_streams::{
    BoxKind, RealRunPlan, RealRunRefusal, Record, Rejection, StopContext, StreamChain, TerminalOutcome, TraceRecording,
    TraceValue, find_chains, link_trace, real_run_plan, recorded_steps,
};
pub use ide_streams::{Link, TraceBanner};
use ide_syntax::{Snapshot, StructureService};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamChainInfo {
    /// The `chain_index` [`debug_stream_trace`] takes for the same frame.
    pub index: u32,
    pub range: Range,
    pub text: String,
    /// Intermediate operations in call order, modifiers included. Empty, like `terminal`, for a
    /// chain the search rejected.
    pub steps: Vec<String>,
    pub terminal: String,
    pub available: bool,
    /// Set exactly when `available` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub reason: Option<ChainUnavailable>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChainUnavailable {
    NotTopFrame,
    NotAtChainStart,
    InsideChainLambda,
    NotJavaStreamRoot {
        root: String,
    },
    LazyTerminal {
        op: String,
    },
    NoTerminal,
    UnknownOperation {
        op: String,
    },
    SyntaxError,
    /// The session has no stream tracer: not java-debug, or its jdtls has no inspector bundle.
    NoBackend,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamTraceResult {
    Ready {
        chain: Box<StreamChainInfo>,
        /// Column titles by recorded step: `steps[0]` is the root call's name (empty for a stream
        /// held in a local), then each operation that records, modifiers left out.
        steps: Vec<String>,
        /// In recording order.
        records: Vec<TraceRecordView>,
        /// Parallel to `records`.
        links: Vec<Link>,
        terminal: TerminalView,
        banners: Vec<TraceBanner>,
        /// The stop the values belong to, for `debug_jvm_memory_fields`.
        generation: u64,
    },
    Unavailable {
        reason: TraceUnavailable,
    },
    Failed {
        detail: String,
    },
    /// Recording was stopped, or the operation aborted, before the chain ran: nothing went wrong.
    Cancelled {
        detail: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TraceRecordView {
    pub step: u16,
    pub value: JvmValue,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TerminalView {
    Value { value: JvmValue },
    Void,
    Threw { exception: JvmValue },
}

/// The stream chains around `frame`'s line; `top`: it is the thread's top frame.
#[command(trust = trusted)]
pub async fn debug_stream_chains(
    host: &Host,
    window: &str,
    session: DebugSessionId,
    frame: StackFrame,
    top: bool,
) -> IdeResult<Vec<StreamChainInfo>> {
    // In source order, with why each cannot be traced; only the top frame can run a trace.
    host.require_trust(window)?;
    let backend = host.debugger.capabilities(session)?.stream_trace;
    Ok(candidates(host, window, frame, top, backend).await?.into_iter().map(|c| c.info).collect())
}

/// Traces chain `chain_index` of [`debug_stream_chains`], whose `range` the UI showed, while the
/// program runs it; cancelling `request` stops recording.
#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn debug_stream_trace(
    host: &Host,
    window: &str,
    session: DebugSessionId,
    request: RequestId,
    thread_id: i64,
    frame: StackFrame,
    chain_index: u32,
    range: Range,
    on_progress: Channel<TraceProgress>,
) -> IdeResult<StreamTraceResult> {
    // Runs the program from `thread_id`, stopped in `frame`, and leaves it stopped after the
    // chain's terminal operation. `range` is that chain's [`StreamChainInfo::range`]: an edit in
    // between can move another chain to the same index. The program runs on after a cancel.
    host.require_trust(window)?;
    let cancel = host.begin_project_request(window, request);
    let chain = ChainRef { frame, index: chain_index, range };
    let result = trace(host, window, session, thread_id, chain, &cancel, &on_progress).await;
    host.end_request(request);
    result
}

/// The chain the UI chose, as [`debug_stream_chains`] listed it.
struct ChainRef {
    frame: StackFrame,
    index: u32,
    range: Range,
}

async fn trace(
    host: &Host,
    window: &str,
    session: DebugSessionId,
    thread_id: i64,
    chosen: ChainRef,
    cancel: &CancellationToken,
    on_progress: &Channel<TraceProgress>,
) -> IdeResult<StreamTraceResult> {
    let line = chosen.frame.line;
    // `stream_trace` decides whether the session can trace, so the backend is assumed here.
    let candidate = candidates(host, window, chosen.frame, true, true)
        .await?
        .into_iter()
        .nth(chosen.index as usize)
        .filter(|c| c.info.range == chosen.range);
    let Some(candidate) = candidate else {
        return Ok(StreamTraceResult::Failed { detail: "the chain changed; trace it again".into() });
    };
    if let Some(reason) = candidate.info.reason.clone() {
        let reason = trace_unavailable(reason, line, candidate.chain.as_ref());
        return Ok(StreamTraceResult::Unavailable { reason });
    }
    let Some(chain) = candidate.chain else {
        return Err(IdeError::internal("an available stream chain has no parsed chain"));
    };
    let plan = real_run_plan(&chain).map_err(|e| IdeError::internal(format!("stream chain plan: {e:?}")))?;
    let plan_json = serde_json::to_value(&plan).map_err(|e| IdeError::internal(e.to_string()))?;
    // `stream_trace` resumes the program before it looks at `cancel`.
    if cancel.is_cancelled() {
        return Ok(StreamTraceResult::Cancelled { detail: "cancelled before the trace started".into() });
    }
    let progress = |p| {
        let _ = on_progress.send(p);
    };
    let run = host.debugger.stream_trace(session, thread_id, plan_json, cancel.clone(), progress).await?;
    Ok(match run {
        TraceRun::Done { collected, generation, resumed_stops } => {
            let info = candidate.info;
            host.blocking(move || Ok(ready(info, &chain, &plan, collected, generation, resumed_stops))).await?
        }
        TraceRun::Unavailable { reason } => StreamTraceResult::Unavailable { reason },
        TraceRun::Failed { detail } => StreamTraceResult::Failed { detail },
        TraceRun::Cancelled { detail } => StreamTraceResult::Cancelled { detail },
    })
}

/// Ends the running trace's terminal operation; `None` when no trace runs.
#[command(trust = trusted)]
pub async fn debug_stream_trace_abort(
    host: &Host,
    window: &str,
    session: DebugSessionId,
) -> IdeResult<Option<AbortState>> {
    // Backs the debugger's Abort Operation action.
    host.require_trust(window)?;
    host.debugger.stream_trace_abort(session).await
}

struct Candidate {
    info: StreamChainInfo,
    /// `None` for a chain the search rejected.
    chain: Option<StreamChain>,
}

/// The file's current text (the open buffer, else the disk) searched off the command thread.
/// Frames outside readable Java sources have no chains: java-debug gives library frames
/// `jdt://contents/…` paths.
async fn candidates(
    host: &Host,
    window: &str,
    frame: StackFrame,
    top: bool,
    backend: bool,
) -> IdeResult<Vec<Candidate>> {
    let Some(path) = frame.path.clone() else { return Ok(Vec::new()) };
    let project = host.project(window)?;
    host.blocking(move || {
        let path = path.into_path_buf();
        let cancel = CancellationToken::new();
        let search = |snap: &Snapshot| {
            if snap.language.as_str() != "java" {
                return Ok(Vec::new());
            }
            chains_at(&project.structure, snap, &frame, top, backend, &cancel)
        };
        if let Some(doc) = project.documents.by_path(&path) {
            let snap = project.documents.text_snapshot(doc)?;
            if snap.large {
                return Err(IdeError::unavailable("file is too large for syntax analysis"));
            }
            return search(&Snapshot::doc(doc, snap.version, &snap.language, &snap.text));
        }
        let language: LanguageId = project.languages.detect(&path, None);
        if language.as_str() != "java" {
            return Ok(Vec::new());
        }
        let Ok(text) = project.text_of(&path) else { return Ok(Vec::new()) };
        search(&Snapshot::text(&language, &text))
    })
    .await
}

fn chains_at(
    service: &StructureService,
    snap: &Snapshot,
    frame: &StackFrame,
    top: bool,
    backend: bool,
    cancel: &CancellationToken,
) -> IdeResult<Vec<Candidate>> {
    let path = frame.path.as_ref().map(|p| p.0.as_path());
    let file_stem = path.and_then(Path::file_stem).and_then(|s| s.to_str()).unwrap_or_default();
    let stop = StopContext { line: frame.line, in_lambda: frame.name.contains("lambda$"), file_stem };
    let found = find_chains(service, snap, &stop, cancel)?;
    let mut candidates: Vec<Candidate> = found
        .chains
        .into_iter()
        .map(|chain| {
            let reason = refusal(&chain, frame.line, top, backend);
            let info = StreamChainInfo {
                index: 0,
                range: chain.range,
                text: chain.text.clone(),
                steps: chain.ops.iter().map(|op| op.name.clone()).collect(),
                terminal: chain.terminal.name.clone(),
                available: reason.is_none(),
                reason,
            };
            Candidate { info, chain: Some(chain) }
        })
        .collect();
    candidates.extend(found.rejected.into_iter().map(|rejected| {
        let reason = if top { rejection(rejected.reason) } else { ChainUnavailable::NotTopFrame };
        let info = StreamChainInfo {
            index: 0,
            range: rejected.range,
            text: rejected.text,
            steps: Vec::new(),
            terminal: String::new(),
            available: false,
            reason: Some(reason),
        };
        Candidate { info, chain: None }
    }));
    candidates.sort_by_key(|c| c.info.range);
    for (i, c) in candidates.iter_mut().enumerate() {
        c.info.index = i as u32;
    }
    Ok(candidates)
}

fn refusal(chain: &StreamChain, line: u32, top: bool, backend: bool) -> Option<ChainUnavailable> {
    if !top {
        return Some(ChainUnavailable::NotTopFrame);
    }
    // ECJ puts the first instruction of `T x =\n    root…` on the root's line, not the
    // statement's; the bundle makes the final call from the line table.
    if line < chain.first_line || line > root_line(chain) {
        return Some(ChainUnavailable::NotAtChainStart);
    }
    if let Err(refused) = real_run_plan(chain) {
        return Some(refusal_reason(refused));
    }
    (!backend).then_some(ChainUnavailable::NoBackend)
}

fn root_line(chain: &StreamChain) -> u32 {
    let before_root = chain.text.get(..chain.root.span.0).unwrap_or_default();
    chain.range.start.line + before_root.matches('\n').count() as u32
}

fn refusal_reason(refused: RealRunRefusal) -> ChainUnavailable {
    match refused {
        RealRunRefusal::NotJavaStreamRoot { root } => ChainUnavailable::NotJavaStreamRoot { root },
        RealRunRefusal::LazyTerminal { op } => ChainUnavailable::LazyTerminal { op },
        RealRunRefusal::NoTerminal => ChainUnavailable::NoTerminal,
        RealRunRefusal::UnknownOperation { op } => ChainUnavailable::UnknownOperation { op },
        RealRunRefusal::InsideChainLambda => ChainUnavailable::InsideChainLambda,
        RealRunRefusal::SyntaxError => ChainUnavailable::SyntaxError,
    }
}

fn rejection(rejected: Rejection) -> ChainUnavailable {
    match rejected {
        Rejection::LazyTerminal { op } => ChainUnavailable::LazyTerminal { op },
        Rejection::NoTerminal => ChainUnavailable::NoTerminal,
        Rejection::UnknownOperation { op } => ChainUnavailable::UnknownOperation { op },
        Rejection::InsideChainLambda => ChainUnavailable::InsideChainLambda,
        Rejection::SyntaxError => ChainUnavailable::SyntaxError,
    }
}

/// The same reasons as the bundle's refusals, for a chain that stopped being traceable between
/// [`debug_stream_chains`] and [`debug_stream_trace`].
fn trace_unavailable(reason: ChainUnavailable, line: u32, chain: Option<&StreamChain>) -> TraceUnavailable {
    let unsupported = |detail: String| TraceUnavailable::Unsupported { detail };
    match reason {
        ChainUnavailable::NotAtChainStart => {
            let start = chain.map_or(String::new(), |c| format!(", the chain starts on line {}", c.first_line + 1));
            TraceUnavailable::NotAtChainStart { detail: format!("the stop is on line {}{start}", line + 1) }
        }
        ChainUnavailable::NoBackend => TraceUnavailable::NoBackend,
        ChainUnavailable::NotTopFrame => unsupported("only the top frame can be traced".into()),
        ChainUnavailable::InsideChainLambda => unsupported("the chain is already running".into()),
        ChainUnavailable::NotJavaStreamRoot { root } => {
            unsupported(format!("the stream {root} does not start in this statement"))
        }
        ChainUnavailable::LazyTerminal { op } => unsupported(format!("{op}() does not run the pipeline")),
        ChainUnavailable::NoTerminal => unsupported("the chain has no terminal operation".into()),
        ChainUnavailable::UnknownOperation { op } => unsupported(format!("unknown stream operation {op}()")),
        ChainUnavailable::SyntaxError => unsupported("the statement does not parse".into()),
    }
}

fn ready(
    chain_info: StreamChainInfo,
    chain: &StreamChain,
    plan: &RealRunPlan,
    collected: TraceCollected,
    generation: u64,
    resumed_stops: u32,
) -> StreamTraceResult {
    let recording = TraceRecording {
        records: collected.records.iter().map(|(step, v)| Record { step: *step, value: trace_value(v) }).collect(),
        dropped: collected.dropped,
        terminal: match &collected.terminal {
            CollectedTerminal::Value(v) => TerminalOutcome::Value { value: trace_value(v) },
            CollectedTerminal::Void => TerminalOutcome::Void,
            CollectedTerminal::Threw(e) => TerminalOutcome::Threw { exception: trace_value(e) },
        },
    };
    let mut linked = link_trace(plan, &recording, collected.skipped_breakpoints);
    // A stream made parallel before the chain's statement, which the bundle found so at run time.
    if collected.sequentialized && !plan.sequentialize {
        linked.banners.push(TraceBanner::Sequentialized);
    }
    if resumed_stops > 0 {
        linked.banners.push(TraceBanner::BreakpointsResumed { count: resumed_stops });
    }
    StreamTraceResult::Ready {
        chain: Box::new(chain_info),
        steps: recorded_steps(chain),
        records: collected.records.into_iter().map(|(step, value)| TraceRecordView { step, value }).collect(),
        links: linked.links,
        terminal: match collected.terminal {
            CollectedTerminal::Value(value) => TerminalView::Value { value },
            CollectedTerminal::Void => TerminalView::Void,
            CollectedTerminal::Threw(exception) => TerminalView::Threw { exception },
        },
        banners: linked.banners,
        generation,
    }
}

fn trace_value(value: &JvmValue) -> TraceValue {
    match value {
        JvmValue::Null => TraceValue::Null,
        JvmValue::Boxed { id, type_name, text } => match box_kind(type_name) {
            Some(class) => TraceValue::Boxed { id: *id, class, value: text.clone() },
            None => TraceValue::Object { id: *id, class: type_name.clone() },
        },
        JvmValue::Str { id, text, .. } => {
            TraceValue::Str { id: *id, value: text.clone().unwrap_or_default(), truncated: text.is_none() }
        }
        JvmValue::Object { id, type_name } | JvmValue::Array { id, type_name, .. } => {
            TraceValue::Object { id: *id, class: type_name.clone() }
        }
        // The recorder boxes every element, so only a terminal's result is primitive, and linking
        // never reads that.
        JvmValue::Primitive { type_name, text } => match box_kind(type_name) {
            Some(class) => TraceValue::Boxed { id: 0, class, value: text.clone() },
            None => TraceValue::Null,
        },
    }
}

/// Wrapper class names (boxed values) and primitive type names (primitive values) alike.
fn box_kind(type_name: &str) -> Option<BoxKind> {
    Some(match type_name {
        "java.lang.Boolean" | "boolean" => BoxKind::Boolean,
        "java.lang.Byte" | "byte" => BoxKind::Byte,
        "java.lang.Character" | "char" => BoxKind::Char,
        "java.lang.Short" | "short" => BoxKind::Short,
        "java.lang.Integer" | "int" => BoxKind::Int,
        "java.lang.Long" | "long" => BoxKind::Long,
        "java.lang.Float" | "float" => BoxKind::Float,
        "java.lang.Double" | "double" => BoxKind::Double,
        _ => return None,
    })
}

#[cfg(test)]
mod tests;

ide_command::domain!(
    stream_trace:
    debug_stream_chains,
    debug_stream_trace,
    debug_stream_trace_abort,
);
