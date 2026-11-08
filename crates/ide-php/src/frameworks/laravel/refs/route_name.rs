//! The `routeName` reference kind: the names of the project's routes
//! ([`RouteTable`]) in `route('home')`, `to_route('home')`,
//! `redirect()->route('home')`, `URL::route('home')`, `Redirect::route(…)`,
//! `Route::has('home')` and the signed-URL variants, as Laravel's
//! documentation on named routes and URL generation lists them.
//!
//! The declaration is the `->name('posts.create')` literal of the route,
//! whose group name prefixes (`dashboard.`) make the full name. Goto goes
//! there; renaming changes the part of the name written there, in the
//! literal and in every usage (the group's prefix stays). A resource's
//! names come from its name (`Route::resource('posts', …)` gives
//! `posts.index`, …): they resolve to it but aren't renamed.

use std::path::Path;

use super::{CalleePattern, Declared, PlacePattern, Position, RefContext, RefItem, ReferenceKind, RenameTarget};
use crate::frameworks::laravel::RouteTable;
use crate::navigate::Target;
use crate::syntax::ParsedFile;

/// The router: Laravel's `Route` facade (and its global alias) and router.
pub(super) const ROUTER: &[&str] = &[
    "Illuminate\\Support\\Facades\\Route",
    "Route",
    "Illuminate\\Routing\\Router",
    "Illuminate\\Contracts\\Routing\\Registrar",
];

/// What makes URLs and redirects to routes.
const URLS: &[&str] = &[
    "Illuminate\\Routing\\UrlGenerator",
    "Illuminate\\Contracts\\Routing\\UrlGenerator",
    "Illuminate\\Support\\Facades\\URL",
    "URL",
];
const REDIRECTS: &[&str] = &["Illuminate\\Routing\\Redirector", "Illuminate\\Support\\Facades\\Redirect", "Redirect"];

const ROUTE: CalleePattern = CalleePattern::Function("route");
const TO_ROUTE: CalleePattern = CalleePattern::Function("to_route");
const URL_ROUTE: CalleePattern =
    CalleePattern::Method { classes: URLS, names: &["route", "signedRoute", "temporarySignedRoute"] };
const REDIRECT_ROUTE: CalleePattern = CalleePattern::Method { classes: REDIRECTS, names: &["route"] };
const HAS: CalleePattern = CalleePattern::Method { classes: ROUTER, names: &["has"] };

static PATTERNS: [PlacePattern; 6] = [
    PlacePattern::argument(ROUTE, 0, "name"),
    PlacePattern::argument(TO_ROUTE, 0, "route"),
    PlacePattern::argument(URL_ROUTE, 0, "name"),
    PlacePattern::argument(REDIRECT_ROUTE, 0, "route"),
    // `Route::has('a')`, `Route::has(['a', 'b'])`.
    PlacePattern::argument(HAS, 0, "name"),
    PlacePattern::argument(HAS, 0, "name").at(Position::ListValue),
];

/// See the module documentation.
pub struct RouteName;

impl RouteName {
    fn routes(cx: &RefContext<'_>) -> std::sync::Arc<RouteTable> {
        cx.engine.laravel_routes().unwrap_or_default()
    }
}

impl ReferenceKind for RouteName {
    fn id(&self) -> &'static str {
        "routeName"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        let routes = Self::routes(cx);
        routes
            .routes()
            .iter()
            .filter_map(|route| {
                let name = route.name.clone()?;
                let methods = route.methods.iter().filter(|method| *method != "HEAD").cloned().collect::<Vec<_>>();
                let detail = format!("{} /{}", methods.join("|"), route.uri);
                Some(RefItem { insert: name.clone(), label: name, detail: Some(detail), from: 0, to: value.len() })
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let routes = Self::routes(cx);
        let mut out: Vec<Target> = Vec::new();
        for route in routes.named(value) {
            let range = route.name_decl.as_ref().map_or(route.range, |decl| decl.range);
            let target = Target { path: route.path.clone(), range };
            if !out.contains(&target) {
                out.push(target);
            }
        }
        out
    }

    fn declared_at(&self, cx: &RefContext<'_>, path: &Path, _parsed: &ParsedFile, offset: u32) -> Option<Declared> {
        let routes = Self::routes(cx);
        let route = routes.declared_name_at(path, offset)?;
        let decl = route.name_decl.as_ref()?;
        if decl.resource {
            return None;
        }
        let name = route.name.clone()?;
        let at = name.len() - decl.local.len() + (offset.min(decl.end) - decl.start) as usize;
        Some(Declared { value: name, start: decl.start, end: decl.end, at })
    }

    fn rename_target(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Option<RenameTarget> {
        let routes = Self::routes(cx);
        let route = routes.named(value).next()?;
        let decl = route.name_decl.as_ref().filter(|decl| !decl.resource)?;
        let start = value.len().checked_sub(decl.local.len()).filter(|start| value[*start..] == decl.local)?;
        Some(RenameTarget {
            key: value.to_owned(),
            range: (start, value.len()),
            declaration: Some((route.path.clone(), decl.range)),
        })
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        Self::routes(cx).named(value).next().is_some()
    }
}
