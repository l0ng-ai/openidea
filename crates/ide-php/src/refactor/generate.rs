//! Generate code (IDEA's Code › Generate for PHP), offered as code actions
//! inside a class-like (its header or body, not inside a method body,
//! closure or anonymous class). The titles are the ones the editor's
//! Generate menu (`src/editor/lsp/generate.ts`) and its Implement / Override
//! Methods actions pick up, so no frontend change is needed:
//!
//! - **Implement methods** (`source.generate.implementMethods`, classes and
//!   enums): one action declaring every abstract method the class-like gets
//!   from its parents, interfaces and traits and doesn't implement, with
//!   the declared signature and a `// TODO: Implement name() method.` body.
//! - **Override method 'Parent::name()'** (`source.generate.overrideMethods`,
//!   classes): one action per method a parent class declares that can be
//!   overridden (not private, final or abstract), nearest parent first; the
//!   body calls `parent::name(…)` and returns its value unless the method
//!   is `void`/`never` or a constructor.
//! - **Generate constructor** (`source.generate.constructor`, classes and
//!   traits without their own constructor): a parameter per non-static
//!   property without a default value (typed as the property), assigned in
//!   the body; a parent constructor's parameters come first and are passed
//!   to `parent::__construct(…)`. **Generate constructor with promoted
//!   properties** (from PHP 8.0) turns those properties into promoted
//!   parameters instead, moving their modifiers, attributes and docblocks
//!   and removing their declarations. The constructor goes in front of the
//!   first method.
//! - **Generate getters / setters / getters and setters**
//!   (`source.generate.accessors`, classes and traits): for every property
//!   (promoted ones included) that lacks them, or with the range on property
//!   declarations only for those (`Generate getter for '$name'`). Getters
//!   are `getName()`, `isName()` for `bool` (a `bool` property already
//!   named `isX`/`hasX` keeps its name); setters `setName(T $name): void`,
//!   not for `readonly` properties; static properties get static accessors.
//! - **Generate PHPDoc** (`refactor.rewrite`, with the range on a property
//!   without a docblock): `/** @var T */` with its declared, else default
//!   value's, type. Functions and methods get theirs from the context
//!   action of [`crate::inspect`] under the same title.
//!
//! Signatures copied from other files keep meaning the same classes: a
//! class the current file resolves differently is imported, or written
//! fully qualified when its short name is taken; `self` of another class
//! becomes its name. Generated methods go after the last member (the
//! constructor before the first method), indented as the class's members.
//! The rules are our own, after IntelliJ's documented Generate actions for
//! PHP.

use std::path::Path;

use ide_core::TextEdit;
use mago_span::HasSpan;
use mago_syntax::cst::{MethodBody, Node};

use super::hierarchy::{class_imports, class_reference, doc_start, member_removal, reindent};
use super::path_to;
use crate::engine::PhpEngine;
use crate::imports::{ImportAction, REWRITE, file_edit, wanted};
use crate::inspect::fixes::{
    MemberKind, doc_type, indent_unit, insert_member, line_indent, line_start, newline, starts_line,
};
use crate::names::{FileNames, NameKind, RelativeClass, fqn_eq};
use crate::navigate::enclosing_class;
use crate::stubs::PhpVersion;
use crate::summary::{ClassKind, ClassLike, FileSummary, Method, Param, Property, TypeHint, Visibility};
use crate::syntax::ParsedFile;
use crate::types::model::Origin;
use crate::types::{Context, Type};

/// The code action kind of Generate constructor.
pub const GENERATE_CONSTRUCTOR: &str = "source.generate.constructor";
/// The code action kind of Generate getters / setters.
pub const GENERATE_ACCESSORS: &str = "source.generate.accessors";
/// The code action kind of Implement methods.
pub const IMPLEMENT_METHODS: &str = "source.generate.implementMethods";
/// The code action kind of Override method.
pub const OVERRIDE_METHODS: &str = "source.generate.overrideMethods";

/// The kinds [`generate_actions`] answers.
pub(crate) const GENERATE_KINDS: [&str; 5] =
    [IMPLEMENT_METHODS, OVERRIDE_METHODS, GENERATE_CONSTRUCTOR, GENERATE_ACCESSORS, REWRITE];

