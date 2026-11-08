//! Route hints and route search: the engine queries behind the code lens on
//! controller methods (the routes pointing to them), the inlay hint after
//! each route registration (its full URI with the group prefixes) and the
//! Route Search dialog (every route, filtered by name or URI part).
//!
//! The answers are plain data ([`RouteInfo`]): the front end offers the
//! actions on them (go to the declaration, copy the URL, open it in the
//! browser, create an HTTP client request from [`RouteInfo::request`]).
//! The URL starts with the application's `APP_URL` from `.env` (else
//! `.env.example`, else `http://localhost`), as Laravel's URL generator
//! does when it has no request.

use std::path::{Path, PathBuf};

use ide_core::{DocId, Range};
use serde::{Deserialize, Serialize};

use super::routes::{RouteAction, RouteDef};
use crate::engine::PhpEngine;
use crate::names::{NameKind, fqn_eq};
use crate::summary::{ClassKind, FileSummary, Visibility};

/// The command a route lens or hint runs when clicked. Its one argument is
/// the JSON of its [`RouteInfo`]s; the front end offers the actions on them.
pub const ROUTE_ACTIONS_COMMAND: &str = "laravel.routeActions";

/// The URL a project without `APP_URL` is served at.
pub const DEFAULT_APP_URL: &str = "http://localhost";

/// One route, as the hints and the search show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    /// The full name (`dashboard.posts.create`).
    pub name: Option<String>,
    /// Upper case, `HEAD` left out next to `GET` (`GET`, `PUT|PATCH`).
    pub methods: Vec<String>,
    /// The full URI with a leading `/` (`/posts/{post}`).
    pub uri: String,
    /// What it runs: `App\Http\Controllers\PostController@show`, `view about`,
    /// `redirect /there`, `Closure`.
    pub action: String,
    pub middleware: Vec<String>,
    /// The route file and the registering method's name in it.
    pub path: PathBuf,
    pub range: Range,
    /// `APP_URL` followed by the URI (parameters left as written).
    pub url: String,
    /// The route as an HTTP client request (`.http` syntax), ending with a
    /// line break.
    pub request: String,
}

impl RouteInfo {
    /// `GET /posts/{post}`.
    pub fn label(&self) -> String {
        format!("{} {}", self.methods.join("|"), self.uri)
    }
}

/// The routes pointing to a controller method.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteLens {
    /// The method's name.
    pub range: Range,
    pub routes: Vec<RouteInfo>,
}

impl RouteLens {
    /// `GET /posts/{post} posts.show` for one route, `3 routes` for more.
    pub fn title(&self) -> String {
        match self.routes.as_slice() {
            [route] => match &route.name {
                Some(name) => format!("{} · {name}", route.label()),
                None => route.label(),
            },
            routes => format!("{} routes", routes.len()),
        }
    }
}

/// The full URI after a route registration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteHint {
    /// The end of the registering call chain.
    pub position: ide_core::Pos,
    /// `/dashboard/posts/create`, or the resource's URI and its count
    /// (`/posts … 2 routes`).
    pub label: String,
    /// The routes it registers (several for a resource).
    pub routes: Vec<RouteInfo>,
}

/// The value of `key` in the text of a `.env` file: `KEY=value`,
/// `export KEY=value`, quoted or not, a ` #` comment after an unquoted
/// value. `None` when the key isn't set or is empty.
pub fn env_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
        let Some((name, value)) = line.split_once('=') else { continue };
        if name.trim() != key {
            continue;
        }
        let value = value.trim();
        let value = match value.chars().next() {
            Some(quote @ ('"' | '\'')) => {
                let rest = &value[1..];
                rest.find(quote).map_or(rest, |end| &rest[..end])
            }
            _ => value.split(" #").next().unwrap_or(value).trim(),
        };
        return (!value.is_empty()).then(|| value.to_owned());
    }
    None
}

/// The application's URL without a trailing `/`: `APP_URL` of `.env`, else
/// of `.env.example`, else [`DEFAULT_APP_URL`]. `text_of` reads a file.
pub fn app_url(root: &Path, text_of: impl Fn(&Path) -> Option<String>) -> String {
    [".env", ".env.example"]
        .iter()
        .find_map(|name| text_of(&root.join(name)).and_then(|text| env_value(&text, "APP_URL")))
        .map(|url| url.trim_end_matches('/').to_owned())
        .unwrap_or_else(|| DEFAULT_APP_URL.to_owned())
}

