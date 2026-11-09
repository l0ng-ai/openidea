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
        for (rel, text) in files {
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
