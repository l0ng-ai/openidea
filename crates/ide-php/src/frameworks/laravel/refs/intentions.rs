//! Laravel's context actions (`refactor.rewrite`) in PHP, after the
//! intentions IntelliJ documents for Laravel; the rules are our own:
//!
//! - **Convert alias 'Route' to facade import**: on a class name that is one
//!   of Laravel's global aliases (`Facade::defaultAliases()`: `\Route`,
//!   `Str` outside a namespace), imports the class behind it and writes the
//!   short name, for every use of the alias in the namespace.
//! - **Inject … instead of facade '…'**: on a static call on a facade
//!   (`View::make()`), replaces the facade's calls with calls on the service
//!   its `getFacadeAccessor()` names (`Illuminate\View\Factory`), injected
//!   through the constructor (a promoted property, `$this->view->make()`,
//!   in every instance method of the class) or, in a controller action or
//!   a console command's `handle()`, through the method (`$view->make()`).
//!   The facade's `use` goes when nothing else names it.
//! - **Move '$x' to the constructor**: on a class-typed parameter of a
//!   controller action (not a model, which is route-bound, nor a request),
//!   removes it, adds a promoted constructor property and rewrites `$x` as
//!   `$this->x` in the method.
//! - **Convert controller string to array callable**: `'PostController@index'`
//!   in a route becomes `[PostController::class, 'index']` (importing the
//!   controller), for one or every one in the file.
//! - **Convert scope to #[Scope] method**: on a `scopePublished()` method of
//!   a model, with Laravel 12's `Illuminate\Database\Eloquent\Attributes\Scope`
//!   installed: renames it `published()`, makes it protected and adds the
//!   attribute (imported), for one or every scope of the class.
//!
//! Constructor injection needs PHP 8.0 (promotion; `readonly` from 8.1)
//! and a class without an inherited constructor, or with its own.

use std::path::Path;

use mago_syntax::cst::{MethodBody, Node};

use super::controller_action::ControllerAction;
use super::validation_actions::{class_name, path_to, span};
use super::{ReferenceKind, kind_of, sites};
use crate::engine::PhpEngine;
use crate::imports::{ImportAction, REWRITE, import_insertion, removal};
use crate::inspect::fixes::{MemberKind, insert_member, line_indent, line_start, newline, starts_line};
use crate::names::{FileNames, NameKind, NameRole, ResolvedName};
use crate::navigate::enclosing_class;
use crate::refactor::hierarchy::doc_start;
use crate::stubs::PhpVersion;
use crate::summary::{ClassKind, ClassLike, FileSummary, Method, Visibility};
use crate::syntax::ParsedFile;
use crate::types::provider::laravel::{LaravelProvider, SCOPE_ATTRIBUTE, scope_name};

const FACADE: &str = "Illuminate\\Support\\Facades\\Facade";
const FACADES: &str = "Illuminate\\Support\\Facades\\";
const MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";
const SYMFONY_REQUEST: &str = "Symfony\\Component\\HttpFoundation\\Request";
const COMMAND: &str = "Illuminate\\Console\\Command";
const ROUTING_CONTROLLER: &str = "Illuminate\\Routing\\Controller";

