//! Refactorings offered as code actions.
//!
//! - **Extract variable** (`refactor.extract.variable`, IDEA's Introduce
//!   Variable): the selected expression (with only a caret, the innermost
//!   one around it that can be extracted) is assigned to a new variable
//!   right before the statement holding it, and replaced by the variable.
//!   Refused where that would change what runs: an expression in a loop
//!   condition (`while`, `do … while`, the condition and step of `for`), an
//!   `elseif` condition, the body of an unbraced `if`/loop, an arrow
//!   function, a parameter default or a declaration (class members,
//!   `static`, `global`, `const`, `declare`); and where the expression is
//!   written to or must stay a variable (an assignment target, `++`/`--`,
//!   `&`, `isset`/`empty`/`unset`, the left of `??`, `foreach` targets,
//!   `list()`), a plain variable, or a whole expression statement.
//! - **Extract constant** (`refactor.extract.constant`, Introduce
//!   Constant): a constant expression (Mago's `Expression::is_constant`:
//!   literals, constants, arrays and operators over them) becomes a class
//!   constant inside a class, interface, enum or trait (traits from PHP
//!   8.2; `private const` from 7.1, public in interfaces), placed after the
//!   class's last constant and used as `self::NAME`; outside class-likes a
//!   `const NAME = …;` in front of the top-level statement holding it
//!   (inside the namespace), used as `NAME`.
//!
//! - **Extract method / function** (`refactor.extract.method` in methods,
//!   `refactor.extract.function` elsewhere): see [`method`].
//! - **Inline variable / method / function** (`refactor.inline.*`): see
//!   [`inline`].
//!
//! The new name comes from the expression ([`names`], the conventions of
//! the frontend's `src/editor/refactor/names.ts`) and is numbered when
//! taken: variables used anywhere in the enclosing function (the file at
//! the top level), constants of the class or namespace. The editor renames
//! it in place afterwards with its own suggestions. The rules are our own,
//! after IntelliJ's documented Introduce Variable / Constant behaviour.

mod inline;
mod method;
pub(crate) mod names;
#[cfg(test)]
mod tests;

use std::path::Path;

use ide_core::TextEdit;
use mago_span::HasSpan;
use mago_syntax::cst::{Access, Binary, Expression, Node, NodeKind, Statement};

use crate::engine::PhpEngine;
use crate::imports::{ImportAction, file_edit, wanted};
use crate::inspect::fixes::{MemberKind, insert_member, line_indent, newline, starts_line};
use crate::names::{FileNames, NameKind};
use crate::navigate::enclosing_class;
use crate::stubs::PhpVersion;
use crate::summary::{ClassKind, FileSummary};
use crate::syntax::ParsedFile;

pub(crate) use inline::inline_actions;
pub use inline::{INLINE_FUNCTION, INLINE_METHOD, INLINE_VARIABLE};
pub use method::{EXTRACT_FUNCTION, EXTRACT_METHOD};

/// The code action kind of Extract variable.
pub const EXTRACT_VARIABLE: &str = "refactor.extract.variable";
/// The code action kind of Extract constant.
pub const EXTRACT_CONSTANT: &str = "refactor.extract.constant";

/// The nodes from the program down to the innermost one holding bytes
/// `start..end`.
fn path_to<'ast, 'arena>(root: Node<'ast, 'arena>, start: u32, end: u32) -> Vec<Node<'ast, 'arena>> {
    let mut path = vec![root];
    loop {
        let last = path[path.len() - 1];
        let next = last.children().into_iter().find(|child| {
            let span = child.span();
            span.start.offset <= start && end <= span.end.offset
        });
        match next {
            Some(child) => path.push(child),
            None => return path,
        }
    }
}

fn span_of(node: &Node<'_, '_>) -> (u32, u32) {
    let span = node.span();
    (span.start.offset, span.end.offset)
}

fn contains(outer: (u32, u32), inner: (u32, u32)) -> bool {
    outer.0 <= inner.0 && inner.1 <= outer.1
}

/// Bytes `start..end` without the blank space around them.
fn trimmed(text: &str, start: u32, end: u32) -> (u32, u32) {
    let slice = &text[start as usize..end as usize];
    let lead = slice.len() - slice.trim_start().len();
    let trail = slice.len() - slice.trim_end().len();
    if lead == slice.len() {
        return (start, start);
    }
    (start + lead as u32, end - trail as u32)
}

