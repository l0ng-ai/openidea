//! The Eloquent model view (`frameworks::laravel::model_view`): the lens on
//! model classes, the view's query and the Add Columns edit, on the fixture
//! app (`fixtures/laravel-app` with `fixtures/laravel-stubs` as its
//! `vendor/`).

use super::*;
use crate::frameworks::laravel::model_view::{ColumnSource, NewColumn, RelatedKind};

const POST_CLASS: &str = "App\\Models\\Post";

fn new_column(name: &str, ty: &str, nullable: bool) -> NewColumn {
    NewColumn { name: name.to_owned(), ty: ty.to_owned(), nullable }
}

impl Project {
    fn relative(&self, path: &Path) -> String {
        let path = crate::project::normalize(path);
        path.strip_prefix(&self.root).unwrap_or(&path).to_string_lossy().replace('\\', "/")
    }

    /// Writes `files` and lets the engine index them.
    fn add_files(&mut self, files: &[(&str, &str)]) {
        let mut paths = Vec::new();
        for (rel, text) in files {
            let path = self.root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            paths.push(path);
        }
        self.engine.files_changed(&paths, &[]);
        assert!(self.engine.wait_idle(Duration::from_secs(60)));
    }
}

/// The text of `rel` after the edits of `edit` to it.
fn edited(project: &Project, edit: &ide_core::WorkspaceEdit, rel: &str) -> String {
    let path = project.root.join(rel);
    let text = match project.engine.open_document(&path) {
        Some(document) => document.text.to_string(),
        None => std::fs::read_to_string(&path).unwrap(),
    };
    let mut document = ide_text::Document::new(&text);
    for file in &edit.files {
        if let FileEdit::Edit { path, edits, .. } = file
            && project.relative(path.as_ref()) == rel
        {
            document.apply_edits(edits).unwrap();
        }
    }
    document.text().to_string()
}

