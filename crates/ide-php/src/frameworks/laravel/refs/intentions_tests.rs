//! Laravel's context actions (`refs/intentions.rs`): before/after fixtures
//! per action on the fixture app (`fixtures/laravel-app` with
//! `fixtures/laravel-stubs` as its `vendor/`).

use super::*;

const PROBE: &str = "app/Http/Controllers/Probe.php";

impl Project {
    /// The rewrite actions at the caret whose title starts with `prefix`,
    /// each with the document's text after its edit.
    fn applied(&mut self, rel: &str, source: &str, prefix: &str) -> Vec<(String, String)> {
        let (doc, pos) = self.open(rel, source);
        let text = caret(source).0;
        let found = self
            .engine
            .code_actions(doc, Range::new(pos, pos), &[crate::imports::REWRITE.to_owned()])
            .unwrap()
            .into_iter()
            .filter(|action| action.title.starts_with(prefix))
            .map(|action| {
                let [FileEdit::Edit { edits, .. }] = action.edit.files.as_slice() else {
                    panic!("one file: {:?}", action.edit)
                };
                let mut document = ide_text::Document::new(&text);
                document.apply_edits(edits).unwrap();
                (action.title, document.text().to_string())
            })
            .collect();
        self.engine.document_closed(doc);
        found
    }

    fn rewrite_file(&self, rel: &str, text: &str) {
        let path = self.root.join(rel);
        std::fs::write(&path, text).unwrap();
        self.engine.files_changed(&[path], &[]);
        assert!(self.engine.wait_idle(std::time::Duration::from_secs(60)));
    }

    fn completion_labels(&mut self, rel: &str, source: &str) -> Vec<String> {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        found.items.into_iter().map(|item| item.label).collect()
    }

    /// The text after the one action at the caret titled `title`.
    fn after(&mut self, rel: &str, source: &str, title: &str) -> String {
        let found = self.applied(rel, source, title);
        match found.as_slice() {
            [(_, text)] => text.clone(),
            _ => panic!("one '{title}': {found:?}"),
        }
    }
}

#[test]
fn converts_facade_aliases_to_imports() {
    let mut project = Project::app();
    let source = "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\n\nclass Probe extends Controller\n{\n    public function run(): bool\n    {\n        return \\Ro/*|*/ute::has('home') && \\Route::has('about');\n    }\n}\n";
    assert_eq!(
        project.after(PROBE, source, "Convert alias 'Route' to facade import"),
        "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\nuse Illuminate\\Support\\Facades\\Route;\n\nclass Probe extends Controller\n{\n    public function run(): bool\n    {\n        return Route::has('home') && Route::has('about');\n    }\n}\n"
    );
    // Outside a namespace the alias is written as it is: only the import.
    let source = "<?php\n\nRo/*|*/ute::get('/x', fn () => 'x');\n";
    assert_eq!(
        project.after("routes/extra.php", source, "Convert alias"),
        "<?php\n\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/x', fn () => 'x');\n"
    );
    // Not on the imported facade, nor on a class that isn't an alias.
    for source in [
        "<?php\n\nuse Illuminate\\Support\\Facades\\Route;\n\nRo/*|*/ute::get('/x', fn () => 'x');\n",
        "<?php\n\nFeedBu/*|*/ilder::make();\n",
    ] {
        assert!(project.applied("routes/extra.php", source, "Convert alias").is_empty(), "{source}");
    }
}

const FACADE_CONTROLLER: &str = "<?php\nnamespace App\\Http\\Controllers;\n\nuse Illuminate\\Support\\Facades\\View;\n\nclass Probe extends Controller\n{\n    public function index()\n    {\n        return View::make('welcome');\n    }\n\n    public function show()\n    {\n        View::share('page', 'show');\n        return View::/*|*/make('about');\n    }\n}\n";

#[test]
fn injects_a_facade_service_through_the_constructor() {
    let mut project = Project::app();
    assert_eq!(
        project.after(PROBE, FACADE_CONTROLLER, "Inject 'Factory' instead of facade 'View' (constructor)"),
        "<?php\nnamespace App\\Http\\Controllers;\n\nuse Illuminate\\View\\Factory;\n\nclass Probe extends Controller\n{\n    public function __construct(private readonly Factory $view)\n    {\n    }\n\n    public function index()\n    {\n        return $this->view->make('welcome');\n    }\n\n    public function show()\n    {\n        $this->view->share('page', 'show');\n        return $this->view->make('about');\n    }\n}\n"
    );
    // An existing constructor gets one more parameter; a static method and
    // a static closure keep the facade, and so does its import.
    let source = "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Services\\FeedBuilder;\nuse Illuminate\\Support\\Facades\\View;\n\nclass Probe extends Controller\n{\n    public function __construct(\n        private FeedBuilder $feed,\n    ) {\n    }\n\n    public static function make()\n    {\n        return View::make('a');\n    }\n\n    public function show()\n    {\n        $f = static fn () => View::make('b');\n        return View::ma/*|*/ke('about');\n    }\n}\n";
    assert_eq!(
        project.after(PROBE, source, "Inject 'Factory' instead of facade 'View' (constructor)"),
        "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Services\\FeedBuilder;\nuse Illuminate\\Support\\Facades\\View;\nuse Illuminate\\View\\Factory;\n\nclass Probe extends Controller\n{\n    public function __construct(\n        private FeedBuilder $feed,\n        private readonly Factory $view,\n    ) {\n    }\n\n    public static function make()\n    {\n        return View::make('a');\n    }\n\n    public function show()\n    {\n        $f = static fn () => View::make('b');\n        return $this->view->make('about');\n    }\n}\n"
    );
}