/// What the actions of one class share.
struct Gen<'a> {
    engine: &'a PhpEngine,
    parsed: &'a ParsedFile,
    path: &'a Path,
    text: &'a str,
    class: &'a ClassLike,
    names: FileNames,
    nl: &'static str,
    unit: &'static str,
    level: PhpVersion,
}

/// One action's edits: byte edits in the class, and the classes to import.
#[derive(Default)]
struct Edits {
    members: Vec<(u32, u32, String)>,
    imports: Vec<String>,
}

/// The Generate actions for bytes `start..end` of an open document,
/// filtered by `only`.
pub(crate) fn generate_actions(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    start: u32,
    end: u32,
    only: &[String],
) -> Vec<ImportAction> {
    if !GENERATE_KINDS.iter().any(|kind| wanted(only, kind)) {
        return Vec::new();
    }
    let summary = FileSummary::extract(parsed);
    if summary.has_errors {
        return Vec::new();
    }
    let (start, end) = (start.min(end), start.max(end));
    let Some(class) = enclosing_class(&summary, start).filter(|class| end <= class.loc.end) else {
        return Vec::new();
    };
    if in_body(parsed, start, end) {
        return Vec::new();
    }
    let text = parsed.text();
    let g = Gen {
        engine,
        parsed,
        path,
        text,
        class,
        names: FileNames::resolve(parsed),
        nl: newline(text),
        unit: indent_unit(text),
        level: engine.language_level(),
    };
    let touched: Vec<&Property> =
        class.properties.iter().filter(|p| !p.has_hooks && p.loc.start <= end && start <= p.loc.end).collect();
    let mut out = Vec::new();
    if wanted(only, IMPLEMENT_METHODS) {
        out.extend(g.implement());
    }
    if wanted(only, OVERRIDE_METHODS) {
        out.extend(g.overrides());
    }
    if wanted(only, GENERATE_CONSTRUCTOR) {
        out.extend(g.constructors());
    }
    if wanted(only, GENERATE_ACCESSORS) {
        out.extend(g.accessors(&touched));
    }
    if wanted(only, REWRITE)
        && let [property] = touched.as_slice()
    {
        out.extend(g.property_doc(property));
    }
    out
}

/// Whether the range is inside a function-like body or an anonymous class
/// (where Generate has nothing for the class around it).
fn in_body(parsed: &ParsedFile, start: u32, end: u32) -> bool {
    path_to(Node::Program(parsed.program()), start, end).iter().any(|node| match node {
        Node::Method(method) => match &method.body {
            MethodBody::Concrete(block) => block.left_brace.start.offset < start && start < block.span().end.offset,
            MethodBody::Abstract(_) => false,
        },
        Node::Closure(_) | Node::ArrowFunction(_) | Node::AnonymousClass(_) | Node::Function(_) => true,
        _ => false,
    })
}

fn visibility_word(visibility: Visibility) -> &'static str {
    match visibility {
        Visibility::Public => "public",
        Visibility::Protected => "protected",
        Visibility::Private => "private",
    }
}

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

/// `name` with its first letter upper-cased and `_`-separated words joined
/// in camel case: `first_name` → `FirstName`.
fn pascal(name: &str) -> String {
    name.split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map(|first| first.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
        })
        .collect()
}

fn is_bool(hint: Option<&TypeHint>) -> bool {
    match hint {
        Some(TypeHint::Builtin(name)) => name == "bool",
        Some(TypeHint::Nullable(inner)) => is_bool(Some(inner)),
        _ => false,
    }
}

fn is_no_value(hint: Option<&TypeHint>) -> bool {
    matches!(hint, Some(TypeHint::Builtin(name)) if name == "void" || name == "never")
}

/// The getter's name for a property.
fn getter_name(property: &Property) -> String {
    let name = &property.name;
    if is_bool(property.type_hint.as_ref()) {
        for prefix in ["is", "has"] {
            if let Some(rest) = name.strip_prefix(prefix)
                && rest.chars().next().is_some_and(|c| c.is_uppercase() || c == '_')
            {
                return format!("{prefix}{}", pascal(rest));
            }
        }
        return format!("is{}", pascal(name));
    }
    format!("get{}", pascal(name))
}

fn setter_name(property: &Property) -> String {
    format!("set{}", pascal(&property.name))
}

