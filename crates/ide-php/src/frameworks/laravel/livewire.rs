//! Livewire in a Laravel project with `livewire/livewire` installed
//! ([`super::LaravelPackages`]): the components ([`LivewireComponents`]) and
//! what the Blade support asks about them.
//!
//! - **Components**, as Livewire's documentation names them: the classes
//!   extending `Livewire\Component` below the app's `Livewire` namespace
//!   (Livewire 3) or `Http\Livewire` (Livewire 2), and below the
//!   `livewire.namespaces` of the `ide.json` files (with their tag prefix,
//!   `admin::users`). `App\Livewire\Posts\CreatePost` is
//!   `posts.create-post`. A component's view is the one its `render()`
//!   names (`view('livewire.counter')`), else `livewire.<name>` (or the
//!   `ide.json` namespace's view folder). Components registered in a
//!   service provider with `Livewire::component('alias', Counter::class)`
//!   are known by their alias too (and win over a discovered one of the
//!   same name).
//! - **Parameters:** what `@livewire('counter', [...])` and a tag's
//!   attributes fill: the parameters of `mount()`, then the public
//!   properties.
//! - **Properties and actions:** what `wire:model` binds to (the public
//!   properties a component declares, not Livewire's own; a property typed
//!   with a `Livewire\Form` gives `form.title`) and what `wire:click` and
//!   the other event directives call (its public methods, without the
//!   lifecycle hooks, plus Livewire's magic actions such as `$refresh`).
//! - **Blade:** the place of the caret in a `wire:` attribute's value
//!   ([`wire_value_at`]).
//!
//! Only Livewire's documentation (MIT) is a design input.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ide_core::Range;

use super::LaravelProject;
use super::auth::{calls, class_name, first_string};
use super::blade::kebab;
use super::parts::PartReader;
use super::views::{ViewTable, provider_files};
use crate::engine::PhpEngine;
use crate::names::FileNames;
use crate::navigate::Target;
use crate::summary::{ClassKind, FileSummary};
use crate::syntax::{LineIndex, ParsedFile};
use crate::types::ClassModel;

/// Livewire's base component class.
pub const COMPONENT: &str = "Livewire\\Component";
/// Livewire's base form class (Livewire 3 form objects).
pub const FORM: &str = "Livewire\\Form";

/// Methods Livewire calls itself (lifecycle hooks), never actions.
const HOOKS: &[&str] = &[
    "mount",
    "boot",
    "booted",
    "hydrate",
    "dehydrate",
    "updating",
    "updated",
    "render",
    "rendering",
    "rendered",
    "exception",
    "placeholder",
];
/// Prefixes of the lifecycle hooks of a property (`updatedTitle`).
const HOOK_PREFIXES: &[&str] = &["hydrate", "dehydrate", "updating", "updated", "boot", "mount"];

/// The actions every component has, as Livewire's documentation on actions
/// lists them.
pub const MAGIC_ACTIONS: &[(&str, &str)] = &[
    ("$refresh", "Re-render the component"),
    ("$set", "Set a property: $set('title', 'value')"),
    ("$toggle", "Toggle a boolean property"),
    ("$dispatch", "Dispatch an event"),
    ("$parent", "The parent component"),
];

/// One component.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LivewireComponent {
    /// The name (`counter`, `posts.create-post`, `admin::users`).
    pub name: String,
    /// The class (FQN, without a leading `\`).
    pub class: String,
    /// The class's file and the range of its name.
    pub path: PathBuf,
    pub range: Range,
    /// The view's file, when it exists.
    pub view: Option<PathBuf>,
    /// Where `Livewire::component('alias', …)` registers it: the provider
    /// and the alias's range (inside the quotes); `None` for a discovered
    /// component.
    pub alias: Option<(PathBuf, Range)>,
}

/// The components of a project, sorted by name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LivewireComponents {
    pub components: Vec<LivewireComponent>,
}

/// A property or action of a component.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LivewireMember {
    pub name: String,
    /// The type (properties) or the parameters (actions).
    pub detail: Option<String>,
    pub target: Option<Target>,
}

