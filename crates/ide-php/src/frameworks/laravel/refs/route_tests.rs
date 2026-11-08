//! Routes, controller actions and middleware (`routeName`,
//! `controllerAction`, `resourceAction`, `middleware`): the route table, and
//! caret fixtures on the fixture app (`fixtures/laravel-app` with
//! `fixtures/laravel-stubs` as its `vendor/`).

use super::*;
use crate::frameworks::laravel::{RouteAction, RouteDef};

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

impl Project {
    /// The fixture app with the stubs as its `vendor/`.
    fn app() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        copy_dir(&fixtures.join("laravel-app"), &root);
        copy_dir(&fixtures.join("laravel-stubs"), &root.join("vendor"));
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(Duration::from_secs(120)));
        Self { _tmp: tmp, root: crate::project::normalize(&root), engine, next_doc: 1 }
    }

    /// The kind of the string at the caret of `body`, a statement of a route
    /// file of the app.
    fn route_kind_at(&mut self, body: &str) -> Option<&'static str> {
        let source = format!(
            "<?php\n\nuse App\\Http\\Controllers\\PostController;\nuse Illuminate\\Support\\Facades\\Route;\nuse Illuminate\\Support\\Facades\\URL;\n\n{body}\n"
        );
        let (doc, pos) = self.open("routes/probe.php", &source);
        let parsed = self.engine.parsed_document(doc).unwrap();
        let resolver = self.engine.resolver();
        let offset = parsed.line_index().byte(pos);
        let kind = site_at(&parsed, &resolver, offset).and_then(|site| kind_of(&site, &resolver)).map(|kind| kind.id());
        self.engine.document_closed(doc);
        kind
    }

    fn complete_in(&mut self, rel: &str, source: &str) -> Vec<String> {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        found.items.into_iter().map(|item| item.label).collect()
    }

    fn definition_in(&mut self, rel: &str, source: &str) -> Vec<(String, u32, String)> {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.definition(doc, pos).unwrap_or_default();
        self.engine.document_closed(doc);
        found.iter().map(|target| self.describe(&target.path, target.range)).collect()
    }

    /// A route file of the app with `from` replaced by `to` (holding the
    /// caret).
    fn edited(&self, rel: &str, from: &str, to: &str) -> String {
        let text = std::fs::read_to_string(self.root.join(rel)).unwrap().replace("\r\n", "\n");
        assert!(text.contains(from), "{from}");
        text.replacen(from, to, 1)
    }
}

/// `(name, methods, uri, action)` of a route.
fn describe(route: &RouteDef) -> (String, String, String, String) {
    let action = match &route.action {
        RouteAction::Controller { class, method, .. } => format!("{class}@{method}"),
        RouteAction::View(view) => format!("view:{view}"),
        RouteAction::Redirect(to) => format!("redirect:{to}"),
        RouteAction::Closure => "closure".to_owned(),
        RouteAction::Unknown => "?".to_owned(),
    };
    (route.name.clone().unwrap_or_default(), route.methods.join("|"), route.uri.clone(), action)
}

fn row(name: &str, methods: &str, uri: &str, action: &str) -> (String, String, String, String) {
    (name.to_owned(), methods.to_owned(), uri.to_owned(), action.to_owned())
}

