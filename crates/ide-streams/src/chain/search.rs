use super::{
    ChainFacts, ChainOp, ChainRoot, ChainSearch, FrameShape, RejectedChain, Rejection, StopContext, StreamChain,
};
use crate::OpRole;
use crate::catalog::{SourceCheck, classify_source, op_role};
use ide_syntax::SyntaxTree;
use tree_sitter::Node;

const METHOD_SCOPES: &[&str] =
    &["method_declaration", "constructor_declaration", "compact_constructor_declaration", "static_initializer"];
pub(super) const TYPE_BODIES: &[&str] =
    &["class_body", "interface_body", "enum_body", "enum_body_declarations", "annotation_type_body"];
pub(super) const TYPE_DECLARATIONS: &[&str] = &[
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

pub(super) fn object_of<'t>(call: Node<'t>) -> Option<Node<'t>> {
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

pub(super) struct Finder<'a, 't> {
    pub(super) t: &'a SyntaxTree<'t>,
    pub(super) line: usize,
    pub(super) file_stem: &'a str,
}

impl<'t> Finder<'_, 't> {
    pub(super) fn text(&self, n: Node) -> &'t str {
        &self.t.text[n.byte_range()]
    }

    pub(super) fn name(&self, call: Node) -> &'t str {
        call.child_by_field_name("name").map_or("", |n| self.text(n))
    }

    fn covers(&self, n: Node) -> bool {
        n.start_position().row <= self.line && self.line <= n.end_position().row
    }

    fn is_terminal(&self, call: Node) -> bool {
        matches!(op_role(self.name(call)), Some(OpRole::Terminal { .. } | OpRole::LazyTerminal))
    }

    pub(super) fn run(&self, stop: &StopContext) -> ChainSearch {
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
