//! Livewire components and Inertia pages (`livewireComponent`,
//! `inertiaPage`, `<livewire:…>` tags, `wire:` values, the undefined-page
//! inspection): caret fixtures on a copy of the fixture app with the
//! `livewire/livewire` and `inertiajs/inertia-laravel` stubs of
//! `fixtures/laravel-stubs` installed.

use ide_core::{TextEdit, WorkspaceEdit};

use super::route_tests::copy_dir;
use super::*;
use crate::blade::BladeDocument;
use crate::frameworks::laravel::LaravelPackages;
use crate::frameworks::laravel::ide_json::IdeJson;
use crate::frameworks::laravel::refs::livewire::class_for_segment;
use crate::navigate::Target;

const COUNTER: &str = r#"<?php

namespace App\Livewire;

use Livewire\Component;

class Counter extends Component
{
    public int $count = 0;

    public string $label = '';

    protected $secret;

    public static $instances = 0;

    public function mount(int $start = 0)
    {
        $this->count = $start;
    }

    public function increment(int $by = 1)
    {
        $this->count += $by;
    }

    public function updatedCount()
    {
    }

    protected function hidden()
    {
    }

    public function render()
    {
        return view('livewire.counter');
    }
}
"#;

const CREATE_POST: &str = r#"<?php

namespace App\Livewire\Posts;

use App\Livewire\Forms\PostForm;
use Livewire\Component;

class CreatePost extends Component
{
    public PostForm $form;

    public function save()
    {
    }
}
"#;

const POST_FORM: &str = r#"<?php

namespace App\Livewire\Forms;

use Livewire\Form;

class PostForm extends Form
{
    public string $title = '';

    public string $body = '';
}
"#;

const COUNTER_VIEW: &str = "resources/views/livewire/counter.blade.php";
const CREATE_POST_VIEW: &str = "resources/views/livewire/posts/create-post.blade.php";

impl Project {
    /// The fixture app with Livewire and Inertia installed, two components,
    /// a form and two pages.
    fn with_packages() -> Self {
        Self::with_packages_and(&[])
    }