/// The expression to extract: the one spanning exactly the selection, or
/// with a caret the innermost one around it that `accept` takes. Its index
/// in the path.
fn chosen(path: &[Node<'_, '_>], selection: (u32, u32), accept: impl Fn(usize) -> bool) -> Option<usize> {
    let expressions = (0..path.len()).rev().filter(|&i| matches!(path[i], Node::Expression(_)));
    if selection.0 == selection.1 {
        return expressions.into_iter().find(|&i| accept(i));
    }
    // The outermost of those spanning it (they list innermost first).
    let exact: Vec<usize> = expressions.filter(|&i| span_of(&path[i]) == selection).collect();
    exact.last().copied().filter(|&i| accept(i))
}

fn expression<'ast, 'arena>(node: &Node<'ast, 'arena>) -> &'ast Expression<'arena> {
    match node {
        Node::Expression(expr) => expr,
        _ => unreachable!("an expression node"),
    }
}

/// Reads or writes a storage location rather than computing a value.
fn is_variable_like(expr: &Expression<'_>) -> bool {
    matches!(
        expr,
        Expression::Variable(_)
            | Expression::ArrayAccess(_)
            | Expression::ArrayAppend(_)
            | Expression::Access(Access::Property(_) | Access::NullSafeProperty(_) | Access::StaticProperty(_))
    )
}

/// Expressions never worth extracting on their own (names, keywords).
fn is_trivial(expr: &Expression<'_>) -> bool {
    matches!(
        expr,
        Expression::Variable(_)
            | Expression::Identifier(_)
            | Expression::Self_(_)
            | Expression::Static(_)
            | Expression::Parent(_)
            | Expression::List(_)
            | Expression::ArrayAppend(_)
            | Expression::Throw(_)
            | Expression::Error(_)
    )
}

/// Whether the expression at `path[i]` is written to, taken by reference
/// or must stay a variable where it stands (looking up to `path[stop]`).
fn in_write_context(path: &[Node<'_, '_>], i: usize, stop: usize) -> bool {
    let target = span_of(&path[i]);
    if !is_variable_like(expression(&path[i])) {
        return false;
    }
    path[stop..i].iter().any(|node| match node {
        Node::Assignment(assignment) => contains(span_of(&Node::Expression(assignment.lhs)), target),
        Node::Binary(Binary { lhs, operator, .. }) if operator.is_null_coalesce() => {
            contains(span_of(&Node::Expression(lhs)), target)
        }
        Node::UnaryPrefix(unary) => unary.operator.is_increment_or_decrement() || unary.operator.is_reference(),
        Node::UnaryPostfix(_)
        | Node::IssetConstruct(_)
        | Node::EmptyConstruct(_)
        | Node::Unset(_)
        | Node::ForeachTarget(_)
        | Node::List(_)
        | Node::Global(_)
        | Node::Static(_) => true,
        _ => false,
    })
}

/// Nodes that hold statements in sequence (a new statement can go in
/// front of each).
fn is_statement_list(kind: NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Program
            | NodeKind::Block
            | NodeKind::NamespaceImplicitBody
            | NodeKind::SwitchExpressionCase
            | NodeKind::SwitchDefaultCase
            | NodeKind::IfColonDelimitedBody
            | NodeKind::IfColonDelimitedBodyElseIfClause
            | NodeKind::IfColonDelimitedBodyElseClause
            | NodeKind::WhileColonDelimitedBody
            | NodeKind::ForColonDelimitedBody
            | NodeKind::ForeachColonDelimitedBody
            | NodeKind::DeclareColonDelimitedBody
    )
}

/// Nodes an extracted variable can't be declared across.
fn is_boundary(kind: NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Statement
            | NodeKind::Function
            | NodeKind::Method
            | NodeKind::Closure
            | NodeKind::ArrowFunction
            | NodeKind::Class
            | NodeKind::Interface
            | NodeKind::Trait
            | NodeKind::Enum
            | NodeKind::AnonymousClass
            | NodeKind::FunctionLikeParameter
            | NodeKind::Static
            | NodeKind::Global
            | NodeKind::Constant
            | NodeKind::Declare
            | NodeKind::EchoTag
            | NodeKind::Use
    )
}

