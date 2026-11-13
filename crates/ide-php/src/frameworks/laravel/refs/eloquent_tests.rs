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
        self.type_in(PROBE, &controller(body))
    }

    fn type_in(&mut self, rel: &str, source: &str) -> String {
        let (doc, pos) = self.open(rel, source);
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
        // An unknown relation: the callback's `Builder<TRelatedModel>` with
        // the template's bound.
        (
            "Post::query()->whereHas('nothing', fn ($q) => $q/*|*/);",
            "Illuminate\\Database\\Eloquent\\Builder<Illuminate\\Database\\Eloquent\\Model>".to_owned(),
        ),
        // The same through `Model::__callStatic`, which no signature of
        // the model binds: the builder's `whereHas` is used.
        (
            "Post::whereHas('nothing', fn ($q) => $q/*|*/);",
            "Illuminate\\Database\\Eloquent\\Builder<Illuminate\\Database\\Eloquent\\Model>".to_owned(),
        ),
        (
            "Post::whereHas('nothing', function ($q) { $q/*|*/; });",
            "Illuminate\\Database\\Eloquent\\Builder<Illuminate\\Database\\Eloquent\\Model>".to_owned(),
        ),
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
        // `*_count` after a `withCount` of the relation, on the models
        // that query loads.
        (
            "foreach (Post::withCount('tags')->get() as $p) {\n            $p->tags_count/*|*/;\n        }",
            "int".to_owned(),
        ),
        ("$u = User::query()->withCount(['posts'])->first();\n        $u->posts_count/*|*/;", "int".to_owned()),
        ("Post::withCount('comments as replies')->first()->replies/*|*/;", "int".to_owned()),
        // A column of that name wins (and is an int too).
        ("$post->comments_count/*|*/;", "int".to_owned()),
    ];
    for (body, expected) in cases {
        assert_eq!(project.eloquent_type(body), expected, "{body}");
    }
    // `withCount` loads `*_count` properties: listed with the attributes.
    let found = project.eloquent_labels(PROBE, &controller("Post::withCount('tags')->first()->tags_c/*|*/"));
    assert_eq!(names(&found), ["tags_count"]);
    let hover = project.eloquent_hover(PROBE, &controller("Post::withCount('tags')->first()->tags_c/*|*/ount;"));
    assert!(hover.contains("withCount('tags')"), "{hover}");
}

#[test]
fn counts_only_after_a_matching_with_count() {
    let mut project = Project::app();
    // No `withCount('tags')` anywhere: no `tags_count`.
    assert_eq!(project.eloquent_type("$post->tags_count/*|*/;"), "mixed");
    assert!(project.eloquent_labels(PROBE, &controller("$post->tags_c/*|*/")).is_empty());
    // Counting another relation doesn't count this one.
    assert_eq!(project.eloquent_type("Post::withCount('comments')->first()->tags_count/*|*/;"), "mixed");
    // Another query's `withCount` doesn't count this model's.
    assert_eq!(project.eloquent_type("Post::withCount('tags')->get();\n        $post->tags_count/*|*/;"), "mixed");
    let other = "$counted = Post::withCount('tags')->get();\n        $plain = Post::query()->get();\n        ";
    assert_eq!(project.eloquent_type(&format!("{other}$plain->first()->tags_count/*|*/;")), "mixed");
    assert_eq!(project.eloquent_type(&format!("{other}$counted->first()->tags_count/*|*/;")), "int");
    // The type says what was counted.
    assert_eq!(
        project.eloquent_type("Post::withCount('tags', 'comments as replies')->first()/*|*/;"),
        "App\\Models\\Post<object{tags_count: int, replies: int}>|null"
    );
    // Through a relation, scopes and fluent calls, and `$this`-returning
    // model methods.
    let cases = [
        "$user->posts()->withCount('tags')->get()->first()->tags_count/*|*/;",
        "Post::withCount('tags')->where('status', 'draft')->latest()->first()->tags_count/*|*/;",
        "Post::query()->withCount('tags')->first()->load('author')->tags_count/*|*/;",
        "Post::withCount(['tags' => fn ($q) => $q])->first()->tags_count/*|*/;",
    ];
    for body in cases {
        assert_eq!(project.eloquent_type(body), "int", "{body}");
    }
    // `loadCount` on a model, also as a statement (from there on), and on
    // a collection.
    assert_eq!(project.eloquent_type("$post->loadCount('tags')->tags_count/*|*/;"), "int");
    assert_eq!(
        project.eloquent_type("$post->tags_count;\n        $post->loadCount('tags');\n        $post->tags_count/*|*/;"),
        "int"
    );
    assert_eq!(project.eloquent_type("$post->tags_count/*|*/;\n        $post->loadCount('tags');"), "mixed");
    assert_eq!(project.eloquent_type("Post::all()->loadCount('tags')->first()->tags_count/*|*/;"), "int");
    // A model's `$withCount` counts on every query.
    let source = post_with(&project, "protected $withCount = ['author'];/*|*/");
    let (post_doc, _) = project.open(POST, &source);
    assert_eq!(project.eloquent_type("$post->author_count/*|*/;"), "int");
    assert_eq!(project.eloquent_type("$user->author_count/*|*/;"), "mixed");
    project.engine.document_closed(post_doc);
    // The inspection doesn't know every `withCount` (scopes, packages):
    // the count of any relation is fine there.
    assert!(project.column_problems(PROBE, &controller("Post::where('tags_count', 1);")).is_empty());
}