    /// [`Self::with_packages`] with more files `(relative path, text)`.
    fn with_packages_and(extra: &[(&str, &str)]) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        copy_dir(&fixtures.join("laravel-app"), &root);
        copy_dir(&fixtures.join("laravel-stubs"), &root.join("vendor"));
        // Installed: listed in `installed.json`, and not disabled.
        let installed_path = root.join("vendor/composer/installed.json");
        let mut installed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&installed_path).unwrap()).unwrap();
        let packages = installed["packages"].as_array_mut().unwrap();
        packages.push(serde_json::json!({
            "name": "livewire/livewire",
            "version": "v3.5.12",
            "type": "library",
            "autoload": { "classmap": ["src/"] },
            "install-path": "../livewire/livewire"
        }));
        packages.push(serde_json::json!({
            "name": "inertiajs/inertia-laravel",
            "version": "v2.0.0",
            "type": "library",
            "autoload": { "classmap": ["src/"], "files": ["helpers.php"] },
            "install-path": "../inertiajs/inertia-laravel"
        }));
        std::fs::write(&installed_path, serde_json::to_string_pretty(&installed).unwrap()).unwrap();
        let ide_json = std::fs::read_to_string(root.join("ide.json")).unwrap();
        let ide_json = ide_json.replace(r#""disabledPackages": ["livewire/livewire"]"#, r#""disabledPackages": []"#);
        std::fs::write(root.join("ide.json"), ide_json).unwrap();
        let files = [
            ("app/Livewire/Counter.php", COUNTER),
            ("app/Livewire/Posts/CreatePost.php", CREATE_POST),
            ("app/Livewire/Forms/PostForm.php", POST_FORM),
            (COUNTER_VIEW, "<div>\n    <button wire:click=\"increment\">{{ $count }}</button>\n</div>\n"),
            (CREATE_POST_VIEW, "<form wire:submit=\"save\">\n    <input wire:model=\"form.title\">\n</form>\n"),
            ("resources/js/Pages/Dashboard.vue", "<template>\n    <div></div>\n</template>\n"),
            ("resources/js/Pages/Posts/Index.vue", "<template>\n    <div></div>\n</template>\n"),
        ];
        for (rel, text) in files.iter().chain(extra) {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
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

    /// The Laravel completion labels of a template (the caret in `source`).
    fn livewire_labels(&self, rel: &str, source: &str) -> Vec<String> {
        let (text, pos) = caret(source);
        let path = self.root.join(rel);
        let blade = BladeDocument { doc: DocId(95), path: &path, version: 1, text: &text };
        let found = self.engine.blade_laravel_completion(&blade, pos).unwrap_or_default();
        found.items.into_iter().map(|item| item.label).collect()
    }

    /// The Laravel goto targets of a template.
    fn livewire_goto(&self, rel: &str, source: &str) -> Vec<(String, u32, String)> {
        let (text, pos) = caret(source);
        let path = self.root.join(rel);
        let blade = BladeDocument { doc: DocId(96), path: &path, version: 1, text: &text };
        let targets = self.engine.blade_laravel_definition(&blade, pos).unwrap_or_default();
        targets.iter().map(|Target { path, range }| self.describe(path, *range)).collect()
    }

    /// The PHP completion labels of a template (string references).
    fn template_php_labels(&self, source: &str) -> Vec<String> {
        let (text, pos) = caret(source);
        let path = self.root.join("resources/views/probe.blade.php");
        let blade = BladeDocument { doc: DocId(97), path: &path, version: 1, text: &text };
        let found = self.engine.blade_completion(&blade, pos, None, &CancellationToken::new());
        self.engine.document_closed(DocId(97));
        found.map(|found| found.items.into_iter().map(|item| item.label).collect()).unwrap_or_default()
    }
}

/// A PHP file of the app around `body`, a statement of a function.
fn probe(body: &str) -> String {
    format!(
        "<?php\n\nnamespace App\\Http;\n\nuse Illuminate\\Support\\Facades\\Route;\nuse Inertia\\Inertia;\nuse Inertia\\Testing\\AssertableInertia;\nuse Livewire\\Livewire;\n\nfunction probe(AssertableInertia $page)\n{{\n    {body}\n}}\n"
    )
}

const PROBE: &str = "app/Http/Probe.php";

fn sorted(mut labels: Vec<String>) -> Vec<String> {
    labels.sort();
    labels
}

#[test]
fn packages_are_detected_and_can_be_switched() {
    let mut ide = IdeJson::default();
    let installed = |name: &str| name == LaravelPackages::LIVEWIRE;
    assert_eq!(LaravelPackages::detect(installed, &ide), LaravelPackages { livewire: true, inertia: false });
    ide.packages.disabled.push(LaravelPackages::LIVEWIRE.to_owned());
    ide.packages.enabled.push(LaravelPackages::INERTIA.to_owned());
    assert_eq!(LaravelPackages::detect(installed, &ide), LaravelPackages { livewire: false, inertia: true });

    // The fixture app has neither.
    let mut project = Project::app();
    assert_eq!(project.engine.laravel().unwrap().packages, LaravelPackages::default());
    assert!(project.engine.laravel_livewire().unwrap().components.is_empty());
    assert!(project.engine.laravel_inertia().unwrap().pages.is_empty());
    assert!(project.complete_in(PROBE, &probe("Inertia::render('/*|*/');")).is_empty());
}

#[test]
fn components_and_pages_of_the_app() {
    let project = Project::with_packages();
    assert_eq!(project.engine.laravel().unwrap().packages, LaravelPackages { livewire: true, inertia: true });
    let components = project.engine.laravel_livewire().unwrap();
    let names: Vec<(&str, &str)> =
        components.components.iter().map(|component| (component.name.as_str(), component.class.as_str())).collect();
    assert_eq!(
        names,
        [("counter", "App\\Livewire\\Counter"), ("posts.create-post", "App\\Livewire\\Posts\\CreatePost")]
    );
    // `render()` names the view, else it is `livewire.<name>`.
    let counter = components.get("counter").unwrap();
    assert!(counter.view.as_ref().unwrap().ends_with(COUNTER_VIEW));
    let create = components.get("posts.create-post").unwrap();
    assert!(create.view.as_ref().unwrap().ends_with(CREATE_POST_VIEW));
    assert_eq!(
        components.of_view(&project.root.join(CREATE_POST_VIEW)).map(|c| c.name.as_str()),
        Some("posts.create-post")
    );

    let pages = project.engine.laravel_inertia().unwrap();
    let names: Vec<&str> = pages.pages.iter().map(|page| page.name.as_str()).collect();
    assert_eq!(names, ["Dashboard", "Posts/Index"]);
    assert_eq!(pages.extension, "vue");
}

#[test]
fn livewire_component_names_in_php_and_blade() {
    let mut project = Project::with_packages();
    let expected = ["counter", "posts.create-post"];
    assert_eq!(sorted(project.complete_in(PROBE, &probe("Livewire::test('/*|*/');"))), expected);
    assert_eq!(sorted(project.template_php_labels("<div>@livewire('/*|*/')</div>\n")), expected);
    assert_eq!(
        project.definition_in(PROBE, &probe("Livewire::test('cou/*|*/nter');")),
        [("app/Livewire/Counter.php".to_owned(), 6, "Counter".to_owned()), (COUNTER_VIEW.to_owned(), 0, String::new())]
    );
    let (doc, pos) = project.open(PROBE, &probe("Livewire::visit('posts.create/*|*/-post');"));
    let hover = project.engine.hover(doc, pos).map(|hover| hover.markdown).unwrap();
    project.engine.document_closed(doc);
    assert!(hover.contains("App\\Livewire\\Posts\\CreatePost") && hover.contains(CREATE_POST_VIEW), "{hover}");
}

#[test]
fn livewire_tags() {
    let project = Project::with_packages();
    const PAGE: &str = "resources/views/probe.blade.php";
    assert_eq!(project.livewire_labels(PAGE, "<livewire:/*|*/"), ["counter", "posts.create-post"]);
    assert_eq!(project.livewire_labels(PAGE, "<livewire:po/*|*/ />"), ["counter", "posts.create-post"]);
    // The `mount()` parameters, then the public properties, in kebab case;
    // attributes already there are left out.
    assert_eq!(project.livewire_labels(PAGE, "<livewire:counter /*|*/ />"), ["start", "count", "label"]);
    assert_eq!(project.livewire_labels(PAGE, "<livewire:counter :count=\"1\" /*|*/ />"), ["start", "label"]);
    assert_eq!(project.livewire_labels(PAGE, "<livewire:posts.create-post /*|*/>"), ["form"]);
    // Blade components still complete.
    assert!(project.livewire_labels(PAGE, "<x-/*|*/").contains(&"x-alert".to_owned()));

    assert_eq!(
        project.livewire_goto(PAGE, "<livewire:cou/*|*/nter />"),
        [("app/Livewire/Counter.php".to_owned(), 6, "Counter".to_owned()), (COUNTER_VIEW.to_owned(), 0, String::new())]
    );
    assert_eq!(
        project.livewire_goto(PAGE, "<livewire:counter lab/*|*/el=\"x\" />"),
        [("app/Livewire/Counter.php".to_owned(), 10, "$label".to_owned())]
    );
    assert_eq!(
        project.livewire_goto(PAGE, "<livewire:counter :sta/*|*/rt=\"2\" />"),
        [("app/Livewire/Counter.php".to_owned(), 16, "$start".to_owned())]
    );
}

#[test]
fn wire_model_and_actions_in_a_component_view() {
    let project = Project::with_packages();
    let mut actions = project.livewire_labels(COUNTER_VIEW, "<button wire:click=\"/*|*/\">");
    actions.sort();
    assert_eq!(actions, ["$dispatch", "$parent", "$refresh", "$set", "$toggle", "increment"]);
    assert_eq!(project.livewire_labels(COUNTER_VIEW, "<input wire:model.live=\"/*|*/\">"), ["count", "label"]);
    assert_eq!(project.livewire_labels(CREATE_POST_VIEW, "<input wire:model=\"/*|*/\">"), ["form"]);
    // A form object's properties after its name.
    assert_eq!(project.livewire_labels(CREATE_POST_VIEW, "<input wire:model=\"form.ti/*|*/\">"), ["title", "body"]);
    assert!(
        project.livewire_labels(CREATE_POST_VIEW, "<form wire:submit.prevent=\"/*|*/\">").contains(&"save".to_owned())
    );
    // Not a component's view.
    assert!(project.livewire_labels("resources/views/probe.blade.php", "<input wire:model=\"/*|*/\">").is_empty());

    assert_eq!(
        project.livewire_goto(COUNTER_VIEW, "<button wire:click=\"incr/*|*/ement(2)\">"),
        [("app/Livewire/Counter.php".to_owned(), 21, "increment".to_owned())]
    );
    assert_eq!(
        project.livewire_goto(CREATE_POST_VIEW, "<input wire:model=\"form.ti/*|*/tle\">"),
        [("app/Livewire/Forms/PostForm.php".to_owned(), 8, "$title".to_owned())]
    );
}

#[test]
fn inertia_page_names() {
    let mut project = Project::with_packages();
    let expected = ["Dashboard", "Posts/Index"];
    for body in [
        "Inertia::render('/*|*/');",
        "return inertia('/*|*/', ['posts' => []]);",
        "Route::inertia('/about', '/*|*/');",
        "$page->component('/*|*/');",
    ] {
        assert_eq!(sorted(project.complete_in(PROBE, &probe(body))), expected, "{body}");
    }
    assert_eq!(
        project.definition_in(PROBE, &probe("Inertia::render('Posts/In/*|*/dex');")),
        [("resources/js/Pages/Posts/Index.vue".to_owned(), 0, String::new())]
    );
}

#[test]
fn the_settings_choose_the_inertia_page_folders() {
    let project = Project::with_packages_and(&[(
        "resources/js/Screens/Home.vue",
        "<template></template>
",
    )]);
    let names = |engine: &PhpEngine| -> Vec<String> {
        engine.laravel_inertia().unwrap().pages.iter().map(|page| page.name.clone()).collect()
    };
    assert_eq!(names(&project.engine), ["Dashboard", "Posts/Index"]);
    let settings = ide_core::settings::LaravelSettings {
        inertia_pages: vec!["resources/js/Screens/".to_owned(), " ".to_owned()],
        ..Default::default()
    };
    project.engine.set_laravel_settings(settings);
    assert_eq!(names(&project.engine), ["Home"]);
    let pages = project.engine.laravel_inertia().unwrap();
    assert_eq!(pages.new_path("Posts/Edit"), Some(project.root.join("resources/js/Screens/Posts/Edit.vue")));
    project.engine.set_laravel_settings(Default::default());
    assert_eq!(names(&project.engine), ["Dashboard", "Posts/Index"]);
}

#[test]
fn reports_undefined_inertia_pages_with_a_create_fix() {
    let mut project = Project::with_packages();
    let source =
        probe("Inertia::render('Posts/Index');\n    Inertia::render('Posts/Edit');\n    inertia('Dash' . 'board');");
    let (doc, _) = project.open(PROBE, &format!("{source}/*|*/"));
    let inspected = project.engine.inspect(doc, &CancellationToken::new()).unwrap();
    let found: Vec<(u32, String)> = inspected
        .diagnostics
        .iter()
        .filter(|d| d.code.as_deref() == Some("PhpUndefinedInertiaPage"))
        .map(|d| (d.range.start.line, d.message.clone()))
        .collect();
    assert_eq!(found, [(12, "Inertia page 'Posts/Edit' is not defined".to_owned())]);
    let action = project
        .engine
        .code_actions(doc, Range::new(Pos::new(12, 22), Pos::new(12, 22)), &[])
        .unwrap()
        .into_iter()
        .find(|action| action.title.starts_with("Create page"))
        .expect("the fix");
    assert_eq!(action.title, "Create page 'Posts/Edit'");
    let WorkspaceEdit { files, .. } = &action.edit;
    let [FileEdit::Create { path, overwrite: false }, FileEdit::Edit { edits, .. }] = files.as_slice() else {
        panic!("{files:?}")
    };
    let path = PathBuf::from(path.clone());
    assert_eq!(path, project.root.join("resources/js/Pages/Posts/Edit.vue"));
    let [TextEdit { new_text, .. }] = edits.as_slice() else { panic!("{edits:?}") };
    assert!(new_text.contains("<template>"), "{new_text}");
    project.engine.document_closed(doc);
}

const CLOCK: &str = r#"<?php

namespace App\Http\Widgets;

use Livewire\Component;

class Clock extends Component
{
    public string $zone = 'UTC';

    public function render()
    {
        return view('widgets.clock');
    }
}
"#;

const LIVEWIRE_PROVIDER: &str = r#"<?php

namespace App\Providers;

use App\Http\Widgets\Clock;
use Illuminate\Support\ServiceProvider;
use Livewire\Livewire;

class LivewireServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Livewire::component('clock', Clock::class);
        Livewire::component('ticker', \App\Livewire\Counter::class);
    }
}
"#;

