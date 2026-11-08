//! The routes of a Laravel project ([`RouteTable`]): every route the HTTP
//! route files of the project model register, with its full name, URI,
//! HTTP methods, action and middleware, and the middleware aliases and
//! groups the application declares.
//!
//! Route files are read syntactically, the way Laravel's router builds its
//! route collection (its public documentation on routing and its source,
//! MIT):
//!
//! - **Registrations:** `Route::get/post/put/patch/delete/options/any`,
//!   `match`, `view`, `redirect`/`permanentRedirect`, `resource` and
//!   `apiResource` on the `Route` facade (or `$router`), with `->name()`,
//!   `->middleware()`, and `->only()`/`->except()`/`->names()` for resources.
//! - **Groups:** `Route::prefix(…)->name(…)->middleware(…)->controller(…)->group(fn …)`
//!   and `Route::group([…], fn …)` (`prefix`, `as`, `middleware`,
//!   `namespace`, `controller`), nested, on top of the route file's own
//!   group ([`RouteFile`]).
//! - **Actions:** `[Controller::class, 'method']`, an invokable
//!   `Controller::class`, `'Controller@method'` (relative to the group's
//!   namespace) and a method name inside a `controller()` group.
//! - **Resources:** the seven actions (five for `apiResource`), their names
//!   (`posts.index`), URIs (`posts/{post}/edit`) and methods, as Laravel's
//!   `ResourceRegistrar` makes them.
//!
//! The middleware ([`MiddlewareDef`]) are Laravel's default aliases and
//! groups (`Middleware::defaultAliases()`), then what `bootstrap/app.php`
//! (`$middleware->alias([…])`, `->group('name', […])`, `appendToGroup`) and an
//! `app/Http/Kernel.php` (`$middlewareAliases`, `$routeMiddleware`,
//! `$middlewareGroups`) declare.

use std::path::{Path, PathBuf};

use ide_core::Range;
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Access, Argument, ArgumentList, ArrayElement, Call, Class, ClassLikeConstantSelector, ClassLikeMember,
    ClassLikeMemberSelector, Expression, Literal, Property, PropertyItem, Statement, Variable,
};
use mago_syntax::walker::Walker;

use super::LaravelProject;
use super::project::RouteFile;
use crate::names::{FileNames, NameKind, Resolution};
use crate::syntax::ParsedFile;

/// The actions of `Route::resource`, in Laravel's order.
pub const RESOURCE_ACTIONS: &[&str] = &["index", "create", "store", "show", "edit", "update", "destroy"];

/// The actions of `Route::apiResource`.
pub const API_RESOURCE_ACTIONS: &[&str] = &["index", "store", "show", "update", "destroy"];

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RouteTable {
    /// In file order (the route files in the project model's order).
    routes: Vec<RouteDef>,
    middleware: Vec<MiddlewareDef>,
}

/// One route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteDef {
    /// The full name, with the group name prefixes (`dashboard.posts.create`).
    pub name: Option<String>,
    /// Upper case (`GET`, `HEAD`).
    pub methods: Vec<String>,
    /// The full URI without the leading `/` (`dashboard/posts/{post}`; empty
    /// for `/`).
    pub uri: String,
    pub action: RouteAction,
    /// The group's, then the route's own.
    pub middleware: Vec<String>,
    pub path: PathBuf,
    /// The byte range of the registering statement (its whole chain).
    pub start: u32,
    pub end: u32,
    /// The registering method's name (`get` of `Route::get`).
    pub range: Range,
    /// Where the name is written, when it is.
    pub name_decl: Option<NameDecl>,
    /// Made by `resource` (`Some(false)`) or `apiResource` (`Some(true)`).
    pub resource: Option<bool>,
}

/// What a route runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouteAction {
    /// A controller method (`__invoke` for an invokable controller), and
    /// where the action names it: the method's string (bytes and range), or
    /// the controller's class for an invokable one or a resource.
    Controller {
        class: String,
        method: String,
        at: Option<(u32, u32, Range)>,
    },
    /// `Route::view`: the view's name.
    View(String),
    /// `Route::redirect`: the destination.
    Redirect(String),
    Closure,
    Unknown,
}

impl RouteAction {
    /// The controller's class.
    pub fn class(&self) -> Option<&str> {
        match self {
            RouteAction::Controller { class, .. } => Some(class),
            _ => None,
        }
    }
}