#[test]
fn model_lists_accept_translated_attributes_and_methods() {
    let mut project = Project::app();
    let source = post_with(
        &project,
        "public $translatedAttributes = ['headline'];\n    protected $guarded = ['headline', 'author', 'word_total', 'missing'];\n\n    public function wordTotal(): int\n    {\n        return 0;\n    }",
    );
    let found = project.column_problems(POST, &source);
    let messages: Vec<&str> = found.iter().map(|(_, message)| message.as_str()).collect();
    assert_eq!(messages, ["Unknown column 'missing' of model 'Post' (table 'posts')"]);
    // A translated attribute is fine in queries too; a method name isn't.
    let (doc, _) = project.open(POST, &format!("{source}/*|*/"));
    let found = project.column_problems(PROBE, &controller("Post::where('headline', 1)->where('word_total', 2);"));
    assert_eq!(found, [(11, "Unknown column 'word_total' of model 'Post' (table 'posts')".to_owned())]);
    project.engine.document_closed(doc);
}

#[test]
fn related_columns_in_where_relation_and_aggregates() {
    let mut project = Project::app();
    for body in ["Post::whereRelation('comments', '/*|*/body', 'x');", "Post::withSum('comments', '/*|*/user_id');"] {
        assert_eq!(project.eloquent_kind_at(body), Some("eloquentField"), "{body}");
    }
    let found = project.eloquent_labels(PROBE, &controller("Post::whereRelation('comments', '/*|*/');"));
    let labels = names(&found);
    assert!(labels.contains(&"body") && labels.contains(&"user_id"), "{labels:?}");
    assert!(!labels.contains(&"title"), "{labels:?}");
    let found = project.eloquent_labels(PROBE, &controller("$user->posts()->withAvg('comments', 'po/*|*/');"));
    assert_eq!(names(&found), ["post_id"]);
    // Nested relations, and an alias of the aggregate.
    let found = project.eloquent_labels(PROBE, &controller("User::whereRelation('posts.comments', 'bo/*|*/');"));
    assert_eq!(names(&found), ["body"]);
    let found = project.eloquent_labels(PROBE, &controller("Post::withMax('comments as latest', 'cre/*|*/');"));
    assert_eq!(names(&found), ["created_at"]);

    let found = project.eloquent_goto(&controller("Post::whereRelation('comments', 'bo/*|*/dy', 'x');"));
    assert_eq!(
        found,
        [("database/migrations/2024_05_02_100000_create_comments_table.php".to_owned(), 14, "'body'".to_owned())]
    );
    let found = project.column_problems(
        PROBE,
        &controller("Post::whereRelation('comments', 'titel', 'x');\n        Post::withSum('comments', 'user_id');"),
    );
    assert_eq!(found, [(11, "Unknown column 'titel' of model 'Comment' (table 'comments')".to_owned())]);
}

