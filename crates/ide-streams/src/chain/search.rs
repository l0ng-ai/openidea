use super::locals::is_visible_local;
use super::{
    ChainOp, ChainRoot, ChainSearch, FrameShape, RejectedChain, Rejection, RootCall, RootKind, StopContext, StreamChain,
};
use crate::OpRole;
use crate::catalog::{SourceFamily, classify_source, jvm_arg_count, op_role};
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
pub(crate) const TYPE_BODIES: &[&str] =
    &["class_body", "interface_body", "enum_body", "enum_body_declarations", "annotation_type_body"];
pub(crate) const TYPE_DECLARATIONS: &[&str] = &[
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

fn saturate(n: usize) -> u8 {
    u8::try_from(n).unwrap_or(u8::MAX)
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
    /// Set when `root` is a call that creates a new stream.
    family: Option<SourceFamily>,
    ops: Vec<Node<'t>>,
}

/// Calls met walking `object` links down to a stream's source.
struct Descent<'t> {
    /// Calls above the source, nearest to the start first.
    above: Vec<Node<'t>>,
    source: Option<(Node<'t>, SourceFamily)>,
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
        match shape {
            Err(reason) => search.rejected.push(reject(reason)),
            Ok(parts) => {
                let frame =
                    self.frame(scope).unwrap_or_else(|kind| FrameShape { kind: Some(kind), ..Default::default() });
                let statement = self.anchor(call, scope);
                search.chains.push(self.chain(parts, frame, scope, statement));
            }
        }
        true
    }

    /// Walks `object` links down from `from`. `None` when a terminal-named
    /// call comes first: what is above it works on a collection, not a stream.
    fn descend(&self, from: Option<Node<'t>>) -> Option<Descent<'t>> {
        let mut above = Vec::new();
        let mut cur = from;
        while let Some(call) = cur.filter(|n| n.kind() == "method_invocation") {
            if let Some(family) = self.source_family(call) {
                return Some(Descent { above, source: Some((call, family)) });
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
        let mut ops: Vec<_> = above.into_iter().rev().collect();
        let (root, family) = match source {
            Some((root, family)) => (root, Some(family)),
            // The stream was made elsewhere: the root is what the lowest operation is called on.
            None => {
                let lowest = ops.iter().position(|c| object_of(*c).is_some() && is_intermediate(self.name(*c)))?;
                ops.drain(..lowest);
                (object_of(ops[0])?, None)
            }
        };
        if let Some(op) = ops.iter().find(|c| !is_intermediate(self.name(**c))) {
            return Some(Err(Rejection::UnknownOperation { op: self.name(*op).into() }));
        }
        if op_role(self.name(terminal)) == Some(OpRole::LazyTerminal) {
            return Some(Err(Rejection::LazyTerminal { op: self.name(terminal).into() }));
        }
        Some(Ok(Parts { terminal, root, family, ops }))
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

    fn source_family(&self, call: Node) -> Option<SourceFamily> {
        classify_source(object_of(call).map(|r| self.text(r).trim()), self.name(call))
    }

    fn chain(&self, parts: Parts<'t>, frame: FrameShape, scope: Node<'t>, statement: Node<'t>) -> StreamChain {
        let Parts { terminal, root, family, ops } = parts;
        let start = terminal.start_byte();
        let op = |call: Node| {
            let mut cursor = call.walk();
            let dot =
                call.children(&mut cursor).find(|c| c.kind() == ".").map_or(call.start_byte(), |d| d.start_byte());
            let name = self.name(call);
            let role = op_role(name).expect("checked by shape");
            let args = saturate(self.jvm_args(call));
            ChainOp { name: name.into(), role, span: (dot - start, call.end_byte() - start), args }
        };
        let (root_kind, call) = match family {
            Some(family) => {
                let args = saturate(self.jvm_args(root));
                let skip: usize = self
                    .skip_regions(statement, scope)
                    .into_iter()
                    .map(|region| self.earlier_exits(region, root, family))
                    .sum();
                let skip = saturate(skip);
                (RootKind::Call, Some(RootCall { name: self.name(root).into(), args, skip, family }))
            }
            None => (self.value_root_kind(root, scope), None),
        };
        StreamChain {
            range: self.t.range(&terminal),
            text: self.text(terminal).into(),
            root: ChainRoot {
                text: self.text(root).into(),
                span: (root.start_byte() - start, root.end_byte() - start),
                call,
            },
            root_kind,
            first_line: statement.start_position().row as u32,
            ops: ops.iter().map(|c| op(*c)).collect(),
            terminal: op(terminal),
            warnings: self.warnings(root, &ops),
            frame,
        }
    }

    /// Parameter count of the method the JVM runs for `call`.
    fn jvm_args(&self, call: Node) -> usize {
        let written = call.child_by_field_name("arguments").map_or(0, |a| {
            let mut cursor = a.walk();
            a.named_children(&mut cursor).filter(|c| !c.kind().ends_with("comment")).count()
        });
        jvm_arg_count(object_of(call).map(|r| self.text(r).trim()), self.name(call), written)
    }

    /// Subtrees where calls that exit before the root can be: the statement holding
    /// the chain, or, for a chain in a compound statement's header, that statement.
    /// For an `else if` also the conditions of the `if`s before it, which all ran;
    /// their branch bodies did not, since the later condition is only reached when
    /// they were skipped.
    fn skip_regions(&self, anchor: Node<'t>, scope: Node<'t>) -> Vec<Node<'t>> {
        let is_statement = |n: Node| n.kind().ends_with("_statement") || n.kind() == "switch_expression";
        if anchor.kind() != "method_invocation" {
            return vec![anchor];
        }
        let mut region = std::iter::successors(anchor.parent(), |n| n.parent())
            .take_while(|n| *n != scope)
            .find(|n| is_statement(*n))
            .unwrap_or(anchor);
        let mut regions = vec![region];
        while let Some(outer) = region
            .parent()
            .filter(|p| p.kind() == "if_statement" && p.child_by_field_name("alternative") == Some(region))
        {
            regions.extend(outer.child_by_field_name("condition"));
            region = outer;
        }
        regions
    }

    /// Calls in `region` that the debugger would take for `root`: same name, parameter
    /// count and source family, returning before `root` does (in its receiver, its
    /// arguments and earlier chains). Lambda and class bodies do not count, as they
    /// run only once a terminal does.
    fn earlier_exits(&self, region: Node, root: Node, family: SourceFamily) -> usize {
        if matches!(region.kind(), "lambda_expression" | "class_body") {
            return 0;
        }
        let mut cursor = region.walk();
        let inside: usize = region.children(&mut cursor).map(|c| self.earlier_exits(c, root, family)).sum();
        let same = region.kind() == "method_invocation"
            && region.id() != root.id()
            && region.end_byte() <= root.end_byte()
            && self.name(region) == self.name(root)
            && self.jvm_args(region) == self.jvm_args(root)
            && self.source_family(region) == Some(family);
        inside + usize::from(same)
    }

    /// `Local` for a variable or parameter the member declares; anything else
    /// (a field, `this.items`, another method's result) is `Other`.
    fn value_root_kind(&self, root: Node<'t>, scope: Node<'t>) -> RootKind {
        let name = self.text(root);
        let member = std::iter::successors(Some(scope), |n| n.parent()).find(|n| is_method_scope(*n)).unwrap_or(scope);
        if root.kind() == "identifier" && is_visible_local(self.t, root, member, name) {
            RootKind::Local { name: name.into() }
        } else {
            RootKind::Other
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