/// The methods shown for a route: `HEAD` only when it is alone.
fn shown_methods(methods: &[String]) -> Vec<String> {
    let without_head: Vec<String> = methods.iter().filter(|method| *method != "HEAD").cloned().collect();
    if without_head.is_empty() { methods.to_vec() } else { without_head }
}

/// `{post}` and `{post?}` as HTTP client variables (`{{post}}`).
fn request_path(uri: &str) -> String {
    let mut out = String::with_capacity(uri.len() + 8);
    let mut rest = uri;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else { break };
        out.push_str(&rest[..open]);
        let name = rest[open + 1..open + close].trim_end_matches('?');
        out.push_str("{{");
        out.push_str(name);
        out.push_str("}}");
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    out
}

/// The route as an HTTP client request: a `###` title (the name, else the
/// method and URI), the request line with `APP_URL`, `Accept: application/json`
/// for `api` routes, and an empty JSON body for methods that send one.
fn request(name: Option<&str>, methods: &[String], uri: &str, middleware: &[String], app_url: &str) -> String {
    let method = methods.iter().find(|method| *method != "HEAD").or(methods.first()).map_or("GET", String::as_str);
    let method = if methods.len() > 2 { "GET" } else { method };
    let title = name.map_or_else(|| format!("{method} {uri}"), str::to_owned);
    let mut out = format!("### {title}\n{method} {app_url}{}\n", request_path(uri));
    let api = middleware.iter().any(|m| m == "api");
    let body = matches!(method, "POST" | "PUT" | "PATCH");
    if api {
        out.push_str("Accept: application/json\n");
    }
    if body {
        out.push_str("Content-Type: application/json\n\n{}\n");
    }
    out
}

fn action_text(action: &RouteAction) -> String {
    match action {
        RouteAction::Controller { class, method, .. } => format!("{class}@{method}"),
        RouteAction::View(view) => format!("view {view}"),
        RouteAction::Redirect(to) => format!("redirect {to}"),
        RouteAction::Closure => "Closure".to_owned(),
        RouteAction::Unknown => String::new(),
    }
}

/// `route` with the application's URL.
pub fn route_info(route: &RouteDef, app_url: &str) -> RouteInfo {
    let uri = format!("/{}", route.uri);
    let methods = shown_methods(&route.methods);
    RouteInfo {
        request: request(route.name.as_deref(), &route.methods, &uri, &route.middleware, app_url),
        url: if route.uri.is_empty() { format!("{app_url}/") } else { format!("{app_url}{uri}") },
        name: route.name.clone(),
        methods,
        uri,
        action: action_text(&route.action),
        middleware: route.middleware.clone(),
        path: route.path.clone(),
        range: route.range,
    }
}

/// Whether `info` matches every whitespace-separated term of `query`
/// (case-insensitive, in its name, URI, methods or action).
pub fn matches(info: &RouteInfo, query: &str) -> bool {
    let haystack =
        format!("{} {} {} {}", info.name.as_deref().unwrap_or_default(), info.uri, info.methods.join(" "), info.action)
            .to_lowercase();
    query.split_whitespace().all(|term| haystack.contains(&term.to_lowercase()))
}

impl PhpEngine {
    /// The application's URL (see [`app_url`]), open buffers first.
    pub fn laravel_app_url(&self) -> Option<String> {
        let project = self.laravel()?;
        Some(app_url(&project.root, |path| match self.open_document(path) {
            Some(document) => Some(document.text.to_string()),
            None => std::fs::read_to_string(path).ok(),
        }))
    }

    /// Every route of the Laravel project in file order, or those matching
    /// every term of `query` (name, URI, method or action parts). `None`
    /// outside Laravel projects.
    pub fn laravel_route_list(&self, query: &str) -> Option<Vec<RouteInfo>> {
        let routes = self.laravel_routes()?;
        let app_url = self.laravel_app_url()?;
        Some(
            routes
                .routes()
                .iter()
                .map(|route| route_info(route, &app_url))
                .filter(|info| matches(info, query))
                .collect(),
        )
    }

