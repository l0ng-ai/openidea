//! The `middleware` reference kind: middleware aliases and groups
//! ([`MiddlewareDef`]) in `Route::middleware('auth')`, `->middleware([…])`,
//! `->withoutMiddleware(…)`, a controller's `$this->middleware(…)` and the
//! `middleware` of `Route::group([…])`. A value may carry parameters
//! (`throttle:60,1`, `can:update,post`): only the name before `:` is a
//! reference. Goto opens the alias's class (or where the project declares
//! it, for a group).
//!
//! The parameters of three of Laravel's middleware are references too
//! ([`Parameter`]): the ability of `can:update,post` (completion, goto and
//! hover as the `gate` kind does it, the model from the route parameter or
//! class after it), and the guards of `auth:web,api` and `guest:web`.
//!
//! [`MiddlewareDef`]: crate::frameworks::laravel::MiddlewareDef

use super::gate::{ability_hover, ability_items, ability_targets, guard_items, guard_targets};
use super::{CalleePattern, PlacePattern, Position, RefContext, RefItem, ReferenceKind};
use crate::frameworks::laravel::RouteTable;
use crate::navigate::Target;

/// What takes middleware: the router, a group's registrar, a route, a
/// resource registration and a controller.
const CLASSES: &[&str] = &[
    "Illuminate\\Support\\Facades\\Route",
    "Route",
    "Illuminate\\Routing\\Router",
    "Illuminate\\Routing\\RouteRegistrar",
    "Illuminate\\Routing\\Route",
    "Illuminate\\Routing\\PendingResourceRegistration",
    "Illuminate\\Routing\\PendingSingletonResourceRegistration",
    "Illuminate\\Routing\\Controller",
];
const ROUTER: &[&str] = &["Illuminate\\Support\\Facades\\Route", "Route", "Illuminate\\Routing\\Router"];

const MIDDLEWARE: CalleePattern =
    CalleePattern::Method { classes: CLASSES, names: &["middleware", "withoutMiddleware"] };
const GROUP: CalleePattern = CalleePattern::Method { classes: ROUTER, names: &["group"] };

static PATTERNS: [PlacePattern; 3] = [
    PlacePattern::argument(MIDDLEWARE, 0, "middleware"),
    PlacePattern::argument(MIDDLEWARE, 0, "middleware").at(Position::ListValue),
    // `Route::group(['middleware' => 'auth'], …)`.
    PlacePattern::argument(GROUP, 0, "attributes").at(Position::ValueOfKey("middleware")),
];

/// The name of a middleware value (`throttle` of `throttle:60,1`).
fn name_of(value: &str) -> &str {
    value.split_once(':').map_or(value, |(name, _)| name)
}

/// A parameter of a middleware value that is a reference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Parameter<'v> {
    /// The ability of `can:`, with the parameters after it (the models).
    Ability { name: &'v str, subjects: Vec<String> },
    /// A guard of `auth:` or `guest:`.
    Guard(&'v str),
}

/// The parameter of `value` around byte `at` and its byte range, when it is
/// a reference.
pub fn parameter_at(value: &str, at: usize) -> Option<(Parameter<'_>, usize, usize)> {
    let (name, params) = value.split_once(':')?;
    let base = name.len() + 1;
    if at < base {
        return None;
    }
    let mut start = base;
    let mut parts = Vec::new();
    for part in params.split(',') {
        parts.push((start, part));
        start += part.len() + 1;
    }
    let index = parts.iter().rposition(|(start, _)| *start <= at)?;
    let (start, part) = parts[index];
    let end = start + part.len();
    match name {
        "can" if index == 0 => {
            let subjects = parts[1..].iter().map(|(_, part)| part.trim().to_owned()).collect();
            Some((Parameter::Ability { name: part, subjects }, start, end))
        }
        "auth" | "guest" => Some((Parameter::Guard(part), start, end)),
        _ => None,
    }
}

/// See the module documentation.
pub struct Middleware;

impl Middleware {
    fn table(cx: &RefContext<'_>) -> std::sync::Arc<RouteTable> {
        cx.engine.laravel_routes().unwrap_or_default()
    }
}

impl ReferenceKind for Middleware {
    fn id(&self) -> &'static str {
        "middleware"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let to = value.find(':').unwrap_or(value.len());
        if at > to {
            // In the parameters.
            return match parameter_at(value, at) {
                Some((Parameter::Ability { subjects, .. }, start, end)) => ability_items(cx, &subjects, start, end),
                Some((Parameter::Guard(_), start, end)) => guard_items(cx, start, end),
                None => Vec::new(),
            };
        }
        Self::table(cx)
            .middleware()
            .iter()
            .map(|middleware| {
                let detail = match &middleware.class {
                    Some(class) => class.rsplit('\\').next().unwrap_or(class).to_owned(),
                    None => "group".to_owned(),
                };
                RefItem {
                    label: middleware.name.clone(),
                    insert: middleware.name.clone(),
                    detail: Some(detail),
                    from: 0,
                    to,
                }
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<Target> {
        match parameter_at(value, at) {
            Some((Parameter::Ability { name, subjects }, ..)) => return ability_targets(cx, &subjects, name),
            Some((Parameter::Guard(name), ..)) => return guard_targets(cx, name),
            None => {}
        }
        let name = name_of(value);
        let table = Self::table(cx);
        let Some(middleware) = table.middleware_named(name) else {
            // A class name.
            return cx.engine.class_targets(name.trim_start_matches('\\'));
        };
        let mut out = middleware.class.as_deref().map(|class| cx.engine.class_targets(class)).unwrap_or_default();
        if out.is_empty()
            && let Some((path, range)) = &middleware.declared
        {
            out.push(Target { path: path.clone(), range: *range });
        }
        out
    }

    fn usage_words(&self, value: &str) -> Vec<String> {
        crate::index::words(name_of(value))
    }

    fn usage_text<'v>(&self, value: &'v str) -> &'v str {
        name_of(value)
    }

    fn canonical(&self, _cx: &RefContext<'_>, value: &str) -> String {
        name_of(value).to_owned()
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let at = value.find(':')? + 1;
        match parameter_at(value, at)? {
            (Parameter::Ability { name, subjects }, ..) => ability_hover(cx, &subjects, name),
            (Parameter::Guard(_), ..) => None,
        }
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        let name = name_of(value);
        Self::table(cx).middleware_named(name).is_some()
            || cx.engine.resolver().class_model(name.trim_start_matches('\\')).is_some()
    }
}
