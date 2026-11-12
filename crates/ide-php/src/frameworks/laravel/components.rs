//! Blade components beyond the component folders (roadmap phase 8.25), as
//! Laravel's `BladeCompiler` and `ComponentTagCompiler` (MIT) find and
//! compile them:
//!
//! - **Registrations** in the service providers of the app, its modules
//!   and its packages ([`ComponentRegistrations`]):
//!   `Blade::component(Alert::class, 'alert', 'prefix')` (the alias guessed
//!   from the class when there is none), `Blade::components([...])`,
//!   `Blade::componentNamespace('Vendor\\Components', 'pkg')` (every class
//!   below the namespace is `<x-pkg::…>`),
//!   `Blade::anonymousComponentPath($dir, 'prefix')` and
//!   `Blade::anonymousComponentNamespace('flights.bookings', 'flights')`. A
//!   class component's view is also the one its `render()` names.
//! - **Variables in a component's view:** a class component's public
//!   properties (typed) and public methods (closures), and
//!   `$componentName` ([`PhpEngine::laravel_component_variables`]); the
//!   `@props` and `@aware` entries are declared by the compiler.
//! - **Slots:** `<x-slot:name>` and `<x-slot name="…">` complete and go to
//!   the variables the enclosing component's view echoes that are none of
//!   its props, attributes or data ([`PhpEngine::laravel_slot_names`]).
//! - **`<x-dynamic-component component="…">`:** the value completes and
//!   goes to components.
//! - **Problems:** a tag no component has (`BladeUndefinedComponent`, with
//!   "Create component" making its anonymous view), and a bound attribute
//!   (`:type="$x"`) whose value the class component's constructor parameter
//!   doesn't accept (`PhpParams`, the same check as PHP calls).
//! - **Quick-fixes** ([`PhpEngine::blade_quick_fixes`]): create the missing
//!   component or view, add an attribute an anonymous component doesn't
//!   declare to its `@props`, and one a class component's constructor
//!   doesn't take to its constructor (a promoted public parameter).
//! - **`@aware([...])`** in a component's view completes the props of the
//!   components whose tags enclose this one's in some template
//!   ([`PhpEngine::laravel_parent_components`]).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ops::Range as Span;
use std::path::{Path, PathBuf};

use ide_core::{CancellationToken, Diagnostic, FileEdit, Range, Severity, TextEdit, WorkspaceEdit};

use super::auth::{calls, class_name};
use super::blade::{BladeCatalog, BladeComponent, ComponentAttribute, class_files_with, kebab};
use super::livewire::rendered_view;
use super::parts::PartReader;
use super::providers::split_arrow;
use super::views::{call_arguments, is_blade, path_expression, provider_files, string_literal};
use super::{LaravelProject, ViewTable};
use crate::blade::structure::{self, DIAGNOSTIC_SOURCE, INSPECTIONS};
use crate::blade::tags::{
    DYNAMIC_COMPONENT, TagPlace, attribute_value_at, component_tags, enclosing_component, enclosing_components,
    is_builtin, tag_place,
};
use crate::blade::{BladeDocument, Compiled, NodeKind, camel, compile_full, parse};
use crate::complete::{Completion, CompletionKind, Completions};
use crate::engine::{EngineState, PhpEngine};
use crate::imports::{ImportAction, QUICKFIX, file_edit};
use crate::index::DeclKind;
use crate::inspect::InspectionContext;
use crate::inspect::calls::Check;
use crate::names::FileNames;
use crate::navigate::Target;
use crate::summary::{ClassKind, FileSummary, Visibility};
use crate::syntax::{LineIndex, ParsedFile};
use crate::types::{Context, ExprTypes, Type};

/// What one service provider registers with the `Blade` facade.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentRegistrations {
    /// `Blade::component(…)` and `Blade::components([...])`: `(tag, class)`.
    pub aliases: Vec<(String, String)>,
    /// `Blade::componentNamespace('Vendor\\Components', 'pkg')`: `(prefix, namespace)`.
    pub namespaces: Vec<(String, String)>,
    /// `Blade::anonymousComponentPath($dir, 'prefix')`.
    pub anonymous_paths: Vec<(Option<String>, PathBuf)>,
    /// `Blade::anonymousComponentNamespace('flights.bookings', 'flights')`:
    /// `(prefix, view folder)`, the folder dotted.
    pub anonymous_namespaces: Vec<(String, String)>,
}

/// Whether a written argument names a class (`Alert::class`, `'App\\Alert'`).
fn names_class(arg: &str) -> bool {
    arg.trim().ends_with("::class") || string_literal(arg).is_some_and(|value| value.contains('\\'))
}

