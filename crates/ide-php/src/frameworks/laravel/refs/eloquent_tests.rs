//! Eloquent columns (`eloquentField`) and relations (`eloquentRelation`),
//! the types of relation closures, collections, factories and `*_count`
//! properties, and the unknown-column inspection, on the fixture app
//! (`fixtures/laravel-app` with `fixtures/laravel-stubs` as its `vendor/`).

use super::*;

const PROBE: &str = "app/Http/Controllers/Probe.php";
const POST: &str = "app/Models/Post.php";
const POSTS_MIGRATION: &str = "database/migrations/2024_05_01_100000_create_posts_table.php";

/// A controller of the app with `body` as the body of its `run` method.
fn controller(body: &str) -> String {
    format!(
        "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Comment;\nuse App\\Models\\Post;\nuse App\\Models\\User;\n\nclass Probe extends Controller\n{{\n    public function run(User $user, Post $post): void\n    {{\n        {body}\n    }}\n}}\n"
    )
}

impl Project {
    fn eloquent_kind_at(&mut self, body: &str) -> Option<&'static str> {
        let (doc, pos) = self.open(PROBE, &controller(body));
        let parsed = self.engine.parsed_document(doc).unwrap();
        let resolver = self.engine.resolver();
        let offset = parsed.line_index().byte(pos);
        let kind = site_at(&parsed, &resolver, offset).and_then(|site| kind_of(&site, &resolver)).map(|kind| kind.id());
        self.engine.document_closed(doc);
        kind
    }

    fn eloquent_labels(&mut self, rel: &str, source: &str) -> Vec<(String, Option<String>)> {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        found.items.into_iter().map(|item| (item.label, item.detail)).collect()
    }

    fn eloquent_goto(&mut self, source: &str) -> Vec<(String, u32, String)> {
        let (doc, pos) = self.open(PROBE, source);
        let found = self.engine.definition(doc, pos).unwrap_or_default();
        let out = found.iter().map(|target| self.describe(&target.path, target.range)).collect();
        self.engine.document_closed(doc);
        out
    }

    fn eloquent_hover(&mut self, rel: &str, source: &str) -> String {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.hover(doc, pos).map(|hover| hover.markdown).unwrap_or_default();
        self.engine.document_closed(doc);
        found
    }

    fn eloquent_type(&mut self, body: &str) -> String {
        let (doc, pos) = self.open(PROBE, &controller(body));
        let found = self.engine.type_at(doc, pos).map(|ty| ty.to_string()).unwrap_or_default();
        self.engine.document_closed(doc);
        found
    }

    /// The unknown-column problems of `source`: `(line, message)`.
    fn column_problems(&mut self, rel: &str, source: &str) -> Vec<(u32, String)> {
        let (doc, _) = self.open(rel, &format!("{source}/*|*/"));
        let inspected = self.engine.inspect(doc, &CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        inspected
            .diagnostics
            .iter()
            .filter(|d| d.code.as_deref() == Some("PhpUnknownEloquentColumn"))
            .map(|d| (d.range.start.line, d.message.clone()))
            .collect()
    }
}

fn names(found: &[(String, Option<String>)]) -> Vec<&str> {
    found.iter().map(|(label, _)| label.as_str()).collect()
}

/// The Post model's source with `members` added to the class.
fn post_with(project: &Project, members: &str) -> String {
    let source = std::fs::read_to_string(project.root.join(POST)).unwrap();
    source.replace("    protected $casts = [", &format!("    {members}\n\n    protected $casts = ["))
}

#[test]
fn place_patterns_match_columns_and_relations() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("Post::where('/*|*/title', 'x');", Some("eloquentField")),
        ("Post::where('title', '/*|*/x');", None),
        ("Post::query()->orderBy('ti/*|*/');", Some("eloquentField")),
        ("$user->posts()->where('/*|*/');", Some("eloquentField")),
        ("Post::select('id', '/*|*/title');", Some("eloquentField")),
        ("Post::select(['id', '/*|*/title']);", Some("eloquentField")),
        ("Post::query()->pluck('title', '/*|*/id');", Some("eloquentField")),
        ("Post::create(['/*|*/title' => 'x']);", Some("eloquentField")),
        ("Post::create(['title' => '/*|*/x']);", None),
        ("$post->update(['/*|*/title' => 'x']);", Some("eloquentField")),
        ("Post::firstOrCreate(['slug' => 'a'], ['/*|*/title' => 'x']);", Some("eloquentField")),
        ("Post::where(['/*|*/slug' => 'a']);", Some("eloquentField")),
        ("Post::with('/*|*/comments');", Some("eloquentRelation")),
        ("Post::with('comments', '/*|*/tags');", Some("eloquentRelation")),
        ("Post::with(['/*|*/comments' => fn ($q) => $q]);", Some("eloquentRelation")),
        ("Post::with(['comments', '/*|*/tags']);", Some("eloquentRelation")),
        ("$post->load('/*|*/tags');", Some("eloquentRelation")),
        ("Post::whereHas('/*|*/comments', fn ($q) => $q);", Some("eloquentRelation")),
        ("Post::withCount('/*|*/comments');", Some("eloquentRelation")),
        // Not about a model.
        ("collect([])->where('/*|*/title');", None),
        // Partial strings while typing.
        ("Post::where('ti/*|*/\n", Some("eloquentField")),
    ];
    for (body, expected) in table {
        assert_eq!(project.eloquent_kind_at(body), *expected, "{body}");
    }
}