#[test]
fn scope_builders_are_the_models() {
    let mut project = Project::app();
    let scope = |project: &Project, body: &str| {
        post_with(
            project,
            &format!("public function scopeDrafts(Builder $query): Builder\n    {{\n        {body}\n    }}"),
        )
    };
    let source = scope(&project, "return $query/*|*/;");
    assert_eq!(project.type_in(POST, &source), "Illuminate\\Database\\Eloquent\\Builder<App\\Models\\Post>");
    let source = scope(&project, "return $query->where('sl/*|*/');");
    assert_eq!(names(&project.eloquent_labels(POST, &source)), ["slug"]);
    let source = scope(&project, "return $query->where('titel', 1);");
    assert_eq!(
        project.column_problems(POST, &source),
        [(25, "Unknown column 'titel' of model 'Post' (table 'posts')".to_owned())]
    );
    // Its scopes complete on it.
    let source = scope(&project, "return $query->publ/*|*/;");
    assert!(names(&project.eloquent_labels(POST, &source)).contains(&"published"));
    // An untyped query parameter, of a scope by name or by attribute.
    let source = post_with(&project, "public function scopeDrafts($query)\n    {\n        return $query/*|*/;\n    }");
    assert_eq!(project.type_in(POST, &source), "Illuminate\\Database\\Eloquent\\Builder<App\\Models\\Post>");
    let source = post_with(
        &project,
        "#[\\Illuminate\\Database\\Eloquent\\Attributes\\Scope]\n    protected function drafts($query)\n    {\n        return $query/*|*/;\n    }",
    );
    assert_eq!(project.type_in(POST, &source), "Illuminate\\Database\\Eloquent\\Builder<App\\Models\\Post>");
    // Not a scope: a raw builder stays raw.
    let source = post_with(
        &project,
        "public function drafts(Builder $query): Builder\n    {\n        return $query/*|*/;\n    }",
    );
    assert_eq!(project.type_in(POST, &source), "Illuminate\\Database\\Eloquent\\Builder");
}

#[test]
fn typed_attribute_accessors_without_return_docs() {
    let mut project = Project::app();
    let source = post_with(
        &project,
        "protected function headline(): Attribute\n    {\n        return Attribute::make(get: fn (): string => strtoupper($this->title));\n    }\n\n    protected function wordCount(): Attribute\n    {\n        return Attribute::make(fn (): int => 1);\n    }\n\n    protected function untyped(): Attribute\n    {\n        return Attribute::make(get: fn () => 1);\n    }/*|*/",
    );
    let (post_doc, _) = project.open(POST, &source);
    assert_eq!(project.eloquent_type("$post->headline/*|*/;"), "string");
    assert_eq!(project.eloquent_type("$post->word_count/*|*/;"), "int");
    let found = project.eloquent_labels(PROBE, &controller("$post->head/*|*/"));
    assert_eq!(names(&found), ["headline"]);
    // The documented one still wins; an untyped getter isn't guessed.
    assert_eq!(project.eloquent_type("$post->excerpt/*|*/;"), "string");
    assert_eq!(project.eloquent_type("$post->untyped/*|*/;"), "mixed");
    project.engine.document_closed(post_doc);
}

/// A later migration renaming `body` to `content` and dropping `options`,
/// and a rollback that would undo it.
const CHANGE_POSTS: &str = "<?php\n\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;\n\nreturn new class extends Migration\n{\n    public function up(): void\n    {\n        Schema::table('posts', function (Blueprint $table) {\n            $table->renameColumn('body', 'content');\n            $table->dropColumn(['options', 'status']);\n        });\n    }\n\n    public function down(): void\n    {\n        Schema::table('posts', function (Blueprint $table) {\n            $table->renameColumn('content', 'body');\n            $table->dropColumn('slug');\n        });\n    }\n};\n/*|*/";

