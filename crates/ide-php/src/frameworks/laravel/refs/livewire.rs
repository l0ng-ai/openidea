//! The `livewireComponent` reference kind: the names of the project's
//! Livewire components ([`LivewireComponents`]) in `@livewire('counter')`
//! (compiled to a `__blade_livewire(…)` call, [`crate::blade::CALL_DIRECTIVES`])
//! and in `Livewire::test('counter')` and `Livewire::visit(…)`, as
//! Livewire's documentation on components and testing lists them.
//! Completion lists the components, goto opens the class and the view.
//! Nothing is answered unless Livewire is installed.
//!
//! `<livewire:counter />` tags are Blade's
//! ([`crate::frameworks::laravel::blade`]).

use super::{CalleePattern, PlacePattern, RefContext, RefItem, ReferenceKind};
use crate::frameworks::laravel::LivewireComponents;
use crate::navigate::Target;

const LIVEWIRE: &[&str] = &["Livewire\\Livewire", "Livewire\\LivewireManager"];

const DIRECTIVE: CalleePattern = CalleePattern::Function("__blade_livewire");
const TEST: CalleePattern = CalleePattern::Method { classes: LIVEWIRE, names: &["test", "visit"] };

static PATTERNS: [PlacePattern; 2] =
    [PlacePattern::argument(DIRECTIVE, 0, "name"), PlacePattern::argument(TEST, 0, "name")];

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
