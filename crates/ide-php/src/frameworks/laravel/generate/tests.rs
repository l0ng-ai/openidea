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
    assert_eq!(context.generators.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), ["model"]);
    assert_eq!(context.generators[0].templates.len(), BUILTIN_TEMPLATES.len());
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
