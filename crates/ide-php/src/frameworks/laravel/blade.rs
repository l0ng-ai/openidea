//! Blade in a Laravel project: layouts (sections and stacks across the
//! views a template extends or is extended by), components (`<x-…>` tags)
//! and custom directives ([`BladeCatalog`]), answered on an open template
//! ([`BladeDocument`]) by the `blade_laravel_*` methods of the engine.
//!
//! - **Components**, as Laravel's `ComponentTagCompiler` finds them:
//!   classes below `app/View/Components` (`Forms/InputGroup.php` is
//!   `<x-forms.input-group>`) and anonymous components, the views below
//!   `components` (`components/card/index.blade.php` and
//!   `components/card/card.blade.php` are `<x-card>`); a module's are
//!   prefixed with its lower-case name (`<x-billing::alert>`). A class
//!   component's attributes are its constructor's parameters, an anonymous
//!   one's its `@props`, both in kebab case.
//! - **Custom directives:** `Blade::directive('name', …)` and
//!   `Blade::if('name', …)` (which also adds `@elsename`, `@endname` and
//!   `@unlessname`) in the service providers of the app and its modules.
//!
//! Only Laravel's documentation and source (MIT) are design inputs.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use ide_core::{Diagnostic, Pos, Range};

use super::views::{call_arguments, is_blade, provider_files};
use super::{LaravelProject, ViewTable};
use crate::blade::structure::{self, Name, NameKind, NameRole};
use crate::blade::tags::{TagPlace, tag_at, tag_place};
use crate::blade::{BladeDocument, DIRECTIVES, directive_prefix};
use crate::complete::{Completion, CompletionKind, Completions};
use crate::engine::PhpEngine;
use crate::navigate::Target;
use crate::summary::FileSummary;
use crate::syntax::LineIndex;

/// A directive a service provider registers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CustomDirective {
    pub name: String,
    /// The provider, and the range of the name's string in it.
    pub path: PathBuf,
    pub range: Range,
    /// Registered with `Blade::if`.
    pub condition: bool,
}

impl CustomDirective {
    /// The directives it adds.
    pub fn names(&self) -> Vec<String> {
        let name = &self.name;
        if self.condition {
            vec![name.clone(), format!("else{name}"), format!("end{name}"), format!("unless{name}")]
        } else {
            vec![name.clone()]
        }
    }
}

/// A Blade component.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BladeComponent {
    /// The tag's name after `x-` (`alert`, `forms.input`, `billing::alert`).
    pub tag: String,
    /// The class of a class-based component, with its file.
    pub class: Option<(String, PathBuf)>,
    /// The view of an anonymous component (or the one named like a class
    /// component).
    pub view: Option<PathBuf>,
}

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BladeCatalog {
    /// Sorted by tag.
    pub components: Vec<BladeComponent>,
    pub directives: Vec<CustomDirective>,
}