#[test]
fn components_registered_in_a_provider() {
    let mut project = Project::with_packages_and(&[
        ("app/Http/Widgets/Clock.php", CLOCK),
        ("app/Providers/LivewireServiceProvider.php", LIVEWIRE_PROVIDER),
        ("resources/views/widgets/clock.blade.php", "<div>{{ $zone }}</div>\n"),
    ]);
    let components = project.engine.laravel_livewire().unwrap();
    let names: Vec<(&str, &str)> =
        components.components.iter().map(|component| (component.name.as_str(), component.class.as_str())).collect();
    // Registered aliases, and the discovered names of the Livewire namespace.
    assert_eq!(
        names,
        [
            ("clock", "App\\Http\\Widgets\\Clock"),
            ("counter", "App\\Livewire\\Counter"),
            ("posts.create-post", "App\\Livewire\\Posts\\CreatePost"),
            ("ticker", "App\\Livewire\\Counter"),
        ]
    );
    let clock = components.get("clock").unwrap();
    assert!(clock.view.as_ref().unwrap().ends_with("resources/views/widgets/clock.blade.php"));
    // Found by class too: the first of its names.
    assert_eq!(components.find("\\App\\Livewire\\Counter").map(|c| c.name.as_str()), Some("counter"));

    assert_eq!(
        sorted(project.complete_in(PROBE, &probe("Livewire::test('/*|*/');"))),
        ["clock", "counter", "posts.create-post", "ticker"]
    );
    assert_eq!(
        project.definition_in(PROBE, &probe("Livewire::test('clo/*|*/ck');")),
        [
            ("app/Http/Widgets/Clock.php".to_owned(), 6, "Clock".to_owned()),
            ("resources/views/widgets/clock.blade.php".to_owned(), 0, String::new())
        ]
    );
    // Tags of registered components.
    assert_eq!(project.livewire_labels("resources/views/probe.blade.php", "<livewire:clock /*|*/ />"), ["zone"]);
}

