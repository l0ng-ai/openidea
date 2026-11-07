use crate::OpRole;
use crate::catalog::{SourceCheck, classify_source, op_role};
use ide_core::{CancellationToken, Range};
use ide_syntax::{Snapshot, StructureResult, StructureService, SyntaxTree};
use serde::{Deserialize, Serialize};
use specta::Type;
use tree_sitter::Node;

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
    service.with_tree(snap, cancel, |t| Finder { t, line: stop.line as usize, file_stem: stop.file_stem }.run(stop))
}

const METHOD_SCOPES: &[&str] =
    &["method_declaration", "constructor_declaration", "compact_constructor_declaration", "static_initializer"];
const TYPE_BODIES: &[&str] =
    &["class_body", "interface_body", "enum_body", "enum_body_declarations", "annotation_type_body"];
const TYPE_DECLARATIONS: &[&str] = &[
    "class_declaration",
    "record_declaration",
    "enum_declaration",
    "interface_declaration",
    "annotation_type_declaration",
];
const SIMPLE_STATEMENTS: &[&str] = &[
    "expression_statement",
    "local_variable_declaration",
    "return_statement",
    "throw_statement",
    "yield_statement",
    "assert_statement",
    "explicit_constructor_invocation",
];

fn is_method_scope(n: Node) -> bool {
    // A bare block in a type body is an instance initializer.
    METHOD_SCOPES.contains(&n.kind())
        || (n.kind() == "block" && n.parent().is_some_and(|p| TYPE_BODIES.contains(&p.kind())))
}

fn is_scope(n: Node) -> bool {
    n.kind() == "lambda_expression" || is_method_scope(n)
}

fn object_of<'t>(call: Node<'t>) -> Option<Node<'t>> {
    call.child_by_field_name("object")
}

/// The call whose `object` is `n`.
fn called_on<'t>(n: Node<'t>) -> Option<Node<'t>> {
    n.parent().filter(|p| p.kind() == "method_invocation" && object_of(*p) == Some(n))
}

/// The pieces of a chain that passed the structural checks.
struct Parts<'t> {
    terminal: Node<'t>,
    root: Node<'t>,
    check: SourceCheck,
    ops: Vec<Node<'t>>,
}

struct Finder<'a, 't> {
    t: &'a SyntaxTree<'t>,
    line: usize,
    file_stem: &'a str,
}