#[test]
fn route_table_of_the_fixture_app() {
    let project = Project::app();
    let routes = project.engine.laravel_routes().unwrap();
    let all: Vec<_> = routes.routes().iter().map(describe).collect();
    let posts = "App\\Http\\Controllers\\PostController";
    let invoices = "Modules\\Billing\\Http\\Controllers\\InvoiceController";
    for expected in [
        row("home", "GET|HEAD", "", "App\\Http\\Controllers\\HomeController@__invoke"),
        row("about", "GET|HEAD", "about", "view:about"),
        row("posts.index", "GET|HEAD", "posts", &format!("{posts}@index")),
        row("posts.show", "GET|HEAD", "posts/{post}", &format!("{posts}@show")),
        row("dashboard.posts.create", "GET|HEAD", "dashboard/posts/create", &format!("{posts}@create")),
        row("dashboard.posts.store", "POST", "dashboard/posts", &format!("{posts}@store")),
        row("dashboard.posts.destroy", "DELETE", "dashboard/posts/{post}", &format!("{posts}@destroy")),
        row("archive.index", "GET|HEAD", "archive", &format!("{posts}@index")),
        row("api.posts.index", "GET|HEAD", "api/posts", "App\\Http\\Controllers\\Api\\PostController@index"),
        row("admin.posts.index", "GET|HEAD", "admin/posts", &format!("{posts}@index")),
        row("billing.invoices.index", "GET|HEAD", "billing/invoices", &format!("{invoices}@index")),
        row("api.billing.invoices.index", "GET|HEAD", "api/billing/invoices", &format!("{invoices}@index")),
    ] {
        assert!(all.contains(&expected), "{expected:?} in {all:#?}");
    }
    // `only(['index', 'show'])` leaves the other actions out.
    assert!(!all.iter().any(|route| route.0 == "posts.create"), "{all:#?}");
    let middleware = |name: &str| routes.named(name).next().unwrap().middleware.clone();
    assert_eq!(middleware("dashboard.posts.create"), ["web", "auth", "author"]);
    assert_eq!(middleware("archive.index"), ["web", "throttle:60,1"]);
    assert_eq!(middleware("admin.posts.index"), ["web", "auth"]);
    // The app's alias, and Laravel's defaults.
    let author = routes.middleware_named("author").unwrap();
    assert_eq!(author.class.as_deref(), Some("App\\Http\\Middleware\\EnsureUserIsAuthor"));
    let (path, range) = author.declared.clone().unwrap();
    assert_eq!(project.describe(&path, range), ("bootstrap/app.php".to_owned(), 22, "author".to_owned()));
    assert!(routes.middleware_named("throttle").is_some_and(|m| m.declared.is_none() && !m.group));
    assert!(routes.middleware_named("web").is_some_and(|m| m.group));
}

const ROUTES: &str = r#"<?php

use App\Http\Controllers\PhotoController;
use Illuminate\Support\Facades\Route;

Route::resource('photos', PhotoController::class)->except(['create', 'edit'])->names(['index' => 'gallery']);
Route::apiResource('photos.comments', 'App\Http\Controllers\CommentController', ['only' => ['index', 'show']]);
Route::resource('admin/users', UserController::class)->only('index');
Route::group(['prefix' => 'legacy', 'as' => 'legacy.', 'namespace' => 'App\Http\Controllers', 'middleware' => ['web']], function () {
    Route::get('/one', 'LegacyController@one')->name('one');
    Route::namespace('Admin')->group(fn () => Route::get('/two', 'PanelController@two')->name('two'));
});
Route::match(['get', 'post'], '/search', fn () => null)->name('search')->middleware(['auth', 'verified'])->withoutMiddleware('verified');
Route::redirect('/here', '/there');
Route::name('tools.')->get('/tool', [PhotoController::class, 'tool'])->name('show');
"#;

#[test]
fn route_table_of_resources_groups_and_actions() {
    let project = Project::new(&[("composer.json", COMPOSER), ("routes/web.php", ROUTES)]);
    let routes = project.engine.laravel_routes().unwrap();
    let all: Vec<_> = routes.routes().iter().map(describe).collect();
    let photos = "App\\Http\\Controllers\\PhotoController";
    let comments = "App\\Http\\Controllers\\CommentController";
    assert_eq!(
        all,
        [
            row("gallery", "GET|HEAD", "photos", &format!("{photos}@index")),
            row("photos.store", "POST", "photos", &format!("{photos}@store")),
            row("photos.show", "GET|HEAD", "photos/{photo}", &format!("{photos}@show")),
            row("photos.update", "PUT|PATCH", "photos/{photo}", &format!("{photos}@update")),
            row("photos.destroy", "DELETE", "photos/{photo}", &format!("{photos}@destroy")),
            row("photos.comments.index", "GET|HEAD", "photos/{photo}/comments", &format!("{comments}@index")),
            row("photos.comments.show", "GET|HEAD", "photos/{photo}/comments/{comment}", &format!("{comments}@show")),
            row("users.index", "GET|HEAD", "admin/users", "UserController@index"),
            row("legacy.one", "GET|HEAD", "legacy/one", "App\\Http\\Controllers\\LegacyController@one"),
            row("legacy.two", "GET|HEAD", "legacy/two", "App\\Http\\Controllers\\Admin\\PanelController@two"),
            row("search", "GET|POST", "search", "closure"),
            row("", "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS", "here", "redirect:/there"),
            row("tools.show", "GET|HEAD", "tool", &format!("{photos}@tool")),
        ]
    );
    assert_eq!(routes.named("legacy.one").next().unwrap().middleware, ["web", "web"]);
    assert_eq!(routes.named("search").next().unwrap().middleware, ["web", "auth"]);
    // The apiResource's routes know they are one.
    assert_eq!(routes.named("photos.comments.index").next().unwrap().resource, Some(true));
}

