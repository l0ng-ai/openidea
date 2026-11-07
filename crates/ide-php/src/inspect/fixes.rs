//! Quick-fixes the inspections attach to their problems, and the text and
//! type helpers they share with the context actions ([`super::intentions`]).
//!
//! - **Create member** (undefined method, property or class constant on a
//!   receiver that is one project class): "Create method 'save' in 'Book'"
//!   adds a stub to the class's declaration, in its own file when that is
//!   another one (not a stub or a `vendor/` file). Methods go last in the
//!   body, with parameters named after the call's arguments (variables,
//!   named arguments, properties, else `$arg1`…) and typed with the
//!   arguments' types when PHP can declare them at the project's language
//!   level; properties after the last property and constants after the last
//!   constant (else first in the body). `static` follows the access; the
//!   member is `private` when the access is inside the class itself, else
//!   `public`.
//! - **Create class** (undefined class, interface or trait): "Create class
//!   'Ghost'" creates the file the PSR-4 (or PSR-0) autoload map gives for
//!   the name, with the namespace and an empty declaration (and
//!   `declare(strict_types=1);` when the current file has it). Not offered
//!   when no autoload root covers the namespace or the file exists.
//! - **Initialize variable** (undefined or possibly undefined variable):
//!   `$x = null;` as the first statement of the enclosing function body. Not
//!   in arrow functions.
//! - **Remove unused variable**: an assignment statement `$x = value;` goes
//!   with its line when the value has no side effects (literals, variables,
//!   constants, arrays and closures of them); otherwise only `$x = ` goes and
//!   the value is still evaluated.
//!
//! The fixes follow the behaviour IntelliJ documents for PHP ("Create
//! method", "Create class", "Initialize variable", "Remove unused
//! variable"); the rules are our own.

use std::path::{Path, PathBuf};

use ide_core::{FileEdit, Range, TextEdit, WorkspaceEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, Argument, ArgumentList, ArrayElement, ArrowFunction, AssignmentOperator, ClassLikeMemberSelector, Closure,
    Expression, ExpressionStatement, Function, Literal, Method, MethodBody, Variable,
};
use mago_syntax::walker::Walker;

use super::{InspectionContext, QuickFix};
use crate::imports::{file_edit, removal};
use crate::names::{FileNames, NameKind, NameScope, Resolution};
use crate::navigate::symbol::file_text;
use crate::navigate::{namespace_of, short_name};
use crate::stubs::PhpVersion;
use crate::summary::{ClassKind, ClassLike, FileSummary};
use crate::syntax::ParsedFile;
use crate::types::{Relative, Type};

// ------------------------------------------------------------------ text

pub(crate) fn newline(text: &str) -> &'static str {
    if text.contains("\r\n") { "\r\n" } else { "\n" }
}

/// The byte where the line holding `at` starts.
pub(crate) fn line_start(text: &str, at: u32) -> u32 {
    text[..at as usize].rfind('\n').map_or(0, |i| i + 1) as u32
}

/// The byte where the line holding `at` ends (before its line break).
pub(crate) fn line_end(text: &str, at: u32) -> u32 {
    let end = text[at as usize..].find('\n').map_or(text.len(), |i| at as usize + i);
    let end = if end > 0 && text.as_bytes().get(end - 1) == Some(&b'\r') { end - 1 } else { end };
    end.max(at as usize) as u32
}

/// The blanks at the start of the line holding `at`.
pub(crate) fn line_indent(text: &str, at: u32) -> &str {
    let start = line_start(text, at) as usize;
    let rest = &text[start..];
    &rest[..rest.len() - rest.trim_start_matches([' ', '\t']).len()]
}

/// Whether only blanks stand between the start of its line and `at`.
pub(crate) fn starts_line(text: &str, at: u32) -> bool {
    text[line_start(text, at) as usize..at as usize].chars().all(|c| c == ' ' || c == '\t')
}

