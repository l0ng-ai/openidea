//! Plan for tracing a chain by running the program itself, and linking what the run recorded.

use crate::OpRole;
use crate::chain::{ChainOp, ChainWarning, RootKind, StreamChain};
use crate::model::{Link, Record, StepKind, TraceValue};
use crate::resolve::{resolve, sorted_pass_through};
use serde::{Deserialize, Serialize};
use specta::Type;

/// A call to find among the method exits of the statement's execution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StepSpec {
    pub name: String,
    /// Parameter count of the JVM method, not the arguments as written.
    pub args: u8,
    /// Only the root uses `skip`: later steps are matched by receiver identity.
    pub skip: u8,
}

/// Sent as JSON to the debugger-side bundle, which wraps each step's return in a recorder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RealRunPlan {
    /// `None` when the stream is already held in [`Self::local`].
    pub root: Option<StepSpec>,
    pub local: Option<String>,
    /// Intermediate operations in call order, modifiers included.
    pub steps: Vec<StepSpec>,
    pub terminal: StepSpec,
    /// Class filters for catching the stream's construction, ANDed within one request by JDI.
    pub class_filters: Vec<String>,
    /// `step_kinds[i]` relates recorded step `i` to `i + 1`. Step 0 is the source;
    /// modifiers record nothing.
    pub step_kinds: Vec<StepKind>,
    /// The chain is parallel, so the trace forces it sequential.
    pub sequentialize: bool,
    /// 0-based line of the statement's first token.
    pub first_line: u32,
    /// 0-based line the chain ends on. Before the terminal runs, the thread is on these lines; once
    /// it is elsewhere, an exception skipped the rest of the chain.
    pub last_line: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RealRunRefusal {
    NotJavaStreamRoot { root: String },
    LazyTerminal { op: String },
    NoTerminal,
    UnknownOperation { op: String },
    InsideChainLambda,
    SyntaxError,
}

const STREAM_PACKAGE: &str = "java.util.stream.*";

pub fn real_run_plan(chain: &StreamChain) -> Result<RealRunPlan, RealRunRefusal> {
    let spec = |op: &ChainOp| StepSpec { name: op.name.clone(), args: op.args, skip: 0 };

    let mut class_filters = vec![STREAM_PACKAGE.to_string()];
    let (root, local) = match (&chain.root_kind, &chain.root.call) {
        (RootKind::Call, Some(call)) => {
            class_filters.extend(call.family.class_filters().iter().map(|f| f.to_string()));
            (Some(StepSpec { name: call.name.clone(), args: call.args, skip: call.skip }), None)
        }
        (RootKind::Local { name }, _) => (None, Some(name.clone())),
        _ => return Err(RealRunRefusal::NotJavaStreamRoot { root: chain.root.text.clone() }),
    };

    let mut step_kinds = Vec::new();
    for op in &chain.ops {
        match op.role {
            OpRole::Step { link } => step_kinds.push(link),
            OpRole::Modifier => {}
            _ => return Err(RealRunRefusal::UnknownOperation { op: op.name.clone() }),
        }
    }
    match chain.terminal.role {
        OpRole::Terminal { .. } => {}
        OpRole::LazyTerminal => return Err(RealRunRefusal::LazyTerminal { op: chain.terminal.name.clone() }),
        _ => return Err(RealRunRefusal::NoTerminal),
    }

    Ok(RealRunPlan {
        root,
        local,
        steps: chain.ops.iter().map(spec).collect(),
        terminal: spec(&chain.terminal),
        class_filters: without_overlaps(class_filters),
        step_kinds,
        sequentialize: chain.warnings.contains(&ChainWarning::Sequentialized),
        first_line: chain.first_line,
        last_line: chain.range.end.line,
    })
}

/// Drops each filter another one covers. A method exit that two requests match arrives as two
/// events of one held event set, and the bundle handles (and resumes) each, so the trace fails.
fn without_overlaps(filters: Vec<String>) -> Vec<String> {
    let covered =
        |f: &String| filters.iter().any(|w| w != f && w.strip_suffix('*').is_some_and(|prefix| f.starts_with(prefix)));
    let mut kept: Vec<String> = Vec::new();
    for f in &filters {
        if !covered(f) && !kept.contains(f) {
            kept.push(f.clone());
        }
    }
    kept
}

/// Names of the recorded steps, indexed like [`Record::step`]: the root call's name (empty for a
/// stream held in a local), then each operation [`real_run_plan`] gives a step kind.
pub fn recorded_steps(chain: &StreamChain) -> Vec<String> {
    let source = match (&chain.root_kind, &chain.root.call) {
        (RootKind::Call, Some(call)) => call.name.clone(),
        _ => String::new(),
    };
    let recording = chain.ops.iter().filter(|op| matches!(op.role, OpRole::Step { .. }));
    std::iter::once(source).chain(recording.map(|op| op.name.clone())).collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TraceRecording {
    pub records: Vec<Record>,
    /// Records the recorder discarded after its budget ran out.
    pub dropped: u64,
    pub terminal: TerminalOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TerminalOutcome {
    Value { value: TraceValue },
    Void,
    Threw { exception: TraceValue },
}

/// Something the user must know to read the trace correctly.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TraceBanner {
    Truncated {
        dropped: u64,
    },
    /// `count()` on a sized source skips the pipeline, so nothing was recorded.
    CountFromSize,
    SortedPassThrough {
        step: u16,
    },
    Sequentialized,
    BreakpointsSkipped {
        count: u32,
    },
    /// Breakpoint stops of the chain's thread while it ran, resumed without being shown.
    BreakpointsResumed {
        count: u32,
    },
    Threw,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkedTrace {
    pub records: Vec<Record>,
    /// Parallel to `records`.
    pub links: Vec<Link>,
    pub banners: Vec<TraceBanner>,
}

pub fn link_trace(plan: &RealRunPlan, recording: &TraceRecording, skipped_breakpoints: u32) -> LinkedTrace {
    let records = &recording.records;
    let mut banners = Vec::new();
    if recording.dropped > 0 {
        banners.push(TraceBanner::Truncated { dropped: recording.dropped });
    }
    if plan.terminal.name == "count" && records.is_empty() {
        banners.push(TraceBanner::CountFromSize);
    }
    for (i, kind) in plan.step_kinds.iter().enumerate() {
        let step = i as u16 + 1;
        if *kind == StepKind::Reorder && sorted_pass_through(records, step) {
            banners.push(TraceBanner::SortedPassThrough { step });
        }
    }
    if plan.sequentialize {
        banners.push(TraceBanner::Sequentialized);
    }
    if skipped_breakpoints > 0 {
        banners.push(TraceBanner::BreakpointsSkipped { count: skipped_breakpoints });
    }
    if matches!(recording.terminal, TerminalOutcome::Threw { .. }) {
        banners.push(TraceBanner::Threw);
    }
    LinkedTrace { links: resolve(&plan.step_kinds, records), records: records.clone(), banners }
}