/// The string literal a route name is written in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NameDecl {
    /// The byte range of the content (inside the quotes).
    pub start: u32,
    pub end: u32,
    pub range: Range,
    /// The name as written, without the group prefixes (`posts.create`).
    pub local: String,
    /// The resource name of a `Route::resource` (one literal for every
    /// action's name, so it can't be renamed as one route's).
    pub resource: bool,
}

/// A middleware alias or group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MiddlewareDef {
    pub name: String,
    /// The class of an alias.
    pub class: Option<String>,
    pub group: bool,
    /// Where the project declares it (the key's literal, inside the quotes);
    /// `None` for Laravel's defaults.
    pub declared: Option<(PathBuf, Range)>,
}

/// Laravel's default middleware aliases (`Middleware::defaultAliases()` of
/// Laravel 11, the `$middlewareAliases` of the skeleton's `Kernel` before).
const DEFAULT_ALIASES: &[(&str, &str)] = &[
    ("auth", "Illuminate\\Auth\\Middleware\\Authenticate"),
    ("auth.basic", "Illuminate\\Auth\\Middleware\\AuthenticateWithBasicAuth"),
    ("auth.session", "Illuminate\\Session\\Middleware\\AuthenticateSession"),
    ("cache.headers", "Illuminate\\Http\\Middleware\\SetCacheHeaders"),
    ("can", "Illuminate\\Auth\\Middleware\\Authorize"),
    ("guest", "Illuminate\\Auth\\Middleware\\RedirectIfAuthenticated"),
    ("password.confirm", "Illuminate\\Auth\\Middleware\\RequirePassword"),
    ("precognitive", "Illuminate\\Foundation\\Http\\Middleware\\HandlePrecognitiveRequests"),
    ("signed", "Illuminate\\Routing\\Middleware\\ValidateSignature"),
    ("throttle", "Illuminate\\Routing\\Middleware\\ThrottleRequests"),
    ("verified", "Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified"),
];

/// Laravel's default middleware groups.
const DEFAULT_GROUPS: &[&str] = &["web", "api"];

impl RouteTable {
    /// The routes of the HTTP route files of `project` and its middleware;
    /// `text_of` reads a file (an open buffer first).
    pub fn read(project: &LaravelProject, text_of: impl Fn(&Path) -> Option<String>) -> Self {
        let mut routes = Vec::new();
        for file in project.http_route_files() {
            let Some(text) = text_of(&file.path) else { continue };
            let parsed = ParsedFile::parse("routes.php", text);
            routes.extend(file_routes(&parsed, file));
        }
        let mut middleware: Vec<MiddlewareDef> = DEFAULT_ALIASES
            .iter()
            .map(|(name, class)| MiddlewareDef {
                name: (*name).to_owned(),
                class: Some((*class).to_owned()),
                group: false,
                declared: None,
            })
            .chain(DEFAULT_GROUPS.iter().map(|name| MiddlewareDef {
                name: (*name).to_owned(),
                class: None,
                group: true,
                declared: None,
            }))
            .collect();
        let sources = [project.paths.bootstrap.join("app.php"), project.paths.app.join("Http").join("Kernel.php")];
        for path in sources {
            let Some(text) = text_of(&path) else { continue };
            let parsed = ParsedFile::parse("middleware.php", text);
            for found in declared_middleware(&parsed, &path) {
                match middleware.iter_mut().find(|known| known.name == found.name && known.group == found.group) {
                    Some(known) => {
                        known.declared = found.declared;
                        if found.class.is_some() {
                            known.class = found.class;
                        }
                    }
                    None => middleware.push(found),
                }
            }
        }
        Self { routes, middleware }
    }

    pub fn routes(&self) -> &[RouteDef] {
        &self.routes
    }

    pub fn middleware(&self) -> &[MiddlewareDef] {
        &self.middleware
    }

    /// The routes named `name`.
    pub fn named<'s>(&'s self, name: &'s str) -> impl Iterator<Item = &'s RouteDef> + 's {
        self.routes.iter().filter(move |route| route.name.as_deref() == Some(name))
    }

    /// The route whose name literal holds byte `offset` of `path`.
    pub fn declared_name_at(&self, path: &Path, offset: u32) -> Option<&RouteDef> {
        self.routes.iter().find(|route| {
            route.path == path
                && route.name_decl.as_ref().is_some_and(|decl| decl.start <= offset && offset <= decl.end)
        })
    }

    /// The innermost route whose registration holds byte `offset` of `path`.
    pub fn route_at(&self, path: &Path, offset: u32) -> Option<&RouteDef> {
        self.routes
            .iter()
            .filter(|route| route.path == path && route.start <= offset && offset <= route.end)
            .min_by_key(|route| route.end - route.start)
    }

    /// The middleware alias or group `name`.
    pub fn middleware_named(&self, name: &str) -> Option<&MiddlewareDef> {
        self.middleware.iter().find(|known| known.name == name)
    }
}