/// `InputGroup` → `input-group` (Laravel's `Str::kebab`).
pub fn kebab(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.char_indices() {
        if c.is_ascii_uppercase() {
            if i > 0 && !out.ends_with('-') {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
        } else if c == '_' {
            out.push('-');
        } else {
            out.push(c);
        }
    }
    out
}

impl BladeCatalog {
    /// The components and custom directives of `project`; `text_of` reads a
    /// service provider (an open buffer first).
    pub fn read(project: &LaravelProject, views: &ViewTable, text_of: impl Fn(&Path) -> Option<String>) -> Self {
        let mut components: Vec<BladeComponent> = Vec::new();
        let mut class_dirs = vec![(
            project.paths.app.join("View").join("Components"),
            format!("{}View\\Components\\", project.app_namespace),
            String::new(),
        )];
        for module in project.modules.iter().filter(|module| module.enabled) {
            let Some(namespace) = &module.namespace else { continue };
            if let Some(dir) = ["app/View/Components", "View/Components", "src/View/Components"]
                .iter()
                .map(|sub| module.path.join(sub))
                .find(|dir| dir.is_dir())
            {
                let prefix = format!("{}::", module.name.to_ascii_lowercase());
                class_dirs.push((dir, format!("{namespace}View\\Components\\"), prefix));
            }
        }
        for (dir, namespace, prefix) in class_dirs {
            let mut files = Vec::new();
            class_files(&dir, &mut Vec::new(), &mut files);
            for (segments, path) in files {
                let tag = format!("{prefix}{}", segments.iter().map(|s| kebab(s)).collect::<Vec<_>>().join("."));
                let class = format!("{namespace}{}", segments.join("\\"));
                components.push(BladeComponent { tag, class: Some((class, path)), view: None });
            }
        }
        for view in views.views() {
            let Some(rest) = view.local().strip_prefix("components.") else { continue };
            let mut segments: Vec<&str> = rest.split('.').collect();
            let len = segments.len();
            if len > 1 && (segments[len - 1] == "index" || segments[len - 1] == segments[len - 2]) {
                segments.pop();
            }
            let prefix = view.namespace().map(|namespace| format!("{namespace}::")).unwrap_or_default();
            let tag = format!("{prefix}{}", segments.join("."));
            match components.iter_mut().find(|known| known.tag == tag) {
                Some(known) => {
                    known.view.get_or_insert_with(|| view.path.clone());
                }
                None => components.push(BladeComponent { tag, class: None, view: Some(view.path.clone()) }),
            }
        }
        components.sort_by(|a, b| a.tag.cmp(&b.tag));
        components.dedup_by(|later, first| later.tag == first.tag);

        let mut directives = Vec::new();
        for path in provider_files(project) {
            let Some(text) = text_of(&path) else { continue };
            directives.extend(registered_directives(&path, &text));
        }
        Self { components, directives }
    }

    /// The component with this tag.
    pub fn component(&self, tag: &str) -> Option<&BladeComponent> {
        self.components.iter().find(|component| component.tag == tag)
    }

    /// Every directive the providers add.
    pub fn directive_names(&self) -> Vec<String> {
        self.directives.iter().flat_map(CustomDirective::names).collect()
    }

    /// The registration adding directive `name`.
    pub fn directive(&self, name: &str) -> Option<&CustomDirective> {
        self.directives.iter().find(|directive| directive.names().iter().any(|known| known == name))
    }
}

/// The `.php` files below `dir` with their path segments (`Forms`,
/// `InputGroup`), sorted.
fn class_files(dir: &Path, segments: &mut Vec<String>, out: &mut Vec<(Vec<String>, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            segments.push(name);
            class_files(&path, segments, out);
            segments.pop();
        } else if let Some(stem) = name.strip_suffix(".php") {
            let mut found = segments.clone();
            found.push(stem.to_owned());
            out.push((found, crate::project::normalize(&path)));
        }
    }
}

/// The `Blade::directive('name', …)` and `Blade::if('name', …)` calls of
/// `text`.
fn registered_directives(path: &Path, text: &str) -> Vec<CustomDirective> {
    let lines = LineIndex::new(text);
    let mut out = Vec::new();
    for (call, condition) in [("Blade::directive(", false), ("Blade::if(", true)] {
        let mut from = 0;
        while let Some(at) = text[from..].find(call) {
            let open = from + at + call.len() - 1;
            from = open + 1;
            if call_arguments(text, open).is_none_or(|args| args.len() < 2) {
                continue;
            }
            let start = open + 1 + (text[open + 1..].len() - text[open + 1..].trim_start().len());
            let Some(quote) = text[start..].chars().next().filter(|c| *c == '\'' || *c == '"') else { continue };
            let Some(len) = text[start + 1..].find(quote) else { continue };
            let name = &text[start + 1..start + 1 + len];
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                continue;
            }
            let range = lines.range((start + 1) as u32, (start + 1 + len) as u32);
            out.push(CustomDirective { name: name.to_owned(), path: path.to_path_buf(), range, condition });
        }
    }
    out
}

/// One attribute a component takes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComponentAttribute {
    /// In kebab case, as written on the tag.
    pub name: String,
    /// The type, else the default value.
    pub detail: Option<String>,
    pub target: Option<Target>,
}

