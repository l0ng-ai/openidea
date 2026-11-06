//! Undefined symbols: class-likes, functions and constants that no project
//! file, open buffer or bundled stub declares.
//!
//! - [`UndefinedClass`] (`PhpUndefinedClass`): names of classes,
//!   interfaces, traits and enums in code (`new`, `::`, `instanceof`, type
//!   hints, `catch`, `extends`/`implements`, trait `use`, attributes). The
//!   message names the kind the place expects (`Undefined interface 'X'`
//!   after `implements`).
//! - [`UndefinedFunction`] (`PhpUndefinedFunction`): called functions,
//!   including first-class callables. An unqualified name inside a
//!   namespace is defined when either the namespaced or the global function
//!   exists, as PHP falls back.
//! - [`UndefinedConstant`] (`PhpUndefinedConstant`): global and namespaced
//!   constants (`const` and `define()`), with the same fallback.
//!
//! Imports (`use` lines) and names in docblocks aren't checked; `self`,
//! `static`, `parent`, `true`, `false` and `null` never are. A name is left
//! alone after a guard naming it in the same function (or the rest of the
//! file at the top level): `class_exists`, `interface_exists`,
//! `trait_exists`, `enum_exists` for class-likes, `function_exists` and
//! `is_callable` for functions, `defined` for constants, with a string or
//! `X::class` argument. `.phpstorm.meta.php` files aren't checked (their
//! calls are directives). The checks only run while the indexes are ready, so
//! dumb mode doesn't flood the editor; open documents are inspected again
//! once indexing finishes. `@noinspection` is handled by the framework.
//!
//! An undefined class-like gets the "Create class" quick-fix
//! ([`super::fixes::create_class`]); the import fixes come from the code
//! actions.
//!
//! The ids and the guard behaviour follow PhpStorm's documented
//! inspections ("Undefined class", "Undefined function", "Undefined
//! constant"); the rest is our own.

use std::collections::HashMap;

use ide_core::Severity;
use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, Argument, ArrowFunction, ClassConstantAccess, ClassLikeConstantSelector, Closure, Expression, Extends,
    Function, FunctionCall, Implements, Interface, Literal, Method, TraitUse,
};
use mago_syntax::walker::Walker;

use super::{Inspection, InspectionContext, Problems, fixes};
use crate::engine::{EngineState, is_meta_path};
use crate::names::{FileNames, NameKind, NameRole, Resolution, ResolvedName, fqn_eq};
use crate::navigate::find_declaration;
use crate::syntax::ParsedFile;

/// `PhpUndefinedClass`.
pub struct UndefinedClass;

/// `PhpUndefinedFunction`.
pub struct UndefinedFunction;

/// `PhpUndefinedConstant`.
pub struct UndefinedConstant;

impl Inspection for UndefinedClass {
    fn id(&self) -> &'static str {
        "PhpUndefinedClass"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        check(cx, NameKind::ClassLike, out);
    }
}

impl Inspection for UndefinedFunction {
    fn id(&self) -> &'static str {
        "PhpUndefinedFunction"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        check(cx, NameKind::Function, out);
    }
}

impl Inspection for UndefinedConstant {
    fn id(&self) -> &'static str {
        "PhpUndefinedConstant"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        check(cx, NameKind::Constant, out);
    }
}

/// Attribute namespaces that tools read and PHP never loads.
const IGNORED_NAMESPACES: [&str; 1] = ["JetBrains\\PhpStorm\\"];