// ------------------------------------------------------------ route files

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A string literal's content as written and its byte range (inside the
/// quotes).
fn literal(expr: &Expression<'_>, text: &str) -> Option<(String, u32, u32)> {
    match expr {
        Expression::Literal(Literal::String(string)) => {
            let span = string.span();
            if string.raw.len() < 2 {
                return None;
            }
            let (start, end) = (span.start.offset + 1, span.end.offset - 1);
            Some((text.get(start as usize..end as usize)?.to_owned(), start, end))
        }
        Expression::Parenthesized(inner) => literal(inner.expression, text),
        _ => None,
    }
}

/// The positional arguments (named ones in their place).
fn args<'a>(list: &'a ArgumentList<'a>) -> Vec<&'a Expression<'a>> {
    list.arguments
        .iter()
        .map(|argument| match argument {
            Argument::Positional(argument) => argument.value,
            Argument::Named(argument) => argument.value,
        })
        .collect()
}

fn elements<'a>(expr: &'a Expression<'a>) -> Vec<&'a ArrayElement<'a>> {
    match expr {
        Expression::Array(array) => array.elements.iter().collect(),
        Expression::LegacyArray(array) => array.elements.iter().collect(),
        _ => Vec::new(),
    }
}

/// The element values of an array literal, else the expression itself.
fn each<'a>(expr: &'a Expression<'a>) -> Vec<&'a Expression<'a>> {
    if !matches!(expr, Expression::Array(_) | Expression::LegacyArray(_)) {
        return vec![expr];
    }
    elements(expr)
        .into_iter()
        .filter_map(|element| match element {
            ArrayElement::Value(element) => Some(element.value),
            ArrayElement::KeyValue(element) => Some(element.value),
            _ => None,
        })
        .collect()
}

/// `$name` without the `$`.
fn variable(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Variable(Variable::Direct(direct)) => {
            Some(lossy(direct.name.strip_prefix(b"$").unwrap_or(direct.name)))
        }
        _ => None,
    }
}

/// `prefix` and `uri` joined with one `/`, without surrounding ones.
fn join_uri(prefix: &str, uri: &str) -> String {
    [prefix.trim_matches('/'), uri.trim_matches('/')]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/")
}

/// The singular of a resource segment, for its parameter (`posts` →
/// `post`), as far as plain English plurals go.
fn singular(word: &str) -> String {
    if let Some(stem) = word.strip_suffix("ies") {
        format!("{stem}y")
    } else if word.ends_with("sses") || word.ends_with("xes") || word.ends_with("ches") || word.ends_with("shes") {
        word[..word.len() - 2].to_owned()
    } else if word.ends_with('s') && !word.ends_with("ss") {
        word[..word.len() - 1].to_owned()
    } else {
        word.to_owned()
    }
}

/// The attributes a group gives the routes in it.
#[derive(Clone, Debug, Default)]
struct Group {
    prefix: String,
    name: String,
    middleware: Vec<String>,
    namespace: Option<String>,
    controller: Option<String>,
}

impl Group {
    fn of_file(file: &RouteFile) -> Self {
        Self {
            prefix: file.prefix.clone(),
            name: file.name_prefix.clone(),
            middleware: file.middleware.clone(),
            namespace: file.namespace.clone(),
            controller: None,
        }
    }

    fn namespace(&mut self, namespace: &str) {
        self.namespace = Some(match (&self.namespace, namespace.strip_prefix('\\')) {
            (_, Some(absolute)) => absolute.to_owned(),
            (Some(outer), None) if !outer.is_empty() => format!("{}\\{namespace}", outer.trim_end_matches('\\')),
            _ => namespace.to_owned(),
        });
    }