#[test]
fn model_view_shows_the_table_columns_members_and_related_classes() {
    let mut project = Project::app();
    project.add_files(&[
        ("app/Http/Resources/PostResource.php", "<?php\nnamespace App\\Http\\Resources;\n\nclass PostResource\n{\n}\n"),
        ("app/Observers/PostObserver.php", "<?php\nnamespace App\\Observers;\n\nclass PostObserver\n{\n}\n"),
        // Same name, but not a factory.
        ("app/Support/PostFactory.php", "<?php\nnamespace App\\Support;\n\nclass PostFactory\n{\n}\n"),
    ]);
    let view = project.engine.laravel_model_view(POST_CLASS).expect("a model view");
    assert_eq!((view.class.as_str(), view.name.as_str(), view.table.as_str()), (POST_CLASS, "Post", "posts"));
    assert_eq!((view.primary_key.as_str(), view.key_type.as_str(), view.incrementing), ("id", "int", true));
    assert!(view.schema_certain);
    let location = view.location.as_ref().unwrap();
    assert_eq!(
        project.describe(&location.path, location.range),
        ("app/Models/Post.php".to_owned(), 15, "Post".to_owned())
    );

    // Columns: types, casts, $fillable, where they come from.
    let names: Vec<&str> = view.columns.iter().map(|c| c.name.as_str()).collect();
    for name in
        ["id", "author_id", "title", "slug", "body", "status", "published_at", "options", "created_at", "deleted_at"]
    {
        assert!(names.contains(&name), "{name}: {names:?}");
    }
    let column = |name: &str| view.columns.iter().find(|c| c.name == name).unwrap();
    let title = column("title");
    assert_eq!((title.ty.as_str(), title.nullable, title.fillable, title.hidden), ("string", false, true, false));
    assert_eq!((title.source, title.database.as_deref(), title.cast.as_deref()), (ColumnSource::Migration, None, None));
    let at = title.location.as_ref().unwrap();
    assert_eq!(
        project.describe(&at.path, at.range),
        ("database/migrations/2024_05_01_100000_create_posts_table.php".to_owned(), 13, "'title'".to_owned())
    );
    assert_eq!(column("status").cast.as_deref(), Some("\\App\\Enums\\PostStatus"));
    assert!(column("published_at").nullable);
    assert!(!column("author_id").fillable);

    // Relations, scopes, accessors.
    let relations: Vec<(&str, &str, Option<&str>, bool)> =
        view.relations.iter().map(|r| (r.name.as_str(), r.kind.as_str(), r.related.as_deref(), r.many)).collect();
    assert_eq!(
        relations,
        [
            ("author", "BelongsTo", Some("App\\Models\\User"), false),
            ("comments", "HasMany", Some("App\\Models\\Comment"), true),
            ("tags", "BelongsToMany", Some("App\\Models\\Tag"), true),
        ]
    );
    let comments = view.relations[1].location.as_ref().unwrap();
    assert_eq!(project.describe(&comments.path, comments.range).2, "comments");
    let scopes: Vec<(&str, &str)> = view.scopes.iter().map(|s| (s.name.as_str(), s.method.as_str())).collect();
    assert_eq!(scopes, [("published", "scopePublished")]);
    let accessors: Vec<(&str, &str, Option<&str>)> =
        view.accessors.iter().map(|a| (a.name.as_str(), a.method.as_str(), a.ty.as_deref())).collect();
    assert_eq!(accessors, [("excerpt", "excerpt", Some("string"))]);
    let excerpt = view.accessors[0].location.as_ref().unwrap();
    assert_eq!(project.describe(&excerpt.path, excerpt.range).2, "excerpt");

    // Related classes by convention, and the migrations of the table.
    let related: Vec<(RelatedKind, &str, String)> = view
        .related
        .iter()
        .map(|r| (r.kind, r.name.as_str(), project.describe(&r.location.path, r.location.range).0))
        .collect();
    assert_eq!(
        related,
        [
            (RelatedKind::Factory, "Database\\Factories\\PostFactory", "database/factories/PostFactory.php".to_owned()),
            (
                RelatedKind::Resource,
                "App\\Http\\Resources\\PostResource",
                "app/Http/Resources/PostResource.php".to_owned()
            ),
            (RelatedKind::Policy, "App\\Policies\\PostPolicy", "app/Policies/PostPolicy.php".to_owned()),
            (RelatedKind::Observer, "App\\Observers\\PostObserver", "app/Observers/PostObserver.php".to_owned()),
            (
                RelatedKind::Migration,
                "2024_05_01_100000_create_posts_table",
                "database/migrations/2024_05_01_100000_create_posts_table.php".to_owned()
            ),
            // It adds a column to `posts` too.
            (
                RelatedKind::Migration,
                "2024_05_02_100000_create_comments_table",
                "database/migrations/2024_05_02_100000_create_comments_table.php".to_owned()
            ),
        ]
    );

    // Not a model.
    assert!(project.engine.laravel_model_view("App\\Policies\\PostPolicy").is_none());
    assert!(project.engine.laravel_model_view("Illuminate\\Database\\Eloquent\\Model").is_none());
    assert!(project.engine.laravel_model_view("App\\Nope").is_none());
}

#[test]
fn model_view_columns_come_from_the_database_when_it_has_them() {
    use crate::frameworks::laravel::{LiveColumn, LiveSchema, LiveTable};
    let project = Project::app();
    let live = |name: &str, data_type: &str, nullable: bool| LiveColumn {
        name: name.to_owned(),
        data_type: data_type.to_owned(),
        nullable,
    };
    project.engine.set_live_schema(Some(LiveSchema {
        source: "app".to_owned(),
        tables: vec![LiveTable {
            name: "posts".to_owned(),
            columns: vec![live("title", "varchar(255)", true), live("views", "integer", false)],
        }],
    }));
    let view = project.engine.laravel_model_view(POST_CLASS).unwrap();
    let column = |name: &str| view.columns.iter().find(|c| c.name == name).unwrap();
    let views = column("views");
    assert_eq!(
        (views.source, views.database.as_deref(), views.ty.as_str()),
        (ColumnSource::Database, Some("app"), "int")
    );
    assert!(views.location.is_none());
    let title = column("title");
    assert_eq!((title.source, title.nullable), (ColumnSource::Database, true));
    // The migration making it is still where it goes.
    assert!(title.location.is_some());
    assert_eq!(column("body").source, ColumnSource::Migration);
}

