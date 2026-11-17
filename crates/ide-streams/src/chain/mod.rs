mod frame;
mod locals;
mod search;
mod warnings;

use crate::{OpRole, SourceFamily};
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
    pub root_kind: RootKind,
    /// 0-based line of the first token of the statement holding the chain.
    pub first_line: u32,
    /// Intermediate operations in call order.
    pub ops: Vec<ChainOp>,
    pub terminal: ChainOp,
    pub frame: FrameShape,
    pub warnings: Vec<ChainWarning>,
}

/// What the chain's first expression is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RootKind {
    /// A call that creates a new stream ([`ChainRoot::call`] is set).
    Call,
    /// A local variable or parameter holding a stream.
    Local { name: String },
    /// A field or the result of another method.
    Other,
}

/// The expression the chain's operations are applied to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChainRoot {
    pub text: String,
    /// Byte range in [`StreamChain::text`].
    pub span: (usize, usize),
    /// Set when [`StreamChain::root_kind`] is `Call`.
    pub call: Option<RootCall>,
}

/// The call that creates the stream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RootCall {
    pub name: String,
    /// Parameter count the JVM sees: always 1 for the stream interfaces' varargs `of`.
    pub args: u8,
    /// Calls with the same name and parameter count that return earlier in the
    /// statement, which the root must not be mistaken for. Calls inside lambda
    /// and class bodies do not count: they only run with the terminal.
    pub skip: u8,
    pub family: SourceFamily,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChainOp {
    pub name: String,
    pub role: OpRole,
    /// Byte range in [`StreamChain::text`], from the `.` to the call's `)`.
    pub span: (usize, usize),
    pub args: u8,
}

/// The class context the chain's frame runs in.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FrameShape {
    /// Set when the frame is of a kind a lambda cannot be compiled into; the chain is still reported.
    /// The other fields are unset then.
    pub kind: Option<FrameKind>,
    /// The innermost enclosing type is a record.
    pub record: bool,
    /// Enclosing type names, outermost first.
    pub class_path: Vec<String>,
    /// Type parameters in scope with the erasure of their first bound: the
    /// method's, then each enclosing type's from the inside out, stopping at
    /// the first static member or static nested type.
    pub type_params: Vec<(String, Option<String>)>,
    pub package: Option<String>,
}

/// Frames whose class cannot host a compiled lambda.
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
    /// The chain is parallel; the trace adds `.sequential()`.
    Sequentialized,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Rejection {
    LazyTerminal {
        op: String,
    },
    /// A new stream with operations but no terminal, so nothing would run.
    NoTerminal,
    UnknownOperation {
        op: String,
    },
    /// Stopped inside a lambda of a chain: the chain is already running.
    InsideChainLambda,
    SyntaxError,
}

/// Calls that only share a terminal's name (`Collectors.toList()`, the
/// `forEach` in `s.toList().forEach(..)`) appear in neither list.
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
