use super::{
    ChainFacts, ChainOp, ChainRoot, ChainSearch, FrameShape, RejectedChain, Rejection, StopContext, StreamChain,
};
use crate::OpRole;
use crate::catalog::{SourceCheck, classify_source, op_role};
use ide_syntax::SyntaxTree;
use tree_sitter::Node;

const METHOD_SCOPES: &[&str] = &[
    "method_declaration",
    "constructor_declaration",
    "compact_constructor_declaration",
    "static_initializer",
    // Field initialisers run in `<init>` / `<clinit>`.
    "field_declaration",
    "constant_declaration",
];
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

fn is_intermediate(name: &str) -> bool {
    matches!(op_role(name), Some(OpRole::Step { .. } | OpRole::Modifier))
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
    /// The root first, then sources nested in its receiver (`r.lines().collect(..).stream()`).
    sources: Vec<(Node<'t>, SourceCheck)>,
    ops: Vec<Node<'t>>,
}

/// Calls met walking `object` links down to a stream's source.
struct Descent<'t> {
    /// Calls above the source, nearest to the start first.
    above: Vec<Node<'t>>,
    source: Option<(Node<'t>, SourceCheck)>,
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
            for call in calls.into_iter().filter(|&c| self.covers(self.anchor(c, scope))) {
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

    /// The first terminal-named call at or above `call` along `object` links.
    fn nearest_terminal(&self, call: Node<'t>) -> Option<Node<'t>> {
        let mut cur = Some(call);
        while let Some(c) = cur {
            if self.is_terminal(c) {
                return Some(c);
            }
            cur = called_on(c);
        }
        None
    }

    /// The statement the line must fall in: the simple statement holding the
    /// call, an expression lambda's body, a field declaration, or the call
    /// itself when it sits in a compound statement's header (`if (s.anyMatch(..)) {`).
    fn anchor(&self, call: Node<'t>, scope: Node<'t>) -> Node<'t> {
        let mut cur = call;
        while let Some(p) = cur.parent() {
            if p == scope {
                return match scope.kind() {
                    "lambda_expression" => scope.child_by_field_name("body").unwrap_or(call),
                    "field_declaration" | "constant_declaration" => scope,
                    _ => call,
                };
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

    /// Records the verdict on one call around the line; `false` when it is no chain at all.
    fn judge(&self, call: Node<'t>, scope: Node<'t>, search: &mut ChainSearch) -> bool {
        let shape = if self.is_terminal(call) {
            self.shape(call)
        } else if self.is_unterminated(call) {
            Some(Err(Rejection::NoTerminal))
        } else {
            None
        };
        let Some(shape) = shape else { return false };
        let reject = |reason| RejectedChain { range: self.t.range(&call), text: self.text(call).into(), reason };
        if self.anchor(call, scope).has_error() {
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

    /// Walks `object` links down from `from`. `None` when a terminal-named
    /// call comes first: what is above it works on a collection, not a stream.
    fn descend(&self, from: Option<Node<'t>>) -> Option<Descent<'t>> {
        let mut above = Vec::new();
        let mut cur = from;
        while let Some(call) = cur.filter(|n| n.kind() == "method_invocation") {
            if let Some(check) = self.source_check(call) {
                return Some(Descent { above, source: Some((call, check)) });
            }
            if self.is_terminal(call) {
                return None;
            }
            above.push(call);
            cur = object_of(call);
        }
        Some(Descent { above, source: None })
    }

    /// `None`: the call only shares a terminal's name (`Collectors.toList()`),
    /// or works on what an earlier terminal returned (`s.toList().forEach(..)`).
    fn shape(&self, terminal: Node<'t>) -> Option<Result<Parts<'t>, Rejection>> {
        let Descent { above, source } = self.descend(object_of(terminal))?;
        let Some(root) = source else {
            let lowest = above.iter().rev().find(|c| object_of(**c).is_some() && is_intermediate(self.name(**c)))?;
            let root = object_of(*lowest).map_or("", |o| self.text(o)).to_string();
            return Some(Err(Rejection::RootNotNewStream { root }));
        };
        let ops: Vec<_> = above.into_iter().rev().collect();
        if let Some(op) = ops.iter().find(|c| !is_intermediate(self.name(**c))) {
            return Some(Err(Rejection::UnknownOperation { op: self.name(*op).into() }));
        }
        if op_role(self.name(terminal)) == Some(OpRole::LazyTerminal) {
            return Some(Err(Rejection::LazyTerminal { op: self.name(terminal).into() }));
        }
        let mut sources = vec![root];
        let mut cur = object_of(root.0);
        while let Some(call) = cur.filter(|n| n.kind() == "method_invocation") {
            sources.extend(self.source_check(call).map(|check| (call, check)));
            cur = object_of(call);
        }
        Some(Ok(Parts { terminal, sources, ops }))
    }

    /// A new stream with intermediate operations but no terminal, standing
    /// on its own (`var s = xs.stream().map(f);`); a stream passed as an
    /// argument or returned from a lambda is someone else's to finish.
    fn is_unterminated(&self, call: Node<'t>) -> bool {
        let standalone = called_on(call).is_none()
            && call.parent().is_some_and(|p| !matches!(p.kind(), "argument_list" | "lambda_expression"));
        if !standalone || object_of(call).is_none() || !is_intermediate(self.name(call)) {
            return false;
        }
        self.descend(Some(call))
            .is_some_and(|d| d.source.is_some() && d.above.iter().all(|c| is_intermediate(self.name(*c))))
    }

    fn source_check(&self, call: Node) -> Option<SourceCheck> {
        let receiver = object_of(call);
        let literal = receiver.is_some_and(|r| r.kind() == "string_literal");
        classify_source(receiver.map(|r| self.text(r).trim()), self.name(call), literal)
    }

    fn chain(&self, parts: Parts<'t>, frame: FrameShape) -> StreamChain {
        let Parts { terminal, sources, ops } = parts;
        let root = sources[0].0;
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
            warnings: self.warnings(&sources, &ops),
            facts: ChainFacts::default(),
        }
    }

    /// The chain a lambda frame runs inside of, when the lambda is an
    /// argument somewhere in a chain's calls.
    fn enclosing_chain(&self, lambda: Node<'t>) -> Option<Node<'t>> {
        let mut cur = lambda.parent();
        while let Some(n) = cur.filter(|n| !is_scope(*n) && !TYPE_BODIES.contains(&n.kind())) {
            if n.kind() == "method_invocation"
                && let Some(end) = self.nearest_terminal(n)
                && self.shape(end).is_some()
            {
                return Some(end);
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