/// One level of indentation as the file writes it: a tab when some line
/// starts with one, else four spaces.
pub(crate) fn indent_unit(text: &str) -> &'static str {
    if text.lines().any(|line| line.starts_with('\t')) { "\t" } else { "    " }
}

/// The edit adding tag `lines` (`@param int $a`, without the `* `) at the
/// end of the docblock at `start..end`: `(start, end, text)` replacing
/// those bytes. A one-line docblock becomes a multi-line one.
pub(crate) fn add_doc_lines(text: &str, start: u32, end: u32, lines: &[String], nl: &str) -> (u32, u32, String) {
    let comment = &text[start as usize..end as usize];
    let indent = line_indent(text, start);
    if let Some(last_newline) = comment.rfind('\n') {
        let closing = &comment[last_newline + 1..];
        if let Some(ws) = closing.strip_suffix("*/").filter(|ws| ws.trim().is_empty()) {
            let at = start + last_newline as u32 + 1;
            return (at, at, lines.iter().map(|line| format!("{ws}* {line}{nl}")).collect());
        }
        // `… text */` on the last line: the tags go on lines of their own.
        let at = end - 2;
        let added: String = lines.iter().map(|line| format!("{nl}{indent} * {line}")).collect();
        return (at, at, format!("{added}{nl}{indent} "));
    }
    let inner = comment.trim_start_matches("/**").trim_end_matches("*/").trim();
    let mut out = format!("/**{nl}");
    if !inner.is_empty() {
        out.push_str(&format!("{indent} * {inner}{nl}"));
    }
    for line in lines {
        out.push_str(&format!("{indent} * {line}{nl}"));
    }
    out.push_str(&format!("{indent} */"));
    (start, end, out)
}

// ----------------------------------------------------------------- types

/// How a class reads in `scope`: its short name when that resolves to it,
/// else the fully qualified name with a leading `\`.
pub(crate) fn class_name(fqn: &str, scope: &NameScope) -> String {
    let fqn = fqn.trim_start_matches('\\');
    let short = short_name(fqn);
    match scope.resolve(NameKind::ClassLike, short).resolution {
        Resolution::Fqn(resolved) if resolved.eq_ignore_ascii_case(fqn) => short.to_owned(),
        _ => format!("\\{fqn}"),
    }
}

/// `ty` in PHPDoc syntax with class names as they read in `scope`.
pub(crate) fn doc_type(ty: &Type, scope: &NameScope) -> String {
    ty.map(&mut |ty| match ty {
        Type::Named { fqn, args } => Some(Type::Named { fqn: class_name(fqn, scope), args: args.clone() }),
        _ => None,
    })
    .to_string()
}

/// `ty` as a native type declaration in `scope` that PHP `level` accepts,
/// or `None` when it can't be written (`mixed`, templates, resources, a
/// syntax newer than the level).
pub(crate) fn native_type(ty: &Type, scope: &NameScope, level: PhpVersion) -> Option<String> {
    let at_least = |major, minor| level >= PhpVersion::new(major, minor);
    let ty = ty.widen();
    let mut parts: Vec<String> = Vec::new();
    let mut nullable = false;
    for member in ty.members() {
        match member {
            Type::Null => nullable = true,
            Type::Intersection(inner) => {
                if !at_least(8, 1) || ty.members().len() > 1 {
                    return None;
                }
                let names: Option<Vec<String>> = inner
                    .iter()
                    .map(|part| match part {
                        Type::Named { fqn, .. } => Some(class_name(fqn, scope)),
                        _ => None,
                    })
                    .collect();
                parts.push(names?.join("&"));
            }
            member => {
                for part in native_parts(member, scope, &at_least)? {
                    if !parts.iter().any(|known| known.eq_ignore_ascii_case(&part)) {
                        parts.push(part);
                    }
                }
            }
        }
    }
    // `bool` covers `false`/`true`.
    if parts.iter().any(|p| p == "bool") {
        parts.retain(|p| p != "false" && p != "true");
    }
    match (parts.as_slice(), nullable) {
        ([], true) => at_least(8, 2).then(|| "null".to_owned()),
        ([], false) => None,
        ([one], false) if one == "false" || one == "true" => at_least(8, 2).then(|| one.clone()),
        ([one], false) => Some(one.clone()),
        ([one], true) if one == "mixed" => Some(one.clone()),
        ([one], true) if one == "void" || one == "never" => None,
        ([one], true) => at_least(7, 1).then(|| format!("?{one}")),
        (many, nullable) => {
            if !at_least(8, 0) || many.iter().any(|p| p == "void" || p == "never" || p == "mixed") {
                return None;
            }
            let mut all = many.to_vec();
            if nullable {
                all.push("null".to_owned());
            }
            Some(all.join("|"))
        }
    }
}