/// The statement a variable for `path[i]` is declared in front of: the
/// innermost statement in a statement list around it, when the expression
/// is evaluated once, at that statement's start.
fn variable_anchor(path: &[Node<'_, '_>], i: usize) -> Option<usize> {
    let anchor =
        (1..i).rev().find(|&j| matches!(path[j], Node::Statement(_)) && is_statement_list(path[j - 1].kind()))?;
    if path[anchor + 1..i].iter().any(|node| is_boundary(node.kind())) {
        return None;
    }
    let target = span_of(&path[i]);
    let Node::Statement(statement) = path[anchor] else { return None };
    let within = |expr: &Expression<'_>| contains(span_of(&Node::Expression(expr)), target);
    let evaluated_once = match statement {
        Statement::If(node) => within(node.condition),
        Statement::While(_) | Statement::DoWhile(_) => false,
        Statement::For(node) => node.initializations.iter().any(|e| within(e)),
        Statement::Foreach(node) => within(node.expression),
        Statement::Switch(node) => within(node.expression),
        Statement::Expression(node) => span_of(&Node::Expression(node.expression)) != target,
        Statement::Echo(_) | Statement::Return(_) | Statement::Unset(_) => true,
        _ => false,
    };
    evaluated_once.then_some(anchor)
}

/// The `$names` written anywhere in bytes `start..end`, without `$`.
fn variables_in(text: &str, start: u32, end: u32) -> Vec<String> {
    let slice = &text[start as usize..end as usize];
    let mut out = Vec::new();
    let mut rest = slice;
    while let Some(at) = rest.find('$') {
        let after = &rest[at + 1..];
        let len = after.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(after.len());
        if len > 0 {
            out.push(after[..len].to_owned());
        }
        rest = &after[len..];
    }
    out
}

/// The Extract variable / constant / method actions for bytes `start..end` of an
/// open document, filtered by `only`.
pub(crate) fn extract_actions(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    start: u32,
    end: u32,
    only: &[String],
) -> Vec<ImportAction> {
    let want_variable = wanted(only, EXTRACT_VARIABLE);
    let want_constant = wanted(only, EXTRACT_CONSTANT);
    let want_method = wanted(only, EXTRACT_METHOD) || wanted(only, EXTRACT_FUNCTION);
    if !want_variable && !want_constant && !want_method {
        return Vec::new();
    }
    let summary = FileSummary::extract(parsed);
    if summary.has_errors {
        return Vec::new();
    }
    let text = parsed.text();
    let (start, end) = (start.min(end), start.max(end));
    let selection = trimmed(text, start, end);
    let nodes = path_to(Node::Program(parsed.program()), selection.0, selection.1);
    let mut out = Vec::new();
    if want_variable && let Some(action) = extract_variable(parsed, path, &nodes, selection) {
        out.push(action);
    }
    if want_constant && let Some(action) = extract_constant(engine, parsed, path, &summary, &nodes, selection) {
        out.push(action);
    }
    if want_method
        && let Some(action) = method::extract_method(engine, parsed, path, &summary, &nodes, selection)
        && wanted(only, action.kind)
    {
        out.push(action);
    }
    out
}

fn extract_variable(
    parsed: &ParsedFile,
    path: &Path,
    nodes: &[Node<'_, '_>],
    selection: (u32, u32),
) -> Option<ImportAction> {
    let text = parsed.text();
    let accept = |i: usize| {
        let expr = expression(&nodes[i]);
        if is_trivial(expr) {
            return false;
        }
        variable_anchor(nodes, i).is_some_and(|anchor| !in_write_context(nodes, i, anchor))
    };
    let i = chosen(nodes, selection, accept)?;
    let anchor = variable_anchor(nodes, i)?;
    let expr = expression(&nodes[i]);
    let (expr_start, expr_end) = span_of(&nodes[i]);
    let (anchor_start, _) = span_of(&nodes[anchor]);
    // Names taken in the enclosing function, else the file.
    let scope = nodes[..anchor]
        .iter()
        .rev()
        .find(|n| matches!(n.kind(), NodeKind::Function | NodeKind::Method | NodeKind::Closure))
        .map_or((0, text.len() as u32), span_of);
    let taken = variables_in(text, scope.0, scope.1);
    let name = names::unique(&names::suggest(expr, false), |n| taken.iter().any(|t| t == n) || n == "this");
    let value = &text[expr_start as usize..expr_end as usize];
    let nl = newline(text);
    let declaration = if starts_line(text, anchor_start) {
        format!("${name} = {value};{nl}{}", line_indent(text, anchor_start))
    } else {
        format!("${name} = {value}; ")
    };
    let index = parsed.line_index();
    Some(ImportAction {
        title: "Extract variable".into(),
        kind: EXTRACT_VARIABLE,
        preferred: false,
        edit: file_edit(
            path,
            vec![
                TextEdit { range: index.range(anchor_start, anchor_start), new_text: declaration },
                TextEdit { range: index.range(expr_start, expr_end), new_text: format!("${name}") },
            ],
        ),
    })
}