#[test]
fn later_migrations_drop_and_rename_columns() {
    let mut project = Project::app();
    let (doc, _) = project.open("database/migrations/2024_06_01_000000_change_posts_table.php", CHANGE_POSTS);
    let columns: Vec<String> = project
        .engine
        .resolver()
        .laravel()
        .columns("posts")
        .into_iter()
        .map(|(_, column)| column.name.clone())
        .collect();
    for gone in ["body", "options", "status"] {
        assert!(!columns.contains(&gone.to_owned()), "{gone}: {columns:?}");
    }
    for kept in ["title", "slug", "content", "comments_count"] {
        assert!(columns.contains(&kept.to_owned()), "{kept}: {columns:?}");
    }
    let labels = project.eloquent_labels(PROBE, &controller("Post::where('conte/*|*/');"));
    assert_eq!(names(&labels), ["content"]);
    let labels = project.eloquent_labels(PROBE, &controller("Post::where('bo/*|*/');"));
    assert!(names(&labels).is_empty(), "{labels:?}");
    assert_eq!(project.eloquent_type("$post->content/*|*/;"), "string");
    let found = project.eloquent_goto(&controller("Post::where('cont/*|*/ent', 'x');"));
    assert_eq!(
        found,
        [("database/migrations/2024_06_01_000000_change_posts_table.php".to_owned(), 11, "'content'".to_owned())]
    );
    let found = project.column_problems(PROBE, &controller("Post::where('body', 'x')->where('content', 'y');"));
    assert_eq!(found, [(11, "Unknown column 'body' of model 'Post' (table 'posts')".to_owned())]);
    project.engine.document_closed(doc);
}

#[test]
fn joins_and_table_aliases() {
    let mut project = Project::app();
    let db = r"\Illuminate\Support\Facades\DB";
    let table: &[(String, Option<&str>)] = &[
        (format!("{db}::table('posts')->join('/*|*/users', 'users.id', '=', 'posts.author_id');"), Some("dbTable")),
        (
            format!("{db}::table('posts')->join('users', '/*|*/users.id', '=', 'posts.author_id');"),
            Some("eloquentField"),
        ),
        (
            format!("{db}::table('posts')->join('users', 'users.id', '=', '/*|*/posts.author_id');"),
            Some("eloquentField"),
        ),
        ("Post::query()->leftJoin('/*|*/users', 'users.id', '=', 'posts.author_id');".to_owned(), Some("dbTable")),
    ];
    for (body, expected) in table {
        assert_eq!(project.eloquent_kind_at(body), *expected, "{body}");
    }
    // The joined table is remembered by the builder.
    assert_eq!(
        project
            .eloquent_type(&format!("{db}::table('posts')->join('users', 'users.id', '=', 'posts.author_id')/*|*/;")),
        r"Illuminate\Database\Query\Builder<string, string>"
    );
    // Unqualified columns from either table; a qualified one from its table.
    let join = format!("{db}::table('posts')->join('users', 'users.id', '=', 'posts.author_id')");
    let found = project.eloquent_labels(PROBE, &controller(&format!("{join}->where('ema/*|*/');")));
    assert_eq!(names(&found), ["email", "email_verified_at"]);
    let found = project.eloquent_labels(PROBE, &controller(&format!("{join}->where('sl/*|*/');")));
    assert_eq!(names(&found), ["slug"]);
    let found =
        project.eloquent_labels(PROBE, &controller(&format!("{db}::table('posts')->join('users', 'users.ema/*|*/');")));
    assert_eq!(names(&found), ["email", "email_verified_at"]);
    let found = project.eloquent_goto(&controller(&format!("{join}->where('ema/*|*/il', 'x');")));
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "database/migrations/0001_01_01_000000_create_users_table.php");

    // Aliases.
    let aliased = format!("{db}::table('posts as p')->join('users as u', 'u.id', '=', 'p.author_id')");
    let found = project.eloquent_labels(PROBE, &controller(&format!("{aliased}->where('u.ema/*|*/');")));
    assert_eq!(names(&found), ["email", "email_verified_at"]);
    let found = project.eloquent_labels(PROBE, &controller(&format!("{aliased}->orderBy('p.sl/*|*/');")));
    assert_eq!(names(&found), ["slug"]);
    let found = project.eloquent_labels(PROBE, &controller(&format!("{db}::table('pos/*|*/ts as p');")));
    assert!(names(&found).contains(&"posts"), "{found:?}");
    let hover = project.eloquent_hover(PROBE, &controller(&format!("{db}::table('pos/*|*/ts as p');")));
    assert!(hover.contains("Table `posts`"), "{hover}");

    // The inspection checks every table of the query.
    let found = project.column_problems(
        PROBE,
        &controller(&format!(
            "{join}->where('email', 1)->where('slug', 2)->where('nope', 3);\n        {aliased}->where('u.email', 1)->where('p.nope', 2);"
        )),
    );
    assert_eq!(
        found,
        [
            (11, "Unknown column 'nope' of tables 'posts', 'users'".to_owned()),
            (12, "Unknown column 'nope' of table 'posts'".to_owned()),
        ]
    );
    // Ordering and grouping may name an alias of the select list.
    let found = project.column_problems(
        PROBE,
        &controller("Post::select(\\DB::raw('year(published_at) as year'))->orderBy('year')->groupBy('year');"),
    );
    assert!(found.is_empty(), "{found:?}");
    // So may any call after the alias in the same chain; another name is
    // still checked.
    let found = project.column_problems(
        PROBE,
        &controller("Post::select(\\DB::raw('COUNT(*) AS total'))->where('totals', 1)->where('total', 1);"),
    );
    assert_eq!(found, [(11, "Unknown column 'totals' of model 'Post' (table 'posts')".to_owned())]);
    // A many-to-many relation's query joins its pivot table.
    let found =
        project.column_problems(PROBE, &controller("$post->tags()->where('tag_id', 1)->where('tags.nope', 2);"));
    assert_eq!(found, [(11, "Unknown column 'nope' of model 'Tag' (table 'tags')".to_owned())]);
    // A model's query: the joined table's columns are fine too.
    let found = project.column_problems(
        PROBE,
        &controller(
            "Post::query()->join('users', 'users.id', '=', 'posts.author_id')->where('email', 1)->where('nope', 2);",
        ),
    );
    assert_eq!(found, [(11, "Unknown column 'nope' of model 'Post' (table 'posts')".to_owned())]);
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

