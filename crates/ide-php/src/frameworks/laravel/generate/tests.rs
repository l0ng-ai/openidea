//! The Laravel generators on the fixture app (`fixtures/laravel-app` with
//! `fixtures/laravel-stubs` as its `vendor/`): snapshots of the generated
//! files, settings, modules, edited templates and errors.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ide_core::settings::{LaravelCodeGeneration, LaravelSettings};
use ide_core::{FileEdit, IdeEvent, SharedSink};

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;

const TIMESTAMP: &str = "2024_06_01_120000";

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

struct App {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
}

impl App {
    fn new() -> Self {
        Self::new_with(|_| {})
    }

    /// The fixture app, changed by `change` (given its root) before the
    /// engine opens it.
    fn new_with(change: impl FnOnce(&Path)) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        copy_dir(&fixtures.join("laravel-app"), &root);
        copy_dir(&fixtures.join("laravel-stubs"), &root.join("vendor"));
        change(&root);
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(Duration::from_secs(120)));
        Self { _tmp: tmp, root: crate::project::normalize(&root), engine }
    }

    fn with_generation(self, generation: LaravelCodeGeneration) -> Self {
        self.engine.set_laravel_settings(LaravelSettings { generation, ..LaravelSettings::default() });
        self
    }

    fn relative(&self, path: &Path) -> String {
        let path = crate::project::normalize(path);
        path.strip_prefix(&self.root).unwrap_or(&path).to_string_lossy().replace('\\', "/")
    }

    /// The generated files as one text: `== path` and the file, each.
    fn golden(&self, files: &[GeneratedFile]) -> String {
        files.iter().map(|file| format!("== {}\n{}", self.relative(&file.path), file.text)).collect()
    }

    fn paths(&self, files: &[GeneratedFile]) -> Vec<String> {
        files.iter().map(|file| self.relative(&file.path)).collect()
    }

    fn generate(&self, spec: &NewModel) -> Result<Vec<GeneratedFile>, String> {
        self.engine.laravel_new_model_files(spec, &TemplateSet::default(), TIMESTAMP)
    }
}

fn field(name: &str, ty: &str) -> ModelField {
    ModelField { name: name.to_owned(), ty: ty.to_owned(), ..ModelField::default() }
}

fn relation(kind: &str, model: &str, name: &str) -> ModelRelation {
    ModelRelation { kind: kind.to_owned(), model: model.to_owned(), name: name.to_owned() }
}

/// A model with every kind of field modifier, relations, an index and all
/// the companion classes.
fn article() -> NewModel {
    NewModel {
        name: "Article".to_owned(),
        fields: vec![
            field("title", "string"),
            ModelField { unique: true, ..field("slug", "string") },
            ModelField { nullable: true, ..field("body", "text") },
            ModelField { default: "false".to_owned(), ..field("featured", "boolean") },
            ModelField { default: "0".to_owned(), index: true, ..field("views", "unsignedInteger") },
            ModelField { nullable: true, ..field("published_at", "timestamp") },
            field("price", "decimal"),
        ],
        relations: vec![
            relation("belongsTo", "User", "author"),
            relation("hasMany", "Comment", ""),
            relation("belongsToMany", "App\\Models\\Tag", ""),
        ],
        indexes: vec![ModelIndex { columns: vec!["featured".to_owned(), "published_at".to_owned()], unique: false }],
        soft_deletes: true,
        factory: true,
        seeder: true,
        controller: ControllerKind::Resource,
        form_requests: true,
        resource: true,
        policy: true,
        ..NewModel::default()
    }
}

#[test]
fn new_model_with_every_companion() {
    let app = App::new();
    let files = app.generate(&article()).unwrap();
    assert_eq!(
        app.paths(&files),
        [
            "app/Models/Article.php",
            "database/migrations/2024_06_01_120000_create_articles_table.php",
            "database/migrations/2024_06_01_120001_create_article_tag_table.php",
            "database/factories/ArticleFactory.php",
            "database/seeders/ArticleSeeder.php",
            "app/Http/Requests/StoreArticleRequest.php",
            "app/Http/Requests/UpdateArticleRequest.php",
            "app/Http/Controllers/ArticleController.php",
            "app/Http/Resources/ArticleResource.php",
            "app/Policies/ArticlePolicy.php",
        ]
    );
    insta::assert_snapshot!("new_model_with_every_companion", app.golden(&files));

    // The edit creates them all, empty first, then with their text.
    let edit = app.engine.laravel_new_model(&article(), &TemplateSet::default(), TIMESTAMP).unwrap();
    assert_eq!(edit.files.len(), files.len() * 2);
    assert!(matches!(&edit.files[0], FileEdit::Create { overwrite: false, .. }));
    assert!(matches!(&edit.files[1], FileEdit::Edit { edits, .. } if edits[0].new_text == files[0].text));
}

