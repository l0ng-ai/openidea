//! The Laravel parity checklist (roadmap phase 8.21): every string-reference kind through
//! completion, goto, find usages and its "undefined …" inspection, and every generator, on the
//! fixture app (`fixtures/laravel-app` with `fixtures/laravel-stubs` as its `vendor/`, Livewire
//! and Inertia installed). The results are written down in `docs/php-engine/laravel.md`.
//!
//! What isn't supported yet is listed in [`GAPS`]; a gap that starts working fails the test, so
//! the list (and the document) stays true. `real_app_checklist` runs the parts that don't need
//! the fixture's names on a real application with `vendor/` (`LARAVEL_APP_DIR`, ignored).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ide_core::{CancellationToken, DocId, FileEdit, IdeEvent, Pos, SharedSink, WorkspaceEdit};
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use ide_php::frameworks::laravel::generate::{ModelField, NewClass, NewModel, TemplateSet};
use ide_php::frameworks::laravel::refs::kinds;
use ide_php::project::LayoutConfig;
use ide_php::stubs::StubFilter;
use ide_php::syntax::ParsedFile;

const CARET: &str = "/*|*/";
const TIMESTAMP: &str = "2024_06_01_120000";

/// One reference kind: where to ask for completion, goto and usages, and an undefined value.
struct Check {
    kind: &'static str,
    /// Statements with the caret at the start of an empty or partial string.
    complete: &'static str,
    /// A completion label it lists.
    label: &'static str,
    /// Statements with the caret on a known value. Outside route files they are also written
    /// to `app/Parity/Uses.php` before the app is indexed, so find usages has a usage in
    /// another file to find.
    goto: &'static str,
    /// The end of the path of one of its targets (`/` separators); `None` when the value
    /// names nothing to go to.
    target: Option<&'static str>,
    /// The statements register routes: they go in a route file (`routes/admin.php`, loaded by
    /// `bootstrap/app.php`), and find usages finds the same values in `routes/web.php`.
    routes: bool,
    /// Statements using an undefined value, and the inspection reporting it.
    undefined: Option<(&'static str, &'static str)>,
}

const fn check(
    kind: &'static str,
    complete: &'static str,
    label: &'static str,
    goto: &'static str,
    target: &'static str,
) -> Check {
    Check { kind, complete, label, goto, target: Some(target), routes: false, undefined: None }
}

impl Check {
    const fn in_routes(self) -> Self {
        Self { routes: true, ..self }
    }

    const fn nothing_to_go_to(self) -> Self {
        Self { target: None, ..self }
    }

    const fn undefined(self, source: &'static str, inspection: &'static str) -> Self {
        Self { undefined: Some((source, inspection)), ..self }
    }
}