/// The live schema of data source `app`: `posts` with a column no
/// migration makes (`rating`) and `title` nullable, and a table no
/// migration creates (`audits`).
fn live_schema() -> crate::frameworks::laravel::LiveSchema {
    use crate::frameworks::laravel::{LiveColumn, LiveSchema, LiveTable};
    let column = |name: &str, data_type: &str, nullable: bool| LiveColumn {
        name: name.into(),
        data_type: data_type.into(),
        nullable,
    };
    LiveSchema {
        source: "app".into(),
        tables: vec![
            LiveTable {
                name: "posts".into(),
                columns: vec![
                    column("id", "INTEGER", false),
                    column("title", "TEXT", true),
                    column("rating", "REAL", true),
                ],
            },
            LiveTable {
                name: "audits".into(),
                columns: vec![column("id", "INTEGER", false), column("event", "varchar(40)", false)],
            },
        ],
    }
}

#[test]
fn a_live_schema_merges_with_the_migrations() {
    let mut project = Project::app();
    let before = project.engine.modification_count();
    project.engine.set_live_schema(Some(live_schema()));
    assert!(project.engine.modification_count() > before);

    // Columns only the database has are completed, the migrations' kept.
    let found = project.eloquent_labels(PROBE, &controller("Post::where('/*|*/');"));
    let labels = names(&found);
    for column in ["rating", "title", "slug", "published_at"] {
        assert!(labels.contains(&column), "{column}: {labels:?}");
    }
    let detail = |name: &str| found.iter().find(|(label, _)| label == name).and_then(|(_, detail)| detail.clone());
    assert_eq!(detail("rating").as_deref(), Some("?float"));

    // The database wins (`title` is nullable there) and is named in hover;
    // goto still opens the migration.
    let hover = project.eloquent_hover(PROBE, &controller("Post::where('ti/*|*/tle', 'x');"));
    assert!(hover.contains("(`string`, nullable), from the database `app`"), "{hover}");
    let hover = project.eloquent_hover(PROBE, &controller("Post::where('sl/*|*/ug', 'x');"));
    assert!(hover.contains("from a migration"), "{hover}");
    let found = project.eloquent_goto(&controller("Post::where('ti/*|*/tle', 'x');"));
    assert_eq!(found, [(POSTS_MIGRATION.to_owned(), 13, "'title'".to_owned())]);
    assert!(project.eloquent_type("$post->rating/*|*/;").contains("float"));
    let hover = project.eloquent_hover(PROBE, &controller("$post->rat/*|*/ing;"));
    assert!(hover.contains("from the database `app`"), "{hover}");
    assert!(project.column_problems(PROBE, &controller("Post::where('rating', 1);")).is_empty());

    // Validation rules see the database's tables and columns.
    let found = project.eloquent_labels(
        PROBE,
        &controller(r"\Illuminate\Support\Facades\Validator::make([], ['a' => 'exists:au/*|*/']);"),
    );
    assert_eq!(names(&found), ["audits"]);
    let found = project.eloquent_labels(
        PROBE,
        &controller(r"\Illuminate\Support\Facades\Validator::make([], ['a' => 'exists:audits,ev/*|*/']);"),
    );
    assert_eq!(names(&found), ["event"]);

    // Dropping the schema goes back to the migrations alone.
    project.engine.set_live_schema(None);
    let found = project.eloquent_labels(PROBE, &controller("Post::where('rat/*|*/');"));
    assert!(found.is_empty(), "{found:?}");
    let hover = project.eloquent_hover(PROBE, &controller("Post::where('ti/*|*/tle', 'x');"));
    assert!(hover.contains("(`string`), from a migration"), "{hover}");
}