#[test]
fn api_controller_settings_and_a_module() {
    let app = App::new().with_generation(LaravelCodeGeneration {
        controller_suffix: "Endpoint".to_owned(),
        policy_suffix: String::new(),
        type_hints: false,
        ..LaravelCodeGeneration::default()
    });
    let spec = NewModel {
        name: "Invoice".to_owned(),
        module: Some("Billing".to_owned()),
        fields: vec![field("number", "string"), ModelField { nullable: true, ..field("paid", "boolean") }],
        relations: vec![relation("morphTo", "", "billable"), relation("morphMany", "App\\Models\\Comment", "")],
        timestamps: false,
        factory: true,
        controller: ControllerKind::Api,
        policy: true,
        ..NewModel::default()
    };
    let files = app.generate(&spec).unwrap();
    assert_eq!(
        app.paths(&files),
        [
            "Modules/Billing/Models/Invoice.php",
            "Modules/Billing/database/migrations/2024_06_01_120000_create_invoices_table.php",
            "Modules/Billing/database/factories/InvoiceFactory.php",
            "Modules/Billing/Http/Controllers/InvoiceEndpoint.php",
            "Modules/Billing/Policies/Invoice.php",
        ]
    );
    insta::assert_snapshot!("api_controller_settings_and_a_module", app.golden(&files));
}

#[test]
fn settings_pick_the_namespace_and_module() {
    let app = App::new()
        .with_generation(LaravelCodeGeneration { module: "Billing".to_owned(), ..LaravelCodeGeneration::default() });
    let spec = NewModel { name: "Payment".to_owned(), migration: false, ..NewModel::default() };
    assert_eq!(app.paths(&app.generate(&spec).unwrap()), ["Modules/Billing/Models/Payment.php"]);
    // The dialog's choice wins; empty is the application.
    let spec = NewModel { module: Some(String::new()), ..spec };
    assert_eq!(app.paths(&app.generate(&spec).unwrap()), ["app/Models/Payment.php"]);

    let app = app
        .with_generation(LaravelCodeGeneration { namespace: "Shop\\".to_owned(), ..LaravelCodeGeneration::default() });
    let files =
        app.generate(&NewModel { name: "Blog/Entry".to_owned(), migration: false, ..NewModel::default() }).unwrap();
    assert_eq!(app.paths(&files), ["app/Models/Blog/Entry.php"]);
    assert!(files[0].text.contains("namespace Shop\\Models\\Blog;"), "{}", files[0].text);
}

#[test]
fn edited_templates_are_used() {
    let app = App::new();
    let templates = TemplateSet::new([(
        template::MODEL.to_owned(),
        "<?php\n\nnamespace $NAMESPACE$;\n\n$IMPORTS$\n\n// Generated: $TABLE$\nclass $CLASS$ extends Model\n{\n}\n"
            .to_owned(),
    )]);
    let spec = NewModel { name: "Note".to_owned(), migration: false, ..NewModel::default() };
    let files = app.engine.laravel_new_model_files(&spec, &templates, TIMESTAMP).unwrap();
    assert_eq!(
        files[0].text,
        "<?php\n\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\n// Generated: notes\nclass Note extends Model\n{\n}\n"
    );
    let broken = TemplateSet::new([(template::MODEL.to_owned(), "#if ($X$)\n".to_owned())]);
    assert!(app.engine.laravel_new_model_files(&spec, &broken, TIMESTAMP).unwrap_err().contains("Laravel Model"));
}