const CHECKS: &[Check] = &[
    check("configKey", "config('blog./*|*/');", "feed", "config('blog.feed./*|*/title');", "config/blog.php")
        .undefined("config('blog.feed.colour');", "PhpUndefinedConfigKey"),
    check("envKey", "env('BLOG_/*|*/');", "BLOG_FEED_ENABLED", "env('/*|*/BLOG_FEED_ENABLED');", ".env.example")
        .undefined("env('BLOG_NOWHERE');", "PhpUndefinedEnvKey"),
    check("translationKey", "__('messages./*|*/');", "welcome", "__('messages./*|*/welcome');", "lang/en/messages.php")
        .undefined("__('messages.nowhere');", "PhpUndefinedTranslation"),
    check(
        "viteAsset",
        "Vite::asset('resources/js//*|*/');",
        "app.js",
        "Vite::asset('/*|*/resources/js/app.js');",
        "resources/js/app.js",
    )
    .undefined("Vite::asset('resources/js/nowhere.js');", "PhpUndefinedViteAsset"),
    check("routeName", "route('/*|*/');", "home", "route('/*|*/home');", "routes/web.php")
        .undefined("route('nowhere');", "PhpUndefinedRoute"),
    check(
        "controllerAction",
        "Route::get('/p', [PostController::class, '/*|*/']);",
        "index",
        "Route::get('/p', [PostController::class, '/*|*/index']);",
        "app/Http/Controllers/PostController.php",
    )
    .in_routes(),
    check(
        "resourceAction",
        "Route::resource('p', PostController::class)->only(['/*|*/']);",
        "index",
        "Route::resource('p', PostController::class)->only(['/*|*/show']);",
        "app/Http/Controllers/PostController.php",
    )
    .in_routes(),
    check(
        "middleware",
        "Route::get('/p', fn () => 1)->middleware('/*|*/');",
        "author",
        "Route::get('/p', fn () => 1)->middleware('/*|*/author');",
        "app/Http/Middleware/EnsureUserIsAuthor.php",
    )
    .in_routes(),
    check(
        "viewName",
        "view('posts./*|*/');",
        "index",
        "view('/*|*/posts.index');",
        "resources/views/posts/index.blade.php",
    )
    .undefined("view('posts.nowhere');", "PhpUndefinedView"),
    // Goto works on a rule's parameters (a field, a table, a column).
    check(
        "validationRule",
        "$request->validate(['a' => '/*|*/']);",
        "required",
        "$request->validate(['a' => 'exists:posts,/*|*/title']);",
        "_create_posts_table.php",
    )
    .undefined("$request->validate(['a' => 'nowhere_rule']);", "PhpUnknownValidationRule"),
    check(
        "requestField",
        "$request->input('/*|*/');",
        "title",
        "$request->input('/*|*/title');",
        "app/Http/Requests/StorePostRequest.php",
    ),
    check("eloquentField", "Post::where('/*|*/');", "title", "Post::where('/*|*/title');", "_create_posts_table.php")
        .undefined("Post::where('nowhere_column', 1);", "PhpUnknownEloquentColumn"),
    check(
        "eloquentRelation",
        "Post::with('/*|*/');",
        "comments",
        "Post::with('/*|*/comments');",
        "app/Models/Post.php",
    ),
    check("dbTable", "DB::table('/*|*/');", "posts", "DB::table('/*|*/posts');", "_create_posts_table.php"),
    check(
        "gate",
        "Gate::allows('/*|*/');",
        "publish-posts",
        "Gate::allows('/*|*/publish-posts');",
        "app/Providers/AppServiceProvider.php",
    )
    .undefined("Gate::allows('nowhere-ability');", "PhpUnknownAbility"),
    check("authGuard", "auth('/*|*/');", "web", "auth('/*|*/web');", "config/auth.php"),
    check(
        "passwordBroker",
        "Password::broker('/*|*/');",
        "users",
        "Password::broker('/*|*/users');",
        "config/auth.php",
    ),
    check(
        "artisanCommand",
        "Artisan::call('posts:/*|*/');",
        "posts:publish",
        "Artisan::call('/*|*/posts:publish');",
        "app/Console/Commands/PublishScheduledPosts.php",
    )
    .undefined("Artisan::call('posts:nowhere');", "PhpUnknownArtisanCommand"),
    check(
        "artisanOption",
        "Artisan::call('posts:publish', ['/*|*/' => true]);",
        "--dry-run",
        "Artisan::call('posts:publish', ['/*|*/--dry-run' => true]);",
        "app/Console/Commands/PublishScheduledPosts.php",
    ),
    check(
        "livewireComponent",
        "Livewire::test('/*|*/');",
        "counter",
        "Livewire::test('/*|*/counter');",
        "app/Livewire/Counter.php",
    ),
    check(
        "livewireParameter",
        "Livewire::test('counter', ['/*|*/' => 1]);",
        "start",
        "Livewire::test('counter', ['/*|*/start' => 1]);",
        "app/Livewire/Counter.php",
    ),
    check(
        "inertiaPage",
        "Inertia::render('/*|*/');",
        "Dashboard",
        "Inertia::render('/*|*/Dashboard');",
        "resources/js/Pages/Dashboard.vue",
    )
    .undefined("Inertia::render('Nowhere');", "PhpUndefinedInertiaPage"),
    // The fixture's `ide.json` lists plain strings, without `stringsWithLocation`.
    check("staticStrings", "feed_theme('/*|*/');", "dark", "feed_theme('/*|*/dark');", "").nothing_to_go_to(),
    check("directoryFiles", "stylesheet('/*|*/');", "app", "stylesheet('/*|*/app');", "resources/css/app.css"),
];

/// What isn't supported yet: `(kind, feature)` with `feature` one of `completion`, `goto`,
/// `usages`, `inspection`. Kept in step with `docs/php-engine/laravel.md`.
const GAPS: &[(&str, &str)] = &[];

const PROBE: &str = "app/Parity/Probe.php";
const ROUTE_PROBE: &str = "routes/admin.php";