#[test]
fn completes_columns_of_the_query_model() {
    let mut project = Project::app();
    let found = project.eloquent_labels(PROBE, &controller("Post::where('/*|*/');"));
    let labels = names(&found);
    for column in ["title", "slug", "body", "status", "published_at", "options", "author_id", "deleted_at"] {
        assert!(labels.contains(&column), "{column}: {labels:?}");
    }
    // Relations and accessors aren't columns.
    assert!(!labels.contains(&"author") && !labels.contains(&"excerpt"), "{labels:?}");
    let detail = |name: &str| found.iter().find(|(label, _)| label == name).and_then(|(_, detail)| detail.clone());
    assert_eq!(detail("title").as_deref(), Some("string"));

    // Through a builder, a relation and a relation closure.
    let labels = project.eloquent_labels(PROBE, &controller("Post::query()->orderBy('sl/*|*/');"));
    assert_eq!(names(&labels), ["slug"]);
    let labels = project.eloquent_labels(PROBE, &controller("$user->posts()->where('publ/*|*/');"));
    assert_eq!(names(&labels), ["published_at"]);
    let found =
        project.eloquent_labels(PROBE, &controller("Post::whereHas('comments', fn ($q) => $q->where('/*|*/'));"));
    let labels = names(&found);
    assert!(labels.contains(&"user_id") && labels.contains(&"post_id"), "{labels:?}");
    assert!(!labels.contains(&"title"), "{labels:?}");

    // Attribute arrays, and a column of another table.
    let labels = project.eloquent_labels(PROBE, &controller("$post->update(['ti/*|*/' => 'x']);"));
    assert_eq!(names(&labels), ["title"]);
    let labels = project.eloquent_labels(PROBE, &controller("Post::where('users.ema/*|*/');"));
    assert_eq!(names(&labels), ["email", "email_verified_at"]);
}

#[test]
fn completes_columns_and_accessors_in_model_properties() {
    let mut project = Project::app();
    let source = post_with(&project, "protected $hidden = ['bo/*|*/'];");
    assert_eq!(names(&project.eloquent_labels(POST, &source)), ["body"]);
    let source = post_with(&project, "protected $appends = ['/*|*/'];");
    assert_eq!(names(&project.eloquent_labels(POST, &source)), ["excerpt"]);
    // `$fillable` and the keys of `casts()`.
    let source =
        std::fs::read_to_string(project.root.join(POST)).unwrap().replace("'slug', 'body'", "'slug', 'bo/*|*/'");
    assert_eq!(names(&project.eloquent_labels(POST, &source)), ["body"]);
    let user = std::fs::read_to_string(project.root.join("app/Models/User.php"))
        .unwrap()
        .replace("'is_admin' => 'boolean'", "'is_ad/*|*/' => 'boolean'");
    assert_eq!(names(&project.eloquent_labels("app/Models/User.php", &user)), ["is_admin"]);
}

#[test]
fn completes_nested_relations() {
    let mut project = Project::app();
    let found = project.eloquent_labels(PROBE, &controller("Post::with('/*|*/');"));
    assert_eq!(names(&found), ["author", "comments", "tags"]);
    let detail = |name: &str| found.iter().find(|(label, _)| label == name).and_then(|(_, detail)| detail.clone());
    assert_eq!(detail("comments").as_deref(), Some("Comment[]"));
    assert_eq!(detail("author").as_deref(), Some("User"));

    let found = project.eloquent_labels(PROBE, &controller("Post::with('comments./*|*/');"));
    assert_eq!(names(&found), ["post", "user"]);
    let found = project.eloquent_labels(PROBE, &controller("$user->load('posts.comments.u/*|*/');"));
    assert_eq!(names(&found), ["user"]);
    let found = project.eloquent_labels(PROBE, &controller("Post::whereHas('ta/*|*/', fn ($q) => $q);"));
    assert_eq!(names(&found), ["tags"]);
    // A collection of models loads relations too.
    let found = project.eloquent_labels(PROBE, &controller("Post::all()->load('auth/*|*/');"));
    assert_eq!(names(&found), ["author"]);
}