    /// For each controller method of the open document `doc` that routes
    /// point to (also through a subclass the route names), those routes.
    /// Empty when Settings › PHP › Laravel › Route hints is off; `None`
    /// outside Laravel projects.
    pub fn laravel_route_lenses(&self, doc: DocId) -> Option<Vec<RouteLens>> {
        let routes = self.laravel_routes()?;
        if !self.laravel_settings().route_hints {
            return Some(Vec::new());
        }
        let parsed = self.parsed_document(doc)?;
        let controllers: Vec<&RouteDef> =
            routes.routes().iter().filter(|route| route.action.class().is_some()).collect();
        if controllers.is_empty() {
            return Some(Vec::new());
        }
        let here = FileSummary::extract(&parsed);
        let resolver = self.resolver();
        let app_url = self.laravel_app_url()?;
        let mut out = Vec::new();
        for class in here.class_likes.iter().filter(|class| class.kind == ClassKind::Class) {
            let related = |found: &str| {
                fqn_eq(NameKind::ClassLike, found, &class.fqn)
                    || resolver.class_model(found).is_some_and(|model| model.is_subclass_of(&class.fqn))
            };
            for method in class.methods.iter().filter(|method| method.visibility == Visibility::Public) {
                let pointing: Vec<RouteInfo> = controllers
                    .iter()
                    .filter(|route| match &route.action {
                        RouteAction::Controller { class: found, method: named, .. } => {
                            named.eq_ignore_ascii_case(&method.name) && related(found)
                        }
                        _ => false,
                    })
                    .map(|route| route_info(route, &app_url))
                    .collect();
                if !pointing.is_empty() {
                    out.push(RouteLens { range: method.name_loc.range, routes: pointing });
                }
            }
        }
        Some(out)
    }