/// The native names of one union member.
fn native_parts(ty: &Type, scope: &NameScope, at_least: &dyn Fn(u8, u8) -> bool) -> Option<Vec<String>> {
    let one = |s: &str| Some(vec![s.to_owned()]);
    match ty {
        Type::Void => at_least(7, 1).then(|| vec!["void".to_owned()]),
        Type::Never => at_least(8, 1).then(|| vec!["never".to_owned()]),
        Type::Bool => one("bool"),
        Type::LiteralBool(false) => one("false"),
        Type::LiteralBool(true) => one("true"),
        Type::Int | Type::IntRange { .. } | Type::LiteralInt(_) => one("int"),
        Type::Float | Type::LiteralFloat(_) => one("float"),
        Type::String(_) | Type::LiteralString(_) | Type::ClassString(_) => one("string"),
        Type::ArrayKey => Some(vec!["int".into(), "string".into()]),
        Type::Numeric => Some(vec!["int".into(), "float".into(), "string".into()]),
        Type::Scalar => Some(vec!["bool".into(), "int".into(), "float".into(), "string".into()]),
        Type::Object => at_least(7, 2).then(|| vec!["object".to_owned()]),
        Type::Array { .. } | Type::List { .. } | Type::Shape(_) => one("array"),
        Type::Iterable { .. } => one("iterable"),
        Type::Callable(_) => one("callable"),
        Type::Closure(_) => Some(vec![class_name("Closure", scope)]),
        Type::Named { fqn, .. } => Some(vec![class_name(fqn, scope)]),
        Type::ClassConstant { class, .. } => Some(vec![class_name(class, scope)]),
        Type::Relative(relative) | Type::GenericRelative { relative, .. } => match relative {
            Relative::Static | Relative::This => at_least(8, 0).then(|| vec!["static".to_owned()]),
            other => one(other.as_str()),
        },
        Type::Mixed => at_least(8, 0).then(|| vec!["mixed".to_owned()]),
        _ => None,
    }
}

// --------------------------------------------------------- create member

/// The kinds of members a fix can create.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemberKind {
    Method,
    Property,
    Constant,
}

/// A parameter of a method to create.
#[derive(Clone, Debug)]
pub(crate) struct NewParam {
    /// Without `$`.
    pub(crate) name: String,
    pub(crate) ty: Option<Type>,
    pub(crate) variadic: bool,
}

/// A member to add to a class.
#[derive(Clone, Debug)]
pub(crate) struct NewMember {
    pub(crate) kind: MemberKind,
    /// The class, fully qualified.
    pub(crate) class: String,
    /// Without `$`.
    pub(crate) name: String,
    pub(crate) is_static: bool,
    pub(crate) private: bool,
    pub(crate) params: Vec<NewParam>,
}