fn probe_source(body: &str) -> String {
    format!(
        "<?php\n\nnamespace App\\Parity;\n\n\
         use App\\Http\\Controllers\\PostController;\n\
         use App\\Http\\Requests\\StorePostRequest;\n\
         use App\\Models\\Post;\n\
         use Illuminate\\Support\\Facades\\Artisan;\n\
         use Illuminate\\Support\\Facades\\DB;\n\
         use Illuminate\\Support\\Facades\\Gate;\n\
         use Illuminate\\Support\\Facades\\Password;\n\
         use Illuminate\\Support\\Facades\\Route;\n\
         use Illuminate\\Support\\Facades\\Vite;\n\
         use Inertia\\Inertia;\n\
         use Livewire\\Livewire;\n\n\
         class Probe\n{{\n    public function run(StorePostRequest $request): void\n    {{\n        {body}\n    }}\n}}\n"
    )
}

fn route_source(body: &str) -> String {
    format!(
        "<?php\n\nuse App\\Http\\Controllers\\PostController;\nuse Illuminate\\Support\\Facades\\Route;\n\n{body}\n"
    )
}

/// `app/Parity/Uses.php`: every goto statement outside route files, without its caret.
fn uses_source() -> String {
    let body: Vec<String> =
        CHECKS.iter().filter(|check| !check.routes).map(|check| check.goto.replace(CARET, "")).collect();
    probe_source(&body.join("\n        ")).replace("class Probe", "class Uses")
}

/// The text without the caret marker, and the caret's position.
fn caret(source: &str) -> (String, Pos) {
    let at = source.find(CARET).expect("a /*|*/ caret");
    let text = format!("{}{}", &source[..at], &source[at + CARET.len()..]);
    let before = &text[..at];
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let pos = Pos::new(before.matches('\n').count() as u32, before[line_start..].encode_utf16().count() as u32);
    (text, pos)
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
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

const COUNTER: &str = r#"<?php

namespace App\Livewire;

use Livewire\Component;

class Counter extends Component
{
    public int $count = 0;

    public function mount(int $start = 0)
    {
        $this->count = $start;
    }

    public function render()
    {
        return view('livewire.counter');
    }
}
"#;

/// The fixture app in a temporary folder with its stub `vendor/`, Livewire and Inertia
/// installed, a Livewire component, an Inertia page and `app/Parity/Uses.php`.
fn fixture_app(tmp: &Path) -> PathBuf {
    let root = dunce::canonicalize(tmp).unwrap().join("laravel-app");
    copy_dir(&fixtures().join("laravel-app"), &root);
    copy_dir(&fixtures().join("laravel-stubs"), &root.join("vendor"));
    let installed_path = root.join("vendor/composer/installed.json");
    let mut installed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&installed_path).unwrap()).unwrap();
    let packages = installed["packages"].as_array_mut().unwrap();
    packages.push(serde_json::json!({
        "name": "livewire/livewire", "version": "v3.5.12", "type": "library",
        "autoload": { "classmap": ["src/"] }, "install-path": "../livewire/livewire"
    }));
    packages.push(serde_json::json!({
        "name": "inertiajs/inertia-laravel", "version": "v2.0.0", "type": "library",
        "autoload": { "classmap": ["src/"], "files": ["helpers.php"] }, "install-path": "../inertiajs/inertia-laravel"
    }));
    std::fs::write(&installed_path, serde_json::to_string_pretty(&installed).unwrap()).unwrap();
    let ide_json = std::fs::read_to_string(root.join("ide.json")).unwrap();
    let ide_json = ide_json.replace(r#""disabledPackages": ["livewire/livewire"]"#, r#""disabledPackages": []"#);
    std::fs::write(root.join("ide.json"), ide_json).unwrap();
    let uses = uses_source();
    for (rel, text) in [
        ("app/Livewire/Counter.php", COUNTER),
        ("resources/views/livewire/counter.blade.php", "<div>{{ $count }}</div>\n"),
        ("resources/js/Pages/Dashboard.vue", "<template>\n    <div></div>\n</template>\n"),
        ("app/Parity/Uses.php", uses.as_str()),
    ] {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    root
}

fn open_engine(root: &Path, cache: &Path) -> Arc<PhpEngine> {
    let config = EngineConfig {
        cache_dir: cache.join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.to_path_buf(), ..LayoutConfig::default() },
        stubs: StubFilter::default(),
    };
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(Duration::from_secs(600)), "{} indexes", root.display());
    engine
}

fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

struct Session {
    engine: Arc<PhpEngine>,
    root: PathBuf,
    next: u32,
}