    /// The full URI after each route registration of the open route file
    /// `doc` that ends in `range`. Empty when the hints are off or the file
    /// isn't one of the project's HTTP route files; `None` outside Laravel
    /// projects.
    pub fn laravel_route_hints(&self, doc: DocId, range: Range) -> Option<Vec<RouteHint>> {
        let routes = self.laravel_routes()?;
        if !self.laravel_settings().route_hints {
            return Some(Vec::new());
        }
        let path = self.document_path(doc)?;
        let here: Vec<&RouteDef> = routes.routes().iter().filter(|route| same_path(&route.path, &path)).collect();
        if here.is_empty() {
            return Some(Vec::new());
        }
        let parsed = self.parsed_document(doc)?;
        let lines = parsed.line_index();
        let (from, to) = lines.byte_range(range);
        let app_url = self.laravel_app_url()?;
        // One hint per registration: a resource registers several routes.
        let mut out: Vec<(u32, RouteHint)> = Vec::new();
        for route in here {
            if route.end < from || route.end > to {
                continue;
            }
            let info = route_info(route, &app_url);
            match out.iter_mut().find(|(end, _)| *end == route.end) {
                Some((_, hint)) => hint.routes.push(info),
                None => out.push((
                    route.end,
                    RouteHint { position: lines.pos(route.end), label: String::new(), routes: vec![info] },
                )),
            }
        }
        Some(
            out.into_iter()
                .map(|(_, mut hint)| {
                    hint.label = hint_label(&hint.routes);
                    hint
                })
                .collect(),
        )
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b || crate::project::normalize(a) == crate::project::normalize(b)
}

/// The URI of one route; for several (a resource), the shortest URI and
/// the count.
fn hint_label(routes: &[RouteInfo]) -> String {
    match routes {
        [route] => route.uri.clone(),
        routes => {
            let base = routes.iter().map(|route| route.uri.as_str()).min_by_key(|uri| uri.len()).unwrap_or("/");
            format!("{base} … {} routes", routes.len())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_values() {
        let text = "APP_NAME=\"Blog\"\n# APP_URL=http://commented\nexport APP_URL='https://blog.test/' \nOTHER=1";
        assert_eq!(env_value(text, "APP_URL").as_deref(), Some("https://blog.test/"));
        assert_eq!(env_value("APP_URL=http://a.test # local\n", "APP_URL").as_deref(), Some("http://a.test"));
        assert_eq!(env_value("APP_URL=\"http://a.test#x\"\n", "APP_URL").as_deref(), Some("http://a.test#x"));
        assert_eq!(env_value("APP_URL=\n", "APP_URL"), None);
        assert_eq!(env_value("APP_URLS=x\n", "APP_URL"), None);
    }

    #[test]
    fn app_url_prefers_env_then_example() {
        let root = Path::new("/app");
        let files = |env: Option<&'static str>, example: Option<&'static str>| {
            move |path: &Path| match path.file_name()?.to_str()? {
                ".env" => env.map(str::to_owned),
                ".env.example" => example.map(str::to_owned),
                _ => None,
            }
        };
        assert_eq!(
            app_url(root, files(Some("APP_URL=http://a.test/"), Some("APP_URL=http://b.test"))),
            "http://a.test"
        );
        assert_eq!(app_url(root, files(Some("APP_NAME=x"), Some("APP_URL=http://b.test"))), "http://b.test");
        assert_eq!(app_url(root, files(None, None)), DEFAULT_APP_URL);
    }

    fn route(name: Option<&str>, methods: &[&str], uri: &str, middleware: &[&str]) -> RouteDef {
        RouteDef {
            name: name.map(str::to_owned),
            methods: methods.iter().map(|m| (*m).to_owned()).collect(),
            uri: uri.to_owned(),
            action: RouteAction::Controller {
                class: "App\\Http\\Controllers\\PostController".to_owned(),
                method: "show".to_owned(),
                at: None,
            },
            middleware: middleware.iter().map(|m| (*m).to_owned()).collect(),
            path: PathBuf::from("/app/routes/web.php"),
            start: 0,
            end: 0,
            range: Range::default(),
            name_decl: None,
            resource: None,
        }
    }

    #[test]
    fn route_infos() {
        let info = route_info(&route(Some("posts.show"), &["GET", "HEAD"], "posts/{post}", &["web"]), "http://a.test");
        assert_eq!(info.methods, ["GET"]);
        assert_eq!(info.uri, "/posts/{post}");
        assert_eq!(info.url, "http://a.test/posts/{post}");
        assert_eq!(info.action, "App\\Http\\Controllers\\PostController@show");
        assert_eq!(info.label(), "GET /posts/{post}");
        assert_eq!(info.request, "### posts.show\nGET http://a.test/posts/{{post}}\n");

        let home = route_info(&route(None, &["GET", "HEAD"], "", &[]), "http://a.test");
        assert_eq!((home.uri.as_str(), home.url.as_str()), ("/", "http://a.test/"));
        assert_eq!(home.request, "### GET /\nGET http://a.test/\n");

        let store = route_info(&route(Some("api.posts.store"), &["POST"], "api/posts/{post?}", &["api"]), "http://a");
        assert_eq!(
            store.request,
            "### api.posts.store\nPOST http://a/api/posts/{{post}}\nAccept: application/json\nContent-Type: application/json\n\n{}\n"
        );
        let update = route_info(&route(None, &["PUT", "PATCH"], "posts/{post}", &[]), "http://a");
        assert_eq!(update.label(), "PUT|PATCH /posts/{post}");
        assert!(
            update.request.starts_with("### PUT /posts/{post}\nPUT http://a/posts/{{post}}\n"),
            "{}",
            update.request
        );
        let any =
            route_info(&route(None, &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], "x", &[]), "h");
        assert!(any.request.contains("\nGET h/x\n"), "{}", any.request);
    }

    #[test]
    fn search_terms() {
        let info = route_info(&route(Some("dashboard.posts.create"), &["GET"], "dashboard/posts/create", &[]), "h");
        for (query, expected) in [
            ("", true),
            ("posts.create", true),
            ("DASHBOARD", true),
            ("get create", true),
            ("posts/create", true),
            ("PostController@show", true),
            ("post delete", false),
            ("missing", false),
        ] {
            assert_eq!(matches(&info, query), expected, "{query}");
        }
    }

    #[test]
    fn lens_titles_and_hint_labels() {
        let one = route_info(&route(Some("posts.show"), &["GET", "HEAD"], "posts/{post}", &[]), "h");
        let unnamed = route_info(&route(None, &["DELETE"], "posts/{post}", &[]), "h");
        let lens = |routes: Vec<RouteInfo>| RouteLens { range: Range::default(), routes };
        assert_eq!(lens(vec![one.clone()]).title(), "GET /posts/{post} · posts.show");
        assert_eq!(lens(vec![unnamed.clone()]).title(), "DELETE /posts/{post}");
        assert_eq!(lens(vec![one.clone(), unnamed.clone()]).title(), "2 routes");
        let index = route_info(&route(None, &["GET"], "posts", &[]), "h");
        assert_eq!(hint_label(std::slice::from_ref(&one)), "/posts/{post}");
        assert_eq!(hint_label(&[one, index, unnamed]), "/posts … 3 routes");
    }
}