/// The parameters of a method created for a call with `arguments`, typed
/// by `type_of`.
pub(crate) fn new_params<'a>(
    arguments: &'a ArgumentList<'a>,
    type_of: impl Fn(&'a Expression<'a>) -> Type,
) -> Vec<NewParam> {
    let mut out: Vec<NewParam> = Vec::new();
    for (i, argument) in arguments.arguments.iter().enumerate() {
        let (value, named, variadic) = match argument {
            Argument::Positional(argument) => (argument.value, None, argument.ellipsis.is_some()),
            Argument::Named(argument) => (argument.value, Some(lossy(argument.name.value)), false),
        };
        let ty = type_of(value);
        let base = named.or_else(|| name_for(value, &ty)).unwrap_or_else(|| format!("arg{}", i + 1));
        let mut name = base.clone();
        let mut n = 2;
        while out.iter().any(|p| p.name == name) {
            name = format!("{base}{n}");
            n += 1;
        }
        let ty = (!variadic).then_some(ty).filter(|ty| !matches!(ty, Type::Mixed | Type::Null | Type::Void));
        out.push(NewParam { name, ty, variadic });
    }
    out
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A parameter name for an argument: the variable's or property's name, or
/// the class name of an object.
fn name_for(value: &Expression<'_>, ty: &Type) -> Option<String> {
    let name = match value {
        Expression::Variable(Variable::Direct(variable)) => {
            let name = lossy(variable.name.strip_prefix(b"$").unwrap_or(variable.name));
            if name == "this" { None } else { Some(name) }
        }
        Expression::Access(Access::Property(access)) => match &access.property {
            ClassLikeMemberSelector::Identifier(name) => Some(lossy(name.value)),
            _ => None,
        },
        Expression::Access(Access::NullSafeProperty(access)) => match &access.property {
            ClassLikeMemberSelector::Identifier(name) => Some(lossy(name.value)),
            _ => None,
        },
        _ => None,
    };
    name.or_else(|| match ty {
        Type::Named { fqn, .. } => {
            let short = short_name(fqn);
            let mut chars = short.chars();
            let first = chars.next()?;
            Some(first.to_lowercase().chain(chars).collect())
        }
        _ => None,
    })
}

/// "Create method 'm' in 'Class'" and friends: the member added to the
/// class's declaration. `None` when the class isn't one project class
/// declared once, or the member can't go in it.
pub(crate) fn create_member(cx: &InspectionContext<'_>, member: &NewMember) -> Option<QuickFix> {
    let engine = cx.engine;
    let targets = engine.declarations_of(NameKind::ClassLike, &member.class, cx.path, cx.summary());
    let [target] = targets.as_slice() else { return None };
    let path = target.path.clone();
    if !is_project_file(cx, &path) {
        return None;
    }
    let other;
    let parsed: &ParsedFile = if path == cx.path {
        cx.parsed
    } else {
        other = ParsedFile::parse(&path.to_string_lossy(), file_text(engine, &path)?);
        &other
    };
    let summary = if path == cx.path { None } else { Some(FileSummary::extract(parsed)) };
    let summary = summary.as_ref().unwrap_or_else(|| cx.summary());
    let class = summary.class_like(&member.class)?;
    let allowed = match member.kind {
        MemberKind::Property => matches!(class.kind, ClassKind::Class | ClassKind::Trait),
        MemberKind::Method | MemberKind::Constant => {
            matches!(class.kind, ClassKind::Class | ClassKind::Trait | ClassKind::Enum)
        }
    };
    if !allowed || summary.has_errors {
        return None;
    }
    let text = parsed.text();
    let names = FileNames::resolve(parsed);
    let (start, end, new_text) = member_insertion(text, class, member, &names, engine.language_level())?;
    let what = match member.kind {
        MemberKind::Method => format!("method '{}'", member.name),
        MemberKind::Property => format!("property '${}'", member.name),
        MemberKind::Constant => format!("constant '{}'", member.name),
    };
    let range = parsed.line_index().range(start, end);
    Some(QuickFix {
        title: format!("Create {what} in '{}'", class.name),
        edit: file_edit(&path, vec![TextEdit { range, new_text }]),
        preferred: false,
    })
}

/// Whether a fix may edit `path`: not a bundled stub, not under `vendor/`.
fn is_project_file(cx: &InspectionContext<'_>, path: &Path) -> bool {
    let engine = cx.engine;
    if path.starts_with(engine.stub_dir()) {
        return false;
    }
    engine.layout().is_none_or(|layout| !path.starts_with(layout.vendor_dir()))
}

/// Where the member goes in `class` and the text to put there: `(start,
/// end, text)` replacing bytes `start..end`.
fn member_insertion(
    text: &str,
    class: &ClassLike,
    member: &NewMember,
    names: &FileNames,
    level: PhpVersion,
) -> Option<(u32, u32, String)> {
    let nl = newline(text);
    let scope = names.scope_at(class.name_loc.start);
    let visibility = if member.private { "private" } else { "public" };
    let static_word = if member.is_static { " static" } else { "" };
    insert_member(text, class, member.kind, |indent| match member.kind {
        MemberKind::Method => {
            let params: Vec<String> = member
                .params
                .iter()
                .map(|p| {
                    let ty = p.ty.as_ref().and_then(|ty| native_type(ty, scope, level));
                    let dots = if p.variadic { "..." } else { "" };
                    match ty {
                        Some(ty) => format!("{ty} {dots}${}", p.name),
                        None => format!("{dots}${}", p.name),
                    }
                })
                .collect();
            format!(
                "{visibility}{static_word} function {}({}){nl}{indent}{{{nl}{indent}}}",
                member.name,
                params.join(", ")
            )
        }
        MemberKind::Property => format!("{visibility}{static_word} ${};", member.name),
        MemberKind::Constant => format!("{visibility} const {} = null;", member.name),
    })
}

/// Where a new member of `kind` goes in `class`, with `declaration` (given
/// the members' indentation) written there: `(start, end, text)` replacing
/// bytes `start..end`. Constants and properties go after the last of their
/// kind, else first; methods last.
pub(crate) fn insert_member(
    text: &str,
    class: &ClassLike,
    kind: MemberKind,
    declaration: impl FnOnce(&str) -> String,
) -> Option<(u32, u32, String)> {
    let nl = newline(text);
    let close = class.loc.end.checked_sub(1)?;
    if text.as_bytes().get(close as usize) != Some(&b'}') {
        return None;
    }
    let open = class.name_loc.end + text[class.name_loc.end as usize..close as usize].find('{')? as u32;
    let class_indent = line_indent(text, class.name_loc.start).to_owned();
    let first_member = class
        .methods
        .iter()
        .map(|m| m.loc.start)
        .chain(class.properties.iter().filter(|p| !p.is_promoted).map(|p| p.loc.start))
        .chain(class.constants.iter().map(|c| c.loc.start))
        .chain(class.cases.iter().map(|c| c.loc.start))
        .chain(class.trait_uses.iter().map(|t| t.loc.start))
        .min();
    let indent = match first_member {
        Some(at) if starts_line(text, at) => line_indent(text, at).to_owned(),
        _ => format!("{class_indent}{}", indent_unit(text)),
    };
    let declaration = declaration(&indent);
    let interior = &text[open as usize + 1..close as usize];
    if interior.trim().is_empty() {
        return Some((open + 1, close, format!("{nl}{indent}{declaration}{nl}{class_indent}")));
    }
    // After the last member of the same kind, on a line of its own.
    let after = match kind {
        MemberKind::Method => None,
        MemberKind::Property => class.properties.iter().filter(|p| !p.is_promoted).map(|p| p.loc.end).max(),
        MemberKind::Constant => class.constants.iter().map(|c| c.loc.end).max(),
    };
    if let Some(after) = after {
        let end = line_end(text, after);
        if matches!(text[after as usize..end as usize].trim(), "" | ";") {
            return Some((end, end, format!("{nl}{indent}{declaration}")));
        }
    }
    if kind != MemberKind::Method {
        return Some((open + 1, open + 1, format!("{nl}{indent}{declaration}{nl}")));
    }
    // Last in the body.
    if starts_line(text, close) {
        let at = line_start(text, close);
        return Some((at, at, format!("{nl}{indent}{declaration}{nl}")));
    }
    Some((close, close, format!("{nl}{nl}{indent}{declaration}{nl}{class_indent}")))
}

// ---------------------------------------------------------- create class

/// "Create class 'Ghost'": the file the autoload map gives for `fqn`, with
/// an empty declaration of `word` (`class`, `interface`, `trait`).
pub(crate) fn create_class(cx: &InspectionContext<'_>, fqn: &str, word: &str) -> Option<QuickFix> {
    let fqn = fqn.trim_start_matches('\\');
    let short = short_name(fqn);
    let valid = short.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
        && short.chars().all(|c| c.is_alphanumeric() || c == '_');
    if !valid {
        return None;
    }
    let layout = cx.engine.layout()?;
    let file: PathBuf = layout.autoload().class_files(fqn).into_iter().next()?;
    if file.exists() || cx.engine.open_document(&file).is_some() || file.starts_with(layout.vendor_dir()) {
        return None;
    }
    let mut content = String::from("<?php\n\n");
    if cx.text().contains("declare(strict_types=1)") {
        content.push_str("declare(strict_types=1);\n\n");
    }
    let namespace = namespace_of(fqn);
    if !namespace.is_empty() {
        content.push_str(&format!("namespace {namespace};\n\n"));
    }
    content.push_str(&format!("{word} {short}\n{{\n}}\n"));
    let edit = WorkspaceEdit {
        files: vec![
            FileEdit::Create { path: file.clone().into(), overwrite: false },
            FileEdit::Edit {
                path: file.into(),
                edits: vec![TextEdit { range: Range::default(), new_text: content }],
                version: None,
            },
        ],
        preconditions: Vec::new(),
    };
    Some(QuickFix { title: format!("Create {word} '{short}'"), edit, preferred: false })
}

// ------------------------------------------------------------- variables

/// A function-like body: `(open brace, close brace)`, or an arrow
/// function's span with `arrow` set.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Body {
    start: u32,
    end: u32,
    arrow: bool,
}