impl LivewireComponents {
    /// The components of `project`, empty when Livewire isn't installed.
    pub fn read(engine: &PhpEngine, project: &LaravelProject, views: &ViewTable) -> Self {
        if !project.packages.livewire {
            return Self::default();
        }
        // `(tag prefix, class namespace with a trailing `\`, view folder)`.
        let mut namespaces: Vec<(String, String, Option<PathBuf>)> = vec![
            (String::new(), format!("{}Livewire\\", project.app_namespace), None),
            (String::new(), format!("{}Http\\Livewire\\", project.app_namespace), None),
        ];
        for (prefix, class, view) in &project.ide_json.packages.livewire {
            if let Some(class) = class {
                namespaces.push((prefix.clone(), format!("{}\\", class.trim_matches('\\')), view.clone()));
            }
        }
        let mut out: Vec<LivewireComponent> = Vec::new();
        let resolver = engine.resolver();
        for provider in provider_files(project) {
            let Some(found) = engine.part("livewire-registrations", &provider, "", &|text| registrations(text)) else {
                continue;
            };
            for (alias, class, at) in found.iter().cloned() {
                let Some(model) = resolver.class_model(&class) else { continue };
                if out.iter().any(|known| known.name == alias) || !model.is_subclass_of(COMPONENT) {
                    continue;
                }
                let Some(path) = engine.class_path(&model.class, Path::new(""), &FileSummary::default()) else {
                    continue;
                };
                let text = engine.text_of(&path).unwrap_or_default();
                let view = rendered_view(&text).and_then(|view| views.get(&view).map(|view| view.path.clone()));
                let range = model.class.name_loc.range;
                let alias_at = Some((crate::project::normalize(&provider), at));
                out.push(LivewireComponent { name: alias, class, path, range, view, alias: alias_at });
            }
        }
        for model in subclasses(engine, COMPONENT) {
            let fqn = model.fqn().trim_start_matches('\\');
            let Some((prefix, rest, view_dir)) = namespaces.iter().find_map(|(prefix, namespace, view)| {
                let rest = fqn.get(..namespace.len()).filter(|head| head.eq_ignore_ascii_case(namespace))?;
                Some((prefix, &fqn[rest.len()..], view))
            }) else {
                continue;
            };
            let local = rest.split('\\').map(kebab).collect::<Vec<_>>().join(".");
            let name = if prefix.is_empty() { local.clone() } else { format!("{prefix}::{local}") };
            if out.iter().any(|known| known.name == name) {
                continue;
            }
            let Some(path) = engine.class_path(&model.class, Path::new(""), &FileSummary::default()) else { continue };
            let text = engine.text_of(&path).unwrap_or_default();
            let view = match (rendered_view(&text), view_dir) {
                (Some(view), _) => views.get(&view).map(|view| view.path.clone()),
                (None, Some(dir)) => {
                    let file = dir.join(format!("{}.blade.php", local.replace('.', "/")));
                    file.is_file().then(|| crate::project::normalize(&file))
                }
                (None, None) => views.get(&format!("livewire.{local}")).map(|view| view.path.clone()),
            };
            let range = model.class.name_loc.range;
            out.push(LivewireComponent { name, class: fqn.to_owned(), path, range, view, alias: None });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Self { components: out }
    }

    /// The component named `name`.
    pub fn get(&self, name: &str) -> Option<&LivewireComponent> {
        self.components.iter().find(|component| component.name == name)
    }

    /// The component named `name`, else the first one of class `name`
    /// (`App\Livewire\Counter`, with or without a leading `\`).
    pub fn find(&self, name: &str) -> Option<&LivewireComponent> {
        let class = name.trim_start_matches('\\');
        self.get(name).or_else(|| self.components.iter().find(|c| c.class.eq_ignore_ascii_case(class)))
    }

    /// The component whose view is `path`.
    pub fn of_view(&self, path: &Path) -> Option<&LivewireComponent> {
        let path = crate::project::normalize(path);
        self.components.iter().find(|component| component.view.as_deref() == Some(path.as_path()))
    }
}

/// The `Livewire::component('alias', Counter::class)` registrations of a
/// service provider's text: `(alias, class, the alias's range)`.
fn registrations(text: &str) -> Vec<(String, String, Range)> {
    if !text.contains("Livewire::component(") {
        return Vec::new();
    }
    let parsed = ParsedFile::parse("provider.php", text);
    let names = FileNames::resolve(&parsed);
    let lines = LineIndex::new(text);
    let mut out = Vec::new();
    for (open, args) in calls(text, "Livewire::component(") {
        let Some((alias, at)) = first_string(text, open, &lines) else { continue };
        let Some(class) = args.get(1).and_then(|arg| class_name(&names, arg, open)) else { continue };
        out.push((alias, class, at));
    }
    out
}

/// The non-abstract classes extending `parent`, directly or not.
fn subclasses(engine: &PhpEngine, parent: &str) -> Vec<Arc<ClassModel>> {
    let Some(index) = engine.index() else { return Vec::new() };
    let resolver = engine.resolver();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue = vec![parent.to_owned()];
    let mut out = Vec::new();
    while let Some(parent) = queue.pop() {
        for decl in index.direct_subclasses(&parent).unwrap_or_default() {
            if !seen.insert(decl.fqn.to_ascii_lowercase()) {
                continue;
            }
            queue.push(decl.fqn.clone());
            if let Some(model) = resolver.class_model(&decl.fqn)
                && model.kind() == ClassKind::Class
                && !model.class.modifiers.is_abstract
            {
                out.push(model);
            }
        }
    }
    out
}

/// The view a component's `render()` names: the first `view('…')` of the
/// class's text.
fn rendered_view(text: &str) -> Option<String> {
    let mut from = 0;
    while let Some(at) = text[from..].find("view(") {
        let start = from + at;
        from = start + 5;
        let before = text[..start].chars().next_back();
        if before.is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '>' | ':')) {
            continue;
        }
        let rest = text[from..].trim_start();
        let Some(quote) = rest.chars().next().filter(|c| *c == '\'' || *c == '"') else { continue };
        let value = &rest[1..];
        let end = value.find(quote)?;
        return Some(value[..end].to_owned());
    }
    None
}