fn check(cx: &InspectionContext<'_>, kind: NameKind, out: &mut Problems) {
    // In dumb mode everything would look undefined.
    if cx.engine.status().state != EngineState::Ready {
        return;
    }
    // Metadata: `override()`, `map()` and friends are directives, not calls.
    if is_meta_path(cx.path) {
        return;
    }
    let names = cx.names();
    if !names.names().iter().any(|name| is_checked(name, kind)) {
        return;
    }
    let scan = Scan::of(cx.parsed, names);
    let summary = cx.summary();
    let mut known: HashMap<String, bool> = HashMap::new();
    for name in names.names() {
        if !is_checked(name, kind) {
            continue;
        }
        if cx.is_cancelled() {
            return;
        }
        let defined = name.resolution.candidates().any(|fqn| {
            let key = match kind {
                NameKind::Constant => fqn.to_owned(),
                _ => fqn.to_ascii_lowercase(),
            };
            *known
                .entry(key)
                .or_insert_with(|| find_declaration(summary, kind, fqn).is_some() || cx.engine.declares(kind, fqn))
        });
        if defined || scan.guarded(kind, name) {
            continue;
        }
        if kind == NameKind::ClassLike
            && name.resolution.primary().is_some_and(|fqn| {
                IGNORED_NAMESPACES.iter().any(|ns| fqn.len() > ns.len() && fqn[..ns.len()].eq_ignore_ascii_case(ns))
            })
        {
            continue;
        }
        let what = match kind {
            NameKind::ClassLike => scan.class_word(name.start),
            NameKind::Function => "function",
            _ => "constant",
        };
        let problem = out.report(name.start, name.end, format!("Undefined {what} '{}'", name.text));
        if kind == NameKind::ClassLike
            && let Resolution::Fqn(fqn) = &name.resolution
            && let Some(fix) = fixes::create_class(cx, fqn, what)
        {
            problem.with_fix(fix);
        }
    }
}

/// A reference of `kind` that names something (not a relative class or a
/// special constant).
fn is_checked(name: &ResolvedName, kind: NameKind) -> bool {
    name.kind == kind
        && name.role == NameRole::Reference
        && name.resolution.primary().is_some()
        && !(kind == NameKind::Constant
            && ["true", "false", "null"].iter().any(|s| name.text.trim_start_matches('\\').eq_ignore_ascii_case(s)))
}

/// A `class_exists`-style check: names of `kind` matching `fqn` are fine
/// from `start` to `end` (the end of the enclosing function, or the file).
#[derive(Debug)]
struct Guard {
    kind: NameKind,
    fqn: String,
    start: u32,
    end: u32,
}

/// What the AST adds to the names: guards, and the kind of class-like a
/// position expects.
#[derive(Default)]
struct Scan {
    guards: Vec<Guard>,
    /// Name start → `interface` or `trait`.
    class_words: HashMap<u32, &'static str>,
}

impl Scan {
    fn of(parsed: &ParsedFile, names: &FileNames) -> Self {
        let mut collector = Collector { names, scan: Scan::default(), function_ends: Vec::new(), in_interface: false };
        ScanWalker.walk_program(parsed.program(), &mut collector);
        collector.scan
    }

    fn guarded(&self, kind: NameKind, name: &ResolvedName) -> bool {
        self.guards.iter().any(|guard| {
            guard.kind == kind
                && guard.start <= name.start
                && name.end <= guard.end
                && name.resolution.candidates().any(|fqn| fqn_eq(kind, fqn, &guard.fqn))
        })
    }

    fn class_word(&self, start: u32) -> &'static str {
        self.class_words.get(&start).copied().unwrap_or("class")
    }
}

struct Collector<'n> {
    names: &'n FileNames,
    scan: Scan,
    /// End offsets of the enclosing functions, methods and closures.
    function_ends: Vec<u32>,
    in_interface: bool,
}

impl Collector<'_> {
    fn enter(&mut self, end: u32) {
        self.function_ends.push(end);
    }

    fn leave(&mut self) {
        self.function_ends.pop();
    }

    fn word(&mut self, start: u32, word: &'static str) {
        self.scan.class_words.insert(start, word);
    }
}

/// The kind a guard function checks.
fn guard_kind(callee: &[u8]) -> Option<NameKind> {
    let callee = callee.strip_prefix(b"\\").unwrap_or(callee);
    let is = |name: &str| callee.eq_ignore_ascii_case(name.as_bytes());
    if is("class_exists") || is("interface_exists") || is("trait_exists") || is("enum_exists") {
        Some(NameKind::ClassLike)
    } else if is("function_exists") || is("is_callable") {
        Some(NameKind::Function)
    } else if is("defined") {
        Some(NameKind::Constant)
    } else {
        None
    }
}