impl<'t> Finder<'_, 't> {
    fn text(&self, n: Node) -> &'t str {
        &self.t.text[n.byte_range()]
    }

    fn name(&self, call: Node) -> &'t str {
        call.child_by_field_name("name").map_or("", |n| self.text(n))
    }

    fn covers(&self, n: Node) -> bool {
        n.start_position().row <= self.line && self.line <= n.end_position().row
    }

    fn is_terminal(&self, call: Node) -> bool {
        matches!(op_role(self.name(call)), Some(OpRole::Terminal { .. } | OpRole::LazyTerminal))
    }

    fn run(&self, stop: &StopContext) -> ChainSearch {
        let mut search = ChainSearch::default();
        let scopes = self.frame_scopes(stop.in_lambda);
        let mut scopes_with_chains = Vec::new();
        for &scope in &scopes {
            let mut calls = Vec::new();
            collect_calls(scope, &mut calls);
            let mut any = false;
            for call in calls.into_iter().filter(|&c| self.is_candidate(c, scope)) {
                any |= self.judge(call, scope, &mut search);
            }
            if any {
                scopes_with_chains.push(scope);
            }
        }
        if stop.in_lambda {
            for &lambda in scopes.iter().filter(|s| !scopes_with_chains.contains(s)) {
                let Some(outer) = self.enclosing_chain(lambda) else { continue };
                let range = self.t.range(&outer);
                if search.chains.iter().any(|c| c.range == range) || search.rejected.iter().any(|r| r.range == range) {
                    continue;
                }
                let text = self.text(outer).to_string();
                search.rejected.push(RejectedChain { range, text, reason: Rejection::InsideChainLambda });
            }
        }
        search.chains.sort_by_key(|c| c.range);
        search.rejected.sort_by_key(|r| r.range);
        search
    }

    /// The innermost method-like scope around the line, or, for a lambda
    /// frame, every lambda inside it whose body covers the line: the frame
    /// name does not say which of several nested lambdas it is.
    fn frame_scopes(&self, in_lambda: bool) -> Vec<Node<'t>> {
        let mut covering = Vec::new();
        self.collect_covering(self.t.tree.root_node(), &mut covering);
        // Nested scopes start later than the ones around them.
        let method = covering.iter().copied().filter(|n| is_method_scope(*n)).max_by_key(|n| n.start_byte());
        if !in_lambda {
            return method.into_iter().collect();
        }
        let inside_method =
            |n: &Node| method.is_none_or(|m| m.start_byte() <= n.start_byte() && n.end_byte() <= m.end_byte());
        let lambda_frame =
            |n: &Node| n.kind() == "lambda_expression" && n.child_by_field_name("body").is_some_and(|b| self.covers(b));
        covering.into_iter().filter(|n| lambda_frame(n) && inside_method(n)).collect()
    }

    fn collect_covering(&self, node: Node<'t>, out: &mut Vec<Node<'t>>) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor).filter(|c| self.covers(*c)) {
            out.push(child);
            self.collect_covering(child, out);
        }
    }

    fn is_candidate(&self, call: Node<'t>, scope: Node<'t>) -> bool {
        self.is_terminal(call) && self.top_terminal(call) == Some(call) && self.covers(self.anchor(call, scope))
    }

    /// The outermost terminal-named call of the call chain through `call`, so
    /// `s.collect(..).stream().count()` yields `count`, not `collect`.
    fn top_terminal(&self, call: Node<'t>) -> Option<Node<'t>> {
        let mut top = self.is_terminal(call).then_some(call);
        let mut cur = call;
        while let Some(up) = called_on(cur) {
            if self.is_terminal(up) {
                top = Some(up);
            }
            cur = up;
        }
        top
    }

    /// The statement the line must fall in: the simple statement holding the
    /// call, an expression lambda's body, or the call itself when it sits in
    /// a compound statement's header (`if (s.anyMatch(..)) {`).
    fn anchor(&self, call: Node<'t>, scope: Node<'t>) -> Node<'t> {
        let mut cur = call;
        while let Some(p) = cur.parent() {
            if p == scope {
                let lambda_body = scope.child_by_field_name("body").filter(|_| scope.kind() == "lambda_expression");
                return lambda_body.unwrap_or(call);
            }
            if SIMPLE_STATEMENTS.contains(&p.kind()) {
                return p;
            }
            if p.kind().ends_with("_statement") {
                return call;
            }
            cur = p;
        }
        call
    }

    /// Records the verdict on one candidate; `false` when it is no chain at all.
    fn judge(&self, terminal: Node<'t>, scope: Node<'t>, search: &mut ChainSearch) -> bool {
        let Some(shape) = self.shape(terminal) else { return false };
        let reject =
            |reason| RejectedChain { range: self.t.range(&terminal), text: self.text(terminal).into(), reason };
        if self.anchor(terminal, scope).has_error() {
            search.rejected.push(reject(Rejection::SyntaxError));
            return true;
        }
        match (self.frame(scope), shape) {
            (Err(frame), _) => search.rejected.push(reject(Rejection::UnsupportedFrame { frame })),
            (Ok(_), Err(reason)) => search.rejected.push(reject(reason)),
            (Ok(frame), Ok(parts)) => search.chains.push(self.chain(parts, frame)),
        }
        true
    }

    /// `None`: the call only shares a terminal's name (`Collectors.toList()`).
    fn shape(&self, terminal: Node<'t>) -> Option<Result<Parts<'t>, Rejection>> {
        let mut below = Vec::new();
        let mut cur = object_of(terminal);
        while let Some(call) = cur.filter(|n| n.kind() == "method_invocation") {
            below.push(call);
            cur = object_of(call);
        }
        let Some((at, check)) = below.iter().enumerate().find_map(|(i, c)| Some((i, self.source_check(*c)?))) else {
            let intermediate = |c: &&Node| {
                object_of(**c).is_some()
                    && matches!(op_role(self.name(**c)), Some(OpRole::Step { .. } | OpRole::Modifier))
            };
            let lowest = below.iter().rev().find(intermediate)?;
            let root = object_of(*lowest).map_or("", |o| self.text(o)).to_string();
            return Some(Err(Rejection::RootNotNewStream { root }));
        };
        let ops: Vec<_> = below[..at].iter().rev().copied().collect();
        if let Some(op) =
            ops.iter().find(|c| !matches!(op_role(self.name(**c)), Some(OpRole::Step { .. } | OpRole::Modifier)))
        {
            return Some(Err(Rejection::UnknownOperation { op: self.name(*op).into() }));
        }
        if op_role(self.name(terminal)) == Some(OpRole::LazyTerminal) {
            return Some(Err(Rejection::LazyTerminal { op: self.name(terminal).into() }));
        }
        Some(Ok(Parts { terminal, root: below[at], check, ops }))
    }

    fn source_check(&self, call: Node) -> Option<SourceCheck> {
        let receiver = object_of(call);
        let literal = receiver.is_some_and(|r| r.kind() == "string_literal");
        classify_source(receiver.map(|r| self.text(r).trim()), self.name(call), literal)
    }

    fn chain(&self, parts: Parts<'t>, frame: FrameShape) -> StreamChain {
        let Parts { terminal, root, check, ops } = parts;
        let start = terminal.start_byte();
        let op = |call: Node| {
            let mut cursor = call.walk();
            let dot =
                call.children(&mut cursor).find(|c| c.kind() == ".").map_or(call.start_byte(), |d| d.start_byte());
            let name = self.name(call);
            let role = op_role(name).expect("checked by shape");
            ChainOp { name: name.into(), role, span: (dot - start, call.end_byte() - start) }
        };
        StreamChain {
            range: self.t.range(&terminal),
            text: self.text(terminal).into(),
            root: ChainRoot {
                text: self.text(root).into(),
                span: (root.start_byte() - start, root.end_byte() - start),
            },
            ops: ops.iter().map(|c| op(*c)).collect(),
            terminal: op(terminal),
            frame,
            warnings: self.warnings(root, check, &ops),
            facts: ChainFacts::default(),
        }
    }

    fn warnings(&self, root: Node, check: SourceCheck, ops: &[Node]) -> Vec<ChainWarning> {
        let call = self.text(root).to_string();
        let mut warnings = Vec::new();
        match check {
            SourceCheck::Stateful => warnings.push(ChainWarning::StatefulSource { call }),
            SourceCheck::Rereads => warnings.push(ChainWarning::RereadsResource { call }),
            SourceCheck::Fresh if self.name(root) == "iterate" && self.iterate_has_state(root) => {
                warnings.push(ChainWarning::StatefulSource { call })
            }
            SourceCheck::Fresh => {}
        }
        let parallel = self.name(root) == "parallelStream"
            || ops.iter().any(|op| matches!(self.name(*op), "parallel" | "sequential"));
        if parallel {
            warnings.push(ChainWarning::ParallelRemoved);
        }
        warnings
    }

    /// A seed function that is a method reference, or a lambda reading
    /// anything besides its own parameters, may yield new elements when the
    /// chain is evaluated again.
    fn iterate_has_state(&self, root: Node) -> bool {
        let Some(args) = root.child_by_field_name("arguments") else { return false };
        let mut cursor = args.walk();
        args.named_children(&mut cursor).any(|arg| match arg.kind() {
            "method_reference" => true,
            "lambda_expression" => {
                let mut params = Vec::new();
                if let Some(p) = arg.child_by_field_name("parameters") {
                    collect_identifiers(p, &mut params);
                }
                let mut used = Vec::new();
                if let Some(body) = arg.child_by_field_name("body") {
                    collect_identifiers(body, &mut used);
                }
                used.iter().any(|u| !params.iter().any(|p| self.text(*p) == self.text(*u)))
            }
            _ => false,
        })
    }

    /// Frame shape from the scope outwards; `Err` for frames the evaluator
    /// cannot compile lambdas in.
    fn frame(&self, scope: Node) -> Result<FrameShape, FrameKind> {
        let mut shape = FrameShape::default();
        let mut past_method = false;
        let mut cur = Some(scope);
        while let Some(n) = cur {
            let kind = n.kind();
            if matches!(kind, "method_declaration" | "constructor_declaration") && !past_method {
                self.push_type_params(n, &mut shape.type_params);
                past_method = true;
            } else if kind == "class_body"
                && n.parent().is_some_and(|p| matches!(p.kind(), "object_creation_expression" | "enum_constant"))
            {
                return Err(FrameKind::Anonymous);
            } else if TYPE_DECLARATIONS.contains(&kind) {
                let parent = n.parent().map_or("program", |p| p.kind());
                let name = n.child_by_field_name("name").map_or("", |c| self.text(c));
                if parent != "program" && !TYPE_BODIES.contains(&parent) {
                    return Err(FrameKind::Local);
                }
                if parent == "program" && name != self.file_stem {
                    return Err(FrameKind::SecondaryTopLevel);
                }
                if shape.class_path.is_empty() {
                    shape.record = kind == "record_declaration";
                }
                shape.class_path.push(name.into());
                self.push_type_params(n, &mut shape.type_params);
                past_method = true;
            } else if kind == "program" {
                let mut cursor = n.walk();
                shape.package =
                    n.named_children(&mut cursor).find(|c| c.kind() == "package_declaration").and_then(|p| {
                        let mut cursor = p.walk();
                        let name = p
                            .named_children(&mut cursor)
                            .find(|c| matches!(c.kind(), "scoped_identifier" | "identifier"));
                        name.map(|c| self.text(c).to_string())
                    });
            }
            cur = n.parent();
        }
        shape.class_path.reverse();
        Ok(shape)
    }

    fn push_type_params(&self, decl: Node, out: &mut Vec<(String, Option<String>)>) {
        let Some(params) = decl.child_by_field_name("type_parameters") else { return };
        let mut cursor = params.walk();
        for param in params.named_children(&mut cursor).filter(|p| p.kind() == "type_parameter") {
            let mut cursor = param.walk();
            let mut children = param.named_children(&mut cursor);
            let Some(name) = children.find(|c| c.kind() == "type_identifier") else { continue };
            let bound = children.find(|c| c.kind() == "type_bound").and_then(|b| {
                let mut cursor = b.walk();
                let first =
                    b.named_children(&mut cursor).find(|c| c.kind() != "annotation" && c.kind() != "marker_annotation");
                first.map(|ty| self.erasure(ty))
            });
            out.push((self.text(name).into(), bound));
        }
    }

    fn erasure(&self, ty: Node) -> String {
        let raw = if ty.kind() == "generic_type" { ty.named_child(0).unwrap_or(ty) } else { ty };
        self.text(raw).into()
    }

    /// The chain a lambda frame runs inside of, when the lambda is an
    /// argument somewhere in a chain's calls.
    fn enclosing_chain(&self, lambda: Node<'t>) -> Option<Node<'t>> {
        let mut cur = lambda.parent();
        while let Some(n) = cur.filter(|n| !is_scope(*n) && !TYPE_BODIES.contains(&n.kind())) {
            if n.kind() == "method_invocation"
                && let Some(top) = self.top_terminal(n)
                && self.shape(top).is_some()
            {
                return Some(top);
            }
            cur = n.parent();
        }
        None
    }
}

/// Method invocations owned by `scope`, not by a nested lambda, method or type body.
fn collect_calls<'t>(scope: Node<'t>, out: &mut Vec<Node<'t>>) {
    let mut cursor = scope.walk();
    for child in scope.children(&mut cursor) {
        if is_scope(child) || TYPE_BODIES.contains(&child.kind()) {
            continue;
        }
        if child.kind() == "method_invocation" {
            out.push(child);
        }
        collect_calls(child, out);
    }
}

/// Identifiers naming variables, so not a member name after a `.`.
fn collect_identifiers<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    if n.kind() == "identifier" {
        let member = n.parent().is_some_and(|p| {
            (p.kind() == "method_invocation" && p.child_by_field_name("name") == Some(n) && object_of(p).is_some())
                || (p.kind() == "field_access" && p.child_by_field_name("field") == Some(n))
        });
        if !member {
            out.push(n);
        }
    }
    let mut cursor = n.walk();
    for child in n.children(&mut cursor) {
        collect_identifiers(child, out);
    }
}