#[test]
fn place_patterns_match_route_strings() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("route('/*|*/home');", Some("routeName")),
        ("route('home', ['/*|*/']);", None),
        ("to_route('ho/*|*/');", Some("routeName")),
        ("redirect()->route('/*|*/');", Some("routeName")),
        ("URL::route('/*|*/');", Some("routeName")),
        ("Route::has('/*|*/');", Some("routeName")),
        ("Route::has(['home', '/*|*/']);", Some("routeName")),
        ("Route::get('/x', [PostController::class, '/*|*/']);", Some("controllerAction")),
        ("Route::get('/x', 'PostController@/*|*/');", Some("controllerAction")),
        ("Route::get('/*|*/x', 'PostController@index');", None),
        ("Route::post('/x', [PostController::class, 'st/*|*/'])->name('x');", Some("controllerAction")),
        ("Route::match(['get'], '/x', [PostController::class, '/*|*/']);", Some("controllerAction")),
        ("Route::match(['/*|*/get'], '/x', [PostController::class, 'index']);", None),
        ("action([PostController::class, '/*|*/']);", Some("controllerAction")),
        ("to_action('PostController@/*|*/');", Some("controllerAction")),
        ("Route::middleware('/*|*/');", Some("middleware")),
        ("Route::middleware(['auth', '/*|*/']);", Some("middleware")),
        ("Route::get('/x', fn () => 1)->middleware('/*|*/');", Some("middleware")),
        ("Route::get('/x', fn () => 1)->withoutMiddleware(['/*|*/']);", Some("middleware")),
        ("Route::group(['middleware' => '/*|*/'], function () {});", Some("middleware")),
        ("Route::group(['prefix' => '/*|*/'], function () {});", None),
        ("Route::resource('posts', PostController::class)->only(['/*|*/']);", Some("resourceAction")),
        ("Route::resource('posts', PostController::class)->except('/*|*/');", Some("resourceAction")),
        ("Route::resource('posts', PostController::class, ['except' => ['/*|*/']]);", Some("resourceAction")),
        ("Route::resource('/*|*/posts', PostController::class);", None),
        // Partial strings while typing.
        ("route('ho/*|*/\n", Some("routeName")),
        ("Route::middleware('au/*|*/\n", Some("middleware")),
    ];
    for (body, expected) in table {
        assert_eq!(project.route_kind_at(body), *expected, "{body}");
    }
}

#[test]
fn completes_route_names_actions_and_middleware() {
    let mut project = Project::app();
    let names = project.complete_in("app/Http/Probe.php", "<?php\nroute('/*|*/');\n");
    for name in ["home", "posts.show", "dashboard.posts.create", "archive.index", "api.billing.invoices.index"] {
        assert!(names.contains(&name.to_owned()), "{name} in {names:?}");
    }
    let names = project.complete_in("app/Http/Probe.php", "<?php\nredirect()->route('dash/*|*/');\n");
    assert!(names.contains(&"dashboard.posts.store".to_owned()), "{names:?}");
    assert!(!names.contains(&"home".to_owned()), "{names:?}");

    // Controller methods: the controller's own public methods.
    let source = project.edited("routes/web.php", "'create']", "'/*|*/']");
    let methods = project.complete_in("routes/web.php", &source);
    assert_eq!(methods, ["create", "destroy", "index", "show", "store"]);
    let source = project.edited("routes/web.php", "[PostController::class, 'create']", "'PostController@/*|*/'");
    let methods = project.complete_in("routes/web.php", &source);
    assert!(methods.contains(&"store".to_owned()), "{methods:?}");
    // In a `Route::controller()` group.
    let source = project.edited("routes/web.php", "Route::get('/', 'index')", "Route::get('/', 'sh/*|*/')");
    assert_eq!(project.complete_in("routes/web.php", &source), ["show"]);

    // Resource actions.
    let source = project.edited("routes/web.php", "->only(['index', 'show'])", "->only(['/*|*/'])");
    let actions = project.complete_in("routes/web.php", &source);
    assert_eq!(actions, ["create", "destroy", "edit", "index", "show", "store", "update"]);

    // Middleware aliases and groups, not in the parameters.
    let names = project.complete_in("app/Http/Probe.php", "<?php\nRoute::middleware(['/*|*/']);\n");
    for name in ["author", "auth", "throttle", "web", "api"] {
        assert!(names.contains(&name.to_owned()), "{name} in {names:?}");
    }
    let names = project.complete_in("app/Http/Probe.php", "<?php\nRoute::middleware('throttle:/*|*/');\n");
    assert!(!names.contains(&"auth".to_owned()), "{names:?}");
}

