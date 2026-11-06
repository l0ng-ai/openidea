//! Inlay hints: parameter names and inferred types.
//!
//! - **Parameter names** (`available: false`) before the positional
//!   arguments whose text doesn't say what they are: literals, arrays,
//!   constants and class constants. Like IntelliJ's default exclusions,
//!   none for variables, property fetches and calls (their names already
//!   tell), single-letter parameters, the one argument of a call whose name
//!   ends with the parameter's (`setTitle('…')`), or that has a generic
//!   name (`strlen('…')`'s `$string`); the variadic parameter is named on
//!   its first argument only.
//! - **Types** (`: Book`, short class names, the full type as tooltip) after
//!   a variable's first assignment in its function (and `foreach` keys and
//!   values), unless the value spells it (literals, `new`, casts, closures,
//!   `Foo::create()` returning a `Foo`), and after the parameter list of
//!   closures and arrow functions without a return type. `mixed` and `void`
//!   are not shown.
//!
//! Which kinds show is up to Editor › Inlay Hints (Types, Parameter names,
//! and the languages they're on), applied by the editor.

use std::collections::HashSet;

use ide_core::{DocId, Pos, Range};
use mago_span::HasSpan;
use mago_syntax::cst::{
    AnonymousClass, Argument, ArrowFunction, AssignmentOperator, Call, Class, Closure, Enum, Expression, Foreach,
    ForeachTarget, Function, Interface, Method, Trait, UnaryPrefixOperator, Variable,
};
use mago_syntax::walker::Walker;

use super::{argument_list, callee, callee_params, method_name};
use crate::engine::PhpEngine;
use crate::names::FileNames;
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::{ExprTypes, Frame, Resolver, Type};

/// What an inlay hint shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InlayHintKind {
    Parameter,
    Type,
}

/// One inlay hint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlayHintInfo {
    pub position: Pos,
    /// `name:` or `: Type`.
    pub label: String,
    pub kind: InlayHintKind,
    pub padding_left: bool,
    pub padding_right: bool,
    pub tooltip: Option<String>,
}

/// Parameter names too generic to hint on a call's only argument.
const GENERIC_NAMES: &[&str] = &["value", "values", "string", "str", "var", "arg", "args", "array", "text", "subject"];

impl PhpEngine {
    /// The inlay hints in `range` of an open document; `None` when the engine
    /// doesn't hold it.
    pub fn inlay_hints(&self, doc: DocId, range: Range) -> Option<Vec<InlayHintInfo>> {
        let parsed = self.parsed_document(doc)?;
        let resolver = self.resolver();
        let names = FileNames::resolve(&parsed);
        let here = FileSummary::extract(&parsed);
        let types = ExprTypes::new(&parsed, &names, &here, &resolver);
        let lines = parsed.line_index();
        let mut hints = Hints {
            parsed: &parsed,
            names: &names,
            here: &here,
            resolver: &resolver,
            types: &types,
            start: lines.byte(range.start),
            end: lines.byte(range.end),
            frames: Vec::new(),
            assigned: HashSet::new(),
            out: Vec::new(),
        };
        HintWalker.walk_program(parsed.program(), &mut hints);
        let mut out = hints.out;
        out.sort_by_key(|hint| (hint.position.line, hint.position.col));
        Some(out)
    }
}

struct Hints<'a, 'r> {
    parsed: &'a ParsedFile,
    names: &'a FileNames,
    here: &'a FileSummary,
    resolver: &'r Resolver<'r>,
    types: &'r ExprTypes<'a, 'r>,
    start: u32,
    end: u32,
    frames: Vec<Frame<'a>>,
    /// The variables written so far, by the start of their function-like
    /// (`u32::MAX` at the top level).
    assigned: HashSet<(u32, Vec<u8>)>,
    out: Vec<InlayHintInfo>,
}

/// Arguments whose text doesn't say what they are.
fn is_opaque(expr: &Expression<'_>) -> bool {
    match expr {
        Expression::Literal(_)
        | Expression::CompositeString(_)
        | Expression::Array(_)
        | Expression::LegacyArray(_)
        | Expression::ConstantAccess(_)
        | Expression::Access(mago_syntax::cst::Access::ClassConstant(_)) => true,
        Expression::UnaryPrefix(unary) => {
            matches!(unary.operator, UnaryPrefixOperator::Negation(_) | UnaryPrefixOperator::Plus(_))
                && matches!(unary.operand, Expression::Literal(_))
        }
        Expression::Parenthesized(inner) => is_opaque(inner.expression),
        _ => false,
    }
}

/// Values that spell their type.
fn spells_type(expr: &Expression<'_>) -> bool {
    match expr {
        Expression::Literal(_)
        | Expression::CompositeString(_)
        | Expression::Array(_)
        | Expression::LegacyArray(_)
        | Expression::Instantiation(_)
        | Expression::AnonymousClass(_)
        | Expression::Closure(_)
        | Expression::ArrowFunction(_)
        | Expression::Clone(_) => true,
        Expression::UnaryPrefix(unary) => unary.operator.is_cast() || is_opaque(expr),
        Expression::Parenthesized(inner) => spells_type(inner.expression),
        _ => false,
    }
}