/// The tag `Blade::component($class)` gives a class without an alias:
/// below `View\Components\` its segments in kebab case joined with `:`,
/// else its base name in kebab case.
pub fn default_alias(class: &str) -> String {
    match class.split_once("\\View\\Components\\") {
        Some((_, rest)) => rest.split('\\').map(kebab).collect::<Vec<_>>().join(":"),
        None => kebab(class.rsplit('\\').next().unwrap_or(class)),
    }
}

impl ComponentRegistrations {
    /// What the provider `path` (text `text`) of `project` registers.
    pub fn read(project: &LaravelProject, path: &Path, text: &str) -> Self {
        let mut out = Self::default();
        if !text.contains("Blade::") {
            return out;
        }
        let parsed = ParsedFile::parse("provider.php", text);
        let names = FileNames::resolve(&parsed);
        let alias = |class: &str, alias: Option<&str>, prefix: &str, open: usize, out: &mut Self| {
            // `component('alert', Alert::class)`: Laravel swaps them.
            let (class, alias) = match alias {
                Some(alias) if names_class(alias) && !names_class(class) => (alias, Some(class)),
                _ => (class, alias),
            };
            if !names_class(class) {
                return;
            }
            let Some(class) = class_name(&names, class, open).filter(|class| !class.is_empty()) else { return };
            let alias = match alias {
                Some(alias) if alias.trim() != "null" => match string_literal(alias) {
                    Some(alias) => alias,
                    None => return,
                },
                _ => default_alias(&class),
            };
            let tag = if prefix.is_empty() { alias } else { format!("{prefix}-{alias}") };
            out.aliases.push((tag, class));
        };
        for (open, args) in calls(text, "Blade::component(") {
            let Some(first) = args.first() else { continue };
            let prefix = args.get(2).and_then(|prefix| string_literal(prefix)).unwrap_or_default();
            alias(first, args.get(1).map(String::as_str), &prefix, open, &mut out);
        }
        for (open, args) in calls(text, "Blade::components(") {
            let Some(list) = args.first().filter(|list| list.starts_with('[')) else { continue };
            let prefix = args.get(1).and_then(|prefix| string_literal(prefix)).unwrap_or_default();
            for element in call_arguments(list, 0).unwrap_or_default() {
                match split_arrow(&element) {
                    Some((class, tag)) => alias(class, Some(tag), &prefix, open, &mut out),
                    None => alias(&element, None, &prefix, open, &mut out),
                }
            }
        }
        for (_, args) in calls(text, "Blade::componentNamespace(") {
            let (Some(namespace), Some(prefix)) =
                (args.first().and_then(|arg| string_literal(arg)), args.get(1).and_then(|arg| string_literal(arg)))
            else {
                continue;
            };
            let namespace = namespace.replace("\\\\", "\\").trim_matches('\\').to_owned();
            out.namespaces.push((prefix, namespace));
        }
        for (_, args) in calls(text, "Blade::anonymousComponentPath(") {
            let Some(dir) = args.first().and_then(|arg| path_expression(project, path, arg)) else { continue };
            out.anonymous_paths.push((args.get(1).and_then(|arg| string_literal(arg)), dir));
        }
        for (_, args) in calls(text, "Blade::anonymousComponentNamespace(") {
            let Some(directory) = args.first().and_then(|arg| string_literal(arg)) else { continue };
            let directory = directory.replace('/', ".").trim_matches('.').to_owned();
            let prefix = args.get(1).and_then(|arg| string_literal(arg)).unwrap_or_else(|| directory.clone());
            out.anonymous_namespaces.push((prefix, directory));
        }
        out
    }
}

/// The tag of an anonymous component's view from its path segments
/// (`card/index` and `card/card` are `card`), with `prefix::`.
fn anonymous_tag(prefix: Option<&str>, mut segments: Vec<&str>) -> String {
    let len = segments.len();
    if len > 1 && (segments[len - 1] == "index" || segments[len - 1] == segments[len - 2]) {
        segments.pop();
    }
    let prefix = prefix.map(|prefix| format!("{prefix}::")).unwrap_or_default();
    format!("{prefix}{}", segments.join("."))
}