/// The name a string literal spells, unescaping `\\` and dropping a leading
/// `\`.
fn spelled_name(value: &[u8]) -> String {
    let text = String::from_utf8_lossy(value).replace("\\\\", "\\");
    text.trim_start_matches('\\').to_owned()
}

struct ScanWalker;

impl<'ast, 'arena, 'n> Walker<'ast, 'arena, Collector<'n>> for ScanWalker {
    fn walk_in_function(&self, node: &'ast Function<'arena>, cx: &mut Collector<'n>) {
        cx.enter(node.span().end.offset);
    }

    fn walk_out_function(&self, _: &'ast Function<'arena>, cx: &mut Collector<'n>) {
        cx.leave();
    }

    fn walk_in_method(&self, node: &'ast Method<'arena>, cx: &mut Collector<'n>) {
        cx.enter(node.span().end.offset);
    }

    fn walk_out_method(&self, _: &'ast Method<'arena>, cx: &mut Collector<'n>) {
        cx.leave();
    }

    fn walk_in_closure(&self, node: &'ast Closure<'arena>, cx: &mut Collector<'n>) {
        cx.enter(node.span().end.offset);
    }

    fn walk_out_closure(&self, _: &'ast Closure<'arena>, cx: &mut Collector<'n>) {
        cx.leave();
    }

    fn walk_in_arrow_function(&self, node: &'ast ArrowFunction<'arena>, cx: &mut Collector<'n>) {
        cx.enter(node.span().end.offset);
    }

    fn walk_out_arrow_function(&self, _: &'ast ArrowFunction<'arena>, cx: &mut Collector<'n>) {
        cx.leave();
    }

    fn walk_in_interface(&self, _: &'ast Interface<'arena>, cx: &mut Collector<'n>) {
        cx.in_interface = true;
    }

    fn walk_out_interface(&self, _: &'ast Interface<'arena>, cx: &mut Collector<'n>) {
        cx.in_interface = false;
    }

    fn walk_in_extends(&self, node: &'ast Extends<'arena>, cx: &mut Collector<'n>) {
        if cx.in_interface {
            for parent in &node.types {
                cx.word(parent.span().start.offset, "interface");
            }
        }
    }

    fn walk_in_implements(&self, node: &'ast Implements<'arena>, cx: &mut Collector<'n>) {
        for interface in &node.types {
            cx.word(interface.span().start.offset, "interface");
        }
    }

    fn walk_in_trait_use(&self, node: &'ast TraitUse<'arena>, cx: &mut Collector<'n>) {
        for name in &node.trait_names {
            cx.word(name.span().start.offset, "trait");
        }
    }

    fn walk_in_function_call(&self, node: &'ast FunctionCall<'arena>, cx: &mut Collector<'n>) {
        let Expression::Identifier(callee) = node.function else { return };
        let Some(kind) = guard_kind(callee.value()) else { return };
        let Some(first) = node.argument_list.arguments.iter().next() else { return };
        let value = match first {
            Argument::Positional(argument) => argument.value,
            Argument::Named(argument) => argument.value,
        };
        let fqn = match value {
            Expression::Literal(Literal::String(string)) => match string.value {
                Some(value) => spelled_name(value),
                None => return,
            },
            Expression::Access(Access::ClassConstant(ClassConstantAccess {
                class: Expression::Identifier(class),
                constant: ClassLikeConstantSelector::Identifier(constant),
                ..
            })) if kind == NameKind::ClassLike && constant.value.eq_ignore_ascii_case(b"class") => {
                match cx.names.at_offset(class.span().start.offset).and_then(|name| name.resolution.primary()) {
                    Some(fqn) => fqn.to_owned(),
                    None => return,
                }
            }
            _ => return,
        };
        if fqn.is_empty() {
            return;
        }
        let end = cx.function_ends.last().copied().unwrap_or(u32::MAX);
        cx.scan.guards.push(Guard { kind, fqn, start: node.span().start.offset, end });
    }
}