/// A template read from disk (an open one's text when it is `own`).
struct Template {
    path: PathBuf,
    text: String,
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

impl PhpEngine {
    /// The attributes component `component` takes.
    pub fn laravel_component_attributes(&self, component: &BladeComponent) -> Vec<ComponentAttribute> {
        let mut out: Vec<ComponentAttribute> = Vec::new();
        if let Some((class, _)) = &component.class {
            let resolver = self.resolver();
            if let Some(model) = resolver.class_model(class)
                && let Some(constructor) = model.method("__construct")
                && let Some(declared) = constructor.declared()
            {
                let path = self.class_path(&constructor.declaring, Path::new(""), &FileSummary::default());
                for param in &declared.params {
                    let detail = param.type_hint.as_ref().map(ToString::to_string).or_else(|| param.default.clone());
                    let target = path.clone().map(|path| Target { path, range: param.name_loc.range });
                    out.push(ComponentAttribute { name: kebab(&param.name), detail, target });
                }
            }
        }
        if let Some(view) = &component.view
            && let Ok(text) = std::fs::read_to_string(view)
        {
            let lines = LineIndex::new(&text);
            for prop in structure::props(&text) {
                let name = kebab(&prop.name);
                if out.iter().any(|known| known.name == name) {
                    continue;
                }
                let target = Some(Target { path: view.clone(), range: lines.range(prop.span.start, prop.span.end) });
                out.push(ComponentAttribute { name, detail: prop.default, target });
            }
        }
        out
    }

    fn custom_directives(&self) -> Vec<String> {
        self.laravel_blade().map(|catalog| catalog.directive_names()).unwrap_or_default()
    }

    /// Completion of the directive name after an `@` at `pos`: the built-in
    /// directives and, in a Laravel project, the custom ones.
    pub fn blade_directive_completion(&self, text: &str, pos: Pos) -> Option<Completions> {
        let (_, range) = directive_prefix(text, pos)?;
        let typed = Range::new(range.start, pos);
        let mut items: Vec<Completion> = DIRECTIVES
            .iter()
            .map(|name| item((*name).to_owned(), Some("Blade directive".into()), CompletionKind::Keyword, typed, range))
            .collect();
        if let Some(catalog) = self.laravel_blade() {
            for directive in &catalog.directives {
                let file =
                    directive.path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
                for name in directive.names() {
                    if !DIRECTIVES.contains(&name.as_str()) {
                        let detail = Some(format!("Custom directive · {file}"));
                        items.push(item(name, detail, CompletionKind::Function, typed, range));
                    }
                }
            }
        }
        Some(Completions { items, incomplete: false })
    }

    /// The template's own problems (unclosed sections and pushes).
    pub fn blade_problems(&self, text: &str) -> Vec<Diagnostic> {
        structure::inspect(text, &self.custom_directives())
    }

    /// The views `blade` extends, nearest first.
    fn ancestors(&self, views: &ViewTable, blade: &BladeDocument) -> Vec<Template> {
        let mut out: Vec<Template> = Vec::new();
        let mut seen: HashSet<PathBuf> = HashSet::from([crate::project::normalize(blade.path)]);
        let mut text = blade.text.to_owned();
        while out.len() < 16 {
            let Some((name, _)) = structure::extends(&text) else { break };
            let Some(view) = views.get(&name) else { break };
            if !seen.insert(view.path.clone()) {
                break;
            }
            let Ok(next) = std::fs::read_to_string(&view.path) else { break };
            text = next.clone();
            out.push(Template { path: view.path.clone(), text: next });
        }
        out
    }

    /// The templates extending `blade`'s view, directly or not.
    fn descendants(&self, views: &ViewTable, blade: &BladeDocument) -> Vec<Template> {
        let Some(own) = views.name_of(blade.path) else { return Vec::new() };
        let templates: Vec<(String, Template)> = views
            .views()
            .iter()
            .filter(|view| is_blade(&view.path) && view.name != own)
            .filter_map(|view| {
                let text = std::fs::read_to_string(&view.path).ok()?;
                Some((view.name.clone(), Template { path: view.path.clone(), text }))
            })
            .collect();
        let mut wanted = vec![own];
        let mut out: Vec<Template> = Vec::new();
        while let Some(parent) = wanted.pop() {
            for (name, template) in &templates {
                let extends = structure::extends(&template.text).map(|(name, _)| super::views::normalize_name(&name));
                if extends.as_deref() == Some(parent.as_str()) && !out.iter().any(|known| known.path == template.path) {
                    out.push(Template { path: template.path.clone(), text: template.text.clone() });
                    wanted.push(name.clone());
                }
            }
        }
        out
    }