/// An insertion starting with a line break, made where blank lines end
/// (before the class's `}`), replaces them instead of adding to them.
fn absorb_blank_lines(text: &str, (start, end, new_text): (u32, u32, String)) -> (u32, u32, String) {
    if start != end || !new_text.starts_with(['\r', '\n']) || line_start(text, start) != start {
        return (start, end, new_text);
    }
    let mut from = start;
    while from > 0 {
        let previous = line_start(text, from - 1);
        if previous == 0 || !text[previous as usize..from as usize].trim().is_empty() {
            break;
        }
        from = previous;
    }
    (from, end, new_text)
}

/// Edits applied in order to `text`, as one edit `(start, end, text)`:
/// sorted by position (insertions at one place in the order given),
/// overlapping deletions merged.
fn combine(text: &str, edits: &[(u32, u32, String)]) -> Option<(u32, u32, String)> {
    let mut edits: Vec<&(u32, u32, String)> = edits.iter().collect();
    edits.sort_by_key(|(start, end, _)| (*start, *end));
    let start = edits.first()?.0;
    let end = edits.iter().map(|edit| edit.1).max()?;
    let mut out = String::new();
    let mut at = start;
    for (from, to, new_text) in edits {
        let from = (*from).max(at);
        out.push_str(&text[at as usize..from as usize]);
        out.push_str(new_text);
        at = at.max(*to);
    }
    out.push_str(&text[at as usize..end as usize]);
    Some((start, end, out))
}