#[test]
fn injects_a_facade_service_through_the_method() {
    let mut project = Project::app();
    assert_eq!(
        project.after(PROBE, FACADE_CONTROLLER, "Inject 'Factory' instead of facade 'View' (method parameter)"),
        "<?php\nnamespace App\\Http\\Controllers;\n\nuse Illuminate\\Support\\Facades\\View;\nuse Illuminate\\View\\Factory;\n\nclass Probe extends Controller\n{\n    public function index()\n    {\n        return View::make('welcome');\n    }\n\n    public function show(Factory $view)\n    {\n        $view->share('page', 'show');\n        return $view->make('about');\n    }\n}\n"
    );
    // Not where the container doesn't call the method, nor in a closure,
    // nor when `$view` is taken.
    let service = FACADE_CONTROLLER
        .replace("class Probe extends Controller", "class Probe")
        .replace("namespace App\\Http\\Controllers;", "namespace App\\Services;");
    let in_closure = FACADE_CONTROLLER
        .replace("return View::/*|*/make('about');", "return function () { return View::/*|*/make('about'); };");
    let taken = FACADE_CONTROLLER.replace("public function show()", "public function show(string $view)");
    for (rel, source) in [("app/Services/Probe.php", service), (PROBE, in_closure), (PROBE, taken)] {
        assert!(
            project.applied(rel, &source, "Inject 'Factory' instead of facade 'View' (method").is_empty(),
            "{source}"
        );
    }
    // Not on a class that isn't a facade.
    let source = "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\n\nclass Probe extends Controller\n{\n    public function index()\n    {\n        return Post::/*|*/query();\n    }\n}\n";
    assert!(project.applied(PROBE, source, "Inject").is_empty());
}

#[test]
fn moves_a_method_dependency_to_the_constructor() {
    let mut project = Project::app();
    let source = "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\nuse App\\Services\\FeedBuilder;\n\nclass Probe extends Controller\n{\n    public function index(FeedBuilder $fe/*|*/ed, Post $post): array\n    {\n        $titles = fn () => $feed->titles();\n        return $feed->titles();\n    }\n}\n";
    assert_eq!(
        project.after(PROBE, source, "Move '$feed' to the constructor"),
        "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\nuse App\\Services\\FeedBuilder;\n\nclass Probe extends Controller\n{\n    public function __construct(private readonly FeedBuilder $feed)\n    {\n    }\n\n    public function index(Post $post): array\n    {\n        $titles = fn () => $this->feed->titles();\n        return $this->feed->titles();\n    }\n}\n"
    );
    // The last parameter, with a constructor already.
    let source = "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\nuse App\\Services\\FeedBuilder;\n\nclass Probe extends Controller\n{\n    public function __construct(private Post $post) {}\n\n    public function index(int $page, FeedBuilder /*|*/$feed): array\n    {\n        return $feed->titles();\n    }\n}\n";
    assert_eq!(
        project.after(PROBE, source, "Move '$feed'"),
        "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\nuse App\\Services\\FeedBuilder;\n\nclass Probe extends Controller\n{\n    public function __construct(private Post $post, private readonly FeedBuilder $feed) {}\n\n    public function index(int $page): array\n    {\n        return $this->feed->titles();\n    }\n}\n"
    );
    // Not for a model (route-bound), a request, a scalar, a reassigned
    // parameter, one captured by a closure, nor outside a controller.
    let base = "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\nuse App\\Services\\FeedBuilder;\nuse Illuminate\\Http\\Request;\n\nclass Probe extends Controller\n{\n    public function index(PARAMS)\n    {\n        BODY\n    }\n}\n";
    for (params, body) in [
        ("Post $po/*|*/st", "return $post;"),
        ("Request $req/*|*/uest", "return $request;"),
        ("int $pa/*|*/ge", "return $page;"),
        ("FeedBuilder $fe/*|*/ed", "$feed = new FeedBuilder(); return $feed;"),
        ("FeedBuilder $fe/*|*/ed", "return function () use ($feed) { return $feed; };"),
    ] {
        let source = base.replace("PARAMS", params).replace("BODY", body);
        assert!(project.applied(PROBE, &source, "Move").is_empty(), "{source}");
    }
    let source = base
        .replace("PARAMS", "FeedBuilder $fe/*|*/ed")
        .replace("BODY", "")
        .replace(" extends Controller", "")
        .replace("namespace App\\Http\\Controllers;", "namespace App\\Services;");
    assert!(project.applied("app/Services/Probe.php", &source, "Move").is_empty());
}