impl Session {
    /// Opens the probe file holding `body`: a method body, or route registrations in a route
    /// file.
    fn open(&mut self, body: &str, routes: bool) -> (DocId, Pos) {
        let (source, file) = if routes { (route_source(body), ROUTE_PROBE) } else { (probe_source(body), PROBE) };
        let (text, pos) = caret(&source);
        self.next += 1;
        let doc = DocId(self.next);
        self.engine.document_opened(doc, &self.root.join(file), 1, &text);
        (doc, pos)
    }

    fn completes(&mut self, check: &Check) -> Result<(), String> {
        let (doc, pos) = self.open(check.complete, check.routes);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new());
        self.engine.document_closed(doc);
        let labels: Vec<String> =
            found.map(|found| found.items.into_iter().map(|item| item.label).collect()).unwrap_or_default();
        if labels.iter().any(|label| label == check.label) {
            Ok(())
        } else {
            Err(format!("no `{}` in {:?}", check.label, labels.iter().take(15).collect::<Vec<_>>()))
        }
    }

    fn goes_to(&mut self, check: &Check) -> Result<(), String> {
        let (doc, pos) = self.open(check.goto, check.routes);
        let targets = self.engine.definition(doc, pos).unwrap_or_default();
        self.engine.document_closed(doc);
        let paths: Vec<String> = targets.iter().map(|target| slashes(&target.path)).collect();
        match check.target {
            Some(target) if paths.iter().any(|path| path.ends_with(target)) => Ok(()),
            Some(target) => Err(format!("no target in `{target}`: {paths:?}")),
            None if paths.is_empty() => Ok(()),
            None => Err(format!("targets where none were expected: {paths:?}")),
        }
    }

    fn has_usages(&mut self, check: &Check) -> Result<(), String> {
        let (doc, pos) = self.open(check.goto, check.routes);
        let found = self.engine.references(doc, pos, false, &CancellationToken::new());
        self.engine.document_closed(doc);
        let usages = match found {
            Some(Ok(usages)) => usages,
            Some(Err(error)) => return Err(error.to_string()),
            None => return Err("nothing at the caret".to_owned()),
        };
        let probe = if check.routes { ROUTE_PROBE } else { PROBE };
        let elsewhere: Vec<String> =
            usages.iter().map(|usage| slashes(&usage.path)).filter(|path| !path.ends_with(probe)).collect();
        if elsewhere.is_empty() { Err(format!("no usage outside the probe ({} in it)", usages.len())) } else { Ok(()) }
    }

    fn reports(&mut self, body: &str, inspection: &str) -> Result<(), String> {
        let (doc, _) = self.open(&format!("{body}{CARET}"), false);
        let inspected = self.engine.inspect(doc, &CancellationToken::new());
        self.engine.document_closed(doc);
        let problems: Vec<&str> = inspected
            .as_ref()
            .map(|found| found.problems.iter().map(|problem| problem.inspection).collect())
            .unwrap_or_default();
        if problems.contains(&inspection) { Ok(()) } else { Err(format!("no {inspection} in {problems:?}")) }
    }
}

#[test]
fn every_reference_kind_completes_goes_to_finds_usages_and_inspects() {
    let tmp = tempfile::tempdir().unwrap();
    let root = fixture_app(tmp.path());
    let engine = open_engine(&root, &tmp.path().join("cache"));
    let mut session = Session { engine, root, next: 0 };

    // Every kind has a check.
    let known: BTreeSet<&str> = kinds().iter().map(|kind| kind.id()).collect();
    let checked: BTreeSet<&str> = CHECKS.iter().map(|check| check.kind).collect();
    assert_eq!(known, checked, "a check per reference kind");

    let mut failures = Vec::new();
    let mut fixed = Vec::new();
    let mut table = Vec::new();
    for check in CHECKS {
        let mut row = vec![check.kind.to_owned()];
        let mut results = vec![
            ("completion", session.completes(check)),
            ("goto", session.goes_to(check)),
            ("usages", session.has_usages(check)),
        ];
        if let Some((body, inspection)) = check.undefined {
            results.push(("inspection", session.reports(body, inspection)));
        }
        for (feature, result) in results {
            let gap = GAPS.contains(&(check.kind, feature));
            row.push(format!("{feature}:{}", if result.is_ok() { "ok" } else { "gap" }));
            match (result, gap) {
                (Ok(()), true) => fixed.push(format!("{} {feature}", check.kind)),
                (Err(error), false) => failures.push(format!("{} {feature}: {error}", check.kind)),
                _ => {}
            }
        }
        table.push(row.join(" "));
    }
    eprintln!("{}", table.join("\n"));
    assert!(failures.is_empty(), "failing checks:\n{}", failures.join("\n"));
    assert!(fixed.is_empty(), "these work now; remove them from GAPS and laravel.md:\n{}", fixed.join("\n"));
}