    /// Every Blade view of the project, the open template's own text for it.
    fn all_templates(&self, views: &ViewTable, blade: &BladeDocument) -> Vec<Template> {
        let own = crate::project::normalize(blade.path);
        let mut out = vec![Template { path: own.clone(), text: blade.text.to_owned() }];
        for view in views.views().iter().filter(|view| is_blade(&view.path) && view.path != own) {
            if let Ok(text) = std::fs::read_to_string(&view.path) {
                out.push(Template { path: view.path.clone(), text });
            }
        }
        out
    }

    /// The names a section or stack name at the caret can refer to: for a
    /// section filled here, those of the layouts it extends; for one shown
    /// here, those the templates extending it fill; for a stack, those of
    /// every view. Each with its template.
    fn counterparts(&self, blade: &BladeDocument, at: &Name, custom: &[String]) -> Vec<(PathBuf, String, Name)> {
        let Some(views) = self.laravel_views() else { return Vec::new() };
        let (templates, role): (Vec<Template>, Option<NameRole>) = match (at.kind, at.role) {
            (NameKind::Section, NameRole::Fill) => (self.ancestors(&views, blade), None),
            (NameKind::Section, NameRole::Show) => (self.descendants(&views, blade), Some(NameRole::Fill)),
            (NameKind::Stack, NameRole::Fill) => (self.all_templates(&views, blade), Some(NameRole::Show)),
            (NameKind::Stack, NameRole::Show) => (self.all_templates(&views, blade), Some(NameRole::Fill)),
        };
        let mut out = Vec::new();
        for template in templates {
            let label = view_label(&views, &template.path);
            for name in structure::names(&template.text, custom) {
                if name.kind == at.kind && role.is_none_or(|role| name.role == role) {
                    out.push((template.path.clone(), label.clone(), name));
                }
            }
        }
        out
    }

    /// Completion of section and stack names, component tags and their
    /// attributes in a template of a Laravel project; `None` elsewhere.
    pub fn blade_laravel_completion(&self, blade: &BladeDocument, pos: Pos) -> Option<Completions> {
        self.laravel()?;
        let lines = LineIndex::new(blade.text);
        let offset = lines.byte(pos);
        let custom = self.custom_directives();
        if let Some(at) = structure::name_at(blade.text, offset, &custom) {
            let replace = lines.range(at.span.start, offset);
            let tab = lines.range(at.span.start, at.span.end);
            let mut items: Vec<Completion> = Vec::new();
            for (_, view, name) in self.counterparts(blade, &at, &custom) {
                if items.iter().any(|known| known.label == name.name) || name.name.is_empty() {
                    continue;
                }
                let what = match name.kind {
                    NameKind::Section => "section",
                    NameKind::Stack => "stack",
                };
                items.push(item(name.name, Some(format!("{what} · {view}")), CompletionKind::Value, replace, tab));
            }
            return Some(Completions { items, incomplete: false });
        }
        let catalog = self.laravel_blade()?;
        match tag_place(blade.text, offset)? {
            TagPlace::Name(span) => {
                // From the `x-`, so the items filter on what was typed.
                let start = span.start - 2;
                let replace = lines.range(start, offset);
                let tab = lines.range(start, span.end);
                let items = catalog
                    .components
                    .iter()
                    .map(|component| {
                        let detail = match &component.class {
                            Some((class, _)) => class.clone(),
                            None => "anonymous component".into(),
                        };
                        item(format!("x-{}", component.tag), Some(detail), CompletionKind::Class, replace, tab)
                    })
                    .collect();
                Some(Completions { items, incomplete: false })
            }
            TagPlace::Attribute { component, name, .. } => {
                let component = catalog.component(&component)?;
                let start = (blade.text[..offset as usize].rfind("<x")?) as u32;
                let tag = tag_at(blade.text, start as usize)?;
                let present: Vec<&str> = tag
                    .attributes
                    .iter()
                    .filter(|attribute| !(attribute.name.start <= offset && offset <= attribute.name.end))
                    .map(|attribute| attribute.bare_name(blade.text))
                    .collect();
                let replace = lines.range(name.start, offset);
                let tab = lines.range(name.start, name.end);
                let has_value = blade.text.as_bytes().get(name.end as usize) == Some(&b'=');
                let items = self
                    .laravel_component_attributes(component)
                    .into_iter()
                    .filter(|attribute| !present.contains(&attribute.name.as_str()))
                    .map(|attribute| {
                        let mut found =
                            item(attribute.name.clone(), attribute.detail, CompletionKind::Property, replace, tab);
                        if !has_value {
                            found.insert_text = format!("{}=\"$0\"", attribute.name);
                            found.is_snippet = true;
                        }
                        found
                    })
                    .collect();
                Some(Completions { items, incomplete: false })
            }
        }
    }