#[test]
fn invalid_requests_fail_with_a_reason() {
    let app = App::new();
    let fails = |spec: NewModel| app.generate(&spec).unwrap_err();
    let named = |name: &str| NewModel { name: name.to_owned(), ..NewModel::default() };
    assert!(fails(named("Post")).contains("exists already"));
    assert!(fails(named("1Post")).contains("not a valid class name"));
    assert!(fails(named("")).contains("not a valid class name"));
    assert!(fails(NewModel { fields: vec![field("id", "string")], ..named("Note") }).contains("twice"));
    assert!(
        fails(NewModel { fields: vec![field("a", "string"), field("A", "text")], ..named("Note") }).contains("twice")
    );
    assert!(fails(NewModel { fields: vec![field("a b", "string")], ..named("Note") }).contains("column name"));
    assert!(fails(NewModel { fields: vec![field("a", "")], ..named("Note") }).contains("column type"));
    assert!(
        fails(NewModel { relations: vec![relation("hasLots", "Post", "")], ..named("Note") }).contains("relation kind")
    );
    assert!(fails(NewModel { relations: vec![relation("hasMany", "", "")], ..named("Note") }).contains("model class"));
    assert!(fails(NewModel { relations: vec![relation("morphTo", "", "")], ..named("Note") }).contains("morphTo"));
    assert!(
        fails(NewModel {
            relations: vec![relation("hasMany", "Post", ""), relation("hasOne", "Post", "posts")],
            ..named("Note")
        })
        .contains("Two relations")
    );
    assert!(
        fails(NewModel {
            indexes: vec![ModelIndex { columns: vec!["nope".to_owned()], unique: true }],
            ..named("Note")
        })
        .contains("unknown column 'nope'")
    );
    assert!(fails(NewModel { module: Some("Shop".to_owned()), ..named("Note") }).contains("no module 'Shop'"));
    // A file in the way.
    std::fs::write(app.root.join("database/factories/NoteFactory.php"), "<?php\n").unwrap();
    assert!(fails(NewModel { factory: true, ..named("Note") }).contains("NoteFactory.php exists already"));
}

#[test]
fn the_generation_context_lists_modules_and_models() {
    let app = App::new()
        .with_generation(LaravelCodeGeneration { module: "Billing".to_owned(), ..LaravelCodeGeneration::default() });
    let context = app.engine.laravel_generation_context().unwrap();
    assert_eq!(context.namespace, "App\\");
    assert_eq!(context.modules, ["Billing"]);
    assert_eq!(context.default_module.as_deref(), Some("Billing"));
    assert_eq!(context.models, ["App\\Models\\Comment", "App\\Models\\Post", "App\\Models\\Tag", "App\\Models\\User"]);
    let ids: Vec<&str> = context.generators.iter().map(|g| g.id.as_str()).collect();
    assert_eq!(ids[0], "model");
    // Livewire isn't installed in the fixture: no Livewire generator.
    let class_ids: Vec<&str> = CLASS_GENERATORS.iter().map(|g| g.id).filter(|id| *id != LIVEWIRE_GENERATOR).collect();
    assert_eq!(ids[1..=class_ids.len()], class_ids[..]);
    // Then the code generations of the fixture's ide.json.
    assert_eq!(ids[class_ids.len() + 1..], ["ide-json:acme.dto"]);
    assert_eq!(context.generators[0].templates.len(), 10);
    assert!(context.generators[0].options.is_empty());
    let listener = context.generators.iter().find(|g| g.id == "listener").unwrap();
    assert_eq!(listener.options, ["event", "queued"]);
    // Every template is rendered by some generator.
    let all = generators();
    for template in BUILTIN_TEMPLATES {
        assert!(all.iter().any(|g| g.templates.iter().any(|name| name == template.name)), "{}", template.name);
    }
}

/// `(relative path, new texts)` of each edited file.
type FileTexts = Vec<(String, Vec<String>)>;

impl App {
    fn class(&self, spec: &NewClass) -> Result<Vec<GeneratedFile>, String> {
        self.engine.laravel_generate_class_files(spec, &TemplateSet::default(), TIMESTAMP)
    }

    /// Opens `rel` with `source` (a `/*|*/` caret) and answers the context
    /// actions starting with `prefix`: `(title, [(path, new texts)])`.
    fn generate_actions(&self, rel: &str, source: &str, prefix: &str) -> Vec<(String, FileTexts)> {
        let at = source.find("/*|*/").unwrap();
        let text = source.replace("/*|*/", "");
        let pos = crate::syntax::LineIndex::new(&text).pos(at as u32);
        let doc = ide_core::DocId(1);
        self.engine.document_opened(doc, &self.root.join(rel), 1, &text);
        let actions = self
            .engine
            .code_actions(doc, ide_core::Range::new(pos, pos), &[crate::imports::REWRITE.to_owned()])
            .unwrap()
            .into_iter()
            .filter(|action| action.title.starts_with(prefix))
            .map(|action| {
                let files = action
                    .edit
                    .files
                    .iter()
                    .filter_map(|file| match file {
                        FileEdit::Edit { path, edits, .. } => {
                            Some((self.relative(path.as_ref()), edits.iter().map(|e| e.new_text.clone()).collect()))
                        }
                        _ => None,
                    })
                    .collect();
                (action.title, files)
            })
            .collect();
        self.engine.document_closed(doc);
        actions
    }
}

fn class_spec(generator: &str, name: &str) -> NewClass {
    NewClass { generator: generator.to_owned(), name: name.to_owned(), ..NewClass::default() }
}

