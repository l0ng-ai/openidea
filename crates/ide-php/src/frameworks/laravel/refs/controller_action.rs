//! The `controllerAction` and `resourceAction` reference kinds.
//!
//! `controllerAction`: a controller method named in a route's action, as
//! Laravel's documentation on routing and controllers writes them:
//! `[PostController::class, 'index']`, `'PostController@index'` (relative to
//! the group's namespace) and `'index'` in a `Route::controller(…)` group,
//! in the action argument of `Route::get/post/put/patch/delete/options/any`
//! and `match`, and in `action()`, `to_action()`, `URL::action()` and
//! `redirect()->action()`. The class comes from the string's site (the
//! `Foo::class` before it, or the route registering it); a `'Foo@bar'`
//! outside route files is looked up as written, then under the app's
//! `Http\Controllers` namespace. Completion lists the controller's public
//! methods, goto opens the method, and find usages compares class and
//! method (the canonical value `Class@method`).
//!
//! `resourceAction`: the actions in `Route::resource(…)->only([…])` and
//! `->except([…])` (and the `only`/`except` options): completion of the
//! seven actions (five for `apiResource`) and goto to the controller's
//! method.

use super::route_name::ROUTER;
use super::{CalleePattern, PlacePattern, Position, RefContext, RefItem, ReferenceKind};
use crate::frameworks::laravel::routes::{API_RESOURCE_ACTIONS, RESOURCE_ACTIONS};
use crate::names::{NameKind, fqn_eq};
use crate::navigate::Target;
use crate::summary::{FileSummary, Visibility};

/// Route registrars: the router and the registrar of a group chain.
const REGISTRARS: &[&str] = &[
    "Illuminate\\Support\\Facades\\Route",
    "Route",
    "Illuminate\\Routing\\Router",
    "Illuminate\\Contracts\\Routing\\Registrar",
    "Illuminate\\Routing\\RouteRegistrar",
];
const URLS: &[&str] = &[
    "Illuminate\\Routing\\UrlGenerator",
    "Illuminate\\Contracts\\Routing\\UrlGenerator",
    "Illuminate\\Support\\Facades\\URL",
    "URL",
    "Illuminate\\Routing\\Redirector",
    "Illuminate\\Support\\Facades\\Redirect",
    "Redirect",
];

const VERBS: CalleePattern =
    CalleePattern::Method { classes: REGISTRARS, names: &["get", "post", "put", "patch", "delete", "options", "any"] };
const MATCH: CalleePattern = CalleePattern::Method { classes: REGISTRARS, names: &["match"] };
const ACTION: CalleePattern = CalleePattern::Function("action");
const TO_ACTION: CalleePattern = CalleePattern::Function("to_action");
const URL_ACTION: CalleePattern = CalleePattern::Method { classes: URLS, names: &["action"] };

static PATTERNS: [PlacePattern; 10] = [
    PlacePattern::argument(VERBS, 1, "action"),
    PlacePattern::argument(VERBS, 1, "action").at(Position::ListValue),
    PlacePattern::argument(MATCH, 2, "action"),
    PlacePattern::argument(MATCH, 2, "action").at(Position::ListValue),
    PlacePattern::argument(ACTION, 0, "name"),
    PlacePattern::argument(ACTION, 0, "name").at(Position::ListValue),
    PlacePattern::argument(TO_ACTION, 0, "action"),
    PlacePattern::argument(TO_ACTION, 0, "action").at(Position::ListValue),
    PlacePattern::argument(URL_ACTION, 0, "action"),
    PlacePattern::argument(URL_ACTION, 0, "action").at(Position::ListValue),
];

/// The class `name` (as written in a `'Foo@bar'` action) means: the class
/// of the site (the route's, resolved against its namespace), else `name`
/// itself when it is a class, else under the app's controllers namespace.
fn controller_class(cx: &RefContext<'_>, name: &str) -> Option<String> {
    let name = name.trim_start_matches('\\').replace("\\\\", "\\");
    if name.is_empty() {
        return None;
    }
    let mut candidates: Vec<String> = cx.class().map(str::to_owned).into_iter().collect();
    candidates.push(name.clone());
    candidates.push(format!("{}Http\\Controllers\\{name}", cx.project.app_namespace));
    let resolver = cx.engine.resolver();
    let known = candidates.iter().find(|class| resolver.class_model(class).is_some()).cloned();
    known.or_else(|| candidates.into_iter().next())
}

/// The class and method of a value, and the byte the method starts at.
fn action_of(cx: &RefContext<'_>, value: &str) -> Option<(String, String, usize)> {
    match value.split_once('@') {
        Some((class, method)) => Some((controller_class(cx, class)?, method.to_owned(), class.len() + 1)),
        None => Some((cx.class()?.to_owned(), value.to_owned(), 0)),
    }
}