#[test]
fn model_classes_get_a_lens() {
    let mut project = Project::app();
    let path = project.root.join("app/Models/Post.php");
    let source = std::fs::read_to_string(&path).unwrap();
    let (doc, _) = project.open("app/Models/Post.php", &format!("{source}/*|*/"));
    let lenses = project.engine.laravel_model_lenses(doc).unwrap();
    assert_eq!(lenses.len(), 1, "{lenses:?}");
    assert_eq!(lenses[0].class, POST_CLASS);
    assert_eq!(project.describe(&path, lenses[0].range).2, "Post");
    assert!(lenses[0].title.starts_with("posts · "), "{}", lenses[0].title);
    assert!(lenses[0].title.ends_with(" · 3 relations"), "{}", lenses[0].title);
    project.engine.document_closed(doc);

    // Not on other classes.
    let policy = std::fs::read_to_string(project.root.join("app/Policies/PostPolicy.php")).unwrap();
    let (doc, _) = project.open("app/Policies/PostPolicy.php", &format!("{policy}/*|*/"));
    assert_eq!(project.engine.laravel_model_lenses(doc), Some(Vec::new()));
}

#[test]
fn add_columns_writes_a_migration_and_fills_fillable() {
    let mut project = Project::app();
    let columns = [new_column("subtitle", "string", true), new_column("editor_id", "foreignId", false)];
    let edit = project.engine.laravel_add_columns(POST_CLASS, &columns, true, "2024_06_01_120000").unwrap();
    let migration = "database/migrations/2024_06_01_120000_add_subtitle_and_editor_id_to_posts_table.php";
    let created: Vec<String> = edit
        .files
        .iter()
        .filter_map(|file| match file {
            FileEdit::Create { path, .. } => Some(project.relative(path.as_ref())),
            _ => None,
        })
        .collect();
    assert_eq!(created, [migration]);
    let source = edit
        .files
        .iter()
        .find_map(|file| match file {
            FileEdit::Edit { path, edits, .. } if project.relative(path.as_ref()) == migration => {
                Some(edits[0].new_text.clone())
            }
            _ => None,
        })
        .unwrap();
    assert!(source.contains("Schema::table('posts', function (Blueprint $table) {"), "{source}");
    assert!(source.contains("$table->string('subtitle')->nullable();"), "{source}");
    assert!(source.contains("$table->foreignId('editor_id')->constrained();"), "{source}");
    let post = edited(&project, &edit, "app/Models/Post.php");
    assert!(
        post.contains(
            "protected $fillable = ['title', 'slug', 'body', 'status', 'published_at', 'subtitle', 'editor_id'];"
        ),
        "{post}"
    );

    // Without $fillable: only the migration.
    let edit = project.engine.laravel_add_columns(POST_CLASS, &columns[..1], false, "2024_06_01_120000").unwrap();
    assert_eq!(edit.files.len(), 2, "{edit:?}");

    // Existing, repeated and invalid names.
    let error = |columns: &[NewColumn]| project.engine.laravel_add_columns(POST_CLASS, columns, true, "x").unwrap_err();
    assert!(error(&[new_column("title", "string", false)]).contains("has a column 'title' already"));
    assert!(error(&[new_column("a", "string", false), new_column("A", "string", false)]).contains("'A'"));
    assert!(error(&[new_column("a b", "string", false)]).contains("not a valid column name"));
    assert!(error(&[new_column("a", "string('x')", false)]).contains("not a column type"));
    assert!(error(&[]).contains("at least one column"));
    assert!(project.engine.laravel_add_columns("App\\Policies\\PostPolicy", &columns, true, "x").is_err());

    // A model without $fillable or $guarded gets one.
    let draft = "<?php\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Draft extends Model\n{\n    public function title(): string\n    {\n        return '';\n    }\n}\n/*|*/";
    let (doc, _) = project.open("app/Models/Draft.php", draft);
    let edit = project
        .engine
        .laravel_add_columns("App\\Models\\Draft", &[new_column("note", "text", false)], true, "2024_06_01_120000")
        .unwrap();
    let text = edited(&project, &edit, "app/Models/Draft.php");
    assert!(
        text.contains(
            "class Draft extends Model\n{\n    protected $fillable = ['note'];\n\n    public function title()"
        ),
        "{text}"
    );
    project.engine.document_closed(doc);

    // A model with $guarded keeps it.
    let guarded = "<?php\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Note extends Model\n{\n    protected $guarded = [];\n}\n/*|*/";
    let (doc, _) = project.open("app/Models/Note.php", guarded);
    let edit = project
        .engine
        .laravel_add_columns("App\\Models\\Note", &[new_column("body", "text", false)], true, "2024_06_01_120000")
        .unwrap();
    assert_eq!(edit.files.len(), 2, "{edit:?}");
    project.engine.document_closed(doc);
}