/// Laravel's global class aliases (`Facade::defaultAliases()` of Laravel
/// 11/12, MIT) and the classes they stand for.
const ALIASES: &[(&str, &str)] = &[
    ("App", "Illuminate\\Support\\Facades\\App"),
    ("Arr", "Illuminate\\Support\\Arr"),
    ("Artisan", "Illuminate\\Support\\Facades\\Artisan"),
    ("Auth", "Illuminate\\Support\\Facades\\Auth"),
    ("Blade", "Illuminate\\Support\\Facades\\Blade"),
    ("Broadcast", "Illuminate\\Support\\Facades\\Broadcast"),
    ("Bus", "Illuminate\\Support\\Facades\\Bus"),
    ("Cache", "Illuminate\\Support\\Facades\\Cache"),
    ("Concurrency", "Illuminate\\Support\\Facades\\Concurrency"),
    ("Config", "Illuminate\\Support\\Facades\\Config"),
    ("Context", "Illuminate\\Support\\Facades\\Context"),
    ("Cookie", "Illuminate\\Support\\Facades\\Cookie"),
    ("Crypt", "Illuminate\\Support\\Facades\\Crypt"),
    ("Date", "Illuminate\\Support\\Facades\\Date"),
    ("DB", "Illuminate\\Support\\Facades\\DB"),
    ("Eloquent", "Illuminate\\Database\\Eloquent\\Model"),
    ("Event", "Illuminate\\Support\\Facades\\Event"),
    ("File", "Illuminate\\Support\\Facades\\File"),
    ("Gate", "Illuminate\\Support\\Facades\\Gate"),
    ("Hash", "Illuminate\\Support\\Facades\\Hash"),
    ("Http", "Illuminate\\Support\\Facades\\Http"),
    ("Js", "Illuminate\\Support\\Js"),
    ("Lang", "Illuminate\\Support\\Facades\\Lang"),
    ("Log", "Illuminate\\Support\\Facades\\Log"),
    ("Mail", "Illuminate\\Support\\Facades\\Mail"),
    ("Notification", "Illuminate\\Support\\Facades\\Notification"),
    ("Number", "Illuminate\\Support\\Number"),
    ("Password", "Illuminate\\Support\\Facades\\Password"),
    ("Process", "Illuminate\\Support\\Facades\\Process"),
    ("Queue", "Illuminate\\Support\\Facades\\Queue"),
    ("RateLimiter", "Illuminate\\Support\\Facades\\RateLimiter"),
    ("Redirect", "Illuminate\\Support\\Facades\\Redirect"),
    ("Request", "Illuminate\\Support\\Facades\\Request"),
    ("Response", "Illuminate\\Support\\Facades\\Response"),
    ("Route", "Illuminate\\Support\\Facades\\Route"),
    ("Schedule", "Illuminate\\Support\\Facades\\Schedule"),
    ("Schema", "Illuminate\\Support\\Facades\\Schema"),
    ("Session", "Illuminate\\Support\\Facades\\Session"),
    ("Storage", "Illuminate\\Support\\Facades\\Storage"),
    ("Str", "Illuminate\\Support\\Str"),
    ("URL", "Illuminate\\Support\\Facades\\URL"),
    ("Uri", "Illuminate\\Support\\Uri"),
    ("Validator", "Illuminate\\Support\\Facades\\Validator"),
    ("View", "Illuminate\\Support\\Facades\\View"),
    ("Vite", "Illuminate\\Support\\Facades\\Vite"),
];

type Edits = Vec<(u32, u32, String)>;

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

/// The variable a service of facade `name` gets: `View` → `view`, `DB` →
/// `db`.
fn variable_for(name: &str) -> String {
    if name.chars().all(|c| !c.is_lowercase()) {
        return name.to_ascii_lowercase();
    }
    let mut chars = name.chars();
    chars.next().map(|first| first.to_lowercase().chain(chars).collect()).unwrap_or_default()
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// After a class name ending at `end`, `::method(`: the byte after `::` and
/// the blanks following it.
fn static_call_after(text: &str, end: u32) -> Option<u32> {
    let rest = &text[end as usize..];
    let after_colons = rest.trim_start().strip_prefix("::")?;
    let method = after_colons.trim_start();
    let len = method.find(|c: char| !is_word(c)).unwrap_or(method.len());
    if len == 0 || method[..len].eq_ignore_ascii_case("class") || !method[len..].trim_start().starts_with('(') {
        return None;
    }
    Some(end + (rest.len() - method.len()) as u32)
}

/// Whether `$name` (with the `$`) occurs in `text` as a whole variable.
fn mentions_variable(text: &str, variable: &str) -> bool {
    text.match_indices(variable).any(|(at, _)| !text[at + variable.len()..].starts_with(is_word))
}

/// A nested scope of a method: a closure (whose body sees only what it
/// captures), an arrow function, or an anonymous class (another `$this`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Inner {
    Closure { is_static: bool },
    Arrow { is_static: bool },
    Class,
}

fn each_node<'ast, 'arena>(node: Node<'ast, 'arena>, f: &mut impl FnMut(Node<'ast, 'arena>)) {
    f(node);
    for child in node.children() {
        each_node(child, f);
    }
}