/// The public methods of `class` that can be actions: not static, not
/// magic (but `__invoke`), not Laravel's own (the base controller's).
fn action_methods(cx: &RefContext<'_>, class: &str) -> Vec<(String, String)> {
    let resolver = cx.engine.resolver();
    let Some(model) = resolver.class_model(class) else { return Vec::new() };
    model
        .methods
        .iter()
        .filter(|method| {
            method.visibility == Visibility::Public
                && !method.is_static
                && (!method.name.starts_with("__") || method.name.eq_ignore_ascii_case("__invoke"))
                && !method.declaring.fqn.trim_start_matches('\\').starts_with("Illuminate\\")
        })
        .map(|method| {
            let declaring = method.declaring.fqn.trim_start_matches('\\');
            (method.name.clone(), declaring.rsplit('\\').next().unwrap_or(declaring).to_owned())
        })
        .collect()
}

/// Where method `name` of `class` is declared.
pub(crate) fn method_target(cx: &RefContext<'_>, class: &str, name: &str) -> Option<Target> {
    let resolver = cx.engine.resolver();
    let model = resolver.class_model(class)?;
    let method = model.method(name)?;
    let declared = method.declared()?;
    let path = cx.engine.class_path(&method.declaring, std::path::Path::new(""), &FileSummary::default())?;
    Some(Target { path, range: declared.name_loc.range })
}

/// See the module documentation.
pub struct ControllerAction;

impl ReferenceKind for ControllerAction {
    fn id(&self) -> &'static str {
        "controllerAction"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let Some((class, _, from)) = action_of(cx, &value[..at]) else { return Vec::new() };
        if at < from {
            return Vec::new();
        }
        action_methods(cx, &class)
            .into_iter()
            .map(|(name, declaring)| RefItem {
                insert: name.clone(),
                label: name,
                detail: Some(declaring),
                from,
                to: value.len(),
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<Target> {
        let Some((class, method, from)) = action_of(cx, value) else { return Vec::new() };
        if at + 1 < from && value.contains('@') {
            // On the class part of `'Foo@bar'`: the class.
            return cx.engine.class_targets(&class);
        }
        method_target(cx, &class, &method).into_iter().collect()
    }

    fn usage_words(&self, value: &str) -> Vec<String> {
        crate::index::words(self.usage_text(value))
    }

    fn usage_text<'v>(&self, value: &'v str) -> &'v str {
        value.rsplit_once('@').map_or(value, |(_, method)| method)
    }

    fn canonical(&self, cx: &RefContext<'_>, value: &str) -> String {
        match action_of(cx, value) {
            Some((class, method, _)) => format!("{class}@{method}"),
            None => value.to_owned(),
        }
    }

    fn refers_to(&self, value: &str, key: &str) -> bool {
        match (value.rsplit_once('@'), key.rsplit_once('@')) {
            (Some((class, method)), Some((key_class, key_method))) => {
                method.eq_ignore_ascii_case(key_method) && fqn_eq(NameKind::ClassLike, class, key_class)
            }
            _ => value == key,
        }
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        let Some((class, method, _)) = action_of(cx, value) else { return false };
        cx.engine.resolver().class_model(&class).is_some_and(|model| model.method(&method).is_some())
    }
}

/// `Route::resource(…)->only([…])`, `->except([…])` and the options.
const PENDING: CalleePattern = CalleePattern::Method {
    classes: &["Illuminate\\Routing\\PendingResourceRegistration"],
    names: &["only", "except"],
};
const RESOURCE: CalleePattern = CalleePattern::Method { classes: ROUTER, names: &["resource", "apiResource"] };

static RESOURCE_PATTERNS: [PlacePattern; 3] = [
    PlacePattern::argument(PENDING, 0, "methods"),
    PlacePattern::argument(PENDING, 0, "methods").at(Position::ListValue),
    // `['only' => ['index']]`.
    PlacePattern::argument(RESOURCE, 2, "options").at(Position::ListValue).nested(),
];

/// See the module documentation.
pub struct ResourceAction;

impl ResourceAction {
    /// The actions of the resource around the site.
    fn actions(cx: &RefContext<'_>) -> &'static [&'static str] {
        let api = cx.site.as_ref().and_then(|site| {
            let routes = cx.engine.laravel_routes()?;
            routes.route_at(&site.path, site.start)?.resource
        });
        if api == Some(true) { API_RESOURCE_ACTIONS } else { RESOURCE_ACTIONS }
    }
}

impl ReferenceKind for ResourceAction {
    fn id(&self) -> &'static str {
        "resourceAction"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &RESOURCE_PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        Self::actions(cx)
            .iter()
            .map(|action| RefItem {
                label: (*action).to_owned(),
                insert: (*action).to_owned(),
                detail: cx.class().map(|class| class.rsplit('\\').next().unwrap_or(class).to_owned()),
                from: 0,
                to: value.len(),
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let Some(class) = cx.class() else { return Vec::new() };
        method_target(cx, class, value).into_iter().collect()
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        Self::actions(cx).contains(&value)
    }
}