/// The function-like bodies of the file.
pub(crate) fn bodies(parsed: &ParsedFile) -> Vec<Body> {
    let mut out = Vec::new();
    BodyWalker.walk_program(parsed.program(), &mut out);
    out
}

struct BodyWalker;

impl<'a> Walker<'a, 'a, Vec<Body>> for BodyWalker {
    fn walk_in_function(&self, node: &'a Function<'a>, out: &mut Vec<Body>) {
        out.push(Body {
            start: node.body.left_brace.start.offset,
            end: node.body.right_brace.start.offset,
            arrow: false,
        });
    }

    fn walk_in_method(&self, node: &'a Method<'a>, out: &mut Vec<Body>) {
        if let MethodBody::Concrete(block) = &node.body {
            out.push(Body { start: block.left_brace.start.offset, end: block.right_brace.start.offset, arrow: false });
        }
    }

    fn walk_in_closure(&self, node: &'a Closure<'a>, out: &mut Vec<Body>) {
        out.push(Body {
            start: node.body.left_brace.start.offset,
            end: node.body.right_brace.start.offset,
            arrow: false,
        });
    }

    fn walk_in_arrow_function(&self, node: &'a ArrowFunction<'a>, out: &mut Vec<Body>) {
        let span = node.span();
        out.push(Body { start: span.start.offset, end: span.end.offset, arrow: true });
    }
}