/// Whether `member` was declared by Livewire itself.
fn livewire_own(declaring: &str) -> bool {
    let declaring = declaring.trim_start_matches('\\');
    declaring.get(..9).is_some_and(|head| head.eq_ignore_ascii_case("Livewire\\"))
}

/// Whether `name` is a lifecycle hook rather than an action.
fn is_hook(name: &str) -> bool {
    name.starts_with("__")
        || HOOKS.iter().any(|hook| hook.eq_ignore_ascii_case(name))
        || HOOK_PREFIXES.iter().any(|prefix| {
            name.len() > prefix.len()
                && name[..prefix.len()].eq_ignore_ascii_case(prefix)
                && name[prefix.len()..].starts_with(|c: char| c.is_ascii_uppercase())
        })
}

impl PhpEngine {
    fn member_target(&self, declaring: &crate::summary::ClassLike, range: Range) -> Option<Target> {
        let path = self.class_path(declaring, Path::new(""), &FileSummary::default())?;
        Some(Target { path, range })
    }

    /// The public properties `class` (a component or a form) declares,
    /// Livewire's own left out.
    pub fn livewire_properties(&self, class: &str) -> Vec<LivewireMember> {
        let Some(model) = self.resolver().class_model(class) else { return Vec::new() };
        model
            .properties
            .iter()
            .filter(|property| {
                property.visibility == crate::summary::Visibility::Public
                    && !property.is_static
                    && !livewire_own(&property.declaring.fqn)
            })
            .filter_map(|property| {
                let declared = property.declared()?;
                Some(LivewireMember {
                    name: property.name.clone(),
                    detail: declared.type_hint.as_ref().map(ToString::to_string),
                    target: self.member_target(&property.declaring, declared.name_loc.range),
                })
            })
            .collect()
    }

    /// The actions of component `class`: its public methods but the
    /// lifecycle hooks, Livewire's own left out.
    pub fn livewire_actions(&self, class: &str) -> Vec<LivewireMember> {
        let Some(model) = self.resolver().class_model(class) else { return Vec::new() };
        model
            .methods
            .iter()
            .filter(|method| {
                method.visibility == crate::summary::Visibility::Public
                    && !method.is_static
                    && !livewire_own(&method.declaring.fqn)
                    && !is_hook(&method.name)
            })
            .filter_map(|method| {
                let declared = method.declared()?;
                let params: Vec<String> = declared.params.iter().map(|param| format!("${}", param.name)).collect();
                Some(LivewireMember {
                    name: method.name.clone(),
                    detail: Some(format!("({})", params.join(", "))),
                    target: self.member_target(&method.declaring, declared.name_loc.range),
                })
            })
            .collect()
    }