impl Gen<'_> {
    fn is_self(&self, fqn: &str) -> bool {
        fqn_eq(NameKind::ClassLike, fqn, &self.class.fqn)
    }

    /// How this class's code writes class `fqn`.
    fn class_name(&self, fqn: &str, imports: &mut Vec<String>) -> String {
        class_reference(self.engine, fqn, &self.names, self.class, imports)
    }

    /// A type hint declared in `declaring`, written for this class.
    fn hint(&self, hint: &TypeHint, declaring: &ClassLike, imports: &mut Vec<String>) -> String {
        let foreign = declaring.kind != ClassKind::Trait && !self.is_self(&declaring.fqn);
        match hint {
            TypeHint::Named(fqn) => self.class_name(fqn, imports),
            TypeHint::Builtin(name) => name.clone(),
            TypeHint::Relative(RelativeClass::Self_) if foreign => self.class_name(&declaring.fqn, imports),
            TypeHint::Relative(RelativeClass::Parent) if foreign && declaring.kind == ClassKind::Class => {
                match declaring.extends.first() {
                    Some(parent) => self.class_name(parent, imports),
                    None => "parent".to_owned(),
                }
            }
            TypeHint::Relative(relative) => relative.as_str().to_owned(),
            TypeHint::Nullable(inner) => format!("?{}", self.hint(inner, declaring, imports)),
            TypeHint::Union(members) => members
                .iter()
                .map(|member| match member {
                    TypeHint::Intersection(_) => format!("({})", self.hint(member, declaring, imports)),
                    _ => self.hint(member, declaring, imports),
                })
                .collect::<Vec<_>>()
                .join("|"),
            TypeHint::Intersection(members) => {
                members.iter().map(|member| self.hint(member, declaring, imports)).collect::<Vec<_>>().join("&")
            }
        }
    }

    /// A parameter as declared in `declaring` (without promotion or
    /// attributes); `with_default` keeps its default value.
    fn param(&self, param: &Param, declaring: &ClassLike, with_default: bool, imports: &mut Vec<String>) -> String {
        let mut out = String::new();
        if let Some(hint) = &param.type_hint {
            out.push_str(&self.hint(hint, declaring, imports));
            out.push(' ');
        }
        if param.by_ref {
            out.push('&');
        }
        if param.variadic {
            out.push_str("...");
        }
        out.push('$');
        out.push_str(&param.name);
        if with_default && let Some(default) = &param.default {
            out.push_str(" = ");
            out.push_str(default);
        }
        out
    }

    /// `visibility [static ]function [&]name(params)[: T]` of a method
    /// declared in `declaring`.
    fn header(&self, method: &Method, declaring: &ClassLike, imports: &mut Vec<String>) -> String {
        let params: Vec<String> = method.params.iter().map(|p| self.param(p, declaring, true, imports)).collect();
        let static_word = if method.is_static { " static" } else { "" };
        let by_ref = if method.by_ref_return { "&" } else { "" };
        let ret = method
            .return_type
            .as_ref()
            .map(|hint| format!(": {}", self.hint(hint, declaring, imports)))
            .unwrap_or_default();
        format!(
            "{}{static_word} function {by_ref}{}({}){ret}",
            visibility_word(method.visibility),
            method.name,
            params.join(", ")
        )
    }

    /// A method with `header` and `body` lines, at `indent`.
    fn method_text(&self, indent: &str, header: &str, body: &[String]) -> String {
        let nl = self.nl;
        let unit = self.unit;
        let lines: String = body.iter().map(|line| format!("{indent}{unit}{line}{nl}")).collect();
        format!("{header}{nl}{indent}{{{nl}{lines}{indent}}}")
    }

    /// `methods` (a header and body lines each) added last in the class.
    fn add_methods(&self, edits: &mut Edits, methods: &[(String, Vec<String>)]) -> Option<()> {
        let nl = self.nl;
        let edit = insert_member(self.text, self.class, MemberKind::Method, |indent| {
            methods
                .iter()
                .map(|(header, body)| self.method_text(indent, header, body))
                .collect::<Vec<_>>()
                .join(&format!("{nl}{nl}{indent}"))
        })?;
        edits.members.push(absorb_blank_lines(self.text, edit));
        Some(())
    }

    fn action(&self, title: String, kind: &'static str, edits: Edits) -> Option<ImportAction> {
        let index = self.parsed.line_index();
        let mut text_edits = Vec::new();
        let imports = class_imports(self.parsed, self.class.loc.start, &edits.imports);
        if let Some((start, end, new_text)) = combine(self.text, &imports) {
            text_edits.push(TextEdit { range: index.range(start, end), new_text });
        }
        let (start, end, new_text) = combine(self.text, &edits.members)?;
        text_edits.push(TextEdit { range: index.range(start, end), new_text });
        Some(ImportAction { title, kind, preferred: false, edit: file_edit(self.path, text_edits) })
    }

    // ------------------------------------------------------- implement

    fn implement(&self) -> Option<ImportAction> {
        if !matches!(self.class.kind, ClassKind::Class | ClassKind::Enum) {
            return None;
        }
        let model = self.engine.class_model(&self.class.fqn)?;
        let missing: Vec<_> = model
            .methods
            .iter()
            .filter(|m| m.is_abstract && matches!(m.origin, Origin::Declared | Origin::Trait))
            .filter(|m| !self.is_self(&m.declaring.fqn) && self.class.method(&m.name).is_none())
            .filter_map(|m| Some((m.declared()?.clone(), m.declaring.clone())))
            .collect();
        if missing.is_empty() {
            return None;
        }
        let mut edits = Edits::default();
        let mut methods = Vec::new();
        for (method, declaring) in &missing {
            let header = self.header(method, declaring, &mut edits.imports);
            let body = vec![format!("// TODO: Implement {}() method.", method.name)];
            methods.push((header, body));
        }
        self.add_methods(&mut edits, &methods)?;
        self.action("Implement methods".into(), IMPLEMENT_METHODS, edits)
    }

    // -------------------------------------------------------- override

    fn overrides(&self) -> Vec<ImportAction> {
        if self.class.kind != ClassKind::Class {
            return Vec::new();
        }
        let Some(model) = self.engine.class_model(&self.class.fqn) else { return Vec::new() };
        let mut candidates: Vec<_> = model
            .methods
            .iter()
            .filter(|m| matches!(m.origin, Origin::Declared | Origin::Trait))
            .filter(|m| !m.is_abstract && !m.is_final && m.visibility != Visibility::Private)
            .filter(|m| !self.is_self(&m.self_class) && self.class.method(&m.name).is_none())
            .filter(|m| model.parents.iter().any(|p| fqn_eq(NameKind::ClassLike, p, &m.self_class)))
            .collect();
        // Nearest parent first, then in declaration order.
        candidates.sort_by_key(|m| {
            let depth = model.parents.iter().position(|p| fqn_eq(NameKind::ClassLike, p, &m.self_class));
            (depth, m.declared().map(|d| d.loc.start))
        });
        let mut out = Vec::new();
        for candidate in candidates {
            let Some(method) = candidate.declared() else { continue };
            let declaring = &candidate.declaring;
            let mut edits = Edits::default();
            let header = self.header(method, declaring, &mut edits.imports);
            let arguments: Vec<String> =
                method.params.iter().map(|p| format!("{}${}", if p.variadic { "..." } else { "" }, p.name)).collect();
            let call = format!("parent::{}({});", method.name, arguments.join(", "));
            let returns = !is_no_value(method.return_type.as_ref())
                && !["__construct", "__destruct", "__clone"].iter().any(|n| method.name.eq_ignore_ascii_case(n));
            let body = vec![if returns { format!("return {call}") } else { call }];
            if self.add_methods(&mut edits, &[(header, body)]).is_none() {
                continue;
            }
            let title = format!("Override method '{}::{}()'", short(&candidate.self_class), method.name);
            out.extend(self.action(title, OVERRIDE_METHODS, edits));
        }
        out
    }

    // ----------------------------------------------------- constructor

    fn constructors(&self) -> Vec<ImportAction> {
        if !matches!(self.class.kind, ClassKind::Class | ClassKind::Trait) || self.class.method("__construct").is_some()
        {
            return Vec::new();
        }
        let parent = self.engine.class_model(&self.class.fqn).and_then(|model| {
            let ctor = model.method("__construct")?;
            let usable = !self.is_self(&ctor.self_class)
                && ctor.visibility != Visibility::Private
                && !ctor.is_abstract
                && ctor.origin == Origin::Declared
                && ctor.declaring.kind == ClassKind::Class;
            usable.then(|| Some((ctor.declared()?.clone(), ctor.declaring.clone()))).flatten()
        });
        let properties: Vec<&Property> = self
            .class
            .properties
            .iter()
            .filter(|p| !p.is_static && !p.is_promoted && !p.has_hooks && !p.is_abstract && p.default.is_none())
            .collect();
        let mut out = Vec::new();
        out.extend(self.constructor(parent.as_ref(), &properties));
        let alone = |p: &Property| self.class.properties.iter().filter(|q| q.loc == p.loc).count() == 1;
        if self.level >= PhpVersion::new(8, 0) && !properties.is_empty() && properties.iter().all(|p| alone(p)) {
            out.extend(self.promoted_constructor(parent.as_ref(), &properties));
        }
        out
    }

    /// The parent constructor's parameters and the `parent::__construct`
    /// call. Their defaults are kept only when nothing follows them.
    fn parent_part(
        &self,
        parent: Option<&(Method, std::sync::Arc<ClassLike>)>,
        followed: bool,
        imports: &mut Vec<String>,
    ) -> (Vec<String>, Option<String>) {
        let Some((ctor, declaring)) = parent else { return (Vec::new(), None) };
        let params = ctor.params.iter().map(|p| self.param(p, declaring, !followed, imports)).collect();
        let arguments: Vec<String> =
            ctor.params.iter().map(|p| format!("{}${}", if p.variadic { "..." } else { "" }, p.name)).collect();
        (params, Some(format!("parent::__construct({});", arguments.join(", "))))
    }

    fn constructor(
        &self,
        parent: Option<&(Method, std::sync::Arc<ClassLike>)>,
        properties: &[&Property],
    ) -> Option<ImportAction> {
        let mut edits = Edits::default();
        let taken: Vec<&str> =
            parent.map(|(ctor, _)| ctor.params.iter().map(|p| p.name.as_str()).collect()).unwrap_or_default();
        let own: Vec<&&Property> = properties.iter().filter(|p| !taken.contains(&p.name.as_str())).collect();
        let (mut params, call) = self.parent_part(parent, !own.is_empty(), &mut edits.imports);
        for property in &own {
            let ty = property.type_hint.as_ref().map(|hint| self.hint(hint, self.class, &mut edits.imports));
            params.push(match ty {
                Some(ty) => format!("{ty} ${}", property.name),
                None => format!("${}", property.name),
            });
        }
        let mut body: Vec<String> = call.into_iter().collect();
        body.extend(properties.iter().map(|p| format!("$this->{} = ${};", p.name, p.name)));
        let header = format!("public function __construct({})", params.join(", "));
        self.add_constructor(&mut edits, &[], |indent| self.method_text(indent, &header, &body))?;
        self.action("Generate constructor".into(), GENERATE_CONSTRUCTOR, edits)
    }

    fn promoted_constructor(
        &self,
        parent: Option<&(Method, std::sync::Arc<ClassLike>)>,
        properties: &[&Property],
    ) -> Option<ImportAction> {
        let text = self.text;
        let nl = self.nl;
        let unit = self.unit;
        let mut edits = Edits::default();
        let (parent_params, call) = self.parent_part(parent, true, &mut edits.imports);
        // Each property's declaration (docblock, attributes, modifiers,
        // type, name) becomes a parameter; `var` means `public`.
        let mut promoted: Vec<(String, String)> = Vec::new();
        let mut removed = Vec::new();
        for property in properties {
            let start = doc_start(text, property.loc.start);
            let from = line_indent(text, property.loc.start).to_owned();
            let declaration = &text[start as usize..property.name_loc.end as usize];
            let declaration = match declaration.find("var ") {
                Some(at)
                    if text[property.loc.start as usize..property.name_loc.start as usize]
                        .trim_start()
                        .starts_with("var ") =>
                {
                    format!("{}public {}", &declaration[..at], &declaration[at + 4..])
                }
                _ => declaration.to_owned(),
            };
            promoted.push((declaration, from));
            removed.push(member_removal(text, start, property.loc.end));
        }
        let call: Vec<String> = call.into_iter().collect();
        let render = move |indent: &str| {
            let inner = format!("{indent}{unit}");
            let mut lines: Vec<String> = parent_params.iter().map(|p| format!("{inner}{p},")).collect();
            for (declaration, from) in &promoted {
                lines.push(format!("{inner}{},", reindent(declaration, from, &inner)));
            }
            let body: String = call.iter().map(|line| format!("{inner}{line}{nl}")).collect();
            format!("public function __construct({nl}{}{nl}{indent}) {{{nl}{body}{indent}}}", lines.join(nl))
        };
        self.add_constructor(&mut edits, &removed, render)?;
        edits.members.extend(removed.into_iter().map(|(start, end)| (start, end, String::new())));
        self.action("Generate constructor with promoted properties".into(), GENERATE_CONSTRUCTOR, edits)
    }

    /// Adds a constructor rendered for an indentation: in front of the first
    /// method, else last; when the class keeps no other member (`removed`
    /// takes the rest), as its only content.
    fn add_constructor(
        &self,
        edits: &mut Edits,
        removed: &[(u32, u32)],
        render: impl Fn(&str) -> String,
    ) -> Option<()> {
        let text = self.text;
        let nl = self.nl;
        let class = self.class;
        let gone = |at: u32| removed.iter().any(|(start, end)| *start <= at && at < *end);
        let first_method = class.methods.iter().map(|m| doc_start(text, m.loc.start)).min();
        if let Some(at) = first_method.filter(|&at| starts_line(text, at)) {
            let indent = line_indent(text, at).to_owned();
            let at = line_start(text, at);
            edits.members.push((at, at, format!("{indent}{}{nl}{nl}", render(&indent))));
            return Some(());
        }
        let others = class
            .properties
            .iter()
            .filter(|p| !p.is_promoted)
            .map(|p| p.loc.start)
            .chain(class.constants.iter().map(|c| c.loc.start))
            .chain(class.cases.iter().map(|c| c.loc.start))
            .chain(class.trait_uses.iter().map(|t| t.loc.start))
            .chain(class.methods.iter().map(|m| m.loc.start));
        let mut others = others.peekable();
        if !removed.is_empty() && others.peek().is_some() && others.all(gone) {
            let close = class.loc.end.checked_sub(1)?;
            let open = class.name_loc.end + text[class.name_loc.end as usize..close as usize].find('{')? as u32;
            let class_indent = line_indent(text, class.name_loc.start).to_owned();
            let indent = format!("{class_indent}{}", self.unit);
            edits.members.push((open + 1, close, format!("{nl}{indent}{}{nl}{class_indent}", render(&indent))));
            // The removals fall inside: `combine` merges them.
            return Some(());
        }
        let edit = insert_member(text, class, MemberKind::Method, render)?;
        edits.members.push(absorb_blank_lines(text, edit));
        Some(())
    }

    // ------------------------------------------------------- accessors

    fn accessors(&self, touched: &[&Property]) -> Vec<ImportAction> {
        if !matches!(self.class.kind, ClassKind::Class | ClassKind::Trait) {
            return Vec::new();
        }
        let model = self.engine.class_model(&self.class.fqn);
        let has = |name: &str| match &model {
            Some(model) => model.method(name).is_some_and(|m| self.is_self(&m.self_class)),
            None => self.class.method(name).is_some(),
        };
        let all: Vec<&Property> = self.class.properties.iter().filter(|p| !p.has_hooks && !p.is_abstract).collect();
        let chosen: &[&Property] = if touched.is_empty() { &all } else { touched };
        let getters: Vec<&Property> = chosen.iter().copied().filter(|p| !has(&getter_name(p))).collect();
        let setters: Vec<&Property> =
            chosen.iter().copied().filter(|p| !p.is_readonly && !has(&setter_name(p))).collect();
        let what = |plural: &str, singular: &str| match touched {
            [one] => format!("{singular} for '${}'", one.name),
            _ => plural.to_owned(),
        };
        let mut out = Vec::new();
        if !getters.is_empty() {
            out.extend(self.accessor_action(what("Generate getters", "Generate getter"), &getters, &[]));
        }
        if !setters.is_empty() {
            out.extend(self.accessor_action(what("Generate setters", "Generate setter"), &[], &setters));
        }
        if !getters.is_empty() && !setters.is_empty() {
            out.extend(self.accessor_action(
                what("Generate getters and setters", "Generate getter and setter"),
                &getters,
                &setters,
            ));
        }
        out
    }

    fn accessor_action(&self, title: String, getters: &[&Property], setters: &[&Property]) -> Option<ImportAction> {
        let mut edits = Edits::default();
        let mut methods = Vec::new();
        let void = if self.level >= PhpVersion::new(7, 1) { ": void" } else { "" };
        for property in &self.class.properties {
            let target = |p: &&Property| p.loc == property.loc && p.name == property.name;
            let (getter, setter) = (getters.iter().any(target), setters.iter().any(target));
            if !getter && !setter {
                continue;
            }
            let ty = property.type_hint.as_ref().map(|hint| self.hint(hint, self.class, &mut edits.imports));
            let static_word = if property.is_static { " static" } else { "" };
            let access = if property.is_static {
                format!("self::${}", property.name)
            } else {
                format!("$this->{}", property.name)
            };
            if getter {
                let ret = ty.as_ref().map(|ty| format!(": {ty}")).unwrap_or_default();
                let header = format!("public{static_word} function {}(){ret}", getter_name(property));
                methods.push((header, vec![format!("return {access};")]));
            }
            if setter {
                let param = match &ty {
                    Some(ty) => format!("{ty} ${}", property.name),
                    None => format!("${}", property.name),
                };
                let header = format!("public{static_word} function {}({param}){void}", setter_name(property));
                methods.push((header, vec![format!("{access} = ${};", property.name)]));
            }
        }
        self.add_methods(&mut edits, &methods)?;
        self.action(title, GENERATE_ACCESSORS, edits)
    }

    // ---------------------------------------------------------- PHPDoc

    fn property_doc(&self, property: &Property) -> Option<ImportAction> {
        let text = self.text;
        if property.is_promoted
            || doc_start(text, property.loc.start) != property.loc.start
            || !starts_line(text, property.loc.start)
        {
            return None;
        }
        let scope = self.names.scope_at(property.loc.start);
        let ty = match (&property.type_hint, &property.default_type) {
            (Some(hint), _) => Type::from_hint(hint),
            (None, Some(lazy)) => self.engine.resolver().resolve(lazy, &Context::in_class(&self.class.fqn)).widen(),
            (None, None) => Type::Mixed,
        };
        let indent = line_indent(text, property.loc.start);
        let new_text = format!("/** @var {} */{}{indent}", doc_type(&ty, scope), self.nl);
        let at = property.loc.start;
        let index = self.parsed.line_index();
        Some(ImportAction {
            title: "Generate PHPDoc".into(),
            kind: REWRITE,
            preferred: false,
            edit: file_edit(self.path, vec![TextEdit { range: index.range(at, at), new_text }]),
        })
    }
}