/// "Initialize variable '$x'": `$x = null;` first in the innermost body
/// around byte `at`.
pub(crate) fn initialize_variable(
    cx: &InspectionContext<'_>,
    bodies: &[Body],
    name: &str,
    at: u32,
) -> Option<QuickFix> {
    let body = bodies.iter().filter(|b| b.start < at && at <= b.end).min_by_key(|b| b.end - b.start)?;
    if body.arrow {
        return None;
    }
    let text = cx.text();
    let nl = newline(text);
    let (open, close) = (body.start, body.end);
    let interior = &text[open as usize + 1..close as usize];
    let brace_indent = line_indent(text, open).to_owned();
    let first = open + 1 + (interior.len() - interior.trim_start().len()) as u32;
    let line = format!("${name} = null;");
    let (start, end, new_text) = if interior.trim().is_empty() {
        let indent = format!("{brace_indent}{}", indent_unit(text));
        (open + 1, close, format!("{nl}{indent}{line}{nl}{brace_indent}"))
    } else if starts_line(text, first) {
        let indent = line_indent(text, first);
        let at = line_start(text, first);
        (at, at, format!("{indent}{line}{nl}"))
    } else {
        (first, first, format!("{line} "))
    };
    Some(QuickFix {
        title: format!("Initialize variable '${name}'"),
        edit: cx.edit(start, end, new_text),
        preferred: true,
    })
}