/// One snapshot per generator: its files for a typical request.
#[test]
fn every_class_generator() {
    let app = App::new();
    let cases: Vec<(&str, NewClass, &[&str])> = vec![
        (
            "controller",
            class_spec("controller", "Admin/Dashboard"),
            &["app/Http/Controllers/Admin/DashboardController.php"],
        ),
        (
            "resource_controller",
            NewClass { model: "Tag".to_owned(), ..class_spec("resource-controller", "TagController") },
            &["app/Http/Controllers/TagController.php"],
        ),
        (
            "resource_controller_api_without_model",
            NewClass { api: true, ..class_spec("resource-controller", "Report") },
            &["app/Http/Controllers/ReportController.php"],
        ),
        ("middleware", class_spec("middleware", "EnsureTokenIsValid"), &["app/Http/Middleware/EnsureTokenIsValid.php"]),
        ("request", class_spec("request", "StoreTag"), &["app/Http/Requests/StoreTagRequest.php"]),
        (
            "resource",
            NewClass { model: "Post".to_owned(), ..class_spec("resource", "Post") },
            &["app/Http/Resources/PostResource.php"],
        ),
        ("resource_collection", class_spec("resource-collection", "Post"), &["app/Http/Resources/PostCollection.php"]),
        ("factory", class_spec("factory", "Comment"), &["database/factories/CommentFactory.php"]),
        (
            "seeder",
            NewClass { model: "Post".to_owned(), ..class_spec("seeder", "Post") },
            &["database/seeders/PostSeeder.php"],
        ),
        (
            "migration_create",
            class_spec("migration", "create_flights_table"),
            &["database/migrations/2024_06_01_120000_create_flights_table.php"],
        ),
        (
            "migration_update",
            class_spec("migration", "add_votes_to_users_table"),
            &["database/migrations/2024_06_01_120000_add_votes_to_users_table.php"],
        ),
        (
            "pivot_migration",
            NewClass {
                model: "Tag".to_owned(),
                related: "App\\Models\\Post".to_owned(),
                ..class_spec("pivot-migration", "")
            },
            &["database/migrations/2024_06_01_120000_create_post_tag_table.php"],
        ),
        ("event", class_spec("event", "PodcastProcessed"), &["app/Events/PodcastProcessed.php"]),
        (
            "listener",
            NewClass { event: "PodcastProcessed".to_owned(), ..class_spec("listener", "SendPodcastNotification") },
            &["app/Listeners/SendPodcastNotification.php"],
        ),
        (
            "listener_sync",
            NewClass { queued: false, ..class_spec("listener", "LogPodcast") },
            &["app/Listeners/LogPodcast.php"],
        ),
        ("job", class_spec("job", "ProcessPodcast"), &["app/Jobs/ProcessPodcast.php"]),
        ("job_sync", NewClass { queued: false, ..class_spec("job", "TidyUp") }, &["app/Jobs/TidyUp.php"]),
        ("mail", class_spec("mail", "OrderShipped"), &["app/Mail/OrderShipped.php"]),
        ("notification", class_spec("notification", "InvoicePaid"), &["app/Notifications/InvoicePaid.php"]),
        ("observer", class_spec("observer", "Comment"), &["app/Observers/CommentObserver.php"]),
        ("policy", class_spec("policy", "Comment"), &["app/Policies/CommentPolicy.php"]),
        ("policy_plain", class_spec("policy", "Billing"), &["app/Policies/BillingPolicy.php"]),
        ("rule", class_spec("rule", "Uppercase"), &["app/Rules/Uppercase.php"]),
        ("exception", class_spec("exception", "InvalidOrderException"), &["app/Exceptions/InvalidOrderException.php"]),
        (
            "http_exception",
            NewClass { status: 418, ..class_spec("http-exception", "TeapotException") },
            &["app/Exceptions/TeapotException.php"],
        ),
        ("provider", class_spec("provider", "RiakServiceProvider"), &["app/Providers/RiakServiceProvider.php"]),
        ("command", class_spec("command", "SendEmails"), &["app/Console/Commands/SendEmails.php"]),
        (
            "component",
            class_spec("component", "Forms/InputField"),
            &["app/View/Components/Forms/InputField.php", "resources/views/components/forms/input-field.blade.php"],
        ),
        (
            "anonymous_component",
            class_spec("anonymous-component", "forms.DatePicker"),
            &["resources/views/components/forms/date-picker.blade.php"],
        ),
        ("view", class_spec("view", "posts/edit"), &["resources/views/posts/edit.blade.php"]),
        ("view_composer", class_spec("view-composer", "Profile"), &["app/View/Composers/ProfileComposer.php"]),
        ("channel", class_spec("channel", "Order"), &["app/Broadcasting/OrderChannel.php"]),
        ("enum", NewClass { backing: "string".to_owned(), ..class_spec("enum", "Suit") }, &["app/Enums/Suit.php"]),
        ("feature_test", class_spec("feature-test", "UserTest"), &["tests/Feature/UserTest.php"]),
        ("unit_test", class_spec("unit-test", "Money/Parser"), &["tests/Unit/Money/ParserTest.php"]),
        (
            "livewire",
            class_spec("livewire", "posts.create-post"),
            &["app/Livewire/Posts/CreatePost.php", "resources/views/livewire/posts/create-post.blade.php"],
        ),
        (
            "livewire_class_name",
            class_spec("livewire", "Counter"),
            &["app/Livewire/Counter.php", "resources/views/livewire/counter.blade.php"],
        ),
    ];
    let mut covered: Vec<&str> = Vec::new();
    for (snapshot, spec, paths) in cases {
        let files = app.class(&spec).unwrap_or_else(|e| panic!("{snapshot}: {e}"));
        assert_eq!(app.paths(&files), paths, "{snapshot}");
        insta::assert_snapshot!(format!("class_{snapshot}"), app.golden(&files));
        covered.push(class_generator(&spec.generator).unwrap().id);
    }
    for generator in CLASS_GENERATORS {
        assert!(covered.contains(&generator.id), "no snapshot of '{}'", generator.id);
    }
}

