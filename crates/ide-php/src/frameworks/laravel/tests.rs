use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ide_core::{IdeEvent, SharedSink};

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;
use crate::summary::{FileSummary, LaravelFacts, RouteFileKind};
use crate::syntax::ParsedFile;

/// The `laravel routes …` lines of a snippet's summary.
fn routes(source: &str) -> Vec<String> {
    let summary = FileSummary::extract(&ParsedFile::parse("routes.php", source));
    summary.render().lines().filter(|line| line.starts_with("laravel routes ")).map(str::to_owned).collect()
}

#[test]
fn with_routing_registers_route_files() {
    let source = r#"<?php
use Illuminate\Foundation\Application;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: [__DIR__.'/../routes/api.php', __DIR__.'/../routes/api_v2.php'],
        commands: __DIR__.'/../routes/console.php',
        channels: __DIR__.'/../routes/channels.php',
        health: '/up',
        apiPrefix: 'api/v1',
    )
    ->create();
"#;
    assert_eq!(
        routes(source),
        [
            "laravel routes Web dir^0/../routes/web.php middleware [web]",
            "laravel routes Api dir^0/../routes/api.php prefix 'api/v1' middleware [api]",
            "laravel routes Api dir^0/../routes/api_v2.php prefix 'api/v1' middleware [api]",
            "laravel routes Console dir^0/../routes/console.php",
            "laravel routes Channels dir^0/../routes/channels.php",
        ]
    );
    // Positional arguments, the default API prefix, `dirname(__DIR__, 2)`.
    let positional = r#"<?php
$app->withRouting(null, dirname(__DIR__, 2).'/routes/web.php', base_path('routes/api.php'));
"#;
    assert_eq!(
        routes(positional),
        [
            "laravel routes Web dir^2/routes/web.php middleware [web]",
            "laravel routes Api base:routes/api.php prefix 'api' middleware [api]",
        ]
    );
}

#[test]
fn route_groups_loading_files_are_registrations() {
    let source = r#"<?php
namespace App\Providers;

use Illuminate\Foundation\Support\Providers\RouteServiceProvider as ServiceProvider;
use Illuminate\Support\Facades\Route;

class RouteServiceProvider extends ServiceProvider
{
    protected $namespace = 'App\Http\Controllers';

    public function boot(): void
    {
        $this->routes(function () {
            Route::middleware('api')
                ->prefix('api')
                ->namespace($this->namespace)
                ->group(base_path('routes/api.php'));

            Route::middleware(['web', 'auth'])
                ->namespace('App\Http\Controllers')
                ->group(base_path('routes/web.php'));

            Route::prefix('admin')->name('admin.')->middleware('web')->domain('admin.example.com')
                ->group(app_path('Admin/routes.php'));

            Route::group(['prefix' => '/legacy/', 'as' => 'legacy.', 'middleware' => 'web'], base_path('routes/legacy.php'));

            // A closure group loads no file; neither does another class's group().
            Route::middleware('web')->group(function () {
                Route::get('/', fn () => 'home');
            });
            $collection->prefix('x')->group(base_path('routes/not.php'));
        });
        $this->loadRoutesFrom(__DIR__.'/../../routes/package.php');
        $router->prefix('hooks')->group(base_path('routes/hooks.php'));
    }
}
"#;
    assert_eq!(
        routes(source),
        [
            "laravel routes Api base:routes/api.php prefix 'api' middleware [api]",
            "laravel routes Web base:routes/web.php middleware [web, auth] namespace 'App\\Http\\Controllers'",
            "laravel routes Web app:Admin/routes.php prefix 'admin' as 'admin.' middleware [web] \
             domain 'admin.example.com'",
            "laravel routes Web base:routes/legacy.php prefix '/legacy/' as 'legacy.' middleware [web]",
            "laravel routes Other dir^0/../../routes/package.php",
            "laravel routes Other base:routes/hooks.php prefix 'hooks'",
        ]
    );
}