#[test]
fn livewire_parameter_keys() {
    let mut project = Project::with_packages();
    // The parameters of `mount()` and the public properties (sorted by the
    // completion).
    let expected = ["count", "label", "start"];
    assert_eq!(project.template_php_labels("<div>@livewire('counter', ['/*|*/'])</div>\n"), expected);
    assert_eq!(project.template_php_labels("<div>@livewire('counter', ['/*|*/' => 1])</div>\n"), expected);
    assert_eq!(project.template_php_labels("<div>@livewire('posts.create-post', ['/*|*/'])</div>\n"), ["form"]);
    // Not a value, nor an unknown component.
    assert!(
        !project
            .template_php_labels("<div>@livewire('counter', ['start' => '/*|*/'])</div>\n")
            .contains(&"count".to_owned())
    );
    assert!(project.template_php_labels("<div>@livewire('nothing', ['/*|*/'])</div>\n").is_empty());
    assert_eq!(
        project.complete_in(PROBE, &probe("Livewire::test(\\App\\Livewire\\Counter::class, ['/*|*/']);")),
        expected
    );
    assert_eq!(project.complete_in(PROBE, &probe("Livewire::test('counter', ['/*|*/' => 2]);")), expected);

    assert_eq!(
        project.definition_in(PROBE, &probe("Livewire::test('counter', ['sta/*|*/rt' => 2]);")),
        [("app/Livewire/Counter.php".to_owned(), 16, "$start".to_owned())]
    );
    assert_eq!(
        project.definition_in(PROBE, &probe("Livewire::test('counter', ['lab/*|*/el' => 'x']);")),
        [("app/Livewire/Counter.php".to_owned(), 10, "$label".to_owned())]
    );
}