#[test]
fn converts_controller_strings_to_array_callables() {
    let mut project = Project::app();
    let source = "<?php\n\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/a', 'PostController@in/*|*/dex');\nRoute::get('/b', 'HomeController@__invoke');\nRoute::get('/c', 'PostController@show');\nRoute::get('/d', 'MissingController@show');\n";
    let found = project.applied("routes/extra.php", source, "Convert");
    assert_eq!(
        found,
        [
            (
                "Convert controller string to array callable".to_owned(),
                "<?php\n\nuse App\\Http\\Controllers\\PostController;\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/a', [PostController::class, 'index']);\nRoute::get('/b', 'HomeController@__invoke');\nRoute::get('/c', 'PostController@show');\nRoute::get('/d', 'MissingController@show');\n".to_owned()
            ),
            (
                "Convert all controller strings in file to array callables".to_owned(),
                "<?php\n\nuse App\\Http\\Controllers\\HomeController;\nuse App\\Http\\Controllers\\PostController;\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/a', [PostController::class, 'index']);\nRoute::get('/b', [HomeController::class, '__invoke']);\nRoute::get('/c', [PostController::class, 'show']);\nRoute::get('/d', 'MissingController@show');\n".to_owned()
            ),
        ]
    );
    // Not on a method name of a `Route::controller()` group, nor on an
    // unknown controller.
    for source in [
        "<?php\n\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/a', 'Missing/*|*/Controller@show');\n",
        "<?php\n\nuse App\\Http\\Controllers\\PostController;\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::controller(PostController::class)->group(function () {\n    Route::get('/', 'in/*|*/dex');\n});\n",
    ] {
        assert!(project.applied("routes/extra.php", source, "Convert").is_empty(), "{source}");
    }
}

#[test]
fn converts_scopes_to_scope_attributes() {
    let mut project = Project::app();
    let model = "app/Models/Post.php";
    let original = std::fs::read_to_string(project.root.join(model)).unwrap();
    let source = original.replace("function scopePublished", "function scopePub/*|*/lished");
    let converted = project.after(model, &source, "Convert scope 'scopePublished' to #[Scope] method");
    assert!(
        converted.contains(
            "use Illuminate\\Database\\Eloquent\\Attributes\\Scope;\nuse Illuminate\\Database\\Eloquent\\Builder;\n"
        ),
        "{converted}"
    );
    assert!(
        converted.contains(
            "    /** Only the posts that are already out. */\n    #[Scope]\n    protected function published(Builder $query): Builder\n"
        ),
        "{converted}"
    );
    // Every scope of the model, whatever their visibility.
    let source = original.replace(
        "    public function getRouteKeyName",
        "    private function scopeDrafts($query)\n    {\n        return $query;\n    }\n\n    function scopeRecent($query)\n    {\n        return $query;\n    }\n\n    public function getRouteKeyName",
    );
    let source = source.replace("function scopeRecent", "function scope/*|*/Recent");
    let found = project.applied(model, &source, "Convert all scopes");
    let [(_, all)] = found.as_slice() else { panic!("{found:?}") };
    for expected in [
        "    #[Scope]\n    protected function published(Builder $query): Builder\n",
        "    #[Scope]\n    protected function drafts($query)\n",
        "    #[Scope]\n    protected function recent($query)\n",
    ] {
        assert!(all.contains(expected), "{expected}\n{all}");
    }
    // Not when the method is called by its name, nor in the body.
    let called = original.replace("return 'slug';", "return $this->scopePublished(static::query()) ? 'slug' : 'id';");
    let called = called.replace("function scopePublished", "function scopePub/*|*/lished");
    assert!(project.applied(model, &called, "Convert scope").is_empty());
    let body = original.replace("return $query->where", "return $query/*|*/->where");
    assert!(project.applied(model, &body, "Convert scope").is_empty());
}

#[test]
fn scope_attribute_methods_are_scopes() {
    let mut project = Project::app();
    let model = "app/Models/Post.php";
    let original = std::fs::read_to_string(project.root.join(model)).unwrap();
    project.rewrite_file(
        model,
        &original
            .replace(
                "use Illuminate\\Database\\Eloquent\\Builder;",
                "use Illuminate\\Database\\Eloquent\\Attributes\\Scope;\nuse Illuminate\\Database\\Eloquent\\Builder;",
            )
            .replace("    public function scopePublished", "    #[Scope]\n    protected function published"),
    );
    let found = project.completion_labels(
        PROBE,
        "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\n\nclass Probe extends Controller\n{\n    public function run(): void\n    {\n        Post::query()->published()->/*|*/\n    }\n}\n",
    );
    // `published()` keeps the builder: its methods follow.
    assert!(found.iter().any(|label| label == "where"), "{found:?}");
    let view = project.engine.laravel_model_view("App\\Models\\Post").unwrap();
    assert!(
        view.scopes.iter().any(|scope| scope.name == "published" && scope.method == "published"),
        "{:?}",
        view.scopes
    );
}
