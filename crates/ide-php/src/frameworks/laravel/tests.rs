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

#[test]
fn route_files_at_config_computed_paths() {
    // Jetstream: `__DIR__.'/../routes/'.config('jetstream.stack').'.php'`.
    let provider = r#"<?php
namespace App\Providers;
class StackServiceProvider extends ServiceProvider {
    public function boot(): void {
        $this->loadRoutesFrom(__DIR__.'/../../routes/'.config('jetstream.stack').'.php');
        Route::middleware('web')->group(base_path('routes/teams-'.(\config('jetstream.teams', 'off')).'.php'));
        $this->loadRoutesFrom(__DIR__.'/../../routes/'.config('jetstream.missing').'.php');
        $this->loadRoutesFrom(__DIR__.'/../../routes/'.config($key).'.php');
    }
}
"#;
    assert_eq!(
        routes(provider),
        [
            "laravel routes Other dir^0/../../routes/{config('jetstream.stack')}.php",
            "laravel routes Web base:routes/teams-{config('jetstream.teams', 'off')}.php middleware [web]",
            "laravel routes Other dir^0/../../routes/{config('jetstream.missing')}.php",
        ]
    );

    let dir = Dir::new();
    dir.write("composer.json", LARAVEL);
    dir.write("config/jetstream.php", "<?php\nreturn ['stack' => 'inertia'];\n");
    let base = LaravelProject::load(&dir.root).unwrap();
    let registered = facts(&dir, &[("app/Providers/StackServiceProvider.php", provider)]);
    let read = |dir: &Dir| ConfigKeys::read(&dir.path("config"), |path| std::fs::read_to_string(path).ok());
    // The key's value, else the call's default; a key with neither leaves its file out.
    let project = base.with_routes_config(&registered, Some(&read(&dir)));
    assert_eq!(
        route_table(&dir, &project),
        ["routes/inertia.php Other '' '' []", "routes/teams-off.php Web '' '' [web]"]
    );
    // A changed configuration picks the other file.
    dir.write(
        "config/jetstream.php",
        "<?php\nreturn ['stack' => env('JETSTREAM_STACK', 'livewire'), 'teams' => \"on\"];\n",
    );
    let project = base.with_routes_config(&registered, Some(&read(&dir)));
    assert_eq!(
        route_table(&dir, &project),
        ["routes/livewire.php Other '' '' []", "routes/teams-on.php Web '' '' [web]"]
    );
    // Without the configuration, only the defaults.
    assert_eq!(route_table(&dir, &base.with_routes(&registered)), ["routes/teams-off.php Web '' '' [web]"]);
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
fn the_settings_override_detection_and_modules() {
    use ide_core::settings::{LaravelDetection, LaravelModuleSystem, LaravelSettings};

    let dir = Dir::new();
    dir.write("composer.json", r#"{"require": {"symfony/console": "^7.0"}}"#);
    dir.write(
        "index.php",
        "<?php
",
    );
    dir.write(
        "modules/Blog/routes/web.php",
        "<?php
",
    );
    let engine = open_engine(&dir);
    assert!(engine.laravel().is_none(), "not a Laravel project");

    // Forced on: read as a Laravel project with its defaults.
    let settings = |detection, modules| LaravelSettings { detection, modules, ..LaravelSettings::default() };
    engine.set_laravel_settings(settings(LaravelDetection::Enabled, LaravelModuleSystem::Auto));
    let project = engine.laravel().expect("detection forced on");
    assert_eq!(project.app_namespace, "App\\");
    let names: Vec<&str> = project.modules.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, ["Blog"]);

    // Module systems: only the nwidart modules (none here), or no modules.
    for system in [LaravelModuleSystem::Nwidart, LaravelModuleSystem::None] {
        engine.set_laravel_settings(settings(LaravelDetection::Enabled, system));
        assert!(engine.laravel().unwrap().modules.is_empty(), "{system:?}");
    }
    engine.set_laravel_settings(settings(LaravelDetection::Enabled, LaravelModuleSystem::Directory));
    assert_eq!(engine.laravel().unwrap().modules.len(), 1);

    // Forced off, even in a Laravel project; back to Auto.
    let composer = dir.write("composer.json", LARAVEL);
    engine.files_changed(&[composer], &[]);
    assert!(engine.wait_idle(Duration::from_secs(60)));
    engine.set_laravel_settings(settings(LaravelDetection::Disabled, LaravelModuleSystem::Auto));
    assert!(engine.laravel().is_none(), "detection forced off");
    assert!(engine.laravel_config().is_none(), "no Laravel model without the project");
    engine.set_laravel_settings(LaravelSettings::default());
    assert!(engine.laravel().is_some());
}

#[test]
fn module_systems_keep_their_kind_of_module() {
    let dir = Dir::new();
    dir.write("composer.json", r#"{"require": {"laravel/framework": "^11.0", "nwidart/laravel-modules": "^11.0"}}"#);
    dir.write("Modules/Blog/module.json", r#"{"name": "Blog"}"#);
    dir.write(
        "app-modules/Billing/routes/web.php",
        "<?php
",
    );
    let project = LaravelProject::load(&dir.root).unwrap();
    let names = |system| -> Vec<String> {
        project.clone().with_module_system(system).modules.into_iter().map(|module| module.name).collect()
    };
    use ide_core::settings::LaravelModuleSystem;
    assert_eq!(names(LaravelModuleSystem::Auto), ["Blog", "Billing"]);
    assert_eq!(names(LaravelModuleSystem::Nwidart), ["Blog"]);
    assert_eq!(names(LaravelModuleSystem::Directory), ["Billing"]);
    assert!(names(LaravelModuleSystem::None).is_empty());
    // Forcing detection reads a project nothing marks as Laravel.
    let plain = Dir::new();
    plain.write("composer.json", "{}");
    assert!(LaravelProject::load(&plain.root).is_none());
    assert!(LaravelProject::load_with(&plain.root, true).is_some());
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

#[test]
fn the_whole_model_is_built_and_forgotten() {
    let dir = Dir::new();
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    copy_dir(&fixtures.join("laravel-app"), &dir.root);
    copy_dir(&fixtures.join("laravel-stubs"), &dir.root.join("vendor"));
    let engine = open_engine(&dir);
    let summary = engine.laravel_model().expect("the fixture is a Laravel app");
    assert_eq!(summary.route_files, 6);
    assert_eq!(summary.modules, 1);
    assert_eq!(summary.gates, 2);
    assert_eq!(summary.vite_entries, 2);
    assert_eq!(summary.models, 4);
    assert_eq!((summary.livewire_components, summary.inertia_pages), (0, 0));
    for (part, count) in [
        ("routes", summary.routes),
        ("views", summary.views),
        ("components", summary.blade_components),
        ("config keys", summary.config_keys),
        ("translations", summary.translations),
        ("env keys", summary.env_keys),
        ("commands", summary.artisan_commands),
    ] {
        assert!(count > 0, "{part}: {summary:?}");
    }

    // Forgetting it reads `composer.json` again: a change on disk shows
    // without a watcher batch.
    let before = engine.modification_count();
    let composer = dir.root.join("composer.json");
    let text = std::fs::read_to_string(&composer).unwrap();
    std::fs::write(&composer, text.replace("\"App\\\\\": \"app/\"", "\"Blog\\\\\": \"app/\"")).unwrap();
    assert_eq!(engine.laravel().unwrap().app_namespace, "App\\", "cached until forgotten");
    engine.forget_laravel_model();
    assert!(engine.modification_count() > before);
    assert_eq!(engine.laravel().unwrap().app_namespace, "Blog\\");
    assert_eq!(engine.laravel_model().unwrap().routes, summary.routes);

    // Outside Laravel projects there is no model.
    let plain = Dir::new();
    std::fs::write(plain.root.join("composer.json"), "{}").unwrap();
    assert_eq!(open_engine(&plain).laravel_model(), None);
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

/// The files of `kind` read into parts after the first `from` reads.
fn reads_since(engine: &PhpEngine, from: usize) -> Vec<(&'static str, String)> {
    let reads = engine.laravel_part_reads();
    reads[from..].iter().map(|(kind, path)| (*kind, path.file_name().unwrap().to_string_lossy().into_owned())).collect()
}

#[test]
fn an_edit_reads_again_only_the_files_it_touched() {
    let dir = Dir::new();
    dir.write("composer.json", LARAVEL);
    dir.write("config/app.php", "<?php\nreturn ['name' => 'Blog'];\n");
    dir.write("config/mail.php", "<?php\nreturn ['from' => 'blog@example.com'];\n");
    dir.write("config/services.php", "<?php\nreturn ['stripe' => ['key' => 'k']];\n");
    dir.write("lang/en/messages.php", "<?php\nreturn ['welcome' => 'Welcome'];\n");
    let web = dir.write("routes/web.php", "<?php\nRoute::get('/', fn () => 1)->name('home');\n");
    let engine = open_engine(&dir);
    assert!(engine.laravel_config().unwrap().get("services.stripe.key").is_some());
    assert!(engine.laravel_translations().unwrap().contains("messages.welcome"));
    assert_eq!(engine.laravel_routes().unwrap().routes().len(), 1);
    let first = engine.laravel_part_reads().len();
    assert!(first >= 5, "every file read once: {:?}", engine.laravel_part_reads());

    // A keystroke in the route file: its routes are read again, and nothing
    // else.
    let doc = ide_core::DocId(1);
    let text = std::fs::read_to_string(&web).unwrap();
    engine.document_opened(doc, &web, 1, &text);
    engine.document_changed(doc, 2, &format!("{text}Route::get('/about', fn () => 2)->name('about');\n"));
    assert!(engine.laravel_routes().unwrap().named("about").next().is_some());
    assert!(engine.laravel_config().unwrap().get("app.name").is_some());
    assert!(engine.laravel_translations().unwrap().contains("messages.welcome"));
    assert_eq!(reads_since(&engine, first), [("routes", "web.php".to_owned())]);

    // An edit to one configuration file (its open buffer) reads only it.
    let app = dir.path("config/app.php");
    let at = engine.laravel_part_reads().len();
    engine.document_opened(ide_core::DocId(2), &app, 1, "<?php\nreturn ['name' => 'Blog', 'locale' => 'en'];\n");
    let keys = engine.laravel_config().unwrap();
    assert!(keys.get("app.locale").is_some());
    assert!(keys.get("mail.from").is_some() && keys.get("services.stripe.key").is_some());
    assert_eq!(reads_since(&engine, at), [("config", "app.php".to_owned())]);

    // A file changed on disk, as a watcher batch reports it: only it.
    let mail = dir.write("config/mail.php", "<?php\nreturn ['from' => 'blog@example.com', 'reply_to' => 'x'];\n");
    engine.files_changed(&[mail], &[]);
    assert!(engine.wait_idle(Duration::from_secs(60)));
    let at = engine.laravel_part_reads().len();
    let keys = engine.laravel_config().unwrap();
    assert!(keys.get("mail.reply_to").is_some() && keys.get("app.locale").is_some());
    assert_eq!(reads_since(&engine, at), [("config", "mail.php".to_owned())]);

    // Forgetting the model reads everything again (a cold build).
    engine.forget_laravel_model();
    let at = engine.laravel_part_reads().len();
    assert!(engine.laravel_config().unwrap().get("mail.reply_to").is_some());
    assert_eq!(reads_since(&engine, at).len(), 3, "the three configuration files");
}

/// The parts taken from the index database after the first `from`.
fn loads_since(engine: &PhpEngine, from: usize) -> Vec<(&'static str, String)> {
    let loads = engine.laravel_part_loads();
    loads[from..].iter().map(|(kind, path)| (*kind, path.file_name().unwrap().to_string_lossy().into_owned())).collect()
}

#[test]
fn a_new_session_takes_the_parts_an_earlier_one_stored() {
    let dir = Dir::new();
    dir.write("composer.json", LARAVEL);
    dir.write("config/app.php", "<?php\nreturn ['name' => 'Blog'];\n");
    let mail = dir.write("config/mail.php", "<?php\nreturn ['from' => 'blog@example.com'];\n");
    let messages = dir.write("lang/en/messages.php", "<?php\nreturn ['welcome' => 'Welcome'];\n");
    dir.write("lang/de.json", "{\n    \"Read more\": \"Mehr\"\n}\n");
    dir.write("routes/web.php", "<?php\nRoute::get('/', fn () => 1)->name('home');\n");
    let engine = open_engine(&dir);
    let summary = engine.laravel_model().unwrap();
    assert!(engine.laravel_part_loads().is_empty(), "nothing stored yet");
    // The worker stores what the build read.
    assert!(engine.wait_idle(Duration::from_secs(60)));
    let stored = engine.laravel_stored_parts();
    assert!(stored >= 5, "the configuration, language and route files: {stored}");
    engine.shutdown();
    drop(engine);

    // Between the sessions one file changes, and another is written again
    // with the same text (a new modification time).
    dir.write("config/mail.php", "<?php\nreturn ['from' => 'blog@example.com', 'reply_to' => 'x'];\n");
    std::fs::write(&messages, "<?php\nreturn ['welcome' => 'Welcome'];\n").unwrap();
    let later = std::time::SystemTime::now() + Duration::from_secs(5);
    std::fs::File::options().write(true).open(&messages).unwrap().set_modified(later).unwrap();

    let engine = open_engine(&dir);
    let again = engine.laravel_model().unwrap();
    assert_eq!(
        (again.config_keys, again.translations, again.routes),
        (summary.config_keys + 1, summary.translations, 1)
    );
    assert!(engine.laravel_config().unwrap().get("mail.reply_to").is_some(), "the changed file is read");
    assert!(engine.laravel_translations().unwrap().contains("Read more"));
    assert_eq!(reads_since(&engine, 0), [("config", "mail.php".to_owned())], "only the changed file is read");
    let loads = loads_since(&engine, 0);
    for file in ["app.php", "messages.php", "de.json", "web.php"] {
        assert!(loads.iter().any(|(_, name)| name == file), "{file} taken from the store: {loads:?}");
    }

    // The touched file is stored again with its new stamp, the changed one
    // with its new text: a third session reads nothing.
    assert!(engine.wait_idle(Duration::from_secs(60)));
    engine.shutdown();
    drop(engine);
    let engine = open_engine(&dir);
    assert_eq!(engine.laravel_model().unwrap(), again);
    assert!(reads_since(&engine, 0).is_empty(), "{:?}", reads_since(&engine, 0));
    assert!(engine.laravel_config().unwrap().get("mail.reply_to").is_some());

    // An open buffer's text wins over the stored part of its file.
    engine.document_opened(ide_core::DocId(1), &mail, 1, "<?php\nreturn ['bcc' => 'y'];\n");
    let keys = engine.laravel_config().unwrap();
    assert!(keys.get("mail.bcc").is_some() && keys.get("mail.reply_to").is_none());

    // A cold model drops the stored parts too.
    engine.forget_laravel_model();
    assert_eq!(engine.laravel_stored_parts(), 0);
}

#[test]
fn inspect_files_runs_in_parallel_like_inspect_file_one_by_one() {
    let dir = Dir::new();
    dir.write("composer.json", LARAVEL);
    dir.write("config/app.php", "<?php\nreturn ['name' => 'Blog'];\n");
    let mut files = Vec::new();
    for n in 0..12 {
        let text = format!(
            "<?php\nnamespace App;\n\nclass Thing{n}\n{{\n    public function run(int $unused): string\n    {{\n        $local = config('app.missing{n}');\n        return undefined_function{n}();\n    }}\n}}\n"
        );
        files.push(dir.write(&format!("app/Thing{n}.php"), &text));
    }
    files.push(dir.write("resources/views/home.blade.php", "@if(true)\n<p>{{ $title }}</p>\n"));
    // A file that can't be read is reported without diagnostics.
    files.push(dir.path("app/Missing.php"));
    let engine = open_engine(&dir);

    let batch = parking_lot::Mutex::new(Vec::new());
    let cancel = ide_core::CancellationToken::new();
    let done = engine.inspect_files(
        &files,
        |path| path.as_path(),
        |path| std::fs::read_to_string(path).ok(),
        &cancel,
        |path, diagnostics| batch.lock().push((path.clone(), diagnostics)),
    );
    assert!(done);
    let mut batch = batch.into_inner();
    batch.sort_by(|a, b| a.0.cmp(&b.0));
    let mut one_by_one: Vec<(PathBuf, Option<Vec<ide_core::Diagnostic>>)> = files
        .iter()
        .map(|path| {
            let found =
                std::fs::read_to_string(path).ok().map(|text| engine.inspect_file(path, &text, &cancel).unwrap());
            (path.clone(), found)
        })
        .collect();
    one_by_one.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(batch, one_by_one);
    let problems = batch.iter().filter_map(|(_, found)| found.as_ref()).map(Vec::len).sum::<usize>();
    assert!(problems >= 24, "an unknown key and an undefined function per class: {batch:?}");
    assert_eq!(
        batch.last().map(|(path, found)| (path.ends_with("home.blade.php"), found.is_some())),
        Some((true, true))
    );
    assert!(batch.iter().any(|(path, found)| path.ends_with("Missing.php") && found.is_none()));

    // Cancelled: it stops and says so.
    cancel.cancel();
    let reported = std::sync::atomic::AtomicUsize::new(0);
    let done = engine.inspect_files(
        &files,
        |path| path.as_path(),
        |path| std::fs::read_to_string(path).ok(),
        &cancel,
        |_, _| {
            reported.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        },
    );
    assert!(!done);
    assert_eq!(reported.into_inner(), 0);
}

#[test]
fn deleting_a_language_file_removes_its_keys() {
    let dir = Dir::new();
    dir.write("composer.json", LARAVEL);
    dir.write("lang/en/messages.php", "<?php\nreturn ['welcome' => 'Welcome', 'bye' => 'Bye'];\n");
    let fr = dir.write("lang/fr/messages.php", "<?php\nreturn ['welcome' => 'Bienvenue'];\n");
    let json = dir.write("lang/de.json", "{\n    \"Read more\": \"Mehr\",\n    \"a \\\"quoted\\\" key\": \"x\"\n}\n");
    let engine = open_engine(&dir);
    let translations = engine.laravel_translations().unwrap();
    let locales = |key: &str| -> Vec<String> {
        engine.laravel_translations().unwrap().get(key).map(|entry| entry.locale.clone()).collect()
    };
    assert_eq!(locales("messages.welcome"), ["en", "fr"]);
    assert_eq!(locales("Read more"), ["de"]);
    // The JSON keys' literals, found in one pass over the file.
    let quoted = translations.get("a \"quoted\" key").next().unwrap();
    assert_eq!((quoted.range.start.line, quoted.range.start.col), (2, 5));
    let read_more = translations.get("Read more").next().unwrap();
    assert_eq!((read_more.range.start.line, read_more.range.start.col, read_more.range.end.col), (1, 5, 14));

    std::fs::remove_file(&fr).unwrap();
    std::fs::remove_file(&json).unwrap();
    engine.files_changed(&[], &[fr, json]);
    assert!(engine.wait_idle(Duration::from_secs(60)));
    let at = engine.laravel_part_reads().len();
    assert_eq!(locales("messages.welcome"), ["en"]);
    assert!(locales("Read more").is_empty(), "the JSON file's keys are gone");
    assert!(locales("messages.bye") == ["en"]);
    assert!(reads_since(&engine, at).is_empty(), "the English file isn't read again");
}

// ------------------------------------------------- package registrations

const SHOP_PROVIDER: &str = r#"<?php
namespace Acme\Shop\Providers;

use Illuminate\Routing\Router;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use Acme\Shop\Http\Middleware\Customer;

class ShopServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(dirname(__DIR__).'/Config/shop.php', 'shop');
    }

    public function boot(Router $router): void
    {
        $router->aliasMiddleware('customer', Customer::class);
        $router->middlewareGroup('shop', [Customer::class]);
        Route::middleware(['web', 'shop'])->group(__DIR__.'/../Routes/web.php');
        $this->loadMigrationsFrom(__DIR__.'/../Database/Migrations');
        $this->loadTranslationsFrom(__DIR__.'/../Resources/lang', 'shop');
        $this->loadJsonTranslationsFrom(__DIR__.'/../Resources/json');
        $this->loadViewsFrom(__DIR__.'/../Resources/views', 'shop');
        $this->publishes([dirname(__DIR__).'/Config/shop.php' => config_path('shop.php')], 'shop-config');
        $this->app->register(EventServiceProvider::class);
    }
}
"#;

const SHOP_ROUTES: &str = r#"<?php
use Illuminate\Support\Facades\Route;

require 'store.php';
Route::group(['middleware' => ['customer'], 'prefix' => 'account', 'as' => 'account.'], function () {
    require __DIR__.'/account.php';
});
"#;

const SHOP_STORE: &str = r#"<?php
use Acme\Shop\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

Route::get('/', [HomeController::class, 'index'])->name('shop.home');
"#;

const SHOP_ACCOUNT: &str = r#"<?php
use Acme\Shop\Http\Controllers\HomeController;
use Illuminate\Support\Facades\Route;

Route::get('orders', [HomeController::class, 'orders'])->name('orders');
"#;

const SHOP_CONTROLLER: &str = r#"<?php
namespace Acme\Shop\Http\Controllers;

class HomeController
{
    public function index() {}

    public function orders() {}
}
"#;

const EVENT_PROVIDER: &str = r#"<?php
namespace Acme\Shop\Providers;

class EventServiceProvider
{
    public function boot()
    {
        $this->loadViewsFrom(__DIR__.'/../Resources/emails', 'shop-mail');
    }
}
"#;

const PKG_PROVIDER: &str = r#"<?php
namespace Acme\Pkg;

class PkgServiceProvider
{
    public function boot()
    {
        $this->loadViewsFrom(__DIR__.'/../views', 'pkg');
    }
}
"#;

#[test]
fn package_providers_register_views_translations_routes_and_modules() {
    let dir = Dir::new();
    dir.write(
        "composer.json",
        r#"{"require": {"laravel/framework": "^11.0", "konekt/concord": "^1.18"},
            "autoload": {"psr-4": {"App\\": "app/", "Acme\\Shop\\": "packages/Acme/Shop/src/"}}}"#,
    );
    dir.write("bootstrap/app.php", BOOTSTRAP);
    dir.write("routes/web.php", "<?php\n");
    dir.write(
        "bootstrap/providers.php",
        r#"<?php
use App\Providers\AppServiceProvider;
use Acme\Shop\Providers\ShopServiceProvider;

return [AppServiceProvider::class, ShopServiceProvider::class];
"#,
    );
    dir.write(
        "app/Providers/AppServiceProvider.php",
        "<?php\nnamespace App\\Providers;\nclass AppServiceProvider {}\n",
    );
    dir.write(
        "config/concord.php",
        "<?php\nreturn ['modules' => [Acme\\Shop\\Providers\\ModuleServiceProvider::class]];\n",
    );
    let shop = "packages/Acme/Shop/src";
    let at = |rel: &str| format!("{shop}/{rel}");
    dir.write(&at("Providers/ShopServiceProvider.php"), SHOP_PROVIDER);
    dir.write(
        &at("Providers/ModuleServiceProvider.php"),
        "<?php\nnamespace Acme\\Shop\\Providers;\nclass ModuleServiceProvider {}\n",
    );
    dir.write(&at("Providers/EventServiceProvider.php"), EVENT_PROVIDER);
    dir.write(&at("Config/shop.php"), "<?php\nreturn ['currency' => 'EUR'];\n");
    dir.write(&at("Database/Migrations/2024_01_01_000000_create_carts_table.php"), "<?php\n");
    dir.write(&at("Resources/lang/en/app.php"), "<?php\nreturn ['title' => 'Shop'];\n");
    dir.write(&at("Resources/json/fr.json"), "{\"Cart\": \"Panier\"}\n");
    dir.write(&at("Resources/views/home.blade.php"), "home\n");
    dir.write(&at("Resources/views/cart.blade.php"), "cart\n");
    dir.write(&at("Resources/emails/order.blade.php"), "order\n");
    dir.write("resources/views/vendor/shop/home.blade.php", "published home\n");
    dir.write(&at("Routes/web.php"), SHOP_ROUTES);
    let store = dir.write(&at("Routes/store.php"), SHOP_STORE);
    dir.write(&at("Routes/account.php"), SHOP_ACCOUNT);
    let controller = dir.write(&at("Http/Controllers/HomeController.php"), SHOP_CONTROLLER);
    // A package found by package discovery.
    dir.write(
        "vendor/composer/installed.json",
        r#"{"packages": [{"name": "acme/pkg", "install-path": "../acme/pkg",
            "autoload": {"psr-4": {"Acme\\Pkg\\": "src/"}},
            "extra": {"laravel": {"providers": ["Acme\\Pkg\\PkgServiceProvider"]}}}]}"#,
    );
    dir.write("vendor/acme/pkg/src/PkgServiceProvider.php", PKG_PROVIDER);
    dir.write("vendor/acme/pkg/views/widget.blade.php", "widget\n");

    let engine = open_engine(&dir);
    let project = engine.laravel().expect("a Laravel project");
    let providers: Vec<String> =
        project.providers.iter().map(|path| path.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(
        providers,
        [
            "AppServiceProvider.php",
            "EventServiceProvider.php",
            "ModuleServiceProvider.php",
            "ShopServiceProvider.php",
            "PkgServiceProvider.php"
        ],
        "the provider folders of the app and of the Concord module, then the discovered package's"
    );
    let modules: Vec<_> = project.modules.iter().map(|m| (m.name.as_str(), m.kind, m.namespace.as_deref())).collect();
    assert_eq!(modules, [("Shop", ModuleKind::Concord, Some("Acme\\Shop\\"))]);
    let files: Vec<String> = views::provider_files(&project)
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    for provider in
        ["AppServiceProvider.php", "ShopServiceProvider.php", "EventServiceProvider.php", "PkgServiceProvider.php"]
    {
        assert!(files.iter().any(|file| file == provider), "{provider} in {files:?}");
    }
    let nwidart = (*project).clone().with_module_system(ide_core::settings::LaravelModuleSystem::Nwidart);
    assert!(nwidart.modules.is_empty(), "Concord modules are read in automatic mode only");

    // Views: the package's, the published copy first, the ones of a
    // provider the package registers, and a discovered package's.
    let views = engine.laravel_views().unwrap();
    assert_eq!(views.get("shop::home").unwrap().path, dir.path("resources/views/vendor/shop/home.blade.php"));
    assert_eq!(views.get("shop::cart").unwrap().path, dir.path(&at("Resources/views/cart.blade.php")));
    assert!(views.get("shop-mail::order").is_some());
    assert!(views.get("pkg::widget").is_some());

    // Translations and configuration.
    let translations = engine.laravel_translations().unwrap();
    assert!(translations.contains("shop::app.title"));
    let cart: Vec<String> = translations.get("Cart").map(|entry| entry.locale.clone()).collect();
    assert_eq!(cart, ["fr"]);
    assert!(engine.laravel_config().unwrap().get("shop.currency").is_some());

    // Routes the package's provider loads, through the files they include,
    // and the middleware it declares.
    let routes = engine.laravel_routes().unwrap();
    let home = routes.named("shop.home").next().expect("shop.home");
    assert_eq!(home.uri, "");
    assert_eq!(home.middleware, ["web", "shop"]);
    let orders = routes.named("account.orders").next().expect("account.orders");
    assert_eq!(orders.uri, "account/orders");
    assert_eq!(orders.middleware, ["web", "shop", "customer"]);
    let customer = routes.middleware_named("customer").expect("the provider's alias");
    assert_eq!(customer.class.as_deref(), Some("Acme\\Shop\\Http\\Middleware\\Customer"));
    assert!(routes.middleware_named("shop").is_some_and(|m| m.group));

    // Route hints in an included file, and lenses on the package's
    // controller.
    let doc = ide_core::DocId(7);
    engine.document_opened(doc, &store, 1, SHOP_STORE);
    let end = ide_core::Pos { line: 10, col: 0 };
    let hints = engine.laravel_route_hints(doc, ide_core::Range { start: ide_core::Pos::default(), end }).unwrap();
    assert_eq!(hints.iter().map(|hint| hint.label.as_str()).collect::<Vec<_>>(), ["/"]);
    let doc = ide_core::DocId(8);
    engine.document_opened(doc, &controller, 1, SHOP_CONTROLLER);
    let lenses = engine.laravel_route_lenses(doc).unwrap();
    let titles: Vec<String> = lenses.iter().map(|lens| lens.title()).collect();
    assert_eq!(titles, ["GET / · shop.home", "GET /account/orders · account.orders"]);

    let summary = engine.laravel_model().unwrap();
    assert_eq!((summary.modules, summary.package_migrations, summary.published), (1, 1, 1));
    assert_eq!(summary.providers, 5, "{summary:?}");
}