#[test]
fn reports_unknown_livewire_parameters() {
    let project = Project::with_packages();
    let text = "<div>\n\
        @livewire('counter', ['start' => 1, 'label' => 'x', 'stepp' => 2])\n\
        @livewire(\\App\\Livewire\\Counter::class, ['nope' => 1])\n\
        @livewire('nothing', ['nope' => 1])\n\
        <livewire:counter :start=\"1\" :$count wire:key=\"k\" lazy class=\"x\" colour=\"red\" />\n\
        <livewire:posts.create-post :form=\"$f\" />\n\
        </div>\n";
    let found: Vec<(String, String)> = project
        .engine
        .blade_problems(text)
        .into_iter()
        .filter(|d| d.code.as_deref() == Some("BladeUnknownLivewireParameter"))
        .map(|d| {
            let lines = crate::syntax::LineIndex::new(text);
            let (start, end) = lines.byte_range(d.range);
            (text[start as usize..end as usize].to_owned(), d.message)
        })
        .collect();
    assert_eq!(
        found,
        [
            ("stepp".to_owned(), "Livewire component 'counter' has no parameter 'stepp'".to_owned()),
            ("nope".to_owned(), "Livewire component 'counter' has no parameter 'nope'".to_owned()),
            ("colour".to_owned(), "Livewire component 'counter' has no parameter 'colour'".to_owned()),
        ]
    );
}