impl BladeCatalog {
    /// This catalog with the components the service providers register
    /// (see the module documentation), each provider's registrations from
    /// `parts`; the components found already win. `class_file` finds a
    /// class's file, `namespace_classes` the classes below a namespace with
    /// their segments below it.
    pub fn with_registrations(
        mut self,
        project: &LaravelProject,
        views: &ViewTable,
        parts: &impl PartReader,
        class_file: impl Fn(&str) -> Option<PathBuf>,
        namespace_classes: impl Fn(&str) -> Vec<(Vec<String>, String, PathBuf)>,
    ) -> Self {
        let context = format!("{:?}", project.paths);
        let add = |components: &mut Vec<BladeComponent>, found: BladeComponent| {
            if !components.iter().any(|known| known.tag == found.tag) {
                components.push(found);
            }
        };
        let jobs: Vec<(PathBuf, String)> =
            provider_files(project).into_iter().map(|provider| (provider, context.clone())).collect();
        let found = parts
            .parts_of("blade-components", &jobs, &|at, text| ComponentRegistrations::read(project, &jobs[at].0, text));
        for part in found {
            let Some(part) = part else { continue };
            for (tag, class) in &part.aliases {
                let file = class_file(class).unwrap_or_default();
                let found = BladeComponent { tag: tag.clone(), class: Some((class.clone(), file)), view: None };
                add(&mut self.components, found);
            }
            for (prefix, namespace) in &part.namespaces {
                for (segments, class, file) in namespace_classes(namespace) {
                    let tag = format!("{prefix}::{}", segments.iter().map(|s| kebab(s)).collect::<Vec<_>>().join("."));
                    add(&mut self.components, BladeComponent { tag, class: Some((class, file)), view: None });
                }
            }
            for (prefix, dir) in &part.anonymous_paths {
                let files = parts.listing("blade-anonymous-components", dir, &|| {
                    let mut files = Vec::new();
                    class_files_with(dir, &mut Vec::new(), &mut files, ".blade.php");
                    files.into_iter().map(|(segments, path)| (segments.join("/"), path)).collect()
                });
                for (name, path) in files.iter() {
                    let tag = anonymous_tag(prefix.as_deref(), name.split('/').collect());
                    add(&mut self.components, BladeComponent { tag, class: None, view: Some(path.clone()) });
                }
            }
            for (prefix, directory) in &part.anonymous_namespaces {
                let head = format!("{directory}.");
                for view in views.views().iter().filter(|view| view.namespace().is_none()) {
                    let Some(rest) = view.local().strip_prefix(&head) else { continue };
                    let tag = anonymous_tag(Some(prefix), rest.split('.').collect());
                    add(&mut self.components, BladeComponent { tag, class: None, view: Some(view.path.clone()) });
                }
            }
        }
        self.components.sort_by(|a, b| a.tag.cmp(&b.tag));
        self.rendered_views(views, parts);
        self
    }

    /// Gives each class component without a view the one its `render()`
    /// names.
    pub(super) fn rendered_views(&mut self, views: &ViewTable, parts: &impl PartReader) {
        let mut targets: Vec<usize> = Vec::new();
        let mut jobs: Vec<(PathBuf, String)> = Vec::new();
        for (at, component) in self.components.iter().enumerate() {
            let Some((_, file)) = &component.class else { continue };
            if component.view.is_some() || file.as_os_str().is_empty() {
                continue;
            }
            targets.push(at);
            jobs.push((file.clone(), String::new()));
        }
        let found = parts.parts_of("component-render", &jobs, &|_, text| rendered_view(text));
        for (at, name) in targets.into_iter().zip(found) {
            let Some(name) = name else { continue };
            if let Some(view) = name.as_deref().and_then(|name| views.get(name)) {
                self.components[at].view = Some(view.path.clone());
            }
        }
    }
}

fn item(label: String, detail: Option<String>, kind: CompletionKind, replace: Range, tab: Range) -> Completion {
    Completion {
        sort_text: label.to_ascii_lowercase(),
        insert_text: label.clone(),
        label,
        label_detail: None,
        detail,
        kind,
        is_snippet: false,
        filter_text: None,
        replace,
        replace_tab: (tab != replace).then_some(tab),
        additional_edits: Vec::new(),
        deprecated: false,
        data: None,
    }
}

/// The view name an anonymous component `tag` would have (`pkg::a.b` →
/// `pkg::components.a.b`).
fn component_view_name(tag: &str) -> String {
    match tag.split_once("::") {
        Some((namespace, local)) => format!("{namespace}::components.{local}"),
        None => format!("components.{tag}"),
    }
}

/// The variable names `text`'s PHP assigns (`$x = …`, `as $x`, `as $k => $v`).
fn assigned_variables(code: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for (start, name) in variables_in(code) {
        let after = code[start + 1 + name.len()..].trim_start();
        let before = code[..start].trim_end();
        let assigns = after.starts_with('=') && !after.starts_with("==") && !after.starts_with("=>");
        if assigns || before.ends_with(" as") || before.ends_with("=>") && before.contains(" as ") {
            out.insert(name.to_owned());
        }
    }
    out
}