fn extract_constant(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    summary: &FileSummary,
    nodes: &[Node<'_, '_>],
    selection: (u32, u32),
) -> Option<ImportAction> {
    let text = parsed.text();
    let level = engine.language_level();
    let version = crate::format::mago_version(level);
    if nodes.iter().any(|n| n.kind() == NodeKind::AnonymousClass) {
        return None;
    }
    let in_class = nodes
        .iter()
        .any(|n| matches!(n.kind(), NodeKind::Class | NodeKind::Interface | NodeKind::Trait | NodeKind::Enum));
    let accept = |i: usize| {
        let expr = expression(&nodes[i]);
        let already_constant = matches!(
            expr,
            Expression::ConstantAccess(_) | Expression::Access(Access::ClassConstant(_)) | Expression::MagicConstant(_)
        );
        !is_trivial(expr)
            && !already_constant
            && expr.is_constant(&version, false)
            && (in_class || !mentions_class(expr))
    };
    let i = chosen(nodes, selection, accept)?;
    let expr = expression(&nodes[i]);
    let (expr_start, expr_end) = span_of(&nodes[i]);
    let value = &text[expr_start as usize..expr_end as usize];
    let suggestions = names::suggest(expr, true);
    let index = parsed.line_index();
    let nl = newline(text);
    let (declaration, replacement) = if in_class {
        let class = enclosing_class(summary, expr_start)?;
        if class.kind == ClassKind::Trait && level < PhpVersion::new(8, 2) {
            return None;
        }
        let name = names::unique(&suggestions, |n| {
            class.constants.iter().any(|c| c.name == n) || class.cases.iter().any(|c| c.name == n)
        });
        let visibility = if class.kind == ClassKind::Interface {
            "public "
        } else if level >= PhpVersion::new(7, 1) {
            "private "
        } else {
            ""
        };
        let (at, to, new_text) =
            insert_member(text, class, MemberKind::Constant, |_| format!("{visibility}const {name} = {value};"))?;
        (TextEdit { range: index.range(at, to), new_text }, format!("self::{name}"))
    } else {
        // In front of the top-level statement (inside the namespace).
        let mut top = nodes.iter().position(|n| matches!(n, Node::Statement(_)))?;
        if let Node::Statement(Statement::Namespace(_)) = nodes[top] {
            top = nodes.iter().skip(top + 1).position(|n| matches!(n, Node::Statement(_)))? + top + 1;
        }
        if let Node::Statement(Statement::Declare(_) | Statement::EchoTag(_)) = nodes[top] {
            return None;
        }
        let file_names = FileNames::resolve(parsed);
        let (anchor_start, _) = span_of(&nodes[top]);
        let namespace = file_names.scope_at(anchor_start).namespace().to_owned();
        let name = names::unique(&suggestions, |n| {
            let fqn = if namespace.is_empty() { n.to_owned() } else { format!("{namespace}\\{n}") };
            summary.constants.iter().any(|c| c.fqn.trim_start_matches('\\') == fqn)
                || engine.declares(NameKind::Constant, &fqn)
        });
        let declaration_line = format!("const {name} = {value};");
        let new_text = if starts_line(text, anchor_start) {
            let indent = line_indent(text, anchor_start);
            let gap = match nodes[top] {
                Node::Statement(
                    Statement::Function(_)
                    | Statement::Class(_)
                    | Statement::Interface(_)
                    | Statement::Trait(_)
                    | Statement::Enum(_),
                ) => nl,
                _ => "",
            };
            format!("{declaration_line}{nl}{gap}{indent}")
        } else {
            format!("{declaration_line} ")
        };
        (TextEdit { range: index.range(anchor_start, anchor_start), new_text }, name)
    };
    Some(ImportAction {
        title: "Extract constant".into(),
        kind: EXTRACT_CONSTANT,
        preferred: false,
        edit: file_edit(
            path,
            vec![declaration, TextEdit { range: index.range(expr_start, expr_end), new_text: replacement }],
        ),
    })
}

/// Whether `self::`/`parent::` appears in the expression (only valid
/// inside a class).
fn mentions_class(expr: &Expression<'_>) -> bool {
    let mut found = false;
    visit(Node::Expression(expr), &mut |node| {
        found |= matches!(node, Node::Expression(Expression::Self_(_) | Expression::Parent(_) | Expression::Static(_)));
    });
    found
}

fn visit<'ast, 'arena>(node: Node<'ast, 'arena>, f: &mut impl FnMut(Node<'ast, 'arena>)) {
    f(node);
    node.visit_children(|child| visit(child, f));
}
