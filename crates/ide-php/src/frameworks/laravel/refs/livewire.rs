//! The `livewireComponent` reference kind: the names of the project's
//! Livewire components ([`LivewireComponents`]) in `@livewire('counter')`
//! (compiled to a `__blade_livewire(…)` call, [`crate::blade::CALL_DIRECTIVES`])
//! and in `Livewire::test('counter')` and `Livewire::visit(…)`, as
//! Livewire's documentation on components and testing lists them.
//! Completion lists the components, goto opens the class and the view.
//! Nothing is answered unless Livewire is installed.
//!
//! The `livewireParameter` kind is the keys of the parameters array after
//! the name (`@livewire('counter', ['start' => 1])`,
//! `Livewire::test(Counter::class, [...])`): the parameters of the
//! component's `mount()` and its public properties, which Livewire fills
//! from them.
//!
//! `<livewire:counter />` tags are Blade's
//! ([`crate::frameworks::laravel::blade`]); they count as usages of the
//! name ([`ReferenceKind::markup_usages`]).
//!
//! Find usages starts from a usage, from the alias of a
//! `Livewire::component('alias', …)` registration, and from the component's
//! class (its usages include the names' usages,
//! [`PhpEngine::livewire_class_usages`]). A registered alias can be renamed
//! (with its registration and tags); a discovered name follows its class.

use std::path::Path;

use ide_core::{CancellationToken, IdeResult};

use super::{CalleePattern, Declared, PlacePattern, Position, RefContext, RefItem, ReferenceKind, RenameTarget};
use crate::blade::tags::{LIVEWIRE_PREFIXES, tag_at_with};
use crate::engine::PhpEngine;
use crate::frameworks::laravel::LivewireComponents;
use crate::frameworks::laravel::views::is_blade;
use crate::names::{NameKind, fqn_eq};
use crate::navigate::{Target, Usage, UsageKind};
use crate::syntax::ParsedFile;

const LIVEWIRE: &[&str] = &["Livewire\\Livewire", "Livewire\\LivewireManager"];

const DIRECTIVE: CalleePattern = CalleePattern::Function("__blade_livewire");
const TEST: CalleePattern = CalleePattern::Method { classes: LIVEWIRE, names: &["test", "visit"] };

const TEST_WITH_PARAMETERS: CalleePattern = CalleePattern::Method { classes: LIVEWIRE, names: &["test"] };

static PATTERNS: [PlacePattern; 2] =
    [PlacePattern::argument(DIRECTIVE, 0, "name"), PlacePattern::argument(TEST, 0, "name")];

// A key being typed is a list value until its `=>` is there.
static PARAMETER_PATTERNS: [PlacePattern; 4] = [
    PlacePattern::argument(DIRECTIVE, 1, "params").at(Position::ArrayKey),
    PlacePattern::argument(DIRECTIVE, 1, "params").at(Position::ListValue),
    PlacePattern::argument(TEST_WITH_PARAMETERS, 1, "params").at(Position::ArrayKey),
    PlacePattern::argument(TEST_WITH_PARAMETERS, 1, "params").at(Position::ListValue),
];

/// See the module documentation.
pub struct LivewireComponentKind;

impl LivewireComponentKind {
    fn components(cx: &RefContext<'_>) -> std::sync::Arc<LivewireComponents> {
        cx.engine.laravel_livewire().unwrap_or_default()
    }
}

