//! Unused code: imports, private members and parameters.
//!
//! - [`UnusedImport`] (`PhpUnusedAlias`): a `use` import no name of its
//!   namespace refers to (code names, attributes, class names in PHPDoc
//!   types, the first segment of qualified names), or a duplicate of an
//!   earlier one: the imports Optimize Imports drops. Quick-fix "Remove
//!   unused import" deletes the statement with its line, or just the item
//!   (and its comma) when the statement has used ones too.
//! - [`UnusedPrivateMethod`] (`PhpUnusedPrivateMethod`),
//!   [`UnusedPrivateField`] (`PhpUnusedPrivateField`) and
//!   [`UnusedPrivateConstant`] (`PhpUnusedPrivateConstant`): a private
//!   method, property or class constant of a class or enum that nothing in
//!   the class body names: a member access on any receiver (`->m()`,
//!   `?->p`, `::m()`, `::$p`, `::C`, first-class callables), a string
//!   (`[$this, 'm']`, `'self::m'`, `__sleep()` lists) or a word in a
//!   docblock inside the class (`@dataProvider`, `@see`). Not reported:
//!   magic methods, promoted properties, members with attributes or
//!   Doctrine-style annotations (`@ORM\Column`), classes using traits (the
//!   trait may use them), traits and anonymous classes, kinds the class
//!   reaches dynamically (`$this->$name()`, `get_object_vars`, `(array)`,
//!   `constant()`, reflection, …), and whole-file matching when the file
//!   binds closures to objects (`Closure::bind`, `bindTo`, `call`).
//! - [`UnusedParameter`] (`PhpUnusedParameter`): from the variable walk
//!   ([`super::variables`]), which says which signatures are checked.
//!
//! Every problem is faded (`unnecessary`). Files with syntax errors aren't
//! checked for imports and members, whose uses may be lost in the parse.
//! The ids follow PhpStorm's documented inspections ("Unused import",
//! "Unused private method", "Unused private field", "Unused parameter");
//! the rules are our own.

use ide_core::Severity;
use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, Call, ClassLikeConstantSelector, ClassLikeMemberSelector, Expression, Literal, PartialApplication,
    TriviaKind, Variable,
};
use mago_syntax::walker::Walker;

use super::variables::Kind as VariableKind;
use super::{Inspection, InspectionContext, Problems, QuickFix};
use crate::engine::is_meta_path;
use crate::imports::unused_imports;
use crate::names::NameKind;
use crate::summary::{ClassKind, ClassLike, Visibility};

/// `PhpUnusedAlias`.
pub struct UnusedImport;

/// `PhpUnusedPrivateMethod`.
pub struct UnusedPrivateMethod;

/// `PhpUnusedPrivateField`.
pub struct UnusedPrivateField;

/// `PhpUnusedPrivateConstant`.
pub struct UnusedPrivateConstant;

/// `PhpUnusedParameter`.
pub struct UnusedParameter;

impl Inspection for UnusedImport {
    fn id(&self) -> &'static str {
        "PhpUnusedAlias"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        if cx.summary().has_errors || is_meta_path(cx.path) {
            return;
        }
        for unused in unused_imports(cx.parsed, cx.names()) {
            let what = match unused.kind {
                NameKind::Function => "function",
                NameKind::Constant => "constant",
                _ => "class",
            };
            let fix = QuickFix {
                title: "Remove unused import".into(),
                edit: cx.edit(unused.remove.0, unused.remove.1, ""),
                preferred: true,
            };
            out.report(unused.start, unused.end, format!("Unused import {what} '{}'", unused.fqn))
                .unnecessary()
                .with_fix(fix);
        }
    }
}

impl Inspection for UnusedPrivateMethod {
    fn id(&self) -> &'static str {
        "PhpUnusedPrivateMethod"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        report(cx, out, MemberKind::Method);
    }
}

impl Inspection for UnusedPrivateField {
    fn id(&self) -> &'static str {
        "PhpUnusedPrivateField"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        report(cx, out, MemberKind::Property);
    }
}

impl Inspection for UnusedPrivateConstant {
    fn id(&self) -> &'static str {
        "PhpUnusedPrivateConstant"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        report(cx, out, MemberKind::Constant);
    }
}

impl Inspection for UnusedParameter {
    fn id(&self) -> &'static str {
        "PhpUnusedParameter"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        for found in cx.variables().iter().filter(|found| found.kind == VariableKind::UnusedParameter) {
            out.report(found.start, found.end, format!("Unused parameter '${}'", found.name)).unnecessary();
        }
    }
}