    /// A controller named in an action string, relative to the namespace.
    fn qualify(&self, class: &str) -> String {
        match (class.strip_prefix('\\'), &self.namespace) {
            (Some(absolute), _) => absolute.to_owned(),
            (None, Some(namespace)) if !namespace.is_empty() => {
                format!("{}\\{class}", namespace.trim_matches('\\'))
            }
            _ => class.to_owned(),
        }
    }
}

/// A registration being read: the route (or resource) and its modifiers.
struct Pending {
    methods: Vec<String>,
    uri: String,
    action: RouteAction,
    range: Range,
    name: Option<(String, u32, u32)>,
    middleware: Vec<String>,
    resource: Option<Resource>,
}

struct Resource {
    api: bool,
    /// The resource name as written, and its literal.
    name: (String, u32, u32),
    controller: Option<(String, u32, u32)>,
    only: Option<Vec<String>>,
    except: Vec<String>,
    names: Vec<(String, String)>,
}

struct Reader<'a> {
    parsed: &'a ParsedFile,
    names: FileNames,
    path: PathBuf,
    out: Vec<RouteDef>,
}

/// The routes `parsed` (the route file `file`) registers.
pub fn file_routes(parsed: &ParsedFile, file: &RouteFile) -> Vec<RouteDef> {
    let mut reader = Reader { parsed, names: FileNames::resolve(parsed), path: file.path.clone(), out: Vec::new() };
    reader.statements(parsed.program().statements.iter(), &Group::of_file(file));
    reader.out
}

/// One call of a chain: its lower-case name, arguments and name's span.
struct Link<'a> {
    name: String,
    args: Vec<&'a Expression<'a>>,
    span: Span,
}

fn link<'a>(selector: &ClassLikeMemberSelector<'_>, list: &'a ArgumentList<'a>) -> Option<Link<'a>> {
    let ClassLikeMemberSelector::Identifier(name) = selector else { return None };
    Some(Link { name: lossy(name.value).to_ascii_lowercase(), args: args(list), span: name.span })
}