impl ReferenceKind for LivewireComponentKind {
    fn id(&self) -> &'static str {
        "livewireComponent"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        Self::components(cx)
            .components
            .iter()
            .map(|component| RefItem {
                label: component.name.clone(),
                insert: component.name.clone(),
                detail: Some(component.class.clone()),
                from: 0,
                to: value.len(),
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let components = Self::components(cx);
        let Some(component) = components.get(value) else { return Vec::new() };
        let mut out = vec![Target { path: component.path.clone(), range: component.range }];
        out.extend(component.view.clone().map(|path| Target { path, range: Default::default() }));
        out
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        !cx.project.packages.livewire || Self::components(cx).get(value).is_some()
    }

    /// The alias of a `Livewire::component('alias', …)` registration.
    fn declared_at(&self, cx: &RefContext<'_>, path: &Path, parsed: &ParsedFile, offset: u32) -> Option<Declared> {
        let path = crate::project::normalize(path);
        let components = Self::components(cx);
        let lines = parsed.line_index();
        components.components.iter().find_map(|component| {
            let (provider, range) = component.alias.as_ref()?;
            let (start, end) = lines.byte_range(*range);
            let found = *provider == path
                && (start..=end).contains(&offset)
                && parsed.text().get(start as usize..end as usize) == Some(component.name.as_str());
            found.then(|| Declared { value: component.name.clone(), start, end, at: (offset - start) as usize })
        })
    }

    /// A registered alias, with its registration; a discovered name follows
    /// its class and can't be renamed on its own.
    fn rename_target(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Option<RenameTarget> {
        let components = Self::components(cx);
        let (provider, range) = components.get(value)?.alias.clone()?;
        if cx.engine.is_library(&provider) {
            return None;
        }
        Some(RenameTarget { key: value.to_owned(), range: (0, value.len()), declarations: vec![(provider, range)] })
    }

    fn valid_name(&self, name: &str) -> bool {
        !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
            && !name.starts_with(['.', ':', '-'])
    }

    fn markup_words(&self, key: &str) -> Vec<String> {
        let mut words = crate::index::words(key);
        words.push("livewire".to_owned());
        words
    }

    /// The `<livewire:name …>` tags of a Blade template.
    fn markup_usages(&self, _cx: &RefContext<'_>, path: &Path, text: &str, key: &str) -> Vec<(u32, u32)> {
        if !is_blade(path) {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut from = 0;
        while let Some(at) = text[from..].find("<livewire:") {
            let start = from + at;
            from = start + 1;
            let Some(tag) = tag_at_with(text, start, LIVEWIRE_PREFIXES) else { continue };
            if text.get(tag.name.start as usize..tag.name.end as usize) == Some(key) {
                out.push((tag.name.start, tag.name.end));
            }
        }
        out
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let components = Self::components(cx);
        let component = components.get(value)?;
        let mut out = format!("Livewire component `{}`\n\n`{}`", component.name, component.class);
        if let Some(view) = &component.view {
            let relative = view.strip_prefix(&cx.project.root).unwrap_or(view);
            out.push_str(&format!("\n\nView: `{}`", relative.to_string_lossy().replace('\\', "/")));
        }
        Some(out)
    }
}

/// See the module documentation.
pub struct LivewireParameterKind;

impl LivewireParameterKind {
    /// The parameters of the component the call names first.
    fn parameters(cx: &RefContext<'_>) -> Vec<crate::frameworks::laravel::LivewireMember> {
        let Some(first) = cx.site.as_ref().and_then(|site| site.first_argument.clone()) else { return Vec::new() };
        let components = LivewireComponentKind::components(cx);
        let class = match components.find(&first) {
            Some(component) => component.class.clone(),
            None => return Vec::new(),
        };
        cx.engine.livewire_parameters(&class)
    }
}

impl ReferenceKind for LivewireParameterKind {
    fn id(&self) -> &'static str {
        "livewireParameter"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PARAMETER_PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        Self::parameters(cx)
            .into_iter()
            .map(|parameter| RefItem {
                label: parameter.name.clone(),
                insert: parameter.name,
                detail: parameter.detail,
                from: 0,
                to: value.len(),
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        Self::parameters(cx).into_iter().filter(|parameter| parameter.name == value).filter_map(|p| p.target).collect()
    }

    fn is_known(&self, _cx: &RefContext<'_>, _value: &str) -> bool {
        true
    }
}

impl PhpEngine {
    /// The usages of the names of the Livewire components of class `fqn`
    /// (`@livewire('counter')`, `<livewire:counter />`,
    /// `Livewire::test('counter')`), and the aliases registering it, for
    /// find usages of the class. Empty outside Laravel projects with
    /// Livewire.
    pub(crate) fn livewire_class_usages(&self, fqn: &str, cancel: &CancellationToken) -> IdeResult<Vec<Usage>> {
        let Some(cx) = self.ref_context() else { return Ok(Vec::new()) };
        let Some(components) = self.laravel_livewire() else { return Ok(Vec::new()) };
        let fqn = fqn.trim_start_matches('\\');
        let mut out = Vec::new();
        for component in components.components.iter().filter(|c| fqn_eq(NameKind::ClassLike, &c.class, fqn)) {
            let name = &component.name;
            out.extend(self.kind_usages(&cx, &LivewireComponentKind, name, name, false, cancel)?);
            if let Some((path, range)) = &component.alias {
                out.push(Usage { path: path.clone(), range: *range, kind: UsageKind::String });
            }
        }
        Ok(out)
    }
}