/// "Remove unused variable '$x'" for the assignment statement whose target
/// starts at byte `at`.
pub(crate) fn remove_unused_variable(cx: &InspectionContext<'_>, name: &str, at: u32) -> Option<QuickFix> {
    let mut finder = AssignmentFinder { at, found: None };
    AssignmentWalker.walk_program(cx.parsed.program(), &mut finder);
    let (statement_start, statement_end, rhs_start, pure) = finder.found?;
    let (start, end) = if pure { removal(cx.text(), statement_start, statement_end) } else { (at, rhs_start) };
    Some(QuickFix {
        title: format!("Remove unused variable '${name}'"),
        edit: cx.edit(start, end, ""),
        preferred: true,
    })
}

struct AssignmentFinder {
    at: u32,
    /// Statement start and end, the value's start, whether the value is
    /// free of side effects.
    found: Option<(u32, u32, u32, bool)>,
}

struct AssignmentWalker;

impl<'a> Walker<'a, 'a, AssignmentFinder> for AssignmentWalker {
    fn walk_in_statement_expression(&self, node: &'a ExpressionStatement<'a>, cx: &mut AssignmentFinder) {
        let Expression::Assignment(assignment) = node.expression else { return };
        if !matches!(assignment.operator, AssignmentOperator::Assign(_))
            || !matches!(assignment.lhs, Expression::Variable(Variable::Direct(_)))
            || assignment.lhs.span().start.offset != cx.at
        {
            return;
        }
        let span = node.span();
        cx.found =
            Some((span.start.offset, span.end.offset, assignment.rhs.span().start.offset, is_pure(assignment.rhs)));
    }
}

/// Whether evaluating `expr` has no effect besides its value.
fn is_pure(expr: &Expression<'_>) -> bool {
    match expr {
        Expression::Literal(_)
        | Expression::Variable(Variable::Direct(_))
        | Expression::ConstantAccess(_)
        | Expression::Closure(_)
        | Expression::ArrowFunction(_)
        | Expression::Access(Access::ClassConstant(_)) => true,
        Expression::Parenthesized(inner) => is_pure(inner.expression),
        Expression::Array(array) => array.elements.iter().all(pure_element),
        Expression::LegacyArray(array) => array.elements.iter().all(pure_element),
        _ => false,
    }
}

fn pure_element(element: &ArrayElement<'_>) -> bool {
    match element {
        ArrayElement::KeyValue(element) => is_pure(element.key) && is_pure(element.value),
        ArrayElement::Value(element) => is_pure(element.value),
        _ => false,
    }
}

/// Whether `literal` is `null`.
pub(crate) fn is_null(expr: &Expression<'_>) -> bool {
    match expr {
        Expression::Literal(Literal::Null(_)) => true,
        Expression::ConstantAccess(access) => access.name.value().eq_ignore_ascii_case(b"null"),
        _ => false,
    }
}