impl<'a> Reader<'a> {
    fn text(&self) -> &'a str {
        self.parsed.text()
    }

    fn range(&self, start: u32, end: u32) -> Range {
        self.parsed.line_index().range(start, end)
    }

    fn statements(&mut self, statements: impl Iterator<Item = &'a Statement<'a>>, group: &Group) {
        for statement in statements {
            match statement {
                Statement::Expression(statement) => self.expression(statement.expression, group),
                Statement::Namespace(namespace) => self.statements(namespace.statements().iter(), group),
                Statement::Block(block) => self.statements(block.statements.iter(), group),
                _ => {}
            }
        }
    }

    /// The FQN of the class an identifier names.
    fn class_ref(&self, expr: &Expression<'_>) -> Option<String> {
        let Expression::Identifier(identifier) = expr else { return None };
        let scope = self.names.scope_at(identifier.span().start.offset);
        match scope.resolve(NameKind::ClassLike, &lossy(identifier.value())).resolution {
            Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => {
                Some(fqn.trim_start_matches('\\').to_owned())
            }
            Resolution::Relative(_) => None,
        }
    }

    /// `Foo::class` as an FQN.
    fn class_constant(&self, expr: &Expression<'_>) -> Option<String> {
        let Expression::Access(Access::ClassConstant(access)) = expr else { return None };
        let ClassLikeConstantSelector::Identifier(constant) = &access.constant else { return None };
        if !constant.value.eq_ignore_ascii_case(b"class") {
            return None;
        }
        self.class_ref(access.class)
    }

    /// A class named by `Foo::class` or a string.
    fn class_arg(&self, expr: &Expression<'_>) -> Option<String> {
        self.class_constant(expr).or_else(|| {
            literal(expr, self.text())
                .map(|(value, ..)| value.replace("\\\\", "\\").trim_start_matches('\\').to_owned())
        })
    }

    /// Middleware names: strings, `Foo::class`, or arrays of them.
    fn middleware(&self, expr: &Expression<'_>) -> Vec<String> {
        each(expr)
            .into_iter()
            .filter_map(|value| {
                self.class_constant(value).or_else(|| literal(value, self.text()).map(|(value, ..)| value))
            })
            .collect()
    }

    fn is_route_facade(&self, class: &Expression<'_>) -> bool {
        self.class_ref(class).is_some_and(|fqn| fqn.rsplit('\\').next() == Some("Route"))
    }

    /// The calls of a chain starting at the `Route` facade or `$router`,
    /// first to last.
    fn chain(&self, mut expr: &'a Expression<'a>) -> Option<Vec<Link<'a>>> {
        let mut links = Vec::new();
        loop {
            match expr {
                Expression::Call(Call::Method(call)) => {
                    links.push(link(&call.method, &call.argument_list)?);
                    expr = call.object;
                }
                Expression::Call(Call::StaticMethod(call)) => {
                    if !self.is_route_facade(call.class) {
                        return None;
                    }
                    links.push(link(&call.method, &call.argument_list)?);
                    break;
                }
                Expression::Parenthesized(inner) => expr = inner.expression,
                other if variable(other).as_deref() == Some("router") => break,
                _ => return None,
            }
        }
        links.reverse();
        Some(links)
    }

    fn expression(&mut self, expr: &'a Expression<'a>, group: &Group) {
        let Some(links) = self.chain(expr) else { return };
        let span = expr.span();
        let mut group = group.clone();
        let mut pending: Option<Pending> = None;
        for link in &links {
            let first = link.args.first().copied();
            if let Some(route) = &mut pending {
                self.modifier(route, link);
                continue;
            }
            match link.name.as_str() {
                "prefix" => {
                    if let Some((prefix, ..)) = first.and_then(|first| literal(first, self.text())) {
                        group.prefix = join_uri(&group.prefix, &prefix);
                    }
                }
                "name" | "as" => {
                    if let Some((name, ..)) = first.and_then(|first| literal(first, self.text())) {
                        group.name.push_str(&name);
                    }
                }
                "middleware" => group.middleware.extend(first.map(|first| self.middleware(first)).unwrap_or_default()),
                "controller" => group.controller = first.and_then(|first| self.class_arg(first)),
                "namespace" => {
                    if let Some((namespace, ..)) = first.and_then(|first| literal(first, self.text())) {
                        group.namespace(&namespace);
                    }
                }
                "group" => {
                    let (attributes, callback) = match link.args[..] {
                        [attributes, callback] => (Some(attributes), callback),
                        [callback] => (None, callback),
                        _ => return,
                    };
                    if let Some(attributes) = attributes {
                        self.group_array(attributes, &mut group);
                    }
                    match callback {
                        Expression::Closure(closure) => self.statements(closure.body.statements.iter(), &group),
                        Expression::ArrowFunction(arrow) => self.expression(arrow.expression, &group),
                        _ => {}
                    }
                    return;
                }
                _ => match self.registration(link, &group) {
                    Some(route) => pending = Some(route),
                    None => return,
                },
            }
        }
        if let Some(route) = pending {
            self.emit(route, &group, span);
        }
    }

    /// `Route::group(['prefix' => …, 'as' => …], …)`.
    fn group_array(&self, array: &Expression<'_>, group: &mut Group) {
        for element in elements(array) {
            let ArrayElement::KeyValue(element) = element else { continue };
            let Some((key, ..)) = literal(element.key, self.text()) else { continue };
            let value = literal(element.value, self.text()).map(|(value, ..)| value);
            match key.as_str() {
                "prefix" => group.prefix = join_uri(&group.prefix, &value.unwrap_or_default()),
                "as" => group.name.push_str(&value.unwrap_or_default()),
                "middleware" => group.middleware.extend(self.middleware(element.value)),
                "namespace" => {
                    if let Some(namespace) = value {
                        group.namespace(&namespace);
                    }
                }
                "controller" => group.controller = self.class_arg(element.value),
                _ => {}
            }
        }
    }

    /// A registering call (`get`, `resource`, …).
    fn registration(&self, link: &Link<'a>, group: &Group) -> Option<Pending> {
        let verb = |methods: &[&str]| methods.iter().map(|method| (*method).to_owned()).collect::<Vec<_>>();
        let uri = |index: usize| link.args.get(index).and_then(|arg| literal(arg, self.text())).map(|(uri, ..)| uri);
        let range = self.range(link.span.start.offset, link.span.end.offset);
        let route = |methods: Vec<String>, uri: String, action: RouteAction| Pending {
            methods,
            uri,
            action,
            range,
            name: None,
            middleware: Vec::new(),
            resource: None,
        };
        let any = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
        Some(match link.name.as_str() {
            "get" => route(verb(&["GET", "HEAD"]), uri(0)?, self.action(link.args.get(1).copied(), group)),
            "post" => route(verb(&["POST"]), uri(0)?, self.action(link.args.get(1).copied(), group)),
            "put" => route(verb(&["PUT"]), uri(0)?, self.action(link.args.get(1).copied(), group)),
            "patch" => route(verb(&["PATCH"]), uri(0)?, self.action(link.args.get(1).copied(), group)),
            "delete" => route(verb(&["DELETE"]), uri(0)?, self.action(link.args.get(1).copied(), group)),
            "options" => route(verb(&["OPTIONS"]), uri(0)?, self.action(link.args.get(1).copied(), group)),
            "any" => route(verb(&any), uri(0)?, self.action(link.args.get(1).copied(), group)),
            "match" => {
                let methods = link
                    .args
                    .first()
                    .map(|methods| self.middleware(methods))
                    .unwrap_or_default()
                    .into_iter()
                    .map(|method| method.to_ascii_uppercase())
                    .collect();
                route(methods, uri(1)?, self.action(link.args.get(2).copied(), group))
            }
            "view" => route(verb(&["GET", "HEAD"]), uri(0)?, RouteAction::View(uri(1).unwrap_or_default())),
            "redirect" | "permanentredirect" => {
                route(verb(&any), uri(0)?, RouteAction::Redirect(uri(1).unwrap_or_default()))
            }
            "resource" | "apiresource" => {
                let name = link.args.first().and_then(|arg| literal(arg, self.text()))?;
                let controller = link.args.get(1).and_then(|arg| {
                    let class = self.class_arg(arg)?;
                    let span = arg.span();
                    Some((class, span.start.offset, span.end.offset))
                });
                let mut resource = Resource {
                    api: link.name == "apiresource",
                    name,
                    controller,
                    only: None,
                    except: Vec::new(),
                    names: Vec::new(),
                };
                if let Some(options) = link.args.get(2) {
                    for element in elements(options) {
                        let ArrayElement::KeyValue(element) = element else { continue };
                        let Some((key, ..)) = literal(element.key, self.text()) else { continue };
                        match key.as_str() {
                            "only" => resource.only = Some(self.middleware(element.value)),
                            "except" => resource.except = self.middleware(element.value),
                            "names" => resource.names.extend(self.names_map(element.value)),
                            _ => {}
                        }
                    }
                }
                let mut pending = route(Vec::new(), String::new(), RouteAction::Unknown);
                pending.resource = Some(resource);
                pending
            }
            _ => return None,
        })
    }

    /// `['index' => 'posts.list']` (the names of a resource's actions).
    fn names_map(&self, expr: &Expression<'_>) -> Vec<(String, String)> {
        elements(expr)
            .into_iter()
            .filter_map(|element| {
                let ArrayElement::KeyValue(element) = element else { return None };
                let (action, ..) = literal(element.key, self.text())?;
                let (name, ..) = literal(element.value, self.text())?;
                Some((action, name))
            })
            .collect()
    }

    /// A call after the registering one (`->name('home')`).
    fn modifier(&self, route: &mut Pending, link: &Link<'a>) {
        let first = link.args.first().copied();
        match (link.name.as_str(), &mut route.resource) {
            ("name" | "as", None) => route.name = first.and_then(|first| literal(first, self.text())),
            ("name", Some(resource)) => {
                if let [action, name] = link.args[..]
                    && let (Some((action, ..)), Some((name, ..))) =
                        (literal(action, self.text()), literal(name, self.text()))
                {
                    resource.names.push((action, name));
                }
            }
            ("names", Some(resource)) => {
                if let Some(first) = first {
                    resource.names.extend(self.names_map(first));
                }
            }
            ("only", Some(resource)) => resource.only = first.map(|first| self.middleware(first)),
            ("except", Some(resource)) => {
                resource.except = first.map(|first| self.middleware(first)).unwrap_or_default()
            }
            ("middleware", _) => route.middleware.extend(first.map(|first| self.middleware(first)).unwrap_or_default()),
            ("withoutmiddleware", _) => {
                let without = first.map(|first| self.middleware(first)).unwrap_or_default();
                route.middleware.retain(|name| !without.contains(name));
            }
            _ => {}
        }
    }

    /// The action argument of a route.
    fn action(&self, expr: Option<&Expression<'_>>, group: &Group) -> RouteAction {
        let Some(expr) = expr else { return RouteAction::Unknown };
        match expr {
            Expression::Closure(_) | Expression::ArrowFunction(_) => RouteAction::Closure,
            Expression::Array(_) | Expression::LegacyArray(_) => {
                let values = each(expr);
                let (Some(class), Some(method)) = (values.first(), values.get(1)) else { return RouteAction::Unknown };
                let (Some(class), Some((method, start, end))) = (self.class_arg(class), literal(method, self.text()))
                else {
                    return RouteAction::Unknown;
                };
                RouteAction::Controller { class, method, at: Some((start, end, self.range(start, end))) }
            }
            _ => {
                if let Some(class) = self.class_constant(expr) {
                    let span = expr.span();
                    let at = (span.start.offset, span.end.offset, self.range(span.start.offset, span.end.offset));
                    return RouteAction::Controller { class, method: "__invoke".to_owned(), at: Some(at) };
                }
                let Some((value, start, end)) = literal(expr, self.text()) else { return RouteAction::Unknown };
                match value.split_once('@') {
                    Some((class, method)) => {
                        let method_start = start + class.len() as u32 + 1;
                        RouteAction::Controller {
                            class: group.qualify(&class.replace("\\\\", "\\")),
                            method: method.to_owned(),
                            at: Some((method_start, end, self.range(method_start, end))),
                        }
                    }
                    None => match &group.controller {
                        Some(class) => RouteAction::Controller {
                            class: class.clone(),
                            method: value,
                            at: Some((start, end, self.range(start, end))),
                        },
                        None => RouteAction::Unknown,
                    },
                }
            }
        }
    }

    fn emit(&mut self, route: Pending, group: &Group, span: Span) {
        let mut middleware = group.middleware.clone();
        middleware.extend(route.middleware);
        let (start, end) = (span.start.offset, span.end.offset);
        let Some(resource) = route.resource else {
            let name_decl = route.name.map(|(local, start, end)| NameDecl {
                range: self.range(start, end),
                start,
                end,
                local,
                resource: false,
            });
            self.out.push(RouteDef {
                name: name_decl.as_ref().map(|decl| format!("{}{}", group.name, decl.local)),
                methods: route.methods,
                uri: join_uri(&group.prefix, &route.uri),
                action: route.action,
                middleware,
                path: self.path.clone(),
                start,
                end,
                range: route.range,
                name_decl,
                resource: None,
            });
            return;
        };
        // `admin/posts` is the resource `posts` with the prefix `admin`;
        // `photos.comments` is nested (`photos/{photo}/comments`).
        let (written, name_start, name_end) = resource.name.clone();
        let (uri_prefix, base) = match written.rsplit_once('/') {
            Some((prefix, base)) => (join_uri(&group.prefix, prefix), base.to_owned()),
            None => (group.prefix.clone(), written.clone()),
        };
        let segments: Vec<&str> = base.split('.').collect();
        let mut uri = uri_prefix;
        for (i, segment) in segments.iter().enumerate() {
            uri = join_uri(&uri, segment);
            if i + 1 < segments.len() {
                uri = join_uri(&uri, &format!("{{{}}}", singular(segment)));
            }
        }
        let parameter = format!("{{{}}}", singular(segments.last().copied().unwrap_or_default()));
        let actions = if resource.api { API_RESOURCE_ACTIONS } else { RESOURCE_ACTIONS };
        let name_range = self.range(name_start, name_end);
        for action in actions {
            if resource.only.as_ref().is_some_and(|only| !only.iter().any(|kept| kept == action))
                || resource.except.iter().any(|left| left == action)
            {
                continue;
            }
            let (methods, uri): (&[&str], String) = match *action {
                "index" => (&["GET", "HEAD"], uri.clone()),
                "create" => (&["GET", "HEAD"], join_uri(&uri, "create")),
                "store" => (&["POST"], uri.clone()),
                "show" => (&["GET", "HEAD"], join_uri(&uri, &parameter)),
                "edit" => (&["GET", "HEAD"], join_uri(&join_uri(&uri, &parameter), "edit")),
                "update" => (&["PUT", "PATCH"], join_uri(&uri, &parameter)),
                _ => (&["DELETE"], join_uri(&uri, &parameter)),
            };
            let name = match resource.names.iter().find(|(named, _)| named == action) {
                Some((_, name)) => format!("{}{name}", group.name),
                None => format!("{}{base}.{action}", group.name),
            };
            let action_target = match &resource.controller {
                Some((class, start, end)) => RouteAction::Controller {
                    class: class.clone(),
                    method: (*action).to_owned(),
                    at: Some((*start, *end, self.range(*start, *end))),
                },
                None => RouteAction::Unknown,
            };
            self.out.push(RouteDef {
                name: Some(name),
                methods: methods.iter().map(|method| (*method).to_owned()).collect(),
                uri,
                action: action_target,
                middleware: middleware.clone(),
                path: self.path.clone(),
                start,
                end,
                range: route.range,
                name_decl: Some(NameDecl {
                    start: name_start,
                    end: name_end,
                    range: name_range,
                    local: written.clone(),
                    resource: true,
                }),
                resource: Some(resource.api),
            });
        }
    }
}