#[test]
fn class_generators_in_a_module_and_with_settings() {
    let app = App::new().with_generation(LaravelCodeGeneration {
        module: "Billing".to_owned(),
        policy_suffix: String::new(),
        type_hints: false,
        ..LaravelCodeGeneration::default()
    });
    let files = app.class(&class_spec("job", "ChargeCard")).unwrap();
    assert_eq!(app.paths(&files), ["Modules/Billing/Jobs/ChargeCard.php"]);
    assert!(files[0].text.contains("namespace Modules\\Billing\\Jobs;"), "{}", files[0].text);
    assert!(files[0].text.contains("public function handle()\n"), "{}", files[0].text);
    let files = app.class(&class_spec("component", "Total")).unwrap();
    assert_eq!(
        app.paths(&files),
        ["Modules/Billing/View/Components/Total.php", "Modules/Billing/resources/views/components/total.blade.php"]
    );
    assert!(files[0].text.contains("return view('billing::components.total');"), "{}", files[0].text);
    let files = app.class(&class_spec("migration", "create_invoices_table")).unwrap();
    assert_eq!(app.paths(&files), ["Modules/Billing/database/migrations/2024_06_01_120000_create_invoices_table.php"]);
    let files = app.class(&class_spec("feature-test", "Invoice")).unwrap();
    assert_eq!(app.paths(&files), ["Modules/Billing/tests/Feature/InvoiceTest.php"]);
    assert!(files[0].text.contains("namespace Modules\\Billing\\Tests\\Feature;"), "{}", files[0].text);
    // An empty policy suffix, and the application chosen in the dialog.
    let files = app.class(&NewClass { module: Some(String::new()), ..class_spec("policy", "Tag") }).unwrap();
    assert_eq!(app.paths(&files), ["app/Policies/Tag.php"]);
    // A migration with an explicit table.
    let files = app
        .class(&NewClass {
            table: "posts".to_owned(),
            create: false,
            module: Some(String::new()),
            ..class_spec("migration", "tidy posts")
        })
        .unwrap();
    assert_eq!(app.paths(&files), ["database/migrations/2024_06_01_120000_tidy_posts.php"]);
    assert!(files[0].text.contains("Schema::table('posts'"), "{}", files[0].text);
}

#[test]
fn providers_are_registered_and_pest_tests_detected() {
    let app = App::new();
    let edit =
        app.engine.laravel_generate_class(&class_spec("provider", "Riak"), &TemplateSet::default(), TIMESTAMP).unwrap();
    let registration = edit
        .files
        .iter()
        .find_map(|file| match file {
            FileEdit::Edit { path, edits, .. } if app.relative(path.as_ref()) == "bootstrap/providers.php" => {
                Some(edits[0].new_text.clone())
            }
            _ => None,
        })
        .expect("the registration");
    assert_eq!(registration, "\n    App\\Providers\\Riak::class,");

    std::fs::create_dir_all(app.root.join("tests")).unwrap();
    std::fs::write(app.root.join("tests/Pest.php"), "<?php\n").unwrap();
    let files = app.class(&class_spec("unit-test", "Money")).unwrap();
    assert_eq!(files[0].text, "<?php\n\ntest('example', function () {\n    expect(true)->toBeTrue();\n});\n");
}