#[test]
fn goto_from_route_names_actions_and_middleware() {
    let mut project = Project::app();
    let web = |line: u32, text: &str| ("routes/web.php".to_owned(), line, text.to_owned());
    let controller =
        |line: u32, text: &str| ("app/Http/Controllers/PostController.php".to_owned(), line, text.to_owned());
    assert_eq!(
        project.definition_in("app/Http/Probe.php", "<?php\nroute('dashboard.posts.cr/*|*/eate');\n"),
        [web(13, "posts.create")]
    );
    // A resource's name: its resource string.
    assert_eq!(
        project.definition_in("app/Http/Probe.php", "<?php\nto_route('posts.sh/*|*/ow');\n"),
        [web(10, "posts")]
    );
    assert_eq!(project.definition_in("app/Http/Probe.php", "<?php\nroute('nope/*|*/');\n"), []);
    // A controller action.
    let source = project.edited("routes/web.php", "'create']", "'cre/*|*/ate']");
    assert_eq!(project.definition_in("routes/web.php", &source), [controller(27, "create")]);
    let source = project.edited("routes/web.php", "Route::get('/', 'index')", "Route::get('/', 'in/*|*/dex')");
    assert_eq!(project.definition_in("routes/web.php", &source), [controller(12, "index")]);
    let source = project.edited("routes/web.php", "->only(['index', 'show'])", "->only(['index', 's/*|*/how'])");
    assert_eq!(project.definition_in("routes/web.php", &source), [controller(19, "show")]);
    // Middleware: the alias's class.
    let source = project.edited("routes/web.php", "'author']", "'auth/*|*/or']");
    assert_eq!(
        project.definition_in("routes/web.php", &source),
        [("app/Http/Middleware/EnsureUserIsAuthor.php".to_owned(), 8, "EnsureUserIsAuthor".to_owned())]
    );
}