// ------------------------------------------------------------- middleware

struct MiddlewareCollect<'a> {
    parsed: &'a ParsedFile,
    names: FileNames,
    path: PathBuf,
    out: Vec<MiddlewareDef>,
}

struct MiddlewareWalker;

impl MiddlewareCollect<'_> {
    fn class(&self, expr: &Expression<'_>) -> Option<String> {
        match expr {
            Expression::Access(Access::ClassConstant(access)) => {
                let ClassLikeConstantSelector::Identifier(constant) = &access.constant else { return None };
                let Expression::Identifier(identifier) = access.class else { return None };
                if !constant.value.eq_ignore_ascii_case(b"class") {
                    return None;
                }
                let scope = self.names.scope_at(identifier.span().start.offset);
                match scope.resolve(NameKind::ClassLike, &lossy(identifier.value())).resolution {
                    Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => {
                        Some(fqn.trim_start_matches('\\').to_owned())
                    }
                    Resolution::Relative(_) => None,
                }
            }
            _ => literal(expr, self.parsed.text()).map(|(value, ..)| value.replace("\\\\", "\\")),
        }
    }

    fn push(&mut self, key: &Expression<'_>, class: Option<String>, group: bool) {
        let Some((name, start, end)) = literal(key, self.parsed.text()) else { return };
        let declared = Some((self.path.clone(), self.parsed.line_index().range(start, end)));
        self.out.retain(|known| !(known.name == name && known.group == group));
        self.out.push(MiddlewareDef { name, class, group, declared });
    }

    /// `['alias' => Foo::class]` (aliases) or `['web' => […]]` (groups).
    fn array(&mut self, array: &Expression<'_>, group: bool) {
        for element in elements(array) {
            let ArrayElement::KeyValue(element) = element else { continue };
            let class = if group { None } else { self.class(element.value) };
            self.push(element.key, class, group);
        }
    }
}