/// The edits of `edit` to existing files: `(path, [new text])`.
fn registrations(app: &App, edit: &WorkspaceEdit) -> Vec<(String, Vec<String>)> {
    let created: Vec<String> = edit
        .files
        .iter()
        .filter_map(|file| match file {
            FileEdit::Create { path, .. } => Some(app.relative(path.as_ref())),
            _ => None,
        })
        .collect();
    edit.files
        .iter()
        .filter_map(|file| match file {
            FileEdit::Edit { path, edits, .. } if !created.contains(&app.relative(path.as_ref())) => {
                Some((app.relative(path.as_ref()), edits.iter().map(|e| e.new_text.clone()).collect()))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn generators_register_what_they_create() {
    let app = App::new_with(|root| {
        std::fs::write(
            root.join("app/Providers/EventServiceProvider.php"),
            "<?php\n\nnamespace App\\Providers;\n\nuse Illuminate\\Foundation\\Support\\Providers\\EventServiceProvider as ServiceProvider;\n\nclass EventServiceProvider extends ServiceProvider\n{\n    protected $listen = [\n    ];\n}\n",
        )
        .unwrap();
    });
    let generate =
        |spec: NewClass| app.engine.laravel_generate_class(&spec, &TemplateSet::default(), TIMESTAMP).unwrap();

    // An observer goes on its model.
    let edit = generate(class_spec("observer", "Comment"));
    let found = registrations(&app, &edit);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "app/Models/Comment.php");
    let texts = found[0].1.join("");
    assert!(texts.contains("#[ObservedBy([CommentObserver::class])]"), "{texts}");
    assert!(texts.contains("use App\\Observers\\CommentObserver;"), "{texts}");
    assert!(texts.contains("use Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy;"), "{texts}");
    // No model, nothing to register.
    assert!(registrations(&app, &generate(class_spec("observer", "Audit"))).is_empty());

    // A listener goes under its event in `$listen`.
    let edit = generate(NewClass { event: "PodcastProcessed".to_owned(), ..class_spec("listener", "SendNotice") });
    let found = registrations(&app, &edit);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "app/Providers/EventServiceProvider.php");
    let texts = found[0].1.join("|");
    assert!(texts.contains("PodcastProcessed::class => [\n            SendNotice::class,\n        ],"), "{texts}");
    assert!(texts.contains("use App\\Events\\PodcastProcessed;"), "{texts}");
    assert!(texts.contains("use App\\Listeners\\SendNotice;"), "{texts}");
    // Without an event, nothing.
    assert!(registrations(&app, &generate(class_spec("listener", "Quiet"))).is_empty());

    // A module's provider goes into its `module.json`.
    let edit =
        generate(NewClass { module: Some("Billing".to_owned()), ..class_spec("provider", "TaxServiceProvider") });
    // The fixture's line endings depend on the checkout.
    let found: Vec<(String, Vec<String>)> = registrations(&app, &edit)
        .into_iter()
        .map(|(path, texts)| (path, texts.iter().map(|text| text.replace("\r\n", "\n")).collect()))
        .collect();
    assert_eq!(
        found,
        [(
            "Modules/Billing/module.json".to_owned(),
            vec![",\n        \"Modules\\\\Billing\\\\Providers\\\\TaxServiceProvider\"".to_owned()]
        )]
    );
}

#[test]
fn livewire_2_components_go_below_http_livewire() {
    let app = App::new_with(|root| {
        let path = root.join("composer.json");
        let text = std::fs::read_to_string(&path).unwrap();
        let text = text.replacen("\"require\": {", "\"require\": {\n        \"livewire/livewire\": \"^2.12\",", 1);
        std::fs::write(&path, text).unwrap();
    });
    assert_eq!(app.engine.laravel().unwrap().livewire_major, Some(2));
    let files = app.class(&class_spec("livewire", "posts.create-post")).unwrap();
    assert_eq!(
        app.paths(&files),
        ["app/Http/Livewire/Posts/CreatePost.php", "resources/views/livewire/posts/create-post.blade.php"]
    );
    assert!(files[0].text.contains("namespace App\\Http\\Livewire\\Posts;"), "{}", files[0].text);
    assert_eq!(App::new().engine.laravel().unwrap().livewire_major, None);
}

#[test]
fn model_actions_use_the_edited_templates() {
    let app = App::new();
    app.engine.set_laravel_templates(TemplateSet::new([(
        template::JSON_RESOURCE.to_owned(),
        "<?php\n\nnamespace $NAMESPACE$;\n\n// Edited\nclass $CLASS$ {}\n".to_owned(),
    )]));
    let comment = std::fs::read_to_string(app.root.join("app/Models/Comment.php")).unwrap();
    let source = comment.replacen("    protected $fillable", "    /*|*/protected $fillable", 1);
    let resource = app.generate_actions("app/Models/Comment.php", &source, "Generate JSON resource");
    assert_eq!(
        resource[0].1[0].1[0],
        "<?php\n\nnamespace App\\Http\\Resources;\n\n// Edited\nclass CommentResource {}\n"
    );
}

#[test]
fn invalid_class_requests_fail_with_a_reason() {
    let app = App::new();
    let fails = |spec: NewClass| app.class(&spec).unwrap_err();
    assert!(fails(class_spec("nothing", "X")).contains("no generator 'nothing'"));
    assert!(fails(class_spec("job", "1Job")).contains("not a valid class name"));
    assert!(fails(class_spec("controller", "Post")).contains("exists already"));
    assert!(fails(class_spec("view", "posts/index")).contains("exists already"));
    assert!(fails(class_spec("view", "posts..x")).contains("not a valid view name"));
    assert!(fails(class_spec("migration", "tidy_up")).contains("Name the table"));
    assert!(fails(class_spec("migration", "")).contains("not a valid migration name"));
    assert!(fails(class_spec("pivot-migration", "")).contains("two models"));
    assert!(
        fails(NewClass { model: "Post".to_owned(), related: "Post".to_owned(), ..class_spec("pivot-migration", "") })
            .contains("two different models")
    );
    assert!(fails(NewClass { backing: "float".to_owned(), ..class_spec("enum", "Suit") }).contains("string or int"));
    assert!(fails(NewClass { status: 99, ..class_spec("http-exception", "Odd") }).contains("not an HTTP status"));
    assert!(fails(NewClass { module: Some("Shop".to_owned()), ..class_spec("job", "X") }).contains("no module 'Shop'"));
}

#[test]
fn generate_actions_inside_a_model() {
    let app = App::new();
    let comment = std::fs::read_to_string(app.root.join("app/Models/Comment.php")).unwrap();
    let source = comment.replacen("    protected $fillable", "    /*|*/protected $fillable", 1);
    let rel = "app/Models/Comment.php";

    let resource = app.generate_actions(rel, &source, "Generate JSON resource");
    assert_eq!(resource.len(), 1, "{resource:?}");
    assert_eq!(resource[0].0, "Generate JSON resource from 'Comment'");
    assert_eq!(resource[0].1[0].0, "app/Http/Resources/CommentResource.php");
    insta::assert_snapshot!("from_model_resource", resource[0].1[0].1[0]);

    let factory = app.generate_actions(rel, &source, "Generate factory");
    assert_eq!(factory.len(), 1, "{factory:?}");
    assert_eq!(factory[0].0, "Generate factory from 'Comment'");
    assert_eq!(factory[0].1[0].0, "database/factories/CommentFactory.php");
    insta::assert_snapshot!("from_model_factory", factory[0].1[0].1[0]);

    let fillable = app.generate_actions(rel, &source, "Add all fields");
    assert_eq!(
        fillable,
        [("Add all fields to $fillable".to_owned(), vec![(rel.to_owned(), vec![", 'post_id', 'user_id'".to_owned()])])]
    );

    // Post has a factory, and everything but `options`/`author_id`… is
    // fillable already: no factory action.
    let post = std::fs::read_to_string(app.root.join("app/Models/Post.php")).unwrap();
    let source = post.replacen("    use SoftDeletes;", "    use SoftDeletes;/*|*/", 1);
    assert!(app.generate_actions("app/Models/Post.php", &source, "Generate factory").is_empty());
    assert_eq!(app.generate_actions("app/Models/Post.php", &source, "Generate JSON resource").len(), 1);

    // Nothing outside a model.
    let controller = std::fs::read_to_string(app.root.join("app/Http/Controllers/HomeController.php")).unwrap();
    let at = controller.find('{').unwrap() + 1;
    let source = format!("{}/*|*/{}", &controller[..at], &controller[at..]);
    assert!(app.generate_actions("app/Http/Controllers/HomeController.php", &source, "Generate").is_empty());
    assert!(app.generate_actions("app/Http/Controllers/HomeController.php", &source, "Add all fields").is_empty());
}

#[test]
fn imports_sort_skip_and_alias() {
    let mut imports = Imports::new("App\\Http\\Controllers", "Post");
    assert_eq!(imports.add("App\\Http\\Controllers\\Controller"), "Controller");
    assert_eq!(imports.add("\\Illuminate\\Http\\Request"), "Request");
    assert_eq!(imports.add("App\\Models\\Post"), "PostModel");
    assert_eq!(imports.add("App\\Models\\Post"), "PostModel");
    assert_eq!(imports.add("App\\Http\\Requests\\Request"), "RequestRequest");
    assert_eq!(
        imports.lines(),
        "use App\\Http\\Requests\\Request as RequestRequest;\nuse App\\Models\\Post as PostModel;\nuse Illuminate\\Http\\Request;"
    );
}

#[test]
fn constructors_promote_or_assign() {
    let params = [
        ConstructorParam {
            ty: "Mailer".to_owned(),
            name: "mailer".to_owned(),
            visibility: "private".to_owned(),
            readonly: true,
        },
        ConstructorParam {
            ty: "?string".to_owned(),
            name: "subject".to_owned(),
            visibility: "public".to_owned(),
            readonly: false,
        },
    ];
    assert_eq!(
        constructor(&params, true),
        "public function __construct(\n    private readonly Mailer $mailer,\n    public ?string $subject,\n) {}"
    );
    assert_eq!(
        constructor(&params, false),
        "private readonly Mailer $mailer;\npublic ?string $subject;\n\npublic function __construct(Mailer $mailer, ?string $subject)\n{\n    $this->mailer = $mailer;\n    $this->subject = $subject;\n}"
    );
    assert_eq!(constructor(&[], true), "");
}

#[test]
fn names() {
    assert_eq!(table_name("BlogPost"), "blog_posts");
    assert_eq!(table_name("Category"), "categories");
    assert_eq!(camel("BlogPost"), "blogPost");
    assert_eq!(camel("blog_posts"), "blogPosts");
}

/// The code generation of the fixture's `ide.json`: listed with its input
/// fields, and rendered from its stubs (a class of `appNamespace`, and a
/// file of `directory` from the fallback stub).
#[test]
fn ide_json_code_generation() {
    let app = App::new();
    let context = app.engine.laravel_generation_context().unwrap();
    let dto = context.generators.iter().find(|g| g.id == "ide-json:acme.dto").expect("the ide.json generator");
    assert_eq!(dto.title, "Data Transfer Object");
    assert!(dto.description.ends_with("ide.json"), "{}", dto.description);
    assert_eq!(dto.templates.len(), 2);
    assert!(dto.templates[0].replace('\\', "/").ends_with("stubs/dto.stub"), "{:?}", dto.templates);
    let fields: Vec<(&str, &str, &str)> =
        dto.fields.iter().map(|f| (f.id.as_str(), f.kind.as_str(), f.variable.as_str())).collect();
    assert_eq!(
        fields,
        [("readonly", "checkbox", "READONLY"), ("source", "select", "SOURCE"), ("summary", "text", "SUMMARY")]
    );
    assert_eq!(dto.fields[1].options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Request", "Model"]);

    // The defaults: read-only, from a request.
    let files = app.class(&class_spec("ide-json:acme.dto", "Invoice")).unwrap();
    assert_eq!(app.paths(&files), ["app/Data/InvoiceData.php", "docs/data/invoice_data.md"]);
    insta::assert_snapshot!("ide_json_dto_defaults", app.golden(&files));

    // Inputs given, in a sub-namespace.
    let spec = NewClass {
        inputs: [("readonly", ""), ("source", "model"), ("summary", "Totals only.")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect(),
        ..class_spec("ide-json:acme.dto", "Billing/Refund")
    };
    let files = app.class(&spec).unwrap();
    assert_eq!(app.paths(&files), ["app/Data/Billing/RefundData.php", "docs/data/Billing/refund_data.md"]);
    insta::assert_snapshot!("ide_json_dto_inputs", app.golden(&files));

    // Errors: a choice that isn't one, no name, an unknown generator, a file in the way.
    let bad = NewClass {
        inputs: [("source".to_owned(), "csv".to_owned())].into_iter().collect(),
        ..class_spec("ide-json:acme.dto", "Invoice")
    };
    assert!(app.class(&bad).unwrap_err().contains("'csv' is not a choice of Source"));
    assert!(app.class(&class_spec("ide-json:acme.dto", " ")).unwrap_err().contains("Enter a name"));
    assert!(app.class(&class_spec("ide-json:nope", "Invoice")).unwrap_err().contains("no generator"));
    std::fs::create_dir_all(app.root.join("app/Data")).unwrap();
    std::fs::write(app.root.join("app/Data/InvoiceData.php"), "<?php\n").unwrap();
    assert!(app.class(&class_spec("ide-json:acme.dto", "Invoice")).unwrap_err().contains("exists already"));
}