/// The `$name` variables of `code`: `(offset of the $, name)`.
fn variables_in(code: &str) -> Vec<(usize, &str)> {
    let b = code.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'$' && b.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') {
            let end = (i + 1..b.len()).find(|&at| !(b[at].is_ascii_alphanumeric() || b[at] == b'_')).unwrap_or(b.len());
            // Not a property (`$this->name` is fine, `->$name` is not ours).
            out.push((i, &code[i + 1..end]));
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

impl PhpEngine {
    /// The classes below namespace `namespace` the index knows, with their
    /// segments below it (`Forms`, `Input`) and their files.
    pub(crate) fn namespace_classes(&self, namespace: &str) -> Vec<(Vec<String>, String, PathBuf)> {
        let Some(index) = self.index() else { return Vec::new() };
        let mut out = Vec::new();
        let mut queue: Vec<(String, Vec<String>)> = vec![(namespace.trim_matches('\\').to_owned(), Vec::new())];
        while let Some((namespace, segments)) = queue.pop() {
            if segments.len() > 4 {
                continue;
            }
            for decl in index.namespace_children(&namespace).unwrap_or_default() {
                let mut found = segments.clone();
                found.push(decl.short_name().to_owned());
                match decl.kind {
                    DeclKind::Namespace => queue.push((decl.fqn.clone(), found)),
                    DeclKind::ClassLike(ClassKind::Class) => out.push((found, decl.fqn.clone(), decl.path())),
                    _ => {}
                }
            }
        }
        out.sort();
        out
    }

    /// The text of `path`: its open buffer, else the file on disk. An open
    /// template's embedded document holds its compiled PHP, not its text:
    /// the file on disk is read.
    pub(crate) fn current_text(&self, path: &Path) -> Option<String> {
        match self.open_document(path).filter(|document| !document.embedded) {
            Some(document) => Some(document.text.to_string()),
            None => std::fs::read_to_string(path).ok(),
        }
    }

    /// The class component whose view is the template `path`.
    pub fn laravel_component_of_view(&self, path: &Path) -> Option<BladeComponent> {
        let catalog = self.laravel_blade()?;
        let path = crate::project::normalize(path);
        catalog
            .components
            .iter()
            .find(|component| component.class.is_some() && component.view.as_deref() == Some(path.as_path()))
            .cloned()
    }

    /// The variables a class component gives its view `path` (`(name,
    /// type)`): its public properties with their types, its public methods
    /// as closures (Laravel's own and `render()` left out), and
    /// `$componentName`. Empty for other templates.
    pub fn laravel_component_variables(&self, path: &Path) -> Vec<(String, String)> {
        let Some(component) = self.laravel_component_of_view(path) else { return Vec::new() };
        let Some((class, _)) = &component.class else { return Vec::new() };
        let resolver = self.resolver();
        let Some(model) = resolver.class_model(class) else { return Vec::new() };
        let own = |declaring: &str| {
            let declaring = declaring.trim_start_matches('\\');
            !declaring.get(..11).is_some_and(|head| head.eq_ignore_ascii_case("Illuminate\\"))
        };
        let context = Context { self_class: Some(class.clone()), static_type: None };
        let receiver = Type::named(class);
        let mut out: Vec<(String, String)> = Vec::new();
        for property in model.properties.iter() {
            if property.visibility != Visibility::Public || property.is_static || !own(&property.declaring.fqn) {
                continue;
            }
            let ty = resolver.property_type(&receiver, &property.name, &context);
            out.push((property.name.clone(), ty.to_string()));
        }
        for method in model.methods.iter() {
            let name = method.name.as_str();
            if method.visibility != Visibility::Public
                || method.is_static
                || !own(&method.declaring.fqn)
                || name.starts_with("__")
                || ["render", "shouldRender", "data", "resolveView"].iter().any(|skip| skip.eq_ignore_ascii_case(name))
                || out.iter().any(|(known, _)| known == name)
            {
                continue;
            }
            out.push((method.name.clone(), "\\Closure".to_owned()));
        }
        out.push(("componentName".to_owned(), "string".to_owned()));
        out
    }

    /// The template `path` (text `text`) compiled to PHP: with the
    /// variables its callers pass it and, for a class component's view,
    /// those of the component; with `$attributes` and `$slot` in component
    /// views; with the project's custom directives and class components.
    pub(crate) fn blade_compile(&self, path: &Path, text: &str) -> Compiled {
        let catalog = self.laravel_blade();
        let own = crate::project::normalize(path);
        let is_component = catalog
            .as_ref()
            .is_some_and(|catalog| catalog.components.iter().any(|known| known.view.as_deref() == Some(own.as_path())))
            || crate::blade::views::ViewPaths::new(&self.root()).is_component_view(path);
        let mut variables: Vec<(String, String)> = self.laravel_view_variables(path).as_ref().clone();
        for (name, ty) in self.laravel_component_variables(path) {
            if !variables.iter().any(|(known, _)| *known == name) {
                variables.push((name, ty));
            }
        }
        let custom = catalog.as_ref().map(|catalog| catalog.directive_names()).unwrap_or_default();
        let classes: Vec<(String, String)> = catalog
            .iter()
            .flat_map(|catalog| catalog.components.iter())
            .filter_map(|component| Some((component.tag.clone(), component.class.as_ref()?.0.clone())))
            .collect();
        compile_full(text, is_component, &variables, &custom, &classes)
    }

    /// The named slots component `component` takes: the variables its view
    /// uses that are none of its `@props`/`@aware` entries, constructor
    /// parameters, view data or variables the view assigns itself, each
    /// with its first use.
    pub fn laravel_slot_names(&self, component: &BladeComponent) -> Vec<ComponentAttribute> {
        let Some(view) = &component.view else { return Vec::new() };
        let Some(text) = self.current_text(view) else { return Vec::new() };
        let mut taken: HashSet<String> =
            ["attributes", "slot", "errors", "loop", "this", "componentName", "__env", "__data"]
                .iter()
                .map(|name| (*name).to_owned())
                .collect();
        taken.extend(structure::props(&text).into_iter().map(|prop| prop.name));
        taken.extend(structure::aware(&text).into_iter().map(|prop| prop.name));
        taken.extend(self.laravel_component_attributes(component).into_iter().map(|attribute| camel(&attribute.name)));
        taken.extend(self.laravel_component_variables(view).into_iter().map(|(name, _)| name));
        taken.extend(self.laravel_view_variables(view).iter().map(|(name, _)| name.clone()));
        let nodes = parse(&text);
        for node in &nodes {
            if let Some(code) = &node.code {
                taken.extend(assigned_variables(&text[code.start as usize..code.end as usize]));
            }
            if let NodeKind::Directive { name } = &node.kind
                && name == "error"
            {
                taken.insert("message".to_owned());
            }
        }
        let lines = LineIndex::new(&text);
        let mut out: Vec<ComponentAttribute> = Vec::new();
        for node in &nodes {
            let Some(code) = &node.code else { continue };
            if matches!(&node.kind, NodeKind::Directive { name } if name == "props" || name == "aware") {
                continue;
            }
            let piece = &text[code.start as usize..code.end as usize];
            for (at, name) in variables_in(piece) {
                if taken.contains(name) || out.iter().any(|known| known.name == name) {
                    continue;
                }
                let start = code.start + at as u32 + 1;
                let range = lines.range(start, start + name.len() as u32);
                out.push(ComponentAttribute {
                    name: name.to_owned(),
                    detail: Some(format!("slot · x-{}", component.tag)),
                    target: Some(Target { path: view.clone(), range }),
                });
            }
        }
        out
    }

    /// The components whose tags enclose a tag of `component` in some
    /// template of the project (`<x-menu><x-menu.item /></x-menu>` makes
    /// `menu` a parent of `menu.item`): whose data `@aware` reads.
    pub fn laravel_parent_components(&self, component: &BladeComponent) -> Vec<BladeComponent> {
        let (Some(catalog), Some(views)) = (self.laravel_blade(), self.laravel_views()) else { return Vec::new() };
        let mut names: Vec<String> = Vec::new();
        for view in views.views().iter().filter(|view| is_blade(&view.path)) {
            let Some(text) = self.current_text(&view.path) else { continue };
            if !text.contains(component.tag.as_str()) {
                continue;
            }
            for tag in component_tags(&text).iter().filter(|tag| tag.name(&text) == component.tag) {
                for parent in enclosing_components(&text, tag.start) {
                    if parent != component.tag && !names.contains(&parent) {
                        names.push(parent);
                    }
                }
            }
        }
        names.iter().filter_map(|name| catalog.component(name).cloned()).collect()
    }

    /// Completion of an entry of `@aware([...])` in a component's view: the
    /// props (and class components' constructor parameters) of the
    /// components whose tags enclose this one's somewhere, camel case, but
    /// not those the view lists already; `None` elsewhere.
    pub(super) fn aware_completion(
        &self,
        blade: &BladeDocument,
        offset: u32,
        lines: &LineIndex,
    ) -> Option<Completions> {
        let text = blade.text;
        let entries = structure::aware(text);
        let at = entries.iter().find(|entry| entry.span.start <= offset && offset <= entry.span.end)?;
        let catalog = self.laravel_blade()?;
        let own = crate::project::normalize(blade.path);
        let replace = lines.range(at.span.start, offset);
        let tab = lines.range(at.span.start, at.span.end);
        let listed: Vec<&str> =
            entries.iter().filter(|entry| entry.span != at.span).map(|entry| entry.name.as_str()).collect();
        let mut items: Vec<Completion> = Vec::new();
        for component in catalog.components.iter().filter(|component| component.view.as_deref() == Some(own.as_path()))
        {
            for parent in self.laravel_parent_components(component) {
                for attribute in self.laravel_component_attributes(&parent) {
                    let name = camel(&attribute.name);
                    if listed.contains(&name.as_str()) || items.iter().any(|known| known.label == name) {
                        continue;
                    }
                    let detail = match &attribute.detail {
                        Some(detail) => format!("{detail} · x-{}", parent.tag),
                        None => format!("x-{}", parent.tag),
                    };
                    items.push(item(name, Some(detail), CompletionKind::Property, replace, tab));
                }
            }
        }
        Some(Completions { items, incomplete: false })
    }

    /// The slots of the component whose body `offset` of `text` is in.
    fn enclosing_slots(&self, text: &str, offset: u32) -> Vec<ComponentAttribute> {
        let Some(catalog) = self.laravel_blade() else { return Vec::new() };
        let Some(tag) = enclosing_component(text, offset) else { return Vec::new() };
        catalog.component(&tag).map(|component| self.laravel_slot_names(component)).unwrap_or_default()
    }

    /// Completion of slot names (`<x-slot:|`, `<x-slot name="|">`) and of
    /// `<x-dynamic-component component="|">`; `None` elsewhere.
    pub(super) fn component_completion(
        &self,
        blade: &BladeDocument,
        offset: u32,
        lines: &LineIndex,
    ) -> Option<Completions> {
        let text = blade.text;
        let slot = |span: Span<u32>| {
            let replace = lines.range(span.start, offset);
            let tab = lines.range(span.start, span.end);
            let items = self
                .enclosing_slots(text, span.start)
                .into_iter()
                .map(|slot| item(slot.name, slot.detail, CompletionKind::Property, replace, tab))
                .collect();
            Some(Completions { items, incomplete: false })
        };
        if let Some(value) = attribute_value_at(text, offset, "slot", "name") {
            return slot(value);
        }
        if let Some(TagPlace::Name(span)) = tag_place(text, offset)
            && text[span.start as usize..span.end as usize].starts_with("slot:")
            && offset >= span.start + 5
        {
            return slot(span.start + 5..span.end);
        }
        let value = attribute_value_at(text, offset, DYNAMIC_COMPONENT, "component")?;
        let catalog = self.laravel_blade()?;
        let replace = lines.range(value.start, offset);
        let tab = lines.range(value.start, value.end);
        let items = catalog
            .components
            .iter()
            .map(|component| {
                let detail = component.class.as_ref().map(|(class, _)| class.clone());
                item(component.tag.clone(), detail, CompletionKind::Class, replace, tab)
            })
            .collect();
        Some(Completions { items, incomplete: false })
    }

    /// Goto from a slot name to its use in the component's view, and from
    /// the `component` of `<x-dynamic-component>` to the component; `None`
    /// elsewhere.
    pub(super) fn component_definition(&self, blade: &BladeDocument, offset: u32) -> Option<Vec<Target>> {
        let text = blade.text;
        let slot = |span: Span<u32>| {
            let written = &text[span.start as usize..span.end as usize];
            let found = self.enclosing_slots(text, span.start).into_iter().find(|slot| slot.name == written);
            Some(found.and_then(|slot| slot.target).into_iter().collect())
        };
        if let Some(value) = attribute_value_at(text, offset, "slot", "name") {
            return slot(value);
        }
        if let Some(TagPlace::Name(span)) = tag_place(text, offset)
            && text[span.start as usize..span.end as usize].starts_with("slot:")
        {
            return slot(span.start + 5..span.end);
        }
        let value = attribute_value_at(text, offset, DYNAMIC_COMPONENT, "component")?;
        let catalog = self.laravel_blade()?;
        let component = catalog.component(&text[value.start as usize..value.end as usize])?;
        Some(self.component_targets(component))
    }

    /// The class and view of `component`.
    pub(super) fn component_targets(&self, component: &BladeComponent) -> Vec<Target> {
        let mut targets = Vec::new();
        if let Some((class, path)) = &component.class {
            let range = self.resolver().class_model(class).map(|model| model.class.name_loc.range).unwrap_or_default();
            if !path.as_os_str().is_empty() {
                targets.push(Target { path: path.clone(), range });
            }
        }
        if let Some(view) = &component.view {
            targets.push(Target { path: view.clone(), range: Range::default() });
        }
        targets
    }

    /// `BladeUndefinedComponent`: the component tags of `text` no
    /// component has, once indexing finished and when the project has
    /// components. Slots, `<x-dynamic-component>` and tags in a namespace
    /// the project doesn't know (no component and no view has it) aren't
    /// reported.
    pub(crate) fn undefined_components(&self, text: &str) -> Vec<Diagnostic> {
        if self.status().state != EngineState::Ready {
            return Vec::new();
        }
        let Some(catalog) = self.laravel_blade() else { return Vec::new() };
        if catalog.components.is_empty() {
            return Vec::new();
        }
        let views = self.laravel_views();
        let lines = LineIndex::new(text);
        let mut out = Vec::new();
        for tag in component_tags(text) {
            let name = tag.name(text);
            if name.is_empty() || is_builtin(name) || catalog.component(name).is_some() {
                continue;
            }
            if let Some((prefix, _)) = name.split_once("::") {
                let head = format!("{prefix}::");
                let known = catalog.components.iter().any(|component| component.tag.starts_with(&head))
                    || views.as_ref().is_some_and(|views| views.namespace(prefix).is_some());
                if !known {
                    continue;
                }
            }
            out.push(Diagnostic {
                range: lines.range(tag.name.start, tag.name.end),
                severity: Severity::Warning,
                message: format!("Component 'x-{name}' is not defined"),
                source: Some(DIAGNOSTIC_SOURCE.into()),
                code: Some(INSPECTIONS[2].into()),
                unnecessary: false,
                deprecated: false,
                server: None,
            });
        }
        out
    }

    /// The template's problems ([`PhpEngine::blade_problems`]) and, as its
    /// file `path` gives the variables their types, the bound attributes of
    /// class components whose value the constructor parameter doesn't
    /// accept (`PhpParams`).
    pub fn blade_file_problems(&self, path: &Path, text: &str) -> Vec<Diagnostic> {
        let mut out = self.blade_problems(text);
        out.extend(self.attribute_type_problems(path, text));
        out.sort_by_key(|diagnostic| diagnostic.range.start);
        out
    }

    fn attribute_type_problems(&self, path: &Path, text: &str) -> Vec<Diagnostic> {
        if !self.inspections().ids().contains(&"PhpParams") || self.status().state != EngineState::Ready {
            return Vec::new();
        }
        let Some(catalog) = self.laravel_blade() else { return Vec::new() };
        let mut bound: Vec<Span<u32>> = Vec::new();
        for tag in component_tags(text) {
            if catalog.component(tag.name(text)).is_some_and(|component| component.class.is_some()) {
                bound.extend(tag.attributes.iter().filter_map(|attribute| attribute.bound_code(text)));
            }
        }
        if bound.is_empty() {
            return Vec::new();
        }
        let compiled = self.blade_compile(path, text);
        let parsed = ParsedFile::parse("template.php", compiled.php.as_str());
        let names = FileNames::resolve(&parsed);
        let summary = FileSummary::extract(&parsed);
        let resolver = self.resolver();
        let types = ExprTypes::new(&parsed, &names, &summary, &resolver);
        let cancel = CancellationToken::new();
        let path = crate::project::normalize(path);
        let cx = InspectionContext::new(self, &parsed, &path, &cancel, &types);
        let strict = self.shared_inspection_config().lock().mode("PhpParams") == crate::inspect::TypeCheckMode::Strict;
        let lines = LineIndex::new(text);
        let mut out = Vec::new();
        for found in cx.calls().iter().filter(|found| found.check == Check::Argument && (found.certain || strict)) {
            let (Some(start), Some(end)) = (compiled.blade_offset(found.start), compiled.blade_offset(found.end))
            else {
                continue;
            };
            if !bound.iter().any(|code| code.start <= start && end <= code.end) {
                continue;
            }
            out.push(Diagnostic {
                range: lines.range(start, end),
                severity: if found.certain { Severity::Error } else { Severity::Warning },
                message: found.message.clone(),
                source: Some(DIAGNOSTIC_SOURCE.into()),
                code: Some("PhpParams".into()),
                unnecessary: false,
                deprecated: false,
                server: None,
            });
        }
        out
    }

    /// The quick-fixes at `range` of a template of a Laravel project:
    /// "Create view" on an undefined view, "Create component" on an
    /// undefined component tag (its anonymous view), and "Add … to @props"
    /// on an attribute an anonymous component doesn't declare.
    pub fn blade_quick_fixes(&self, blade: &BladeDocument, range: Range) -> Vec<ImportAction> {
        if self.laravel().is_none() {
            return Vec::new();
        }
        let text = blade.text;
        let lines = LineIndex::new(text);
        let touches = |found: Range| found.start <= range.end && range.start <= found.end;
        let mut out = Vec::new();
        for (diagnostic, fix) in self.blade_reference_fixes(text) {
            if let Some((title, edit)) = fix
                && touches(diagnostic.range)
            {
                out.push(ImportAction { title, kind: QUICKFIX, preferred: true, edit, open: None });
            }
        }
        let views = self.laravel_views();
        for diagnostic in self.undefined_components(text) {
            if !touches(diagnostic.range) {
                continue;
            }
            let (start, end) = lines.byte_range(diagnostic.range);
            let tag = &text[start as usize..end as usize];
            let Some(path) = views.as_ref().and_then(|views| views.new_path(&component_view_name(tag))) else {
                continue;
            };
            let edit = WorkspaceEdit {
                files: vec![FileEdit::Create { path: path.into(), overwrite: false }],
                ..WorkspaceEdit::default()
            };
            out.push(ImportAction {
                title: format!("Create component 'x-{tag}'"),
                kind: QUICKFIX,
                preferred: true,
                edit,
                open: None,
            });
        }
        let (start, _) = lines.byte_range(range);
        out.extend(self.add_prop_fix(text, start));
        out.extend(self.add_constructor_param_fix(text, start));
        out
    }

    /// "Add constructor parameter '$name' to <x-tag>" on an attribute of a
    /// class component's tag that its constructor doesn't take: a promoted
    /// public parameter (so the view sees it too), `string` for a plain
    /// attribute and `mixed` for a bound one, optional (`= null`) after
    /// optional parameters. Added to the class's constructor, or to a new
    /// one; `None` when the class inherits a constructor or ends with a
    /// variadic parameter.
    fn add_constructor_param_fix(&self, text: &str, offset: u32) -> Option<ImportAction> {
        let TagPlace::Attribute { component, name, bound } = tag_place(text, offset)? else { return None };
        let written = &text[name.start as usize..name.end as usize];
        let plain = !written.is_empty()
            && written.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && written.as_bytes()[0].is_ascii_alphabetic()
            && !["class", "style", "id"].contains(&written);
        if !plain || text.as_bytes().get(name.start.wrapping_sub(2) as usize..name.start as usize) == Some(b"::") {
            return None;
        }
        let catalog = self.laravel_blade()?;
        let found = catalog.component(&component)?;
        let (class, path) = found.class.as_ref()?;
        if path.as_os_str().is_empty()
            || self.laravel_component_attributes(found).iter().any(|attribute| attribute.name == kebab(&camel(written)))
        {
            return None;
        }
        let param = camel(written);
        let class_text = self.current_text(path)?;
        let parsed = ParsedFile::parse("component.php", class_text.as_str());
        let summary = FileSummary::extract(&parsed);
        let declared =
            summary.class_likes.iter().find(|known| known.fqn.trim_start_matches('\\').eq_ignore_ascii_case(class))?;
        let params = declared.method("__construct").map(|ctor| ctor.params.as_slice()).unwrap_or_default();
        if params.last().is_some_and(|last| last.variadic) {
            return None;
        }
        let ty = if bound { "mixed" } else { "string" };
        let declaration = if params.iter().any(|known| known.default.is_some()) {
            let nullable = if bound { "mixed".to_owned() } else { format!("?{ty}") };
            format!("public {nullable} ${param} = null")
        } else {
            format!("public {ty} ${param}")
        };
        let (from, to, new_text) = self.constructor_param(&class_text, declared, &declaration)?;
        let lines = LineIndex::new(&class_text);
        let edit = TextEdit { range: lines.range(from, to), new_text };
        Some(ImportAction {
            title: format!("Add constructor parameter '${param}' to <x-{component}>"),
            kind: QUICKFIX,
            preferred: false,
            edit: file_edit(path, vec![edit]),
            open: None,
        })
    }

    /// "Add 'name' to the @props of <x-tag>" on an attribute of an
    /// anonymous component's tag that its `@props` doesn't list.
    fn add_prop_fix(&self, text: &str, offset: u32) -> Option<ImportAction> {
        let TagPlace::Attribute { component, name, .. } = tag_place(text, offset)? else { return None };
        let written = &text[name.start as usize..name.end as usize];
        let plain = !written.is_empty()
            && written.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && !["class", "style", "id"].contains(&written);
        if !plain {
            return None;
        }
        let catalog = self.laravel_blade()?;
        let found = catalog.component(&component)?;
        let view = found.view.as_ref().filter(|_| found.class.is_none())?;
        if self.laravel_component_attributes(found).iter().any(|attribute| attribute.name == kebab(&camel(written))) {
            return None;
        }
        let prop = camel(written);
        let view_text = self.current_text(view)?;
        let view_lines = LineIndex::new(&view_text);
        let props = parse(&view_text).into_iter().find_map(|node| match (&node.kind, &node.code) {
            (NodeKind::Directive { name }, Some(code)) if name == "props" => Some(code.clone()),
            _ => None,
        });
        let edit = match props.and_then(|code| structure::arguments(&view_text, &code).into_iter().next()) {
            Some(array) if view_text[array.start as usize..array.end as usize].ends_with(']') => {
                let close = array.end - 1;
                let before = view_text[array.start as usize + 1..close as usize].trim_end();
                let at = array.start + 1 + before.len() as u32;
                let new_text = if before.is_empty() {
                    format!("'{prop}'")
                } else if before.ends_with(',') {
                    format!(" '{prop}'")
                } else {
                    format!(", '{prop}'")
                };
                TextEdit { range: view_lines.range(at, at), new_text }
            }
            Some(_) => return None,
            None => TextEdit { range: view_lines.range(0, 0), new_text: format!("@props(['{prop}'])\n\n") },
        };
        Some(ImportAction {
            title: format!("Add '{prop}' to the @props of <x-{component}>"),
            kind: QUICKFIX,
            preferred: false,
            edit: file_edit(view, vec![edit]),
            open: None,
        })
    }
}