/// Literal types widened, class names without their namespace
/// (`list<App\Model\Book>` → `list<Book>`).
pub(super) fn short_type(ty: &Type) -> String {
    let full = ty.to_string();
    let mut out = String::with_capacity(full.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        out.push_str(word.rsplit('\\').next().unwrap_or(word));
        word.clear();
    };
    for c in full.chars() {
        if c.is_alphanumeric() || c == '_' || c == '\\' || c == '-' {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

fn shown(ty: &Type) -> bool {
    !matches!(ty, Type::Mixed | Type::Void | Type::Never)
}

impl<'a> Hints<'a, '_> {
    fn in_range(&self, offset: u32) -> bool {
        self.start <= offset && offset <= self.end
    }

    fn pos(&self, offset: u32) -> Pos {
        self.parsed.line_index().pos(offset)
    }

    fn scope_key(&self) -> u32 {
        self.frames
            .iter()
            .rev()
            .find_map(|frame| match frame {
                Frame::Function(node) => Some(node.span().start.offset),
                Frame::Method(node) => Some(node.span().start.offset),
                Frame::Closure(node) => Some(node.span().start.offset),
                Frame::Arrow(node) => Some(node.span().start.offset),
                Frame::Class(_) => None,
            })
            .unwrap_or(u32::MAX)
    }

    fn class(&mut self, name_start: u32) {
        let fqn = self.here.class_likes.iter().find(|class| class.name_loc.start == name_start).map(|c| c.fqn.clone());
        self.frames.push(Frame::Class(fqn));
    }

    fn type_hint(&mut self, at: u32, ty: &Type) {
        let ty = ty.widen();
        if !shown(&ty) {
            return;
        }
        self.out.push(InlayHintInfo {
            position: self.pos(at),
            label: format!(": {}", short_type(&ty)),
            kind: InlayHintKind::Type,
            padding_left: false,
            padding_right: false,
            tooltip: Some(ty.to_string()),
        });
    }

    /// Parameter names before the opaque arguments of `call`.
    fn parameters(&mut self, call: &'a Expression<'a>) {
        let Some(list) = argument_list(call) else { return };
        let positional: Vec<&Expression<'a>> = list
            .arguments
            .iter()
            .map_while(|argument| match argument {
                Argument::Positional(positional) if positional.ellipsis.is_none() => Some(positional.value),
                _ => None,
            })
            .collect();
        if !positional.iter().any(|value| is_opaque(value) && self.in_range(value.span().start.offset)) {
            return;
        }
        let Some(callee) = callee(self.types, self.names, self.resolver, call, &self.frames) else { return };
        let context = self.types.context(&self.frames);
        let params = callee_params(self.resolver, self.here, &callee, &context);
        let called = match call {
            Expression::Call(Call::Function(function)) => match function.function {
                Expression::Identifier(identifier) => {
                    String::from_utf8_lossy(identifier.last_segment()).to_ascii_lowercase()
                }
                _ => String::new(),
            },
            Expression::Call(Call::Method(method)) => method_name(&method.method).unwrap_or_default(),
            Expression::Call(Call::NullSafeMethod(method)) => method_name(&method.method).unwrap_or_default(),
            Expression::Call(Call::StaticMethod(method)) => method_name(&method.method).unwrap_or_default(),
            _ => String::new(),
        }
        .to_ascii_lowercase();
        let only = list.arguments.len() == 1;
        for (index, value) in positional.iter().enumerate() {
            let Some(param) = params.get(index).or_else(|| params.last().filter(|p| p.variadic)) else { break };
            let first_variadic = params.len().saturating_sub(1);
            if param.variadic && index > first_variadic {
                continue;
            }
            let Some(name) = param.name.as_deref() else { continue };
            let start = value.span().start.offset;
            if !is_opaque(value) || !self.in_range(start) || name.chars().count() <= 1 {
                continue;
            }
            let lower = name.to_ascii_lowercase();
            if only && (called.ends_with(&lower) || GENERIC_NAMES.contains(&lower.as_str())) {
                continue;
            }
            let label = if param.variadic { format!("...{name}:") } else { format!("{name}:") };
            self.out.push(InlayHintInfo {
                position: self.pos(start),
                label,
                kind: InlayHintKind::Parameter,
                padding_left: false,
                padding_right: true,
                tooltip: None,
            });
        }
    }

    /// `: T` after a variable's first write in its function.
    fn written(&mut self, variable: &'a Expression<'a>, ty: impl FnOnce(&Self) -> Type) {
        let Expression::Variable(Variable::Direct(direct)) = variable else { return };
        if direct.name == b"$this" {
            return;
        }
        let key = (self.scope_key(), direct.name.to_vec());
        if !self.assigned.insert(key) {
            return;
        }
        let end = direct.span.end.offset;
        if self.in_range(end) {
            let ty = ty(self);
            self.type_hint(end, &ty);
        }
    }

    /// Whether `value` is `Foo::make()` returning a `Foo`.
    fn names_its_class(&self, value: &'a Expression<'a>, ty: &Type) -> bool {
        let Expression::Call(Call::StaticMethod(call)) = value else { return false };
        let Expression::Identifier(class) = call.class else { return false };
        let class = String::from_utf8_lossy(class.last_segment()).to_ascii_lowercase();
        ty.members().iter().all(|member| match member {
            Type::Named { fqn, .. } => fqn.rsplit('\\').next().is_some_and(|short| short.eq_ignore_ascii_case(&class)),
            _ => false,
        })
    }

    fn assignment(&mut self, expr: &'a Expression<'a>) {
        let Expression::Assignment(assignment) = expr else { return };
        if !matches!(assignment.operator, AssignmentOperator::Assign(_)) {
            return;
        }
        let rhs = assignment.rhs;
        let spelled = spells_type(rhs);
        self.written(assignment.lhs, |hints| {
            if spelled {
                return Type::Mixed;
            }
            let ty = hints.types.type_of(rhs, &hints.frames);
            if hints.names_its_class(rhs, &ty) { Type::Mixed } else { ty }
        });
    }

    fn closure_return(&mut self, expr: &'a Expression<'a>) {
        let at = match expr {
            Expression::Closure(closure) if closure.return_type_hint.is_none() => match &closure.use_clause {
                Some(clause) => clause.right_parenthesis.end.offset,
                None => closure.parameter_list.right_parenthesis.end.offset,
            },
            Expression::ArrowFunction(arrow) if arrow.return_type_hint.is_none() => {
                arrow.parameter_list.right_parenthesis.end.offset
            }
            _ => return,
        };
        if !self.in_range(at) {
            return;
        }
        if let Type::Closure(Some(signature)) = self.types.type_of(expr, &self.frames)
            && let Some(returns) = &signature.return_type
        {
            self.type_hint(at, returns);
        }
    }

    fn foreach(&mut self, foreach: &'a Foreach<'a>) {
        let targets = match &foreach.target {
            ForeachTarget::Value(target) => vec![target.value],
            ForeachTarget::KeyValue(target) => vec![target.key, target.value],
        };
        for target in targets {
            let Expression::Variable(Variable::Direct(direct)) = target else { continue };
            let (name, at) = (direct.name, direct.span.start.offset);
            self.written(target, |hints| {
                hints.types.variable_type(name.strip_prefix(b"$").unwrap_or(name), at, &hints.frames)
            });
        }
    }
}

struct HintWalker;

impl<'a, 'r> Walker<'a, 'a, Hints<'a, 'r>> for HintWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Hints<'a, 'r>) {
        // Every assignment counts (a later one isn't the first), wherever
        // the range is.
        if let Expression::Assignment(_) = expr {
            cx.assignment(expr);
            return;
        }
        let span = expr.span();
        if span.end.offset < cx.start || span.start.offset > cx.end {
            return;
        }
        match expr {
            Expression::Closure(_) | Expression::ArrowFunction(_) => cx.closure_return(expr),
            _ if argument_list(expr).is_some() => cx.parameters(expr),
            _ => {}
        }
    }

    fn walk_in_foreach(&self, node: &'a Foreach<'a>, cx: &mut Hints<'a, 'r>) {
        cx.foreach(node);
    }

    fn walk_in_class(&self, node: &'a Class<'a>, cx: &mut Hints<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_class(&self, _: &'a Class<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_interface(&self, node: &'a Interface<'a>, cx: &mut Hints<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_interface(&self, _: &'a Interface<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_trait(&self, node: &'a Trait<'a>, cx: &mut Hints<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_trait(&self, _: &'a Trait<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_enum(&self, node: &'a Enum<'a>, cx: &mut Hints<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_enum(&self, _: &'a Enum<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.push(Frame::Class(None));
    }
    fn walk_out_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_function(&self, node: &'a Function<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.push(Frame::Function(node));
    }
    fn walk_out_function(&self, _: &'a Function<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_method(&self, node: &'a Method<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.push(Frame::Method(node));
    }
    fn walk_out_method(&self, _: &'a Method<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_closure(&self, node: &'a Closure<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.push(Frame::Closure(node));
    }
    fn walk_out_closure(&self, _: &'a Closure<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_arrow_function(&self, node: &'a ArrowFunction<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.push(Frame::Arrow(node));
    }
    fn walk_out_arrow_function(&self, _: &'a ArrowFunction<'a>, cx: &mut Hints<'a, 'r>) {
        cx.frames.pop();
    }
}