#[test]
fn module_paths_are_registrations() {
    let source = r#"<?php
namespace Modules\Blog\Providers;

use Illuminate\Support\Facades\Route;

class RouteServiceProvider
{
    protected string $name = 'Blog';

    public function map(): void
    {
        Route::middleware('web')->group(module_path($this->name, '/routes/web.php'));
        Route::middleware('api')->prefix('api')->name('api.')->group(module_path('Blog', '/routes/api.php'));
    }
}
"#;
    assert_eq!(
        routes(source),
        [
            "laravel routes Web module(?):/routes/web.php middleware [web]",
            "laravel routes Api module(Blog):/routes/api.php prefix 'api' as 'api.' middleware [api]",
        ]
    );
}

// ------------------------------------------------------------ project model

struct Dir {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

impl Dir {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("app");
        std::fs::create_dir_all(&root).unwrap();
        Self { _tmp: tmp, root }
    }

    fn write(&self, rel: &str, text: &str) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    fn path(&self, rel: &str) -> PathBuf {
        crate::project::normalize(&self.root.join(rel))
    }
}

const LARAVEL: &str = r#"{"require": {"laravel/framework": "^11.0"}, "autoload": {"psr-4": {"App\\": "app/"}}}"#;

#[test]
fn detects_laravel_and_its_version() {
    let dir = Dir::new();
    dir.write("composer.json", r#"{"require": {"symfony/console": "^7.0"}}"#);
    assert_eq!(LaravelProject::load(&dir.root), None, "not a Laravel project");

    // `artisan` alone is enough.
    dir.write("artisan", "#!/usr/bin/env php\n<?php\n");
    let project = LaravelProject::load(&dir.root).expect("artisan");
    assert_eq!(project.version, None);

    // The required package; the version from installed.json, then composer.lock.
    std::fs::remove_file(dir.root.join("artisan")).unwrap();
    dir.write("composer.json", LARAVEL);
    assert_eq!(LaravelProject::load(&dir.root).unwrap().version, None);
    dir.write(
        "vendor/composer/installed.json",
        r#"{"packages": [{"name": "laravel/framework", "version": "v11.31.0"}]}"#,
    );
    assert_eq!(LaravelProject::load(&dir.root).unwrap().version.as_deref(), Some("11.31.0"));
    dir.write(
        "composer.lock",
        r#"{"packages": [{"name": "monolog/monolog", "version": "3.0.0"}, {"name": "laravel/framework", "version": "v10.48.2"}]}"#,
    );
    assert_eq!(LaravelProject::load(&dir.root).unwrap().version.as_deref(), Some("10.48.2"));

    // Locked without being required (a metapackage pulled it in).
    dir.write("composer.json", r#"{"require": {"acme/laravel-pack": "^1.0"}}"#);
    assert!(LaravelProject::load(&dir.root).is_some());
}

#[test]
fn paths_and_app_namespace() {
    let dir = Dir::new();
    dir.write("composer.json", LARAVEL);
    let project = LaravelProject::load(&dir.root).unwrap();
    assert_eq!(project.app_namespace, "App\\");
    assert_eq!(project.paths.app, dir.path("app"));
    assert_eq!(project.paths.config, dir.path("config"));
    assert_eq!(project.paths.views, dir.path("resources/views"));
    assert_eq!(project.paths.routes, dir.path("routes"));
    assert_eq!(project.paths.database, dir.path("database"));
    assert_eq!(project.paths.lang, dir.path("lang"));

    // A renamed app namespace; `resources/lang` before Laravel 9.
    dir.write(
        "composer.json",
        r#"{"require": {"laravel/framework": "^8.0"}, "autoload": {"psr-4": {"Database\\Seeders\\": "database/seeders/", "Acme\\Shop\\": "app"}}}"#,
    );
    dir.write("resources/lang/en/messages.php", "<?php return [];\n");
    let project = LaravelProject::load(&dir.root).unwrap();
    assert_eq!(project.app_namespace, "Acme\\Shop\\");
    assert_eq!(project.paths.lang, dir.path("resources/lang"));
    dir.write("lang/en.json", "{}");
    assert_eq!(LaravelProject::load(&dir.root).unwrap().paths.lang, dir.path("lang"));
}

#[test]
fn lists_nwidart_and_directory_modules() {
    let dir = Dir::new();
    dir.write(
        "composer.json",
        r#"{"require": {"laravel/framework": "^11.0", "nwidart/laravel-modules": "^11.0"},
            "autoload": {"psr-4": {"App\\": "app/", "Domains\\": "app-modules/"}}}"#,
    );
    dir.write("config/modules.php", "<?php\nreturn [\n    'namespace' => 'Packages',\n    'paths' => [\n        'modules' => base_path('packages'),\n    ],\n];\n");
    dir.write("modules_statuses.json", r#"{"Blog": true, "Shop": false}"#);
    dir.write("packages/Blog/module.json", r#"{"name": "Blog"}"#);
    dir.write("packages/Blog/composer.json", r#"{"autoload": {"psr-4": {"Packages\\Blog\\": "app/"}}}"#);
    dir.write("packages/Shop/module.json", r#"{"name": "Shop"}"#);
    dir.write("packages/Wiki/module.json", r#"{"name": "Wiki"}"#);
    dir.write("packages/notes/README.md", "not a module");
    // Directory modules: namespace from the root PSR-4 mapping or their own composer.json.
    dir.write("app-modules/Billing/routes/web.php", "<?php\n");
    dir.write("app-modules/Billing/src/Providers/BillingServiceProvider.php", "<?php\n");
    dir.write("app-modules/Empty/README.md", "no module");
    dir.write("app/Modules/Forum/Providers/ForumServiceProvider.php", "<?php\n");
    dir.write("modules/Chat/composer.json", r#"{"autoload": {"psr-4": {"Acme\\Chat\\": "src/"}}}"#);

    let project = LaravelProject::load(&dir.root).unwrap();
    let modules: Vec<(&str, ModuleKind, Option<&str>, bool)> = project
        .modules
        .iter()
        .map(|module| (module.name.as_str(), module.kind, module.namespace.as_deref(), module.enabled))
        .collect();
    assert_eq!(
        modules,
        [
            ("Forum", ModuleKind::Directory, Some("App\\Modules\\Forum\\"), true),
            ("Billing", ModuleKind::Directory, Some("Domains\\Billing\\"), true),
            ("Chat", ModuleKind::Directory, Some("Acme\\Chat\\"), true),
            ("Blog", ModuleKind::Nwidart, Some("Packages\\Blog\\"), true),
            ("Shop", ModuleKind::Nwidart, Some("Packages\\Shop\\"), false),
            ("Wiki", ModuleKind::Nwidart, Some("Packages\\Wiki\\"), false),
        ]
    );
    assert_eq!(project.module("blog").unwrap().path, dir.path("packages/Blog"));
    assert_eq!(project.module_of(&dir.path("packages/Shop/routes/web.php")).unwrap().name, "Shop");
    assert!(project.module_of(&dir.path("routes/web.php")).is_none());

    // Without nwidart/laravel-modules, a `module.json` folder isn't a module.
    dir.write("composer.json", LARAVEL);
    std::fs::remove_file(dir.root.join("modules_statuses.json")).unwrap();
    let names: Vec<String> =
        LaravelProject::load(&dir.root).unwrap().modules.into_iter().map(|module| module.name).collect();
    assert_eq!(names, ["Forum", "Billing", "Chat"]);
}

/// The facts of `files` (relative paths and sources), merged with their paths.
fn facts(dir: &Dir, files: &[(&str, &str)]) -> LaravelFacts {
    let summaries: Vec<(PathBuf, FileSummary)> = files
        .iter()
        .map(|(rel, source)| (dir.path(rel), FileSummary::extract(&ParsedFile::parse(rel, *source))))
        .collect();
    LaravelFacts::merge_located(summaries.iter().map(|(path, summary)| (Some(path.as_path()), &summary.laravel)))
}

/// `(path relative to the root, kind, prefix, name prefix, middleware, module)`.
fn route_table(dir: &Dir, project: &LaravelProject) -> Vec<String> {
    project
        .route_files
        .iter()
        .map(|file| {
            let path = file.path.strip_prefix(&dir.root).unwrap_or(&file.path).to_string_lossy().replace('\\', "/");
            format!(
                "{path} {:?} '{}' '{}' [{}]{}",
                file.kind,
                file.prefix,
                file.name_prefix,
                file.middleware.join(","),
                file.module.as_deref().map(|m| format!(" {m}")).unwrap_or_default()
            )
        })
        .collect()
}

#[test]
fn route_files_resolve_against_their_registrations() {
    let dir = Dir::new();
    dir.write("composer.json", r#"{"require": {"laravel/framework": "^11.0", "nwidart/laravel-modules": "^11.0"}}"#);
    dir.write("Modules/Blog/module.json", r#"{"name": "Blog"}"#);
    let base = LaravelProject::load(&dir.root).unwrap();
    let bootstrap = r#"<?php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        then: function () {
            Route::middleware('web')->prefix('/admin/')->name('admin.')->group(base_path('routes/admin.php'));
        },
    )->create();
"#;
    let module = r#"<?php
namespace Modules\Blog\Providers;
class RouteServiceProvider {
    public function map(): void {
        Route::middleware('web')->group(module_path($this->name, '/Routes/web.php'));
        Route::middleware('api')->prefix('api/blog')->group(module_path('Blog', 'Routes/api.php'));
        Route::middleware('web')->group(module_path('Missing', 'Routes/web.php'));
        $this->loadRoutesFrom(dirname(__DIR__).'/Routes/hooks.php');
    }
}
"#;
    let registered =
        facts(&dir, &[("Modules/Blog/Providers/RouteServiceProvider.php", module), ("bootstrap/app.php", bootstrap)]);
    let project = base.with_routes(&registered);
    assert_eq!(
        route_table(&dir, &project),
        [
            "Modules/Blog/Routes/web.php Web '' '' [web] Blog",
            "Modules/Blog/Routes/api.php Api 'api/blog' '' [api] Blog",
            "Modules/Blog/Routes/hooks.php Other '' '' [] Blog",
            "routes/web.php Web '' '' [web]",
            "routes/api.php Api 'api' '' [api]",
            "routes/console.php Console '' '' []",
            "routes/admin.php Web 'admin' 'admin.' [web]",
        ]
    );
    let web = &project.route_files[3];
    let (file, range) = web.registered_at.as_ref().unwrap();
    assert_eq!(file, &dir.path("bootstrap/app.php"));
    assert_eq!((range.start.line, range.start.col), (3, 13), "the path argument");
    assert!(project.is_route_file(&dir.root.join("routes").join("..").join("routes").join("web.php")));
    let http: Vec<RouteFileKind> = project.http_route_files().map(|file| file.kind).collect();
    assert!(!http.contains(&RouteFileKind::Console));

    // The same file registered twice the same way counts once.
    let twice = facts(&dir, &[("bootstrap/app.php", bootstrap), ("bootstrap/copy.php", bootstrap)]);
    assert_eq!(base.with_routes(&twice).route_files.len(), 4);
}

#[test]
fn default_route_files_without_registrations() {
    let dir = Dir::new();
    dir.write("composer.json", LARAVEL);
    dir.write("routes/web.php", "<?php\n");
    let project = LaravelProject::load(&dir.root).unwrap().with_routes(&LaravelFacts::default());
    assert_eq!(route_table(&dir, &project), ["routes/web.php Web '' '' [web]"]);
    assert!(project.route_files[0].registered_at.is_none());
    dir.write("routes/api.php", "<?php\n");
    let project = LaravelProject::load(&dir.root).unwrap().with_routes(&LaravelFacts::default());
    assert_eq!(route_table(&dir, &project), ["routes/web.php Web '' '' [web]", "routes/api.php Api 'api' '' [api]"]);
}

// ------------------------------------------------------------------- engine

fn open_engine(dir: &Dir) -> Arc<PhpEngine> {
    let config = EngineConfig {
        cache_dir: dir._tmp.path().join("cache").join(CACHE_SUBDIR),
        layout: LayoutConfig { root: dir.root.clone(), ..LayoutConfig::default() },
        stubs: StubFilter::default(),
    };
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(Duration::from_secs(60)));
    engine
}

fn route_paths(dir: &Dir, engine: &PhpEngine) -> Vec<String> {
    route_table(dir, &engine.laravel().expect("a Laravel project"))
}

const BOOTSTRAP: &str = r#"<?php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(web: __DIR__.'/../routes/web.php')
    ->create();
"#;

#[test]
fn the_engine_keeps_the_model_up_to_date() {
    let dir = Dir::new();
    dir.write("composer.json", r#"{"require": {"symfony/console": "^7.0"}}"#);
    dir.write("index.php", "<?php\n");
    let bootstrap = dir.write("bootstrap/app.php", BOOTSTRAP);
    let engine = open_engine(&dir);
    assert!(engine.laravel().is_none(), "not a Laravel project");

    // composer.json changes: Laravel is detected.
    let composer = dir.write("composer.json", LARAVEL);
    engine.files_changed(&[composer], &[]);
    assert!(engine.wait_idle(Duration::from_secs(60)));
    assert_eq!(route_paths(&dir, &engine), ["routes/web.php Web '' '' [web]"]);
    let first = engine.laravel().unwrap();
    assert!(Arc::ptr_eq(&first, &engine.laravel().unwrap()), "cached until something changes");

    // A watcher batch changes the route files.
    std::fs::write(
        &bootstrap,
        BOOTSTRAP.replace(
            "web: __DIR__.'/../routes/web.php'",
            "web: __DIR__.'/../routes/web.php', api: __DIR__.'/../routes/api.php', apiPrefix: 'v1'",
        ),
    )
    .unwrap();
    engine.files_changed(std::slice::from_ref(&bootstrap), &[]);
    assert!(engine.wait_idle(Duration::from_secs(60)));
    assert_eq!(route_paths(&dir, &engine), ["routes/web.php Web '' '' [web]", "routes/api.php Api 'v1' '' [api]"]);

    // An open buffer counts before it is saved.
    let edited = BOOTSTRAP.replace("routes/web.php", "routes/site.php");
    engine.document_opened(ide_core::DocId(1), &bootstrap, 1, &edited);
    assert_eq!(route_paths(&dir, &engine), ["routes/site.php Web '' '' [web]"]);
    engine.document_closed(ide_core::DocId(1));

    // A module folder appearing.
    let module = dir.write("modules/Blog/routes/web.php", "<?php\n");
    engine.files_changed(&[module.parent().unwrap().parent().unwrap().to_path_buf()], &[]);
    assert!(engine.wait_idle(Duration::from_secs(60)));
    let names: Vec<String> = engine.laravel().unwrap().modules.iter().map(|m| m.name.clone()).collect();
    assert_eq!(names, ["Blog"]);
}

#[test]
fn the_fixture_app_model() {
    let dir = Dir::new();
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    copy_dir(&fixtures.join("laravel-app"), &dir.root);
    copy_dir(&fixtures.join("laravel-stubs"), &dir.root.join("vendor"));
    let engine = open_engine(&dir);
    let project = engine.laravel().expect("the fixture is a Laravel app");
    assert_eq!(project.version.as_deref(), Some("11.31.0"));
    assert_eq!(project.app_namespace, "App\\");
    assert_eq!(
        route_table(&dir, &project),
        [
            "Modules/Billing/Routes/web.php Web 'billing' 'billing.' [web] Billing",
            "Modules/Billing/Routes/api.php Api 'api/billing' 'api.billing.' [api] Billing",
            "routes/web.php Web '' '' [web]",
            "routes/api.php Api 'api' '' [api]",
            "routes/console.php Console '' '' []",
            "routes/admin.php Web 'admin' 'admin.' [web,auth]",
        ]
    );
    for file in &project.route_files {
        assert!(file.path.is_file(), "{} exists", file.path.display());
    }
    let modules: Vec<(&str, ModuleKind, Option<&str>, bool)> = project
        .modules
        .iter()
        .map(|module| (module.name.as_str(), module.kind, module.namespace.as_deref(), module.enabled))
        .collect();
    assert_eq!(modules, [("Billing", ModuleKind::Nwidart, Some("Modules\\Billing\\"), true)]);
}

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