#[test]
fn finds_usages_of_route_names_and_controller_methods() {
    let mut project = Project::app();
    let source = std::fs::read_to_string(project.root.join("app/Http/Controllers/Api/PostController.php"))
        .unwrap()
        .replace("route('posts.show'", "route('posts.sh/*|*/ow'");
    let found = project.references("app/Http/Controllers/Api/PostController.php", &source);
    let found: Vec<(String, u32, String, UsageKind)> = found;
    assert_eq!(
        found,
        [
            ("app/Http/Controllers/Api/PostController.php".to_owned(), 14, "posts.show".to_owned(), UsageKind::String),
            ("app/Http/Controllers/PostController.php".to_owned(), 36, "posts.show".to_owned(), UsageKind::String),
            ("routes/web.php".to_owned(), 10, "posts".to_owned(), UsageKind::Declaration),
        ]
    );
    // From the declaration, in the route file.
    let source = project.edited("routes/web.php", "->name('posts.store')", "->name('posts.st/*|*/ore')");
    let found = project.references("routes/web.php", &source);
    assert_eq!(found, [("routes/web.php".to_owned(), 14, "posts.store".to_owned(), UsageKind::Declaration)]);

    // A controller method's usages include the routes naming it.
    let source = std::fs::read_to_string(project.root.join("app/Http/Controllers/PostController.php"))
        .unwrap()
        .replace("function create()", "function cre/*|*/ate()");
    let found = project.references("app/Http/Controllers/PostController.php", &source);
    assert!(found.contains(&("routes/web.php".to_owned(), 13, "create".to_owned(), UsageKind::String)), "{found:?}");
    let source = std::fs::read_to_string(project.root.join("app/Http/Controllers/PostController.php"))
        .unwrap()
        .replace("function index()", "function ind/*|*/ex()");
    let found: Vec<(String, u32)> = project
        .references("app/Http/Controllers/PostController.php", &source)
        .into_iter()
        .filter(|usage| usage.3 == UsageKind::String)
        .map(|usage| (usage.0, usage.1))
        .collect();
    assert_eq!(
        found,
        [("routes/admin.php".to_owned(), 7), ("routes/web.php".to_owned(), 10), ("routes/web.php".to_owned(), 19)]
    );
    // From an action string: the same method's other actions.
    let source = project.edited("routes/web.php", "Route::get('/', 'index')", "Route::get('/', 'ind/*|*/ex')");
    let found: Vec<(String, u32, String)> =
        project.references("routes/web.php", &source).into_iter().map(|usage| (usage.0, usage.1, usage.2)).collect();
    assert_eq!(
        found,
        [
            ("app/Http/Controllers/PostController.php".to_owned(), 12, "index".to_owned()),
            ("routes/admin.php".to_owned(), 7, "index".to_owned()),
            ("routes/web.php".to_owned(), 19, "index".to_owned()),
        ]
    );
}

#[test]
fn renames_a_route_name_in_its_route_file_and_callers() {
    let mut project = Project::app();
    let usage = "<?php\nreturn route('dashboard.posts.cre/*|*/ate');\n";
    let (doc, pos) = project.open("app/Http/Probe.php", usage);
    let range = project.engine.prepare_rename(doc, pos).unwrap().unwrap();
    // The part written in the route file; the group's prefix stays.
    assert_eq!(range, Range::new(Pos::new(1, 24), Pos::new(1, 36)));
    project.engine.document_closed(doc);
    let edits = project.rename("app/Http/Probe.php", usage, "posts.make");
    assert_eq!(
        edits,
        [
            ("app/Http/Probe.php".to_owned(), 1, "posts.create".to_owned()),
            ("routes/web.php".to_owned(), 13, "posts.create".to_owned()),
        ]
    );
    // From the declaration.
    let source = project.edited("routes/web.php", "->name('posts.store')", "->name('posts.st/*|*/ore')");
    let edits = project.rename("routes/web.php", &source, "posts.save");
    assert_eq!(edits, [("routes/web.php".to_owned(), 14, "posts.store".to_owned())]);
    // A resource's names aren't renamed one by one.
    let (doc, pos) = project.open("app/Http/Probe.php", "<?php\nroute('posts.in/*|*/dex');\n");
    assert_eq!(project.engine.prepare_rename(doc, pos), Some(None));
}

#[test]
fn reports_undefined_route_names() {
    let mut project = Project::app();
    let source = "<?php\nroute('home');\nto_route('nope.missing');\nredirect()->route('dashboard.posts.store');\n$x = 'nope.other';\n";
    let (doc, _) = project.open("app/Http/Probe.php", &format!("{source}/*|*/"));
    let inspected = project.engine.inspect(doc, &CancellationToken::new()).unwrap();
    let found: Vec<(u32, String)> = inspected
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_deref() == Some("PhpUndefinedRoute"))
        .map(|diagnostic| (diagnostic.range.start.line, diagnostic.message.clone()))
        .collect();
    assert_eq!(found, [(2, "Route 'nope.missing' is not defined".to_owned())]);
}

#[test]
fn route_kinds_validate_values() {
    let project = Project::app();
    let cx = project.engine.ref_context().unwrap();
    assert!(RouteName.is_known(&cx, "dashboard.posts.create"));
    assert!(!RouteName.is_known(&cx, "posts.create"));
    assert!(Middleware.is_known(&cx, "throttle:60,1"));
    assert!(Middleware.is_known(&cx, "author"));
    assert!(!Middleware.is_known(&cx, "nope"));
    assert!(ControllerAction.is_known(&cx, "PostController@store"));
    assert!(!ControllerAction.is_known(&cx, "PostController@nope"));
}