/// The files `edit` creates, with their text.
fn created_files(edit: &WorkspaceEdit) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for file in &edit.files {
        if let FileEdit::Edit { path, edits, .. } = file {
            let text: String = edits.iter().map(|edit| edit.new_text.as_str()).collect();
            out.push((path.to_path_buf(), text));
        }
    }
    out
}

/// `files` isn't empty, no file is, and the PHP ones parse without errors.
fn check_generated(files: &[(PathBuf, String)]) -> Result<(), String> {
    if files.is_empty() {
        return Err("no files".to_owned());
    }
    for (path, text) in files {
        let name = slashes(path);
        if text.trim().is_empty() {
            return Err(format!("{name} is empty"));
        }
        if name.ends_with(".php")
            && !name.ends_with(".blade.php")
            && ParsedFile::parse(&name, text.as_str()).has_errors()
        {
            return Err(format!("{name} doesn't parse:\n{text}"));
        }
    }
    Ok(())
}

/// A request for generator `id` with every option filled in.
fn class_request(id: &str) -> NewClass {
    let name = match id {
        "migration" => "create_parities_table",
        "pivot-migration" => "post_tag",
        "view" | "anonymous-component" => "parity.card",
        "livewire" => "parity.counter",
        _ => "ParityThing",
    };
    NewClass {
        generator: id.to_owned(),
        name: name.to_owned(),
        model: "Post".to_owned(),
        related: "Tag".to_owned(),
        event: "App\\Events\\PostPublished".to_owned(),
        create: true,
        ..NewClass::default()
    }
}

#[test]
fn every_generator_generates_files_that_parse() {
    let tmp = tempfile::tempdir().unwrap();
    let root = fixture_app(tmp.path());
    let engine = open_engine(&root, &tmp.path().join("cache"));
    let context = engine.laravel_generation_context().expect("a Laravel project");
    let ids: Vec<&str> = context.generators.iter().map(|generator| generator.id.as_str()).collect();
    assert!(ids.contains(&"model"), "{ids:?}");
    assert!(ids.contains(&"livewire"), "Livewire is installed: {ids:?}");
    assert!(ids.iter().any(|id| id.starts_with("ide-json:")), "the ide.json code generation: {ids:?}");

    let templates = TemplateSet::default();
    let mut failures = Vec::new();
    for generator in &context.generators {
        let result = if generator.id == "model" {
            let spec = NewModel {
                name: "Parity".to_owned(),
                fields: vec![ModelField { name: "title".to_owned(), ty: "string".to_owned(), ..ModelField::default() }],
                migration: true,
                factory: true,
                seeder: true,
                form_requests: true,
                resource: true,
                policy: true,
                ..NewModel::default()
            };
            engine.laravel_new_model(&spec, &templates, TIMESTAMP)
        } else {
            engine.laravel_generate_class(&class_request(&generator.id), &templates, TIMESTAMP)
        };
        if let Err(error) = result.and_then(|edit| check_generated(&created_files(&edit))) {
            failures.push(format!("{}: {error}", generator.id));
        }
    }
    assert!(failures.is_empty(), "failing generators:\n{}", failures.join("\n"));
}