#[test]
fn goes_to_columns_and_relations() {
    let mut project = Project::app();
    let found = project.eloquent_goto(&controller("Post::where('ti/*|*/tle', 'x');"));
    assert_eq!(found, [(POSTS_MIGRATION.to_owned(), 13, "'title'".to_owned())]);
    let found = project.eloquent_goto(&controller("Comment::query()->orderBy('bo/*|*/dy');"));
    assert_eq!(
        found,
        [("database/migrations/2024_05_02_100000_create_comments_table.php".to_owned(), 14, "'body'".to_owned())]
    );
    // The segment at the caret.
    let found = project.eloquent_goto(&controller("Post::with('comments.us/*|*/er');"));
    assert_eq!(found, [("app/Models/Comment.php".to_owned(), 16, "user".to_owned())]);
    let found = project.eloquent_goto(&controller("Post::with('comm/*|*/ents.user');"));
    assert_eq!(found, [(POST.to_owned(), 34, "comments".to_owned())]);

    let hover = project.eloquent_hover(PROBE, &controller("Post::where('ti/*|*/tle', 'x');"));
    assert!(hover.contains("Column `title` of table `posts`"), "{hover}");
}

#[test]
fn types_relation_closures_collections_and_factories() {
    let mut project = Project::app();
    let builder = |model: &str| format!("Illuminate\\Database\\Eloquent\\Builder<App\\Models\\{model}>");
    let collection = |model: &str| format!("Illuminate\\Database\\Eloquent\\Collection<int, App\\Models\\{model}>");
    let factory = "Database\\Factories\\PostFactory<App\\Models\\Post>";
    let cases: Vec<(&str, String)> = vec![
        ("Post::whereHas('comments', fn ($q) => $q/*|*/);", builder("Comment")),
        ("Post::whereHas('comments', function ($q) { $q/*|*/; });", builder("Comment")),
        ("Post::with(['comments.user' => fn ($q) => $q/*|*/]);", builder("User")),
        ("$user->posts()->whereHas('tags', fn ($q) => $q/*|*/);", builder("Tag")),
        ("Post::all()/*|*/;", collection("Post")),
        ("$user->posts()->get()/*|*/;", collection("Post")),
        ("Post::where('status', 'draft')->get()/*|*/;", collection("Post")),
        ("Post::factory()/*|*/;", factory.to_owned()),
        ("Post::factory()->create()/*|*/;", "App\\Models\\Post".to_owned()),
        ("Post::factory()->published()->make()/*|*/;", "App\\Models\\Post".to_owned()),
        ("Post::factory()->count(3)->create()/*|*/;", collection("Post")),
        ("Post::factory(3)->make()/*|*/;", collection("Post")),
        ("Post::factory()->count(2)->state([])->create()/*|*/;", collection("Post")),
        ("Post::factory()->createOne()/*|*/;", "App\\Models\\Post".to_owned()),
        ("$post->tags_count/*|*/;", "int".to_owned()),
        ("$user->posts_count/*|*/;", "int".to_owned()),
        // A column of that name wins (and is an int too).
        ("$post->comments_count/*|*/;", "int".to_owned()),
    ];
    for (body, expected) in cases {
        assert_eq!(project.eloquent_type(body), expected, "{body}");
    }
    // `withCount` loads `*_count` properties: listed with the attributes.
    let found = project.eloquent_labels(PROBE, &controller("$post->tags_c/*|*/"));
    assert_eq!(names(&found), ["tags_count"]);
    let hover = project.eloquent_hover(PROBE, &controller("$post->tags_c/*|*/ount;"));
    assert!(hover.contains("withCount('tags')"), "{hover}");
}

#[test]
fn reports_unknown_columns_when_the_schema_is_certain() {
    let mut project = Project::app();
    let found = project.column_problems(
        PROBE,
        &controller(
            "Post::where('titel', 'x');\n        Post::query()->orderBy('title')->where('posts.slug', 'a')->where('options->theme', 'dark');\n        Post::select('title as heading')->where('comments_count', '>', 1)->where('tags_count', 2);\n        $post->update(['excerpt' => 'x', 'nope' => 1]);\n        Comment::where('users.anything', 1);",
        ),
    );
    assert_eq!(
        found,
        [
            (11, "Unknown column 'titel' of model 'Post' (table 'posts')".to_owned()),
            (14, "Unknown column 'nope' of model 'Post' (table 'posts')".to_owned()),
        ]
    );
    // In the model's lists.
    let source = post_with(
        &project,
        "protected $hidden = ['body', 'secret'];\n    protected $appends = ['excerpt', 'summary'];",
    );
    let found = project.column_problems(POST, &source);
    let messages: Vec<&str> = found.iter().map(|(_, message)| message.as_str()).collect();
    assert_eq!(
        messages,
        [
            "Unknown column 'secret' of model 'Post' (table 'posts')",
            "Unknown accessor 'summary' of model 'Post' (table 'posts')"
        ]
    );
    // A table no migration creates: nothing is certain.
    let draft = "<?php\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Draft extends Model\n{\n    public function run(): void\n    {\n        self::where('anything', 1);\n    }\n}\n";
    assert_eq!(project.column_problems("app/Models/Draft.php", draft), []);
}