    /// The class of property `name` of `class` when it is a Livewire form
    /// (`public PostForm $form`).
    pub fn livewire_form_of(&self, class: &str, name: &str) -> Option<String> {
        let resolver = self.resolver();
        let model = resolver.class_model(class)?;
        let property = model.property(name)?;
        let hint = property.declared()?.type_hint.as_ref()?.to_string();
        let form = hint.trim_start_matches('?').trim_start_matches('\\').to_owned();
        resolver.class_model(&form).filter(|model| model.is_subclass_of(FORM))?;
        Some(form)
    }

    /// The parameters component `class` takes (`@livewire('counter',
    /// ['start' => 1])`): the parameters of its `mount()`, then its public
    /// properties.
    pub fn livewire_parameters(&self, class: &str) -> Vec<LivewireMember> {
        let mut out: Vec<LivewireMember> = Vec::new();
        if let Some(model) = self.resolver().class_model(class)
            && let Some(mount) = model.method("mount")
            && let Some(declared) = mount.declared()
        {
            for param in &declared.params {
                out.push(LivewireMember {
                    name: param.name.clone(),
                    detail: param.type_hint.as_ref().map(ToString::to_string).or_else(|| param.default.clone()),
                    target: self.member_target(&mount.declaring, param.name_loc.range),
                });
            }
        }
        for property in self.livewire_properties(class) {
            if !out.iter().any(|known| known.name == property.name) {
                out.push(property);
            }
        }
        out
    }

    /// The attributes a `<livewire:…>` tag of `component` takes: its
    /// parameters ([`Self::livewire_parameters`]) in kebab case.
    pub fn livewire_tag_attributes(&self, component: &LivewireComponent) -> Vec<LivewireMember> {
        let mut out: Vec<LivewireMember> = Vec::new();
        for parameter in self.livewire_parameters(&component.class) {
            let name = kebab(&parameter.name);
            if !out.iter().any(|known| known.name == name) {
                out.push(LivewireMember { name, ..parameter });
            }
        }
        out
    }
}

/// What a `wire:` attribute's value holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireValue {
    /// A property (`wire:model`, `wire:model.live`).
    Property,
    /// An action (`wire:click`, `wire:submit.prevent`, `wire:keydown.enter`).
    Action,
}

/// The directives whose value is an action, as Livewire's documentation
/// lists them (any browser event works; these are the common ones).
const ACTION_DIRECTIVES: &[&str] = &[
    "click",
    "submit",
    "keydown",
    "keyup",
    "keypress",
    "change",
    "input",
    "blur",
    "focus",
    "init",
    "poll",
    "target",
    "mouseenter",
    "mouseleave",
    "dblclick",
    "scroll",
    "select",
    "paste",
    "copy",
];