/// The checklist's parts that don't depend on the fixture's names, on a real application
/// with `vendor/` (`LARAVEL_APP_DIR`): the project model, completion of the kinds every app
/// has values for, and every generator (in memory; nothing is written).
#[test]
#[ignore = "needs a Laravel application with vendor/ in LARAVEL_APP_DIR"]
fn real_app_checklist() {
    let Some(root) = std::env::var_os("LARAVEL_APP_DIR").map(PathBuf::from) else {
        eprintln!("LARAVEL_APP_DIR isn't set; skipped");
        return;
    };
    let root = dunce::canonicalize(&root).expect("LARAVEL_APP_DIR exists");
    let tmp = tempfile::tempdir().unwrap();
    let engine = open_engine(&root, tmp.path());
    let project = engine.laravel().expect("a Laravel project");
    eprintln!("Laravel {:?}, app namespace {}", project.version, project.app_namespace);
    let model = engine.laravel_model().expect("the project model");
    eprintln!("{model:?}");
    assert!(model.routes > 0 && model.views > 0 && model.config_keys > 0, "{model:?}");

    let mut session = Session { engine: engine.clone(), root: root.clone(), next: 0 };
    let mut missing = Vec::new();
    for (kind, body) in [
        ("configKey", "config('/*|*/');"),
        ("routeName", "route('/*|*/');"),
        ("viewName", "view('/*|*/');"),
        ("translationKey", "__('/*|*/');"),
        ("envKey", "env('/*|*/');"),
        // The probe's `StorePostRequest` is the fixture's: a request every app has.
        ("validationRule", "(new \\Illuminate\\Http\\Request())->validate(['a' => '/*|*/']);"),
        ("validationRule", "\\Illuminate\\Support\\Facades\\Validator::make([], ['a' => ['/*|*/']]);"),
        ("artisanCommand", "Artisan::call('/*|*/');"),
    ] {
        let (doc, pos) = session.open(body, false);
        let found = session.engine.completion(doc, pos, None, &CancellationToken::new());
        session.engine.document_closed(doc);
        if found.is_none_or(|found| found.items.is_empty()) {
            missing.push(kind);
        }
    }
    // Monica's services validate what their `rules()` returns
    // (`Validator::make($data, $this->rules())` in `App\Services\BaseService`).
    if root.join("app/Services/BaseService.php").is_file() {
        let source = "<?php\n\nnamespace App\\Services;\n\nclass ParityProbe extends BaseService\n{\n    public function rules(): array\n    {\n        return ['a' => 'requ/*|*/'];\n    }\n}\n";
        let (text, pos) = caret(source);
        let doc = DocId(9_999);
        engine.document_opened(doc, &root.join("app/Services/ParityProbe.php"), 1, &text);
        let found = engine.completion(doc, pos, None, &CancellationToken::new());
        engine.document_closed(doc);
        if !found.is_some_and(|found| found.items.iter().any(|item| item.label == "required")) {
            missing.push("validationRule (service rules())");
        }
    }
    assert!(missing.is_empty(), "no completion for {missing:?}");

    // Phase 8.31: the app's route files name no missing controller class or method.
    let route_files: BTreeSet<PathBuf> = engine
        .laravel_routes()
        .map(|routes| routes.routes().iter().map(|route| route.path.clone()).collect())
        .unwrap_or_default();
    let mut undefined = Vec::new();
    for (index, path) in route_files.iter().enumerate() {
        if path.to_string_lossy().replace('\\', "/").contains("/vendor/") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        let doc = DocId(20_000 + index as u32);
        engine.document_opened(doc, path, 1, &text);
        let inspected = engine.inspect(doc, &CancellationToken::new());
        engine.document_closed(doc);
        for diagnostic in inspected.map(|found| found.diagnostics).unwrap_or_default() {
            if diagnostic.code.as_deref() == Some("PhpUndefinedController") {
                undefined.push(format!(
                    "{}:{}: {}",
                    path.display(),
                    diagnostic.range.start.line + 1,
                    diagnostic.message
                ));
            }
        }
    }
    eprintln!("{} route files checked for undefined controllers", route_files.len());
    // Reviewed: real dead routes of the pinned versions (the controllers have no such
    // method), and the action of phase 8.31's report when it is added to Bagisto.
    const REAL: &[&str] = &[
        "Method 'show' does not exist in controller 'VaultCompanyController'",
        "Method 'update' does not exist in controller 'VaultSettingsController'",
        "Method 'index' does not exist in controller 'VaultSettingsLabelController'",
        "Method 'index' does not exist in controller 'VaultSettingsTagController'",
        "Method 'show' does not exist in controller 'UserController'",
        "Method 'store' does not exist in controller 'PersonalizeModulesController'",
        "Method 'update' does not exist in controller 'PersonalizeModulesController'",
        "Method 'destroy' does not exist in controller 'PersonalizeModulesController'",
        "Method 'massDestroy' does not exist in controller 'CurrencyController'",
        "Method 'dream' does not exist in controller 'CartRuleController'",
    ];
    undefined.retain(|found| !REAL.iter().any(|real| found.ends_with(real)));
    assert!(undefined.is_empty(), "undefined controllers:\n{}", undefined.join("\n"));

    // Phase 9.5: the app's own code and tests name no unknown Artisan command.
    let mut files = app_php_files(&root);
    let mut tests = vec![root.join("tests")];
    while let Some(dir) = tests.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                tests.push(path);
            } else if path.extension().is_some_and(|extension| extension == "php") {
                files.push(path);
            }
        }
    }
    let mut unknown = Vec::new();
    let mut checked = 0;
    for (index, path) in files.iter().enumerate() {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        if !["Artisan::", "->call(", "callSilent", "command(", "->artisan("].iter().any(|call| text.contains(call)) {
            continue;
        }
        checked += 1;
        let doc = DocId(40_000 + index as u32);
        engine.document_opened(doc, path, 1, &text);
        let inspected = engine.inspect(doc, &CancellationToken::new());
        engine.document_closed(doc);
        for diagnostic in inspected.map(|found| found.diagnostics).unwrap_or_default() {
            if diagnostic.code.as_deref() == Some("PhpUnknownArtisanCommand") {
                unknown.push(format!("{}:{}: {}", path.display(), diagnostic.range.start.line + 1, diagnostic.message));
            }
        }
    }
    eprintln!("{checked} files checked for unknown Artisan commands");
    assert!(unknown.is_empty(), "unknown Artisan commands:\n{}", unknown.join("\n"));

    let context = engine.laravel_generation_context().expect("generators");
    let mut failures = Vec::new();
    for generator in context.generators.iter().filter(|generator| generator.id != "model") {
        let base = class_request(&generator.id);
        // Class names get a prefix the app won't have; migration and view
        // names (`create_parities_table`, `parity.card`) stay as they are.
        let name = if base.name.contains(['_', '.']) { base.name.clone() } else { format!("ParityCheck{}", base.name) };
        let request = NewClass { model: engine.laravel_models().first().cloned().unwrap_or_default(), name, ..base };
        let result = engine.laravel_generate_class(&request, &TemplateSet::default(), TIMESTAMP);
        if let Err(error) = result.and_then(|edit| check_generated(&created_files(&edit))) {
            failures.push(format!("{}: {error}", generator.id));
        }
    }
    engine.shutdown();
    assert!(failures.is_empty(), "failing generators:\n{}", failures.join("\n"));
}

