mod frame;
mod search;
mod warnings;

use crate::OpRole;
use ide_core::{CancellationToken, Range};
use ide_syntax::{Snapshot, StructureResult, StructureService};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Where the debuggee stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StopContext<'a> {
    pub line: u32,
    /// The DAP frame is a lambda body (`lambda$…`); the line alone cannot tell.
    pub in_lambda: bool,
    /// File name without extension: the top-level class the file is named after.
    pub file_stem: &'a str,
}

/// Chains around the stopped line; both lists in source order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChainSearch {
    pub chains: Vec<StreamChain>,
    pub rejected: Vec<RejectedChain>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RejectedChain {
    pub range: Range,
    pub text: String,
    pub reason: Rejection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamChain {
    pub range: Range,
    pub text: String,
    pub root: ChainRoot,
    /// Intermediate operations in call order.
    pub ops: Vec<ChainOp>,
    pub terminal: ChainOp,
    pub frame: FrameShape,
    pub warnings: Vec<ChainWarning>,
    pub facts: ChainFacts,
}

/// The call that creates the stream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChainRoot {
    pub text: String,
    /// Byte range in [`StreamChain::text`].
    pub span: (usize, usize),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChainOp {
    pub name: String,
    pub role: OpRole,
    /// Byte range in [`StreamChain::text`], from the `.` to the call's `)`.
    pub span: (usize, usize),
}

/// The class context the chain's frame runs in.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FrameShape {
    /// The innermost enclosing type is a record.
    pub record: bool,
    /// Enclosing type names, outermost first.
    pub class_path: Vec<String>,
    /// Type parameters in scope (the method's, then each enclosing type's from
    /// the inside out) with the erasure of their first bound.
    pub type_params: Vec<(String, Option<String>)>,
    pub package: Option<String>,
}

/// Frames whose class the evaluator cannot compile a lambda into.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FrameKind {
    Anonymous,
    Local,
    /// A top-level type not named after the file.
    SecondaryTopLevel,
}

/// Tracing still works, but its result may differ from the program's own run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChainWarning {
    /// The trace runs sequentially.
    ParallelRemoved,
    /// `call` yields different elements on the second evaluation.
    StatefulSource { call: String },
    /// `call` reads an external resource again.
    RereadsResource { call: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Rejection {
    RootNotNewStream {
        root: String,
    },
    LazyTerminal {
        op: String,
    },
    UnknownOperation {
        op: String,
    },
    /// Stopped inside a lambda of a chain: the chain is already running.
    InsideChainLambda,
    UnsupportedFrame {
        frame: FrameKind,
    },
    SyntaxError,
    PrivateMethodInLambda {
        name: String,
    },
    SuperMethodReference,
    SwitchExpression,
    PatternNotRewritable,
    UnqualifiableType {
        name: String,
    },
    ReservedIdentifier {
        name: String,
    },
    MissingTypeHint {
        name: String,
    },
}

/// Normalisation facts gathered while the tree is at hand.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChainFacts {}

/// Calls that only share a terminal's name (`Collectors.toList()`) appear in neither list.
pub fn find_chains(
    service: &StructureService,
    snap: &Snapshot,
    stop: &StopContext,
    cancel: &CancellationToken,
) -> StructureResult<ChainSearch> {
    service.with_tree(snap, cancel, |t| {
        search::Finder { t, line: stop.line as usize, file_stem: stop.file_stem }.run(stop)
    })
}