#[test]
fn the_livewire_generator_is_listed_when_livewire_is_installed() {
    let project = Project::with_packages();
    let context = project.engine.laravel_generation_context().unwrap();
    assert!(context.generators.iter().any(|generator| generator.id == "livewire"));
    let spec = crate::frameworks::laravel::generate::NewClass {
        generator: "livewire".to_owned(),
        name: "posts.edit-post".to_owned(),
        ..Default::default()
    };
    let files = project
        .engine
        .laravel_generate_class_files(&spec, &crate::frameworks::laravel::generate::TemplateSet::default(), "")
        .unwrap();
    let paths: Vec<String> = files
        .iter()
        .map(|file| file.path.strip_prefix(&project.root).unwrap().to_string_lossy().replace('\\', "/"))
        .collect();
    assert_eq!(paths, ["app/Livewire/Posts/EditPost.php", "resources/views/livewire/posts/edit-post.blade.php"]);

    let app = Project::app();
    let context = app.engine.laravel_generation_context().unwrap();
    assert!(!context.generators.iter().any(|generator| generator.id == "livewire"));
}

const TICKER_VIEW: &str = "resources/views/dashboard.blade.php";

/// The fixture app with Livewire, the `clock` and `ticker` registrations and
/// a template using `ticker` as a tag and a directive.
fn with_ticker() -> Project {
    Project::with_packages_and(&[
        ("app/Http/Widgets/Clock.php", CLOCK),
        ("app/Providers/LivewireServiceProvider.php", LIVEWIRE_PROVIDER),
        ("resources/views/widgets/clock.blade.php", "<div>{{ $zone }}</div>\n"),
        (
            TICKER_VIEW,
            "<div>\n    <livewire:ticker :start=\"1\" />\n    @livewire('ticker')\n    <livewire:tickers />\n</div>\n",
        ),
    ])
}

/// The string usages among `found`, as `(path, line, text)`.
fn strings(found: Vec<(String, u32, String, UsageKind)>) -> Vec<(String, u32, String)> {
    found.into_iter().filter(|usage| usage.3 == UsageKind::String).map(|usage| (usage.0, usage.1, usage.2)).collect()
}

#[test]
fn finds_usages_of_livewire_components_from_aliases_and_classes() {
    let mut project = with_ticker();
    let expected = [
        ("app/Http/Probe.php".to_owned(), 11, "ticker".to_owned()),
        (TICKER_VIEW.to_owned(), 1, "ticker".to_owned()),
        (TICKER_VIEW.to_owned(), 2, "ticker".to_owned()),
    ];
    // From a usage: tags count, `<livewire:tickers />` doesn't.
    let found = strings(project.references(PROBE, &probe("Livewire::test('tic/*|*/ker');")));
    assert_eq!(found, expected);

    // From the alias of its registration.
    project.open(PROBE, &probe("Livewire::test('ticker/*|*/');"));
    let provider = LIVEWIRE_PROVIDER.replace("component('ticker'", "component('tic/*|*/ker'");
    let found = project.references("app/Providers/LivewireServiceProvider.php", &provider);
    assert_eq!(strings(found.clone()), expected);
    assert!(
        found.contains(&("app/Livewire/Counter.php".to_owned(), 6, "Counter".to_owned(), UsageKind::Declaration)),
        "{found:?}"
    );

    // From the class: the usages of its names (`counter` and `ticker`) and
    // the registration.
    let counter = COUNTER.replace("class Counter", "class Coun/*|*/ter");
    let found = strings(project.references("app/Livewire/Counter.php", &counter));
    for usage in [
        ("app/Http/Probe.php".to_owned(), 11, "ticker".to_owned()),
        ("app/Providers/LivewireServiceProvider.php".to_owned(), 13, "ticker".to_owned()),
        (TICKER_VIEW.to_owned(), 1, "ticker".to_owned()),
        (TICKER_VIEW.to_owned(), 2, "ticker".to_owned()),
    ] {
        assert!(found.contains(&usage), "{usage:?} in {found:?}");
    }
}