    /// Goto definition in a template of a Laravel project: a section or
    /// stack name to where its counterparts are, a component tag to its
    /// class and view, a component attribute to its parameter or `@props`
    /// entry, a custom directive to its registration. `None` when the caret
    /// is on none of them.
    pub fn blade_laravel_definition(&self, blade: &BladeDocument, pos: Pos) -> Option<Vec<Target>> {
        self.laravel()?;
        let lines = LineIndex::new(blade.text);
        let offset = lines.byte(pos);
        let custom = self.custom_directives();
        if let Some(at) = structure::name_at(blade.text, offset, &custom) {
            let found = self.counterparts(blade, &at, &custom);
            let matching: Vec<(PathBuf, Name)> = found
                .into_iter()
                .filter(|(path, _, name)| {
                    name.name == at.name && !(*path == crate::project::normalize(blade.path) && name.span == at.span)
                })
                .map(|(path, _, name)| (path, name))
                .collect();
            // A section filled here: the nearest layout naming it.
            let nearest = matching.first().map(|(path, _)| path.clone());
            let targets = matching
                .into_iter()
                .filter(|(path, _)| {
                    at.kind != NameKind::Section || at.role != NameRole::Fill || Some(path) == nearest.as_ref()
                })
                .filter_map(|(path, name)| {
                    let text = if path == crate::project::normalize(blade.path) {
                        blade.text.to_owned()
                    } else {
                        std::fs::read_to_string(&path).ok()?
                    };
                    let range = LineIndex::new(&text).range(name.span.start, name.span.end);
                    Some(Target { path, range })
                })
                .collect();
            return Some(targets);
        }
        let catalog = self.laravel_blade()?;
        if let Some((_, range)) = directive_prefix(blade.text, pos) {
            let word = &blade.text[lines.byte(range.start) as usize..lines.byte(range.end) as usize];
            let directive = catalog.directive(word)?;
            return Some(vec![Target { path: directive.path.clone(), range: directive.range }]);
        }
        match tag_place(blade.text, offset)? {
            TagPlace::Name(span) => {
                let tag = &blade.text[span.start as usize..span.end as usize];
                let component = catalog.component(tag)?;
                let mut targets = Vec::new();
                if let Some((class, path)) = &component.class {
                    let range =
                        self.resolver().class_model(class).map(|model| model.class.name_loc.range).unwrap_or_default();
                    targets.push(Target { path: path.clone(), range });
                }
                if let Some(view) = &component.view {
                    targets.push(Target { path: view.clone(), range: Range::default() });
                }
                Some(targets)
            }
            TagPlace::Attribute { component, name, .. } => {
                let component = catalog.component(&component)?;
                let written = &blade.text[name.start as usize..name.end as usize];
                let attribute =
                    self.laravel_component_attributes(component).into_iter().find(|known| known.name == written)?;
                Some(attribute.target.into_iter().collect())
            }
        }
    }
}

/// The view name of `path` for an item's detail, else its file name.
fn view_label(views: &ViewTable, path: &Path) -> String {
    views
        .name_of(path)
        .unwrap_or_else(|| path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default())
}