/// The closures, arrow functions and anonymous classes of `parsed`.
fn inner_scopes(parsed: &ParsedFile) -> Vec<(u32, u32, Inner)> {
    let mut out = Vec::new();
    each_node(Node::Program(parsed.program()), &mut |node| {
        let found = match node {
            Node::Closure(closure) => Some((span(closure), Inner::Closure { is_static: closure.r#static.is_some() })),
            Node::ArrowFunction(arrow) => Some((span(arrow), Inner::Arrow { is_static: arrow.r#static.is_some() })),
            Node::AnonymousClass(class) => Some((span(class), Inner::Class)),
            _ => None,
        };
        if let Some(((start, end), inner)) = found {
            out.push((start, end, inner));
        }
    });
    out
}

/// Whether `at` lies in a nested scope of `inner` that `bad` refuses.
fn inside(scopes: &[(u32, u32, Inner)], at: u32, bad: impl Fn(Inner) -> bool) -> bool {
    scopes.iter().any(|(start, end, inner)| *start <= at && at < *end && bad(*inner))
}

/// Class-like references in `from..to` that name `fqn`.
fn references<'n>(
    names: &'n FileNames,
    fqn: &'n str,
    from: u32,
    to: u32,
) -> impl Iterator<Item = &'n ResolvedName> + 'n {
    names.names().iter().filter(move |name| {
        name.kind == NameKind::ClassLike
            && name.role == NameRole::Reference
            && from <= name.start
            && name.end <= to
            && name.resolution.matches(NameKind::ClassLike, fqn)
    })
}

/// The `use` statement importing only `fqn`, from `use` through `;`.
fn sole_import(text: &str, names: &FileNames, fqn: &str) -> Option<(u32, u32)> {
    let import = names.names().iter().find(|name| {
        name.kind == NameKind::ClassLike
            && name.role == NameRole::Import
            && name.resolution.matches(NameKind::ClassLike, fqn)
    })?;
    let from = line_start(text, import.start);
    let line_end = text[from as usize..].find('\n').map_or(text.len(), |at| from as usize + at);
    let line = text[from as usize..line_end].trim_end();
    let statement = line.trim_start();
    if !statement.starts_with("use ") || !statement.ends_with(';') || statement.contains([',', '{']) {
        return None;
    }
    let start = from + (line.len() - statement.len()) as u32;
    Some((start, from + line.len() as u32))
}

impl PhpEngine {
    /// The Laravel context actions at bytes `start..end` of `parsed` (see
    /// the module documentation). Empty outside Laravel projects.
    pub(crate) fn laravel_intentions(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        start: u32,
        end: u32,
    ) -> Vec<ImportAction> {
        if self.ref_context().is_none() {
            return Vec::new();
        }
        let names = FileNames::resolve(parsed);
        let summary = FileSummary::extract(parsed);
        let mut out = Vec::new();
        out.extend(self.alias_import(parsed, path, &names, start));
        out.extend(self.facade_injection(parsed, path, &names, &summary, start, end));
        out.extend(self.move_to_constructor(parsed, path, &names, &summary, start, end));
        out.extend(self.controller_strings(parsed, path, &names, start, end));
        out.extend(self.attribute_scopes(parsed, path, &names, &summary, start));
        out
    }

    fn rewrite(title: String, parsed: &ParsedFile, path: &Path, edits: Edits) -> ImportAction {
        ImportAction { title, kind: REWRITE, preferred: false, edit: Self::byte_edit(parsed, path, edits) }
    }

    /// The edit importing `fqn` for a name at `at`, unless already added.
    fn import_once(parsed: &ParsedFile, at: u32, fqn: Option<String>, added: &mut Vec<String>, edits: &mut Edits) {
        let Some(fqn) = fqn else { return };
        if added.iter().any(|known| known.eq_ignore_ascii_case(&fqn)) {
            return;
        }
        let (at, line) = import_insertion(parsed, at, NameKind::ClassLike, &fqn);
        edits.push((at, at, line));
        added.push(fqn);
    }

    // ------------------------------------------------------------ aliases

    /// "Convert alias 'Route' to facade import".
    fn alias_import(&self, parsed: &ParsedFile, path: &Path, names: &FileNames, start: u32) -> Option<ImportAction> {
        let name = names
            .at_offset(start)
            .filter(|name| name.kind == NameKind::ClassLike && name.role == NameRole::Reference)?;
        let alias = name.resolution.primary()?.trim_start_matches('\\');
        if alias.contains('\\') || self.declares(NameKind::ClassLike, alias) {
            return None;
        }
        let (alias, target) = *ALIASES.iter().find(|(known, _)| known.eq_ignore_ascii_case(alias))?;
        self.resolver().class_model(target)?;
        let namespace = names.scope_at(name.start).namespace().to_owned();
        let (written, import) = class_name(self, names, name.start, target);
        let mut edits: Edits = names
            .names()
            .iter()
            .filter(|other| {
                other.kind == NameKind::ClassLike
                    && other.role == NameRole::Reference
                    && other
                        .resolution
                        .primary()
                        .is_some_and(|p| p.trim_start_matches('\\').eq_ignore_ascii_case(alias))
                    && names.scope_at(other.start).namespace() == namespace
            })
            .map(|other| (other.start, other.end, written.clone()))
            .collect();
        Self::import_once(parsed, name.start, import, &mut Vec::new(), &mut edits);
        let what = if target.starts_with(FACADES) { "facade" } else { "class" };
        Some(Self::rewrite(format!("Convert alias '{alias}' to {what} import"), parsed, path, edits))
    }

    // ------------------------------------------------------------ facades

    /// "Inject 'Factory' instead of facade 'View' (constructor)" and
    /// "(method parameter)".
    fn facade_injection(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        names: &FileNames,
        summary: &FileSummary,
        start: u32,
        end: u32,
    ) -> Vec<ImportAction> {
        let text = parsed.text();
        let nodes = path_to(Node::Program(parsed.program()), start, end);
        let Some(call) = nodes.iter().rev().find_map(|node| match node {
            Node::StaticMethodCall(call) => Some(*call),
            _ => None,
        }) else {
            return Vec::new();
        };
        let Some(name) = names
            .at_offset(span(call.class).0)
            .filter(|name| name.kind == NameKind::ClassLike && name.role == NameRole::Reference)
        else {
            return Vec::new();
        };
        let resolver = self.resolver();
        let Some(facade) = name
            .resolution
            .primary()
            .and_then(|fqn| resolver.class_model(fqn.trim_start_matches('\\')))
            .filter(|model| model.fqn() != FACADE && model.is_subclass_of(FACADE))
        else {
            return Vec::new();
        };
        let facade = facade.fqn().to_owned();
        let Some(service) = LaravelProvider::facade_class(&resolver, &facade) else { return Vec::new() };
        let Some(class) = enclosing_class(summary, start).filter(|class| class.kind == ClassKind::Class) else {
            return Vec::new();
        };
        let Some(method) = class.methods.iter().find(|m| m.loc.start <= start && end <= m.loc.end && !m.is_static)
        else {
            return Vec::new();
        };
        let scopes = inner_scopes(parsed);
        let variable = variable_for(short(&facade));
        let (type_text, import) = class_name(self, names, class.loc.start, &service);
        let service_short = short(&service);
        let facade_short = short(&facade);
        let mut out = Vec::new();

        // Through the constructor: the calls of every instance method.
        let calls: Vec<(u32, u32)> = class
            .methods
            .iter()
            .filter(|m| !m.is_static)
            .flat_map(|m| references(names, &facade, m.loc.start, m.loc.end))
            .filter(|name| {
                !inside(&scopes, name.start, |inner| {
                    matches!(
                        inner,
                        Inner::Class | Inner::Closure { is_static: true } | Inner::Arrow { is_static: true }
                    )
                })
            })
            .filter_map(|name| static_call_after(text, name.end).map(|after| (name.start, after)))
            .collect();
        let taken = resolver.class_model(&class.fqn).is_some_and(|model| model.property(&variable).is_some());
        if self.language_level() >= PhpVersion::new(8, 0)
            && !taken
            && calls.iter().any(|(at, _)| *at == name.start)
            && let Some(ctor) =
                self.constructor_param(text, class, &format!("{}{type_text} ${variable}", self.promoted()))
        {
            let mut edits: Edits =
                calls.iter().map(|(from, to)| (*from, *to, format!("$this->{variable}->"))).collect();
            edits.push(ctor);
            edits.extend(Self::facade_imports(
                parsed,
                names,
                &facade,
                calls.len(),
                &service,
                import.clone(),
                class.loc.start,
            ));
            out.push(Self::rewrite(
                format!("Inject '{service_short}' instead of facade '{facade_short}' (constructor)"),
                parsed,
                path,
                edits,
            ));
        }

        // Through the method: where the container calls it.
        let injectable = self.is_controller(class) && method.visibility == Visibility::Public
            || method.name.eq_ignore_ascii_case("handle")
                && resolver.class_model(&class.fqn).is_some_and(|model| model.is_subclass_of(COMMAND));
        let method_text = &text[method.loc.start as usize..method.loc.end as usize];
        if injectable && method.name != "__construct" && !mentions_variable(method_text, &format!("${variable}")) {
            let calls: Vec<(u32, u32)> = references(names, &facade, method.loc.start, method.loc.end)
                .filter(|name| {
                    !inside(&scopes, name.start, |inner| matches!(inner, Inner::Class | Inner::Closure { .. }))
                })
                .filter_map(|name| static_call_after(text, name.end).map(|after| (name.start, after)))
                .collect();
            if calls.iter().any(|(at, _)| *at == name.start)
                && let Some(param) = Self::first_param(text, method, &format!("{type_text} ${variable}"))
            {
                let mut edits: Edits = calls.iter().map(|(from, to)| (*from, *to, format!("${variable}->"))).collect();
                edits.push(param);
                edits.extend(Self::facade_imports(
                    parsed,
                    names,
                    &facade,
                    calls.len(),
                    &service,
                    import,
                    class.loc.start,
                ));
                out.push(Self::rewrite(
                    format!("Inject '{service_short}' instead of facade '{facade_short}' (method parameter)"),
                    parsed,
                    path,
                    edits,
                ));
            }
        }
        out
    }

    /// The service's import (for a name at `at`), in place of the facade's
    /// when no other use of the facade remains (`replaced` of them are).
    fn facade_imports(
        parsed: &ParsedFile,
        names: &FileNames,
        facade: &str,
        replaced: usize,
        service: &str,
        import: Option<String>,
        at: u32,
    ) -> Edits {
        let text = parsed.text();
        let remaining = references(names, facade, 0, u32::MAX).count() > replaced;
        let old = if remaining { None } else { sole_import(text, names, facade) };
        let mut edits = Edits::new();
        match (old, import) {
            (Some((from, to)), Some(_)) => edits.push((from, to, format!("use {service};"))),
            (Some((from, to)), None) => {
                let (from, to) = removal(text, from, to);
                edits.push((from, to, String::new()));
            }
            (None, import) => Self::import_once(parsed, at, import, &mut Vec::new(), &mut edits),
        }
        edits
    }

    /// `private readonly ` (or `private ` before PHP 8.1).
    fn promoted(&self) -> &'static str {
        if self.language_level() >= PhpVersion::new(8, 1) { "private readonly " } else { "private " }
    }

    /// A controller: named `…Controller`, in an `Http\Controllers`
    /// namespace, or extending Laravel's.
    fn is_controller(&self, class: &ClassLike) -> bool {
        short(&class.fqn).ends_with("Controller")
            || class.fqn.contains("\\Http\\Controllers\\")
            || self.resolver().class_model(&class.fqn).is_some_and(|model| model.is_subclass_of(ROUTING_CONTROLLER))
    }

    /// The edit adding parameter `declaration` to the class's constructor,
    /// or a constructor taking it (before the first method). `None` when the
    /// class inherits a constructor it would have to call.
    fn constructor_param(&self, text: &str, class: &ClassLike, declaration: &str) -> Option<(u32, u32, String)> {
        let nl = newline(text);
        if let Some(ctor) = class.method("__construct") {
            return match ctor.params.last() {
                Some(last) if starts_line(text, last.loc.start) => {
                    let indent = line_indent(text, last.loc.start);
                    let rest = &text[last.loc.end as usize..];
                    let trimmed = rest.trim_start();
                    if trimmed.starts_with(',') {
                        let at = last.loc.end + (rest.len() - trimmed.len()) as u32 + 1;
                        Some((at, at, format!("{nl}{indent}{declaration},")))
                    } else {
                        Some((last.loc.end, last.loc.end, format!(",{nl}{indent}{declaration}")))
                    }
                }
                Some(last) => Some((last.loc.end, last.loc.end, format!(", {declaration}"))),
                None => {
                    let open = ctor.name_loc.end + text[ctor.name_loc.end as usize..].find('(')? as u32;
                    Some((open + 1, open + 1, declaration.to_owned()))
                }
            };
        }
        if self.resolver().class_model(&class.fqn).is_some_and(|model| model.method("__construct").is_some()) {
            return None;
        }
        let render = |indent: &str| format!("public function __construct({declaration}){nl}{indent}{{{nl}{indent}}}");
        let first = class.methods.iter().map(|m| doc_start(text, m.loc.start)).min();
        match first {
            Some(at) if starts_line(text, at) => {
                let indent = line_indent(text, at);
                let from = line_start(text, at);
                Some((from, from, format!("{indent}{}{nl}{nl}", render(indent))))
            }
            _ => insert_member(text, class, MemberKind::Method, render),
        }
    }

    /// The edit adding parameter `declaration` first in `method`'s list.
    fn first_param(text: &str, method: &Method, declaration: &str) -> Option<(u32, u32, String)> {
        match method.params.first() {
            Some(first) if starts_line(text, first.loc.start) => {
                let indent = line_indent(text, first.loc.start);
                let from = line_start(text, first.loc.start);
                Some((from, from, format!("{indent}{declaration},{}", newline(text))))
            }
            Some(first) => Some((first.loc.start, first.loc.start, format!("{declaration}, "))),
            None => {
                let open = method.name_loc.end + text[method.name_loc.end as usize..].find('(')? as u32;
                Some((open + 1, open + 1, declaration.to_owned()))
            }
        }
    }

    // -------------------------------------------------- method parameter

    /// "Move '$x' to the constructor".
    fn move_to_constructor(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        names: &FileNames,
        summary: &FileSummary,
        start: u32,
        end: u32,
    ) -> Option<ImportAction> {
        if self.language_level() < PhpVersion::new(8, 0) {
            return None;
        }
        let text = parsed.text();
        let nodes = path_to(Node::Program(parsed.program()), start, end);
        let method_node = nodes.iter().rev().find_map(|node| match node {
            Node::Method(method) => Some(*method),
            _ => None,
        })?;
        let parameters: Vec<_> = method_node.parameter_list.parameters.iter().collect();
        let index = parameters.iter().position(|param| {
            let (from, to) = span(*param);
            from <= start && end <= to
        })?;
        let param = parameters[index];
        if param.ampersand.is_some()
            || param.ellipsis.is_some()
            || param.default_value.is_some()
            || !param.modifiers.is_empty()
            || param.hooks.is_some()
        {
            return None;
        }
        let (hint_start, hint_end) = span(param.hint.as_ref()?);
        let hint =
            names.at_offset(hint_start).filter(|name| name.end == hint_end && name.kind == NameKind::ClassLike)?;
        let resolver = self.resolver();
        let dependency = resolver.class_model(hint.resolution.primary()?.trim_start_matches('\\'))?;
        if dependency.is_subclass_of(MODEL) || dependency.is_subclass_of(SYMFONY_REQUEST) {
            return None;
        }
        let class = enclosing_class(summary, start).filter(|class| class.kind == ClassKind::Class)?;
        let method = class.methods.iter().find(|m| m.name_loc.start == span(&method_node.name).0)?;
        if method.is_static || method.name.eq_ignore_ascii_case("__construct") || !self.is_controller(class) {
            return None;
        }
        let name = String::from_utf8_lossy(param.variable.name).into_owned();
        let bare = name.trim_start_matches('$').to_owned();
        if resolver.class_model(&class.fqn).is_some_and(|model| model.property(&bare).is_some()) {
            return None;
        }
        let MethodBody::Concrete(body) = &method_node.body else { return None };
        let body_text = &text[span(body).0 as usize..span(body).1 as usize];
        if body_text.contains("compact(") || body_text.contains("get_defined_vars") {
            return None;
        }
        let scopes = inner_scopes(parsed);
        let mut uses = Vec::new();
        let mut refused = false;
        each_node(Node::Block(body), &mut |node| {
            if let Node::DirectVariable(variable) = node
                && variable.name == param.variable.name
            {
                let (from, to) = span(variable);
                let after = text[to as usize..].trim_start();
                let before = text[..from as usize].trim_end();
                let assigned = (after.starts_with('=') && !after.starts_with("==") && !after.starts_with("=>"))
                    || ["+=", "-=", ".=", "*=", "/=", "??=", "++", "--"].iter().any(|op| after.starts_with(op));
                let rebound = before.ends_with('&')
                    || before.ends_with("++")
                    || before.ends_with("--")
                    || before.ends_with(" as")
                    || before.ends_with("global")
                    || before.ends_with("static")
                    || before.ends_with("unset(");
                let nested = inside(&scopes, from, |inner| {
                    matches!(inner, Inner::Class | Inner::Closure { .. } | Inner::Arrow { is_static: true })
                });
                refused |= assigned || rebound || nested;
                uses.push((from, to));
            }
        });
        if refused {
            return None;
        }
        let type_text = &text[hint_start as usize..hint_end as usize];
        let ctor = self.constructor_param(text, class, &format!("{}{type_text} {name}", self.promoted()))?;
        let (from, to) = span(param);
        let removed = match (parameters.get(index + 1), index.checked_sub(1).map(|i| parameters[i])) {
            (Some(next), _) => (from, span(*next).0),
            (None, Some(previous)) => (span(previous).1, to),
            (None, None) => (from, to),
        };
        let mut edits: Edits = vec![(removed.0, removed.1, String::new()), ctor];
        edits.extend(uses.into_iter().map(|(from, to)| (from, to, format!("$this->{bare}"))));
        Some(Self::rewrite(format!("Move '{name}' to the constructor"), parsed, path, edits))
    }

    // ------------------------------------------------ controller strings

    /// "Convert controller string to array callable" and the one for every
    /// such string of the file.
    fn controller_strings(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        names: &FileNames,
        start: u32,
        end: u32,
    ) -> Vec<ImportAction> {
        let resolver = self.resolver();
        let convertible: Vec<(u32, u32, String, Option<String>)> = sites(parsed, &resolver, &[&ControllerAction], None)
            .into_iter()
            .filter(|site| {
                site.steps.is_empty()
                    && site.value.contains('@')
                    && kind_of(site, &resolver).is_some_and(|kind| kind.id() == "controllerAction")
            })
            .filter_map(|site| {
                let cx = self.site_context(path, &site)?;
                let canonical = ControllerAction.canonical(&cx, &site.value);
                let (class, method) = canonical.rsplit_once('@')?;
                if method.is_empty() || !method.chars().all(is_word) || resolver.class_model(class).is_none() {
                    return None;
                }
                let (written, import) = class_name(self, names, site.start, class);
                Some((site.start - 1, site.end + 1, format!("[{written}::class, '{method}']"), import))
            })
            .collect();
        let Some(at) = convertible.iter().position(|(from, to, _, _)| *from <= start && end <= *to) else {
            return Vec::new();
        };
        let edits = |chosen: &[&(u32, u32, String, Option<String>)]| {
            let mut edits = Edits::new();
            let mut imports: Vec<(String, u32)> = Vec::new();
            for (from, to, callable, import) in chosen {
                edits.push((*from, *to, callable.clone()));
                imports.extend(import.clone().map(|fqn| (fqn, *from)));
            }
            // Sorted, as they may go at the same place.
            imports.sort_by_key(|(fqn, _)| fqn.to_ascii_lowercase());
            let mut added = Vec::new();
            for (fqn, at) in imports {
                Self::import_once(parsed, at, Some(fqn), &mut added, &mut edits);
            }
            edits
        };
        let mut out = vec![Self::rewrite(
            "Convert controller string to array callable".to_owned(),
            parsed,
            path,
            edits(&[&convertible[at]]),
        )];
        if convertible.len() > 1 {
            let all: Vec<_> = convertible.iter().collect();
            out.push(Self::rewrite(
                "Convert all controller strings in file to array callables".to_owned(),
                parsed,
                path,
                edits(&all),
            ));
        }
        out
    }

    // ------------------------------------------------------------ scopes

    /// "Convert scope 'scopeX' to #[Scope] method" and the one for every
    /// scope of the model.
    fn attribute_scopes(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        names: &FileNames,
        summary: &FileSummary,
        start: u32,
    ) -> Vec<ImportAction> {
        let text = parsed.text();
        let resolver = self.resolver();
        let Some(class) = enclosing_class(summary, start) else { return Vec::new() };
        let Some(model) = resolver.class_model(&class.fqn).filter(|model| model.is_subclass_of(MODEL)) else {
            return Vec::new();
        };
        if resolver.class_model(SCOPE_ATTRIBUTE).is_none() {
            return Vec::new();
        }
        let convertible: Vec<(&Method, String)> = class
            .methods
            .iter()
            .filter(|method| !method.is_static && starts_line(text, method.loc.start))
            .filter_map(|method| {
                let rest = scope_name(&method.name)?;
                let mut chars = rest.chars();
                let name: String = chars.next()?.to_lowercase().chain(chars).collect();
                // Called by its method name elsewhere: left alone.
                let called = text.match_indices(method.name.as_str()).any(|(at, _)| {
                    at as u32 != method.name_loc.start && !text[at + method.name.len()..].starts_with(is_word)
                });
                (model.method(&name).is_none() && !called).then_some((method, name))
            })
            .collect();
        let header_end = |method: &Method| {
            text[method.name_loc.end as usize..method.loc.end as usize]
                .find('{')
                .map_or(method.loc.end, |at| method.name_loc.end + at as u32)
        };
        let Some(at) =
            convertible.iter().position(|(method, _)| method.loc.start <= start && start <= header_end(method))
        else {
            return Vec::new();
        };
        let (attribute, import) = class_name(self, names, class.loc.start, SCOPE_ATTRIBUTE);
        let nl = newline(text);
        let edits = |chosen: &[&(&Method, String)]| {
            let mut edits = Edits::new();
            for (method, name) in chosen {
                let header = &text[method.loc.start as usize..method.name_loc.start as usize];
                let visibility = ["public", "protected", "private"].iter().find_map(|word| {
                    header.match_indices(word).find(|(at, _)| {
                        !header[..*at].ends_with(is_word) && !header[at + word.len()..].starts_with(is_word)
                    })
                });
                match visibility {
                    Some((at, word)) => {
                        let at = method.loc.start + at as u32;
                        edits.push((at, at + word.len() as u32, "protected".to_owned()));
                    }
                    None => {
                        if let Some(at) = header.rfind("function") {
                            let at = method.loc.start + at as u32;
                            edits.push((at, at, "protected ".to_owned()));
                        }
                    }
                }
                edits.push((method.name_loc.start, method.name_loc.end, name.clone()));
                let from = line_start(text, method.loc.start);
                let indent = line_indent(text, method.loc.start);
                edits.push((from, from, format!("{indent}#[{attribute}]{nl}")));
            }
            Self::import_once(parsed, class.loc.start, import.clone(), &mut Vec::new(), &mut edits);
            edits
        };
        let (method, _) = &convertible[at];
        let mut out = vec![Self::rewrite(
            format!("Convert scope '{}' to #[Scope] method", method.name),
            parsed,
            path,
            edits(&[&convertible[at]]),
        )];
        if convertible.len() > 1 {
            let all: Vec<_> = convertible.iter().collect();
            out.push(Self::rewrite("Convert all scopes to #[Scope] methods".to_owned(), parsed, path, edits(&all)));
        }
        out
    }
}
