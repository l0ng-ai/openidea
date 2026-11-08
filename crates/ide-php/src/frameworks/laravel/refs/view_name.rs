//! The `viewName` reference kind: the names of the project's views
//! ([`ViewTable`]) in `view('posts.index')`, `View::make(…)` and the view
//! factory's other methods (`exists`, `first`, `composer`, `creator`),
//! `Route::view('/about', 'about')`, `response()->view(…)`, a mailable's or
//! mail message's `view()`, `markdown()` and `text()`, `new Content(view: …,
//! markdown: …)`, and the Blade directives `@include` (and its `If`, `When`,
//! `Unless`, `First` forms), `@extends`, `@each` and `@component`, which the
//! Blade compiler turns into `__blade_<directive>(…)` calls
//! ([`crate::blade::VIEW_CALL_PREFIX`]); as Laravel's documentation on
//! views, Blade, responses and mail lists them.
//!
//! Completion goes as a path tree, segment by segment (after `posts.` the
//! views and folders of `resources/views/posts`; namespaces as `billing::`).
//! Goto opens the view's file. Renaming changes the name after its
//! namespace in every usage and moves the file.

use ide_core::FileEdit;

use super::route_name::ROUTER;
use super::{CalleePattern, PlacePattern, Position, RefContext, RefItem, ReferenceKind, RenameTarget};
use crate::frameworks::laravel::views::{ViewTable, normalize_name, relative_file, valid_local_name};
use crate::navigate::Target;

/// The view factory: Laravel's `View` facade (and its global alias), the
/// factory and its contract.
const FACTORY: &[&str] = &[
    "Illuminate\\Support\\Facades\\View",
    "View",
    "Illuminate\\View\\Factory",
    "Illuminate\\Contracts\\View\\Factory",
];
const RESPONSES: &[&str] = &[
    "Illuminate\\Routing\\ResponseFactory",
    "Illuminate\\Contracts\\Routing\\ResponseFactory",
    "Illuminate\\Support\\Facades\\Response",
    "Response",
];
const MAIL: &[&str] = &["Illuminate\\Mail\\Mailable", "Illuminate\\Notifications\\Messages\\MailMessage"];
const CONTENT: &[&str] = &["Illuminate\\Mail\\Mailables\\Content"];

const VIEW: CalleePattern = CalleePattern::Function("view");
const MAKE: CalleePattern = CalleePattern::Method { classes: FACTORY, names: &["make", "exists"] };
const FIRST: CalleePattern = CalleePattern::Method { classes: FACTORY, names: &["first"] };
const COMPOSER: CalleePattern = CalleePattern::Method { classes: FACTORY, names: &["composer", "creator"] };
const ROUTE_VIEW: CalleePattern = CalleePattern::Method { classes: ROUTER, names: &["view"] };
const RESPONSE_VIEW: CalleePattern = CalleePattern::Method { classes: RESPONSES, names: &["view"] };
const MAIL_VIEW: CalleePattern = CalleePattern::Method { classes: MAIL, names: &["view", "markdown", "text"] };
const NEW_CONTENT: CalleePattern = CalleePattern::Method { classes: CONTENT, names: &["__construct"] };

/// The function a Blade view directive compiles to (named with
/// [`crate::blade::VIEW_CALL_PREFIX`]).
const fn blade(name: &'static str) -> CalleePattern {
    CalleePattern::Function(name)
}

