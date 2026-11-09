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
//! ([`crate::frameworks::laravel::blade`]).

use super::{CalleePattern, PlacePattern, Position, RefContext, RefItem, ReferenceKind};
use crate::frameworks::laravel::LivewireComponents;
use crate::navigate::Target;

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