/// The PHP files of the application itself under `root` (not `vendor/`,
/// `node_modules/` or `storage/`).
fn app_php_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> =
        ["app", "packages", "database", "routes"].iter().map(|dir| root.join(dir)).filter(|dir| dir.is_dir()).collect();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !["vendor", "node_modules", "storage", ".git"].contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if name.ends_with(".php") && !name.ends_with(".blade.php") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Phase 8.27: the model view of every model of a real application, and the
/// unknown-column problems of its own files (`LARAVEL_APP_DIR`). Prints
/// each problem so they can be checked for false positives; the counts
/// are recorded in `docs/php-engine/laravel.md`.
#[test]
#[ignore = "needs a real Laravel application in LARAVEL_APP_DIR"]
fn real_app_eloquent_columns() {
    let Some(root) = std::env::var_os("LARAVEL_APP_DIR").map(PathBuf::from) else {
        eprintln!("LARAVEL_APP_DIR isn't set; skipped");
        return;
    };
    let root = dunce::canonicalize(&root).expect("LARAVEL_APP_DIR exists");
    let tmp = tempfile::tempdir().unwrap();
    let engine = open_engine(&root, tmp.path());
    let models = engine.laravel_models();
    let mut without_view = Vec::new();
    let mut certain = 0;
    for model in &models {
        match engine.laravel_model_view(model) {
            Some(view) => certain += usize::from(view.schema_certain),
            None => without_view.push(model.clone()),
        }
    }
    eprintln!("{} models, {certain} with a certain schema", models.len());
    assert!(!models.is_empty(), "no models");
    assert!(without_view.is_empty(), "no model view for {without_view:?}");

    let files = app_php_files(&root);
    let mut problems = Vec::new();
    for path in &files {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        let found = engine.inspect_file(path, &text, &CancellationToken::new()).unwrap_or_default();
        for problem in found.iter().filter(|d| d.code.as_deref() == Some("PhpUnknownEloquentColumn")) {
            let rel = slashes(path.strip_prefix(&root).unwrap_or(path));
            problems.push(format!("{rel}:{}: {}", problem.range.start.line + 1, problem.message));
        }
    }
    for problem in &problems {
        eprintln!("{problem}");
    }
    eprintln!("{} files inspected, {} unknown-column problems", files.len(), problems.len());
    engine.shutdown();
}