/// A `wire:` attribute value at the caret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WireAt {
    pub what: WireValue,
    /// The byte range of the value (inside the quotes).
    pub value: std::ops::Range<u32>,
    /// The byte range of the name (a dotted property path's segment or an
    /// action) at the caret.
    pub word: std::ops::Range<u32>,
    /// For a property path, the segments before the caret's (`form`).
    pub path: Vec<String>,
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// The `wire:` attribute value the caret at `offset` is in, if any.
pub fn wire_value_at(text: &str, offset: u32) -> Option<WireAt> {
    let b = text.as_bytes();
    let offset = (offset as usize).min(b.len());
    // The opening quote: the nearest quote before the caret, preceded by `=`.
    let quote_at = (0..offset).rev().find(|&at| matches!(b[at], b'"' | b'\'' | b'<' | b'>' | b'\n'))?;
    let quote = b[quote_at];
    if !matches!(quote, b'"' | b'\'') || quote_at == 0 || b[quote_at - 1] != b'=' {
        return None;
    }
    let name_end = quote_at - 1;
    let name_start =
        (0..name_end).rev().find(|&at| b[at].is_ascii_whitespace() || b[at] == b'<').map_or(0, |at| at + 1);
    let name = &text[name_start..name_end];
    let directive = name.strip_prefix("wire:")?;
    let directive = directive.split('.').next().unwrap_or_default();
    let what = if directive == "model" {
        WireValue::Property
    } else if ACTION_DIRECTIVES.contains(&directive) {
        WireValue::Action
    } else {
        return None;
    };
    let value_start = quote_at + 1;
    let value_end = (value_start..b.len()).find(|&at| b[at] == quote || b[at] == b'\n').unwrap_or(b.len());
    let start = (value_start..offset).rev().find(|&at| !is_word(b[at])).map_or(value_start, |at| at + 1);
    let end = (offset..value_end).find(|&at| !is_word(b[at])).unwrap_or(value_end);
    let mut path = Vec::new();
    if what == WireValue::Property && start > value_start && b[start - 1] == b'.' {
        let head = &text[value_start..start - 1];
        if head.bytes().all(|c| is_word(c) || c == b'.') {
            path = head.split('.').map(str::to_owned).collect();
        } else {
            return None;
        }
    } else if start != value_start && what == WireValue::Property {
        return None;
    }
    Some(WireAt { what, value: value_start as u32..value_end as u32, word: start as u32..end as u32, path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_view_a_render_method_names() {
        let text = "class A {\n    public function render() { return view('livewire.posts.list', ['x' => 1]); }\n}";
        assert_eq!(rendered_view(text).as_deref(), Some("livewire.posts.list"));
        assert_eq!(rendered_view("return $this->view(\"a\"); return preview('b');").as_deref(), None);
        assert_eq!(rendered_view("return view(\"a.b\");").as_deref(), Some("a.b"));
    }

    #[test]
    fn reads_registrations_of_a_provider() {
        let text = r#"<?php
namespace App\Providers;

use App\Http\Widgets\Clock;
use Livewire\Livewire;

class AppServiceProvider
{
    public function boot(): void
    {
        Livewire::component('clock', Clock::class);
        \Livewire\Livewire::component('admin.stats', 'App\\Admin\\Stats');
        Livewire::component($dynamic, Clock::class);
    }
}
"#;
        let lines = LineIndex::new(text);
        let found: Vec<(String, String, &str)> = registrations(text)
            .into_iter()
            .map(|(alias, class, at)| {
                let (start, end) = lines.byte_range(at);
                (alias, class, &text[start as usize..end as usize])
            })
            .collect();
        // With the alias's range, inside the quotes.
        assert_eq!(
            found,
            [
                ("clock".to_owned(), "App\\Http\\Widgets\\Clock".to_owned(), "clock"),
                ("admin.stats".to_owned(), "App\\Admin\\Stats".to_owned(), "admin.stats")
            ]
        );
        assert!(registrations("<?php Gate::define('x', fn () => true);").is_empty());
    }

    #[test]
    fn hooks_are_not_actions() {
        for hook in ["mount", "render", "updatedTitle", "hydrate", "dehydrateFoo", "bootWithTrait", "__construct"] {
            assert!(is_hook(hook), "{hook}");
        }
        for action in ["save", "update", "updater", "increment", "booking"] {
            assert!(!is_hook(action), "{action}");
        }
    }

    #[test]
    fn wire_values() {
        let at = |source: &str| {
            let offset = source.find('|').unwrap();
            let text = source.replace('|', "");
            wire_value_at(&text, offset as u32).map(|found| {
                (found.what, text[found.word.start as usize..found.word.end as usize].to_owned(), found.path)
            })
        };
        assert_eq!(at(r#"<input wire:model="ti|tle">"#), Some((WireValue::Property, "title".into(), vec![])));
        assert_eq!(at(r#"<input wire:model.live.debounce="|">"#), Some((WireValue::Property, String::new(), vec![])));
        assert_eq!(
            at(r#"<input wire:model="form.ti|">"#),
            Some((WireValue::Property, "ti".into(), vec!["form".to_owned()]))
        );
        assert_eq!(at(r#"<button wire:click="sa|ve(1)">"#), Some((WireValue::Action, "save".into(), vec![])));
        assert_eq!(at(r#"<form wire:submit.prevent='|'>"#), Some((WireValue::Action, String::new(), vec![])));
        assert_eq!(at(r#"<button wire:click="$ref|">"#), Some((WireValue::Action, "$ref".into(), vec![])));
        // Not a value, or not a directive with members.
        assert_eq!(at(r#"<input wire:model="title" |>"#), None);
        assert_eq!(at(r#"<div wire:loading="|">"#), None);
        assert_eq!(at(r#"<div class="|">"#), None);
    }
}
