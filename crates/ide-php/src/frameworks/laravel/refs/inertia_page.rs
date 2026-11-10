//! The `inertiaPage` reference kind: the names of the project's Inertia
//! pages ([`InertiaPages`]) in `Inertia::render('Posts/Index')`,
//! `inertia('…')`, `Route::inertia('/about', 'About')` and a test's
//! `$page->component('…')` (`AssertableInertia`), as Inertia's
//! documentation on responses, routing and testing lists them.
//!
//! Completion lists the pages, goto opens the page's file (Vue, React or
//! Svelte). A name no page has is reported by `PhpUndefinedInertiaPage`
//! ([`crate::inspect::laravel`]) when a page folder exists, with a
//! "Create page" quick-fix writing the file. Renaming the last segment of a
//! name renames the page's file and every usage; find usages and rename
//! also start from the page file itself
//! ([`PhpEngine::laravel_inertia_page_references`](crate::engine::PhpEngine::laravel_inertia_page_references)).
//! Nothing is answered unless Inertia is installed.

use ide_core::{FileEdit, Severity};

use super::route_name::ROUTER;
use super::{CalleePattern, PlacePattern, RefContext, RefItem, ReferenceKind, RenameTarget, Undefined};
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

    fn canonical(&self, _cx: &RefContext<'_>, value: &str) -> String {
        value.trim_matches('/').to_owned()
    }

    /// The last segment of a page's name (`Index` of `Posts/Index`) when
    /// its file is named after it; the file is renamed with it.
    fn rename_target(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Option<RenameTarget> {
        let pages = Self::pages(cx);
        let page = pages.get(value).filter(|page| page.name == value)?;
        let start = value.rfind('/').map_or(0, |slash| slash + 1);
        let file = page.path.file_name()?.to_string_lossy();
        if !file.starts_with(&value[start..]) || cx.engine.is_library(&page.path) {
            return None;
        }
        Some(RenameTarget { key: value.to_owned(), range: (start, value.len()), declarations: Vec::new() })
    }

    /// One segment that can be a file name.
    fn valid_name(&self, name: &str) -> bool {
        !name.is_empty()
            && name != "."
            && name != ".."
            && !name.contains(['/', '\\', '\'', '"', ':', '*', '?', '<', '>', '|'])
            && !name.contains(char::is_whitespace)
    }

    fn rename_files(&self, cx: &RefContext<'_>, key: &str, new_value: &str) -> Vec<FileEdit> {
        let pages = Self::pages(cx);
        let Some(page) = pages.get(key) else { return Vec::new() };
        let (old, new) = (key.rsplit('/').next().unwrap_or(key), new_value.rsplit('/').next().unwrap_or(new_value));
        let Some(file) = page.path.file_name().map(|file| file.to_string_lossy().into_owned()) else {
            return Vec::new();
        };
        let Some(rest) = file.strip_prefix(old) else { return Vec::new() };
        let to = page.path.with_file_name(format!("{new}{rest}"));
        if to == page.path {
            return Vec::new();
        }
        vec![FileEdit::Rename { from: page.path.clone().into(), to: to.into() }]
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
            fixes: Vec::new(),
        };
        let Some(path) = pages.new_path(value) else { return Some(problem) };
        let extension = path.extension().map(|found| found.to_string_lossy().into_owned()).unwrap_or_default();
        let text = page_template(value, &extension);
        Some(problem.with_fix(format!("Create page '{value}'"), creation_edit(vec![GeneratedFile { path, text }])))
    }
}