static PATTERNS: [PlacePattern; 23] = [
    PlacePattern::argument(VIEW, 0, "view"),
    PlacePattern::argument(MAKE, 0, "view"),
    PlacePattern::argument(FIRST, 0, "views").at(Position::ListValue),
    PlacePattern::argument(COMPOSER, 0, "views"),
    PlacePattern::argument(COMPOSER, 0, "views").at(Position::ListValue),
    PlacePattern::argument(ROUTE_VIEW, 1, "view"),
    PlacePattern::argument(RESPONSE_VIEW, 0, "view"),
    PlacePattern::argument(MAIL_VIEW, 0, "view"),
    PlacePattern::argument(NEW_CONTENT, 0, "view"),
    PlacePattern::argument(NEW_CONTENT, 1, "html"),
    PlacePattern::argument(NEW_CONTENT, 2, "text"),
    PlacePattern::argument(NEW_CONTENT, 3, "markdown"),
    // Blade (see the module documentation).
    PlacePattern::argument(blade("__blade_include"), 0, "view"),
    PlacePattern::argument(blade("__blade_includeIf"), 0, "view"),
    PlacePattern::argument(blade("__blade_includeWhen"), 1, "view"),
    PlacePattern::argument(blade("__blade_includeUnless"), 1, "view"),
    PlacePattern::argument(blade("__blade_includeFirst"), 0, "view").at(Position::ListValue),
    PlacePattern::argument(blade("__blade_each"), 0, "view"),
    PlacePattern::argument(blade("__blade_each"), 3, "empty"),
    PlacePattern::argument(blade("__blade_extends"), 0, "view"),
    PlacePattern::argument(blade("__blade_extendsFirst"), 0, "views").at(Position::ListValue),
    PlacePattern::argument(blade("__blade_component"), 0, "view"),
    PlacePattern::argument(blade("__blade_componentFirst"), 0, "views").at(Position::ListValue),
];

/// See the module documentation.
pub struct ViewName;

impl ViewName {
    fn views(cx: &RefContext<'_>) -> std::sync::Arc<ViewTable> {
        cx.engine.laravel_views().unwrap_or_default()
    }
}

/// The end of the segment of `value` the byte `at` is in.
fn segment_end(value: &str, at: usize) -> usize {
    value[at.min(value.len())..].find(['.', '/']).map_or(value.len(), |dot| at + dot)
}

impl ReferenceKind for ViewName {
    fn id(&self) -> &'static str {
        "viewName"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let views = Self::views(cx);
        let typed = &value[..at.min(value.len())];
        let to = segment_end(value, at);
        let (namespace, local_start) = match typed.find("::") {
            Some(colons) => (Some(&typed[..colons]), colons + 2),
            None => (None, 0),
        };
        let local = &typed[local_start..];
        let (parent, from) = match local.rfind(['.', '/']) {
            Some(dot) => (Some(local[..dot].replace('/', ".")), local_start + dot + 1),
            None => (None, local_start),
        };
        let root = cx.project.root.clone();
        let relative =
            |path: &std::path::Path| path.strip_prefix(&root).unwrap_or(path).to_string_lossy().replace('\\', "/");
        let mut items: Vec<RefItem> = views
            .children(namespace, parent.as_deref())
            .into_iter()
            .map(|child| {
                let detail = match &child.view {
                    Some(path) => relative(path),
                    None => format!("{}/", child.segment),
                };
                RefItem { insert: child.segment.clone(), label: child.segment, detail: Some(detail), from, to }
            })
            .collect();
        if namespace.is_none() && parent.is_none() {
            for known in views.namespaces() {
                let label = format!("{}::", known.name);
                let detail = known.dirs.first().map(|dir| relative(dir));
                items.push(RefItem { insert: label.clone(), label, detail, from, to });
            }
        }
        items
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let views = Self::views(cx);
        views.get(value).map(|view| Target { path: view.path.clone(), range: Default::default() }).into_iter().collect()
    }

    fn canonical(&self, _cx: &RefContext<'_>, value: &str) -> String {
        normalize_name(value)
    }

    fn rename_target(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Option<RenameTarget> {
        let views = Self::views(cx);
        views.get(value)?;
        let start = value.find("::").map_or(0, |colons| colons + 2);
        Some(RenameTarget { key: normalize_name(value), range: (start, value.len()), declaration: None })
    }

    fn valid_name(&self, name: &str) -> bool {
        valid_local_name(name)
    }

    fn rename_files(&self, cx: &RefContext<'_>, key: &str, new_value: &str) -> Vec<FileEdit> {
        let views = Self::views(cx);
        let Some(view) = views.get(key) else { return Vec::new() };
        let local = normalize_name(new_value);
        let local = local.split_once("::").map_or(local.as_str(), |(_, local)| local);
        let Some(to) = relative_file(&view.base, local, view.extension()) else { return Vec::new() };
        if to == view.path {
            return Vec::new();
        }
        vec![FileEdit::Rename { from: view.path.clone().into(), to: to.into() }]
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        Self::views(cx).get(value).is_some()
    }
}