/// The application's own Blade templates (`resources/views`, and the views of `packages/`).
fn app_blade_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> =
        ["resources", "packages"].iter().map(|dir| root.join(dir)).filter(|d| d.is_dir()).collect();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !["vendor", "node_modules", "storage", ".git"].contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if name.ends_with(".blade.php") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Phase 8.29: batch Inspect Code over the application's own PHP files and Blade templates
/// (`LARAVEL_APP_DIR`, not `vendor/`). Prints the count of each inspection and an even sample
/// of `SAMPLE` diagnostics with their source line, which `docs/php-engine/laravel.md` reviews
/// for false positives.
#[test]
#[ignore = "needs a real Laravel application in LARAVEL_APP_DIR"]
fn real_app_inspect_code() {
    const SAMPLE: usize = 100;
    let Some(root) = std::env::var_os("LARAVEL_APP_DIR").map(PathBuf::from) else {
        eprintln!("LARAVEL_APP_DIR isn't set; skipped");
        return;
    };
    let root = dunce::canonicalize(&root).expect("LARAVEL_APP_DIR exists");
    let tmp = tempfile::tempdir().unwrap();
    let engine = open_engine(&root, tmp.path());
    let mut files = app_php_files(&root);
    files.extend(app_blade_files(&root));
    // Batch Inspect Code as the host runs it, in parallel (phase 9.4),
    // timed, then file by file: both find the same.
    let started = std::time::Instant::now();
    let batch = parking_lot::Mutex::new(std::collections::BTreeMap::new());
    let done = engine.inspect_files(
        &files,
        |path| path.as_path(),
        |path| std::fs::read_to_string(path).ok(),
        &CancellationToken::new(),
        |path, diagnostics| drop(batch.lock().insert(path.clone(), diagnostics.unwrap_or_default())),
    );
    assert!(done, "the batch ran to the end");
    let parallel = started.elapsed();
    let batch = batch.into_inner();
    // Again, with the type cache the first run filled.
    let started = std::time::Instant::now();
    assert!(engine.inspect_files(
        &files,
        |path| path.as_path(),
        |path| std::fs::read_to_string(path).ok(),
        &CancellationToken::new(),
        |_, _| {}
    ));
    let parallel_warm = started.elapsed();
    let started = std::time::Instant::now();
    let mut slowest = Vec::new();
    let mut found = Vec::new();
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for path in &files {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        let lines: Vec<&str> = text.lines().collect();
        let at = std::time::Instant::now();
        let diagnostics = engine.inspect_file(path, &text, &CancellationToken::new()).unwrap_or_default();
        slowest.push((at.elapsed(), path.clone()));
        assert_eq!(batch.get(path), Some(&diagnostics), "{}: the batch differs", path.display());
        for diagnostic in diagnostics {
            let code = diagnostic.code.clone().unwrap_or_else(|| "syntax".to_owned());
            *counts.entry(code.clone()).or_default() += 1;
            let rel = slashes(path.strip_prefix(&root).unwrap_or(path));
            let line = diagnostic.range.start.line as usize;
            let source = lines.get(line).map_or("", |l| l.trim());
            let source: String = source.chars().take(160).collect();
            found.push(format!("{rel}:{}: [{code}] {}\n      {source}", line + 1, diagnostic.message));
        }
    }
    eprintln!(
        "{} files inspected, {} diagnostics; in parallel {:.2} s (again {:.2} s), one by one {:.2} s",
        files.len(),
        found.len(),
        parallel.as_secs_f64(),
        parallel_warm.as_secs_f64(),
        started.elapsed().as_secs_f64()
    );
    slowest.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    for (took, path) in slowest.iter().take(5) {
        eprintln!("slowest: {:>8.2} s {}", took.as_secs_f64(), slashes(path.strip_prefix(&root).unwrap_or(path)));
    }
    for (code, count) in &counts {
        eprintln!("{count:>6} {code}");
    }
    // `INSPECT_ALL=1` prints every diagnostic instead.
    let all = std::env::var_os("INSPECT_ALL").is_some();
    let step = if all { 1 } else { (found.len() / SAMPLE).max(1) };
    eprintln!("sample (every {step}th):");
    for diagnostic in found.iter().step_by(step).take(if all { usize::MAX } else { SAMPLE }) {
        eprintln!("{diagnostic}");
    }
    engine.shutdown();
}
