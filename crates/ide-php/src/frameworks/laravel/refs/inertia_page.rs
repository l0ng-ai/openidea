//! The `inertiaPage` reference kind: the names of the project's Inertia
//! pages ([`InertiaPages`]) in `Inertia::render('Posts/Index')`,
//! `inertia('…')`, `Route::inertia('/about', 'About')` and a test's
//! `$page->component('…')` (`AssertableInertia`), as Inertia's
//! documentation on responses, routing and testing lists them.
//!
//! Completion lists the pages, goto opens the page's file (Vue, React or
//! Svelte). A name no page has is reported by `PhpUndefinedInertiaPage`
//! ([`crate::inspect::laravel`]) when a page folder exists, with a
//! "Create page" quick-fix writing the file. Nothing is answered unless
//! Inertia is installed.

use ide_core::Severity;

use super::route_name::ROUTER;
use super::{CalleePattern, PlacePattern, RefContext, RefItem, ReferenceKind, Undefined};
use crate::frameworks::laravel::InertiaPages;
use crate::frameworks::laravel::generate::{GeneratedFile, creation_edit};
use crate::frameworks::laravel::inertia::page_template;
use crate::navigate::Target;

const INERTIA: &[&str] = &["Inertia\\Inertia", "Inertia\\ResponseFactory"];
const ASSERT: &[&str] = &["Inertia\\Testing\\AssertableInertia"];

const HELPER: CalleePattern = CalleePattern::Function("inertia");
const RENDER: CalleePattern = CalleePattern::Method { classes: INERTIA, names: &["render"] };
const ROUTE: CalleePattern = CalleePattern::Method { classes: ROUTER, names: &["inertia"] };
const COMPONENT: CalleePattern = CalleePattern::Method { classes: ASSERT, names: &["component"] };

static PATTERNS: [PlacePattern; 4] = [
    PlacePattern::argument(HELPER, 0, "component"),
    PlacePattern::argument(RENDER, 0, "component"),
    PlacePattern::argument(ROUTE, 1, "component"),
    PlacePattern::argument(COMPONENT, 0, "value"),
];

/// See the module documentation.
pub struct InertiaPageKind;

impl InertiaPageKind {
    fn pages(cx: &RefContext<'_>) -> std::sync::Arc<InertiaPages> {
        cx.engine.laravel_inertia().unwrap_or_default()
    }

    fn relative(cx: &RefContext<'_>, path: &std::path::Path) -> String {
        path.strip_prefix(&cx.project.root).unwrap_or(path).to_string_lossy().replace('\\', "/")
    }
}

impl ReferenceKind for InertiaPageKind {
    fn id(&self) -> &'static str {
        "inertiaPage"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        Self::pages(cx)
            .pages
            .iter()
            .map(|page| RefItem {
                label: page.name.clone(),
                insert: page.name.clone(),
                detail: Some(Self::relative(cx, &page.path)),
                from: 0,
                to: value.len(),
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let pages = Self::pages(cx);
        pages.get(value).map(|page| Target { path: page.path.clone(), range: Default::default() }).into_iter().collect()
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        !cx.project.packages.inertia || Self::pages(cx).get(value).is_some()
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let pages = Self::pages(cx);
        let page = pages.get(value)?;
        Some(format!("Inertia page `{}`\n\n`{}`", page.name, Self::relative(cx, &page.path)))
    }

    fn undefined(&self, cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
        let pages = Self::pages(cx);
        if !cx.project.packages.inertia || !pages.has_dir() || pages.get(value).is_some() {
            return None;
        }
        let problem = Undefined {
            message: format!("Inertia page '{value}' is not defined"),
            severity: Severity::Warning,
            fix: None,
        };
        let Some(path) = pages.new_path(value) else { return Some(problem) };
        let extension = path.extension().map(|found| found.to_string_lossy().into_owned()).unwrap_or_default();
        let text = page_template(value, &extension);
        Some(problem.with_fix(format!("Create page '{value}'"), creation_edit(vec![GeneratedFile { path, text }])))
    }
}