#[test]
fn the_query_builder_knows_its_table() {
    let mut project = Project::app();
    project.engine.set_live_schema(Some(live_schema()));
    let db = r"\Illuminate\Support\Facades\DB";
    let table: &[(&str, Option<&str>)] = &[
        (r"\Illuminate\Support\Facades\DB::table('/*|*/posts');", Some("dbTable")),
        (r"\Illuminate\Support\Facades\DB::connection()->table('/*|*/posts');", Some("dbTable")),
        (r"\Illuminate\Support\Facades\DB::table('posts')->where('/*|*/title', 1);", Some("eloquentField")),
        (r"\Illuminate\Support\Facades\DB::table('posts')->insert(['/*|*/title' => 'x']);", Some("eloquentField")),
    ];
    for (body, expected) in table {
        assert_eq!(project.eloquent_kind_at(body), *expected, "{body}");
    }
    // The table is a literal type argument (shown widened).
    assert_eq!(
        project.eloquent_type(&format!("{db}::table('posts')->where('a', 1)/*|*/;")),
        r"Illuminate\Database\Query\Builder<string>"
    );

    // Table names from the migrations and the database.
    let found = project.eloquent_labels(PROBE, &controller(&format!("{db}::table('/*|*/');")));
    let labels = names(&found);
    for name in ["audits", "comments", "post_tag", "posts", "tags", "users"] {
        assert!(labels.contains(&name), "{name}: {labels:?}");
    }
    let detail = |name: &str| found.iter().find(|(label, _)| label == name).and_then(|(_, detail)| detail.clone());
    assert_eq!(detail("audits").as_deref(), Some("2 columns · database"));
    assert_eq!(detail("tags").as_deref(), Some("2 columns · migration"));
    let hover = project.eloquent_hover(PROBE, &controller(&format!("{db}::table('pos/*|*/ts');")));
    assert!(
        hover.contains("Table `posts`") && hover.contains("- `rating` `float`, nullable, from the database `app`"),
        "{hover}"
    );
    let found = project.eloquent_goto(&controller(&format!("{db}::table('ta/*|*/gs');")));
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, POSTS_MIGRATION);

    // The builder's columns.
    let found = project.eloquent_labels(PROBE, &controller(&format!("{db}::table('audits')->where('/*|*/');")));
    assert_eq!(names(&found), ["event", "id"]);
    let found = project.eloquent_labels(PROBE, &controller(&format!("{db}::table('posts')->orderBy('rat/*|*/');")));
    assert_eq!(names(&found), ["rating"]);
    let found = project.eloquent_goto(&controller(&format!("{db}::table('posts')->where('sl/*|*/ug', 1);")));
    assert_eq!(found, [(POSTS_MIGRATION.to_owned(), 14, "'slug'".to_owned())]);
    let hover = project.eloquent_hover(PROBE, &controller(&format!("{db}::table('audits')->where('ev/*|*/ent', 1);")));
    assert!(hover.contains("Column `event` of table `audits` (`string`), from the database `app`"), "{hover}");
    let found = project
        .column_problems(PROBE, &controller(&format!("{db}::table('audits')->where('evnt', 1)->where('event', 'x');")));
    assert_eq!(found, [(11, "Unknown column 'evnt' of table 'audits'".to_owned())]);
}