#[test]
fn renames_a_registered_livewire_alias() {
    let mut project = with_ticker();
    let edits = project.rename(PROBE, &probe("Livewire::test('tic/*|*/ker');"), "clicker");
    assert_eq!(
        edits,
        [
            ("app/Http/Probe.php".to_owned(), 11, "ticker".to_owned()),
            ("app/Providers/LivewireServiceProvider.php".to_owned(), 13, "ticker".to_owned()),
            (TICKER_VIEW.to_owned(), 1, "ticker".to_owned()),
            (TICKER_VIEW.to_owned(), 2, "ticker".to_owned()),
        ]
    );
    // From the registration.
    let provider = LIVEWIRE_PROVIDER.replace("component('ticker'", "component('tic/*|*/ker'");
    let edits = project.rename("app/Providers/LivewireServiceProvider.php", &provider, "clicker");
    assert_eq!(edits.len(), 3, "{edits:?}");
    // A discovered name follows its class: it is renamed with it.
    let (doc, pos) = project.open(PROBE, &probe("Livewire::test('coun/*|*/ter');"));
    assert_eq!(project.engine.prepare_rename(doc, pos), Some(Some(Range::new(Pos::new(11, 20), Pos::new(11, 27)))));
    assert!(!LivewireComponentKind.valid_name("a b") && LivewireComponentKind.valid_name("admin::stats-x"));
}

const LIVE_POSTS_VIEW: &str = "resources/views/posts/live.blade.php";

/// The fixture app with Livewire and a template using `posts.create-post`
/// as tags and a directive (and a tag of another name).
fn with_create_post_usages() -> Project {
    Project::with_packages_and(&[(
        LIVE_POSTS_VIEW,
        "<div>\n    <livewire:posts.create-post />\n    @livewire('posts.create-post', ['a' => 1])\n    <livewire:posts.create-posts />\n</div>\n",
    )])
}

/// A rename's text edits as `(path, line, replaced text, new text)`,
/// sorted, and the files it moves (relative).
type Renamed = (Vec<(String, u32, String, String)>, Vec<(String, String)>);

fn rename_with_files(project: &mut Project, rel: &str, source: &str, new_name: &str) -> IdeResult<Renamed> {
    let (doc, pos) = project.open(rel, source);
    let edit = project.engine.rename(doc, pos, new_name, &CancellationToken::new()).unwrap();
    let edit = match edit {
        Ok(edit) => edit,
        Err(e) => {
            project.engine.document_closed(doc);
            return Err(e);
        }
    };
    let relative = |path: &PathBuf| path.strip_prefix(&project.root).unwrap().to_string_lossy().replace('\\', "/");
    let (mut edits, mut moves) = (Vec::new(), Vec::new());
    for file in &edit.files {
        match file {
            FileEdit::Edit { path, edits: text_edits, .. } => {
                let path = PathBuf::from(path.clone());
                for edit in text_edits {
                    let (rel, line, text) = project.describe(&path, edit.range);
                    edits.push((rel, line, text, edit.new_text.clone()));
                }
            }
            FileEdit::Rename { from, to } => {
                moves.push((relative(&PathBuf::from(from.clone())), relative(&PathBuf::from(to.clone()))));
            }
            other => panic!("{other:?}"),
        }
    }
    project.engine.document_closed(doc);
    edits.sort();
    Ok((edits, moves))
}

fn edit(path: &str, line: u32, old: &str, new: &str) -> (String, u32, String, String) {
    (path.to_owned(), line, old.to_owned(), new.to_owned())
}

#[test]
fn renaming_a_component_class_renames_its_discovered_name() {
    let mut project = with_create_post_usages();
    let class = "app/Livewire/Posts/CreatePost.php";
    let (edits, moves) = rename_with_files(
        &mut project,
        class,
        &CREATE_POST.replace("class CreatePost", "class Create/*|*/Post"),
        "EditPost",
    )
    .unwrap();
    assert_eq!(
        edits,
        [
            edit(class, 7, "CreatePost", "EditPost"),
            edit(LIVE_POSTS_VIEW, 1, "create-post", "edit-post"),
            edit(LIVE_POSTS_VIEW, 2, "create-post", "edit-post"),
        ]
    );
    assert_eq!(moves, [(class.to_owned(), "app/Livewire/Posts/EditPost.php".to_owned())]);

    // A class registered with an alias keeps the alias; its discovered name
    // (`counter`) follows.
    let mut project = with_ticker();
    project.open(PROBE, &probe("Livewire::test('counter/*|*/');"));
    let (edits, _) = rename_with_files(
        &mut project,
        "app/Livewire/Counter.php",
        &COUNTER.replace("class Counter", "class Coun/*|*/ter"),
        "Clicker",
    )
    .unwrap();
    assert!(edits.contains(&edit(PROBE, 11, "counter", "clicker")), "{edits:?}");
    assert!(!edits.iter().any(|edit| edit.2 == "ticker"), "{edits:?}");
}