#[test]
fn package_registrations_of_a_provider() {
    let dir = Dir::new();
    dir.write("composer.json", LARAVEL);
    let project = LaravelProject::load(&dir.root).unwrap();
    let provider = dir.path("packages/x/src/Providers/XServiceProvider.php");
    let text = r#"<?php
$this->loadTranslationsFrom(__DIR__.'/../lang');
$this->loadMigrationsFrom([__DIR__.'/../a', __DIR__.'/../b']);
$this->publishes([
    __DIR__.'/../views' => resource_path('views/vendor/x'),
    __DIR__.'/../x.php' => config_path('x.php'),
], 'x');
"#;
    let found = PackageRegistrations::read(&project, &provider, text);
    assert_eq!(found.translations, [(None, dir.path("packages/x/src/lang"))]);
    assert_eq!(found.migrations, [dir.path("packages/x/src/a"), dir.path("packages/x/src/b")]);
    let published: Vec<_> = found.publishes.iter().map(|p| (p.from.clone(), p.to.clone(), p.group.clone())).collect();
    assert_eq!(
        published,
        [
            (dir.path("packages/x/src/views"), dir.path("resources/views/vendor/x"), Some("x".to_owned())),
            (dir.path("packages/x/src/x.php"), dir.path("config/x.php"), Some("x".to_owned())),
        ]
    );
}