fn report(cx: &InspectionContext<'_>, out: &mut Problems, kind: MemberKind) {
    for found in cx.unused_members().iter().filter(|found| found.kind == kind) {
        let message = match kind {
            MemberKind::Method => format!("Unused private method '{}'", found.name),
            MemberKind::Property => format!("Unused private property '${}'", found.name),
            MemberKind::Constant => format!("Unused private constant '{}'", found.name),
        };
        out.report(found.start, found.end, message).unnecessary();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemberKind {
    Method,
    Property,
    Constant,
}

/// An unused private member.
#[derive(Clone, Debug)]
pub(crate) struct Found {
    kind: MemberKind,
    /// Without `$`.
    name: String,
    start: u32,
    end: u32,
}

/// Text in a class body that means the class may reach its properties
/// without naming them.
const PROPERTIES_OFF: &[&str] = &[
    "get_object_vars",
    "(array)",
    "foreach ($this",
    "__sleep",
    "__serialize",
    "serialize(",
    "var_export",
    "print_r",
    "var_dump",
    "json_encode($this",
    "property_exists",
    "Reflection",
];

/// … its methods.
const METHODS_OFF: &[&str] =
    &["method_exists", "call_user_func", "get_class_methods", "is_callable", "Reflection", "__call"];

/// … its constants.
const CONSTANTS_OFF: &[&str] = &["constant(", "Reflection"];

/// Every unused private member of the file's classes (computed once for the
/// three inspections), in source order.
pub(crate) fn find(cx: &InspectionContext<'_>) -> Vec<Found> {
    let summary = cx.summary();
    if summary.has_errors || is_meta_path(cx.path) {
        return Vec::new();
    }
    let classes: Vec<&ClassLike> = summary
        .class_likes
        .iter()
        .filter(|class| matches!(class.kind, ClassKind::Class | ClassKind::Enum) && class.trait_uses.is_empty())
        .filter(|class| {
            class.methods.iter().any(|m| m.visibility == Visibility::Private)
                || class.properties.iter().any(|p| p.visibility == Visibility::Private)
                || class.constants.iter().any(|c| c.visibility == Visibility::Private)
        })
        .collect();
    if classes.is_empty() {
        return Vec::new();
    }
    let mut uses = Uses::default();
    UsesWalker.walk_program(cx.parsed.program(), &mut uses);
    if cx.is_cancelled() {
        return Vec::new();
    }
    let text = cx.text();
    let docs: Vec<(u32, u32)> = cx
        .parsed
        .program()
        .trivia
        .iter()
        .filter(|trivia| trivia.kind == TriviaKind::DocBlockComment)
        .map(|trivia| (trivia.span.start.offset, trivia.span.end.offset))
        .collect();
    let whole_file = text.contains("Closure::bind") || text.contains("bindTo(") || text.contains("->call(");
    let mut out = Vec::new();
    for class in classes {
        let body = &text[class.loc.start as usize..(class.loc.end as usize).min(text.len())];
        let (from, to) = if whole_file { (0, text.len() as u32) } else { (class.loc.start, class.loc.end) };
        let inside = |offset: u32| from <= offset && offset < to;
        let off = |list: &[&str]| list.iter().any(|needle| body.contains(needle));
        let in_docs = |name: &str, fold: bool| {
            docs.iter()
                .filter(|(start, _)| inside(*start))
                .any(|&(start, end)| contains_word(&text[start as usize..end as usize], name, fold))
        };
        let named = |list: &[(String, u32)], name: &str, fold: bool| {
            list.iter().chain(&uses.strings).any(|(used, at)| inside(*at) && same(used, name, fold))
        };
        let annotated = |name_start: u32| annotated(text, &docs, name_start);

        if !off(METHODS_OFF) && !uses.dynamic_methods.iter().any(|&at| inside(at)) {
            for method in &class.methods {
                if method.visibility != Visibility::Private
                    || method.name.starts_with("__")
                    || !method.attributes.is_empty()
                    || annotated(method.name_loc.start)
                    || named(&uses.methods, &method.name, true)
                    || in_docs(&method.name, true)
                {
                    continue;
                }
                out.push(Found {
                    kind: MemberKind::Method,
                    name: method.name.clone(),
                    start: method.name_loc.start,
                    end: method.name_loc.end,
                });
            }
        }
        if !off(PROPERTIES_OFF) && !uses.dynamic_properties.iter().any(|&at| inside(at)) {
            for property in &class.properties {
                if property.visibility != Visibility::Private
                    || property.is_promoted
                    || !property.attributes.is_empty()
                    || annotated(property.name_loc.start)
                    || named(&uses.properties, &property.name, false)
                    || in_docs(&property.name, false)
                {
                    continue;
                }
                out.push(Found {
                    kind: MemberKind::Property,
                    name: property.name.clone(),
                    start: property.name_loc.start,
                    end: property.name_loc.end,
                });
            }
        }
        if !off(CONSTANTS_OFF) && !uses.dynamic_constants.iter().any(|&at| inside(at)) {
            for constant in &class.constants {
                if constant.visibility != Visibility::Private
                    || !constant.attributes.is_empty()
                    || annotated(constant.name_loc.start)
                    || named(&uses.constants, &constant.name, false)
                    || in_docs(&constant.name, false)
                {
                    continue;
                }
                out.push(Found {
                    kind: MemberKind::Constant,
                    name: constant.name.clone(),
                    start: constant.name_loc.start,
                    end: constant.name_loc.end,
                });
            }
        }
    }
    out.sort_by_key(|found| (found.start, found.end));
    out
}

fn same(used: &str, name: &str, fold: bool) -> bool {
    if fold { used.eq_ignore_ascii_case(name) } else { used == name }
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

/// Whether `name` stands in `text` as a whole word.
fn contains_word(text: &str, name: &str, fold: bool) -> bool {
    if name.is_empty() || name.len() > text.len() {
        return false;
    }
    let (hay, needle) =
        if fold { (text.to_ascii_lowercase(), name.to_ascii_lowercase()) } else { (text.to_owned(), name.to_owned()) };
    let bytes = hay.as_bytes();
    let mut from = 0;
    while let Some(i) = hay[from..].find(&needle) {
        let at = from + i;
        let end = at + needle.len();
        let before = at == 0 || !is_word_byte(bytes[at - 1]);
        let after = end == bytes.len() || !is_word_byte(bytes[end]);
        if before && after {
            return true;
        }
        from = at + 1;
        while !hay.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

/// Whether the docblock in front of the member named at `name_start` has an
/// annotation (`@ORM\Column`, `@Serializer\Groups`): a tag starting with an
/// upper-case letter, which frameworks read by reflection.
fn annotated(text: &str, docs: &[(u32, u32)], name_start: u32) -> bool {
    let Some(&(start, end)) = docs.iter().rev().find(|(_, end)| *end <= name_start) else { return false };
    let between = &text[end as usize..name_start as usize];
    if between.contains([';', '{', '}']) {
        return false;
    }
    let doc = &text.as_bytes()[start as usize..end as usize];
    doc.windows(2).any(|w| w[0] == b'@' && w[1].is_ascii_uppercase())
}

/// The member names the file's code mentions, by the offset of the mention.
#[derive(Default)]
struct Uses {
    methods: Vec<(String, u32)>,
    properties: Vec<(String, u32)>,
    constants: Vec<(String, u32)>,
    /// String literals (and the part after `::` of `'Class::member'`).
    strings: Vec<(String, u32)>,
    dynamic_methods: Vec<u32>,
    dynamic_properties: Vec<u32>,
    dynamic_constants: Vec<u32>,
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

impl Uses {
    fn selector(&mut self, selector: &ClassLikeMemberSelector<'_>, at: u32, method: bool) {
        match (selector, method) {
            (ClassLikeMemberSelector::Identifier(name), true) => self.methods.push((lossy(name.value), at)),
            (ClassLikeMemberSelector::Identifier(name), false) => self.properties.push((lossy(name.value), at)),
            (_, true) => self.dynamic_methods.push(at),
            (_, false) => self.dynamic_properties.push(at),
        }
    }

    fn expression(&mut self, expr: &Expression<'_>) {
        let at = expr.span().start.offset;
        match expr {
            Expression::Call(Call::Method(call)) => self.selector(&call.method, at, true),
            Expression::Call(Call::NullSafeMethod(call)) => self.selector(&call.method, at, true),
            Expression::Call(Call::StaticMethod(call)) => self.selector(&call.method, at, true),
            Expression::PartialApplication(PartialApplication::Method(partial)) => {
                self.selector(&partial.method, at, true)
            }
            Expression::PartialApplication(PartialApplication::StaticMethod(partial)) => {
                self.selector(&partial.method, at, true)
            }
            Expression::Access(Access::Property(access)) => self.selector(&access.property, at, false),
            Expression::Access(Access::NullSafeProperty(access)) => self.selector(&access.property, at, false),
            Expression::Access(Access::StaticProperty(access)) => match &access.property {
                Variable::Direct(variable) => {
                    let name = variable.name.strip_prefix(b"$").unwrap_or(variable.name);
                    self.properties.push((lossy(name), at));
                }
                _ => self.dynamic_properties.push(at),
            },
            Expression::Access(Access::ClassConstant(access)) => match &access.constant {
                ClassLikeConstantSelector::Identifier(name) => self.constants.push((lossy(name.value), at)),
                _ => self.dynamic_constants.push(at),
            },
            Expression::Literal(Literal::String(string)) => {
                if let Some(value) = string.value {
                    let value = lossy(value);
                    if let Some((_, member)) = value.rsplit_once("::") {
                        self.strings.push((member.trim_start_matches('$').to_owned(), at));
                    }
                    self.strings.push((value, at));
                }
            }
            _ => {}
        }
    }
}

struct UsesWalker;

impl<'a> Walker<'a, 'a, Uses> for UsesWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, uses: &mut Uses) {
        uses.expression(expr);
    }
}