#[test]
fn renaming_a_discovered_name_renames_its_class() {
    let mut project = with_create_post_usages();
    let source = probe("Livewire::test('posts.create-p/*|*/ost');");
    let (doc, pos) = project.open(PROBE, &source);
    // The last segment: the rest comes from the namespace.
    assert_eq!(project.engine.prepare_rename(doc, pos), Some(Some(Range::new(Pos::new(11, 26), Pos::new(11, 37)))));
    project.engine.document_closed(doc);

    let (edits, moves) = rename_with_files(&mut project, PROBE, &source, "edit-post").unwrap();
    assert_eq!(
        edits,
        [
            edit(PROBE, 11, "create-post", "edit-post"),
            edit("app/Livewire/Posts/CreatePost.php", 7, "CreatePost", "EditPost"),
            edit(LIVE_POSTS_VIEW, 1, "create-post", "edit-post"),
            edit(LIVE_POSTS_VIEW, 2, "create-post", "edit-post"),
        ]
    );
    assert_eq!(moves, [("app/Livewire/Posts/CreatePost.php".to_owned(), "app/Livewire/Posts/EditPost.php".to_owned())]);
    // Names no class gives.
    for bad in ["Edit-Post", "edit--post", "edit.post", "edit post", "-edit", ""] {
        assert!(rename_with_files(&mut project, PROBE, &source, bad).is_err(), "{bad}");
    }
    assert_eq!(class_for_segment("edit-post2").as_deref(), Some("EditPost2"));
}

const PAGE_CONTROLLER: &str = r#"<?php

namespace App\Http\Controllers;

use Inertia\Inertia;

class PageController
{
    public function index()
    {
        return Inertia::render('Posts/Index');
    }
}
"#;

#[test]
fn finds_usages_of_and_renames_inertia_pages_from_their_files() {
    let mut project = Project::with_packages_and(&[("app/Http/Controllers/PageController.php", PAGE_CONTROLLER)]);
    let page = project.root.join("resources/js/Pages/Posts/Index.vue");
    let cancel = CancellationToken::new();
    assert_eq!(project.engine.laravel_inertia_page_name(&page).as_deref(), Some("Posts/Index"));
    assert_eq!(project.engine.laravel_inertia_page_name(&project.root.join("resources/js/app.js")), None);

    let found = project.engine.laravel_inertia_page_references(&page, true, &cancel).unwrap().unwrap();
    let found: Vec<(String, u32, String)> =
        found.iter().map(|usage| project.describe(&usage.path, usage.range)).collect();
    assert_eq!(
        found,
        [
            ("app/Http/Controllers/PageController.php".to_owned(), 10, "Posts/Index".to_owned()),
            ("resources/js/Pages/Posts/Index.vue".to_owned(), 0, String::new()),
        ]
    );

    // Renaming the page renames its file and the last segment of every usage.
    let edit = project.engine.laravel_inertia_page_rename(&page, "List", &cancel).unwrap().unwrap();
    let [FileEdit::Edit { path, edits, .. }, FileEdit::Rename { from, to }] = edit.files.as_slice() else {
        panic!("{edit:?}")
    };
    assert_eq!(project.describe(&PathBuf::from(path.clone()), edits[0].range).2, "Index");
    assert_eq!(edits[0].new_text, "List");
    assert_eq!(PathBuf::from(from.clone()), page);
    assert_eq!(PathBuf::from(to.clone()), project.root.join("resources/js/Pages/Posts/List.vue"));
    assert!(project.engine.laravel_inertia_page_rename(&page, "A/B", &cancel).unwrap().is_err());

    // The same from a usage in PHP.
    let (doc, pos) = project.open(PROBE, &probe("Inertia::render('Posts/In/*|*/dex');"));
    let range = project.engine.prepare_rename(doc, pos).unwrap().unwrap();
    assert_eq!(range, Range::new(Pos::new(11, 27), Pos::new(11, 32)));
    let edit = project.engine.rename(doc, pos, "List", &cancel).unwrap().unwrap();
    assert!(edit.files.iter().any(|file| matches!(file, FileEdit::Rename { .. })), "{edit:?}");
    assert_eq!(edit.files.iter().filter(|file| matches!(file, FileEdit::Edit { .. })).count(), 2);
}