#[test]
fn a_changed_provider_reads_the_providers_again() {
    let dir = Dir::new();
    dir.write("composer.json", LARAVEL);
    let provider = dir.write(
        "app/Providers/AppServiceProvider.php",
        "<?php\nnamespace App\\Providers;\nclass AppServiceProvider {}\n",
    );
    let engine = open_engine(&dir);
    assert_eq!(engine.laravel().unwrap().providers, [dir.path("app/Providers/AppServiceProvider.php")]);
    assert!(engine.laravel_views().unwrap().namespace("extra").is_none());

    // The provider now registers another one, which adds views.
    dir.write(
        "app/Providers/AppServiceProvider.php",
        "<?php\nnamespace App\\Providers;\nclass AppServiceProvider {\n    public function register() {\n        \
         $this->app->register(\\App\\Extra\\ExtraServiceProvider::class);\n    }\n}\n",
    );
    let extra = dir.write(
        "app/Extra/ExtraServiceProvider.php",
        "<?php\nnamespace App\\Extra;\nclass ExtraServiceProvider {\n    public function boot() {\n        \
         $this->loadViewsFrom(__DIR__.'/views', 'extra');\n    }\n}\n",
    );
    dir.write("app/Extra/views/panel.blade.php", "panel\n");
    engine.files_changed(&[provider, extra], &[]);
    assert!(engine.wait_idle(Duration::from_secs(60)));
    assert_eq!(engine.laravel().unwrap().providers.len(), 2);
    assert!(engine.laravel_views().unwrap().get("extra::panel").is_some());
}