impl<'a> Walker<'a, 'a, MiddlewareCollect<'a>> for MiddlewareWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut MiddlewareCollect<'a>) {
        let (selector, list) = match expr {
            Expression::Call(Call::Method(call)) => (&call.method, &call.argument_list),
            Expression::Call(Call::StaticMethod(call)) => (&call.method, &call.argument_list),
            _ => return,
        };
        let ClassLikeMemberSelector::Identifier(name) = selector else { return };
        let name = lossy(name.value).to_ascii_lowercase();
        let args = args(list);
        match (name.as_str(), &args[..]) {
            ("alias", [array]) => cx.array(array, false),
            ("aliasmiddleware", [key, class]) => {
                let class = cx.class(class);
                cx.push(key, class, false);
            }
            ("group" | "appendtogroup" | "prependtogroup" | "middlewaregroup", [key, _]) => cx.push(key, None, true),
            _ => {}
        }
    }

    fn walk_in_class(&self, class: &'a Class<'a>, cx: &mut MiddlewareCollect<'a>) {
        for member in class.members.iter() {
            let ClassLikeMember::Property(Property::Plain(property)) = member else { continue };
            for item in property.items.iter() {
                let PropertyItem::Concrete(item) = item else { continue };
                match item.variable.name {
                    b"$middlewareAliases" | b"$routeMiddleware" => cx.array(item.value, false),
                    b"$middlewareGroups" => cx.array(item.value, true),
                    _ => {}
                }
            }
        }
    }
}

/// The middleware aliases and groups `parsed` (at `path`) declares.
fn declared_middleware(parsed: &ParsedFile, path: &Path) -> Vec<MiddlewareDef> {
    let mut collect =
        MiddlewareCollect { parsed, names: FileNames::resolve(parsed), path: path.to_path_buf(), out: Vec::new() };
    MiddlewareWalker.walk_program(parsed.program(), &mut collect);
    collect.out
}
