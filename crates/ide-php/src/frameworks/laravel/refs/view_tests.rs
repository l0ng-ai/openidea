//! Views (`viewName`): the view table, and caret fixtures on the fixture
//! app (`fixtures/laravel-app` with `fixtures/laravel-stubs` as its
//! `vendor/`), in PHP files and Blade templates.

use super::*;
use crate::blade::BladeDocument;
use crate::frameworks::laravel::ViewTable;

impl Project {
    /// The kind of the string at the caret of `body`, a statement of a
    /// controller of the app.
    fn view_kind_at(&mut self, body: &str) -> Option<&'static str> {
        let source = format!(
            "<?php\n\nuse Illuminate\\Mail\\Mailable;\nuse Illuminate\\Mail\\Mailables\\Content;\nuse Illuminate\\Support\\Facades\\Route;\nuse Illuminate\\Support\\Facades\\View;\n\n{body}\n"
        );
        let (doc, pos) = self.open("app/Http/Probe.php", &source);
        let parsed = self.engine.parsed_document(doc).unwrap();
        let resolver = self.engine.resolver();
        let offset = parsed.line_index().byte(pos);
        let kind = site_at(&parsed, &resolver, offset).and_then(|site| kind_of(&site, &resolver)).map(|kind| kind.id());
        self.engine.document_closed(doc);
        kind
    }

    /// A Blade template of the app with the caret, held by the engine.
    fn blade(&mut self, rel: &str, source: &str) -> (DocId, PathBuf, String, Pos) {
        let (text, pos) = caret(source);
        let doc = DocId(self.next_doc);
        self.next_doc += 1;
        (doc, self.root.join(rel), text, pos)
    }

    /// `(relative path, line)` of usages.
    fn lines(&self, usages: &[Usage]) -> Vec<(String, u32)> {
        usages.iter().map(|usage| (self.describe(&usage.path, usage.range).0, usage.range.start.line)).collect()
    }
}

#[test]
fn view_table_of_the_fixture_app() {
    let project = Project::app();
    let views = project.engine.laravel_views().unwrap();
    let names: Vec<&str> = views.views().iter().map(|view| view.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "about",
            "billing::invoices.index",
            "components.alert",
            "components.badge",
            "layouts.app",
            "posts._card",
            "posts.create",
            "posts.index",
            "posts.show",
            "welcome",
        ]
    );
    let billing = views.get("billing::invoices.index").unwrap();
    assert!(billing.path.ends_with("Modules/Billing/resources/views/invoices/index.blade.php"), "{billing:?}");
    assert_eq!(views.get("posts/show").map(|view| view.name.as_str()), Some("posts.show"));
    assert_eq!(
        views.name_of(&project.root.join("resources/views/posts/_card.blade.php")).as_deref(),
        Some("posts._card")
    );
    let children: Vec<String> = views.children(None, Some("posts")).into_iter().map(|child| child.segment).collect();
    assert_eq!(children, ["_card", "create", "index", "show"]);
    let top = views.children(None, None);
    assert!(top.iter().any(|child| child.segment == "posts" && child.view.is_none()), "{top:?}");
    assert!(top.iter().any(|child| child.segment == "welcome" && child.view.is_some()), "{top:?}");
    assert_eq!(
        views.new_path("billing::invoices.show"),
        Some(project.root.join("Modules/Billing/resources/views/invoices/show.blade.php"))
    );
    assert_eq!(views.new_path("nope::x"), None);
    assert_eq!(views.new_path("a..b"), None);
}

const VIEW_PROVIDER: &str = r#"<?php
namespace App\Providers;

use Illuminate\Support\Facades\View;
use Illuminate\Support\ServiceProvider;

class ViewServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $this->loadViewsFrom(__DIR__ . '/../../packages/blog/views', 'blog');
        View::addNamespace('mail', resource_path('mail-views'));
        $this->loadViewsFrom($this->path(), 'unknown');
    }
}
"#;

#[test]
fn view_namespaces_registered_by_providers() {
    let project = Project::new(&[
        ("composer.json", COMPOSER),
        ("app/Providers/ViewServiceProvider.php", VIEW_PROVIDER),
        ("packages/blog/views/post.blade.php", "<p></p>"),
        ("packages/blog/views/partials/meta.php", "<p></p>"),
        ("resources/mail-views/welcome.blade.php", "<p></p>"),
        ("resources/views/home.blade.php", "<p></p>"),
        ("resources/views/home.php", "<p></p>"),
    ]);
    let views = project.engine.laravel_views().unwrap();
    let names: Vec<&str> = views.views().iter().map(|view| view.name.as_str()).collect();
    assert_eq!(names, ["blog::partials.meta", "blog::post", "home", "mail::welcome"]);
    // `.blade.php` wins.
    assert!(views.get("home").unwrap().path.ends_with("home.blade.php"));
    assert_eq!(views.namespaces().iter().map(|ns| ns.name.as_str()).collect::<Vec<_>>(), ["blog", "mail"]);
}

#[test]
fn place_patterns_match_view_strings() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("view('/*|*/posts.index');", Some("viewName")),
        ("view('posts.index', ['/*|*/a' => 1]);", None),
        ("view(view: 'po/*|*/');", Some("viewName")),
        ("view(data: 'po/*|*/');", None),
        ("View::make('/*|*/');", Some("viewName")),
        ("View::exists('/*|*/');", Some("viewName")),
        ("View::first(['a', '/*|*/']);", Some("viewName")),
        ("View::composer(['a', '/*|*/'], fn () => 1);", Some("viewName")),
        ("view()->make('/*|*/');", Some("viewName")),
        ("Route::view('/about', '/*|*/');", Some("viewName")),
        ("Route::view('/*|*/about', 'about');", None),
        ("response()->view('/*|*/');", Some("viewName")),
        ("(new Mailable())->markdown('/*|*/');", Some("viewName")),
        ("(new Mailable())->view('/*|*/');", Some("viewName")),
        ("new Content(markdown: '/*|*/');", Some("viewName")),
        ("new Content('/*|*/');", Some("viewName")),
        ("new Content(with: ['/*|*/' => 1]);", None),
        ("route('/*|*/');", Some("routeName")),
        // Partial strings while typing.
        ("view('posts./*|*/\n", Some("viewName")),
    ];
    for (body, expected) in table {
        assert_eq!(project.view_kind_at(body), *expected, "{body}");
    }
}

#[test]
fn completes_view_names_as_a_path_tree() {
    let mut project = Project::app();
    let names = project.complete_in("app/Http/Probe.php", "<?php\nview('/*|*/');\n");
    for name in ["about", "posts", "layouts", "components", "welcome", "billing::"] {
        assert!(names.contains(&name.to_owned()), "{name} in {names:?}");
    }
    assert!(!names.contains(&"index".to_owned()), "{names:?}");
    let names = project.complete_in("app/Http/Probe.php", "<?php\nview('posts./*|*/');\n");
    assert_eq!(names, ["_card", "create", "index", "show"]);
    let names = project.complete_in("app/Http/Probe.php", "<?php\nView::make('posts.sh/*|*/');\n");
    assert_eq!(names, ["show"]);
    let names = project.complete_in("app/Http/Probe.php", "<?php\nview('billing::/*|*/');\n");
    assert_eq!(names, ["invoices"]);
    let names = project.complete_in("app/Http/Probe.php", "<?php\nview('billing::invoices./*|*/');\n");
    assert_eq!(names, ["index"]);

    // In a template: `@include`, `@extends`, and `view()` in an echo.
    for source in ["@include('posts./*|*/')\n", "@extends('posts./*|*/')\n", "{{ view('posts./*|*/') }}\n"] {
        let (doc, path, text, pos) = project.blade("resources/views/probe.blade.php", source);
        let blade = BladeDocument { doc, path: &path, version: 1, text: &text };
        let found = project.engine.blade_completion(&blade, pos, None, &CancellationToken::new()).unwrap();
        let labels: Vec<&str> = found.items.iter().map(|item| item.label.as_str()).collect();
        assert_eq!(labels, ["_card", "create", "index", "show"], "{source}");
        // The range is the segment, in the template.
        assert_eq!(found.items[0].replace.start, Pos::new(0, pos.col));
        project.engine.document_closed(doc);
    }
}

#[test]
fn goto_view_files() {
    let mut project = Project::app();
    let view = |rel: &str| (rel.to_owned(), 0, String::new());
    assert_eq!(
        project.definition_in("app/Http/Probe.php", "<?php\nview('posts.sh/*|*/ow');\n"),
        [view("resources/views/posts/show.blade.php")]
    );
    assert_eq!(
        project.definition_in("app/Http/Probe.php", "<?php\nRoute::view('/x', 'billing::invoices/*|*/.index');\n"),
        [view("Modules/Billing/resources/views/invoices/index.blade.php")]
    );
    assert_eq!(project.definition_in("app/Http/Probe.php", "<?php\nview('posts.no/*|*/pe');\n"), []);
}

#[test]
fn finds_usages_of_views_in_php_files_and_templates() {
    let mut project = Project::app();
    let cancel = CancellationToken::new();
    let card = project.engine.laravel_view_usages("posts._card", &cancel).unwrap().unwrap();
    assert_eq!(
        project.lines(&card),
        [("resources/views/posts/index.blade.php".to_owned(), 6), ("resources/views/welcome.blade.php".to_owned(), 5)]
    );
    // The range is the name in the template.
    assert_eq!(project.describe(&card[0].path, card[0].range).2, "posts._card");
    let layout = project.engine.laravel_view_usages("layouts.app", &cancel).unwrap().unwrap();
    assert_eq!(layout.len(), 5, "{:?}", project.lines(&layout));
    assert_eq!(
        project.engine.laravel_view_name(&project.root.join("resources/views/layouts/app.blade.php")).as_deref(),
        Some("layouts.app")
    );

    // From a string in PHP: the view file is the declaration.
    let found = project.references("app/Http/Probe.php", "<?php\nview('posts.in/*|*/dex');\n");
    let found: Vec<(String, u32, UsageKind)> = found.into_iter().map(|usage| (usage.0, usage.1, usage.3)).collect();
    assert_eq!(
        found,
        [
            ("app/Http/Controllers/PostController.php".to_owned(), 16, UsageKind::String),
            ("app/Http/Probe.php".to_owned(), 1, UsageKind::String),
            ("resources/views/posts/index.blade.php".to_owned(), 0, UsageKind::Declaration),
        ]
    );
}

#[test]
fn renames_a_view_moving_its_file() {
    let mut project = Project::app();
    let source = "<?php\nreturn view('posts._ca/*|*/rd');\n";
    let (doc, pos) = project.open("app/Http/Probe.php", source);
    let range = project.engine.prepare_rename(doc, pos).unwrap().unwrap();
    assert_eq!(range, Range::new(Pos::new(1, 13), Pos::new(1, 24)));
    let edit = project.engine.rename(doc, pos, "posts.card", &CancellationToken::new()).unwrap().unwrap();
    let mut edits = Vec::new();
    let mut moved = Vec::new();
    for file in &edit.files {
        match file {
            FileEdit::Edit { path, edits: changes, .. } => {
                let path = PathBuf::from(path.clone());
                for change in changes {
                    assert_eq!(change.new_text, "posts.card");
                    edits.push(project.describe(&path, change.range));
                }
            }
            FileEdit::Rename { from, to } => moved.push((PathBuf::from(from.clone()), PathBuf::from(to.clone()))),
            other => panic!("{other:?}"),
        }
    }
    edits.sort();
    assert_eq!(
        edits,
        [
            ("app/Http/Probe.php".to_owned(), 1, "posts._card".to_owned()),
            ("resources/views/posts/index.blade.php".to_owned(), 6, "posts._card".to_owned()),
            ("resources/views/welcome.blade.php".to_owned(), 5, "posts._card".to_owned()),
        ]
    );
    let views = project.root.join("resources/views/posts");
    assert_eq!(moved, [(views.join("_card.blade.php"), views.join("card.blade.php"))]);
    // The rename moves the file last.
    assert!(matches!(edit.files.last(), Some(FileEdit::Rename { .. })));
    // Into a new folder; namespaces stay.
    let edit = project.engine.rename(doc, pos, "cards.post", &CancellationToken::new()).unwrap().unwrap();
    let moved: Vec<PathBuf> = edit
        .files
        .iter()
        .filter_map(|file| match file {
            FileEdit::Rename { to, .. } => Some(PathBuf::from(to.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(moved, [project.root.join("resources/views/cards/post.blade.php")]);
    assert!(project.engine.rename(doc, pos, "posts/../x", &CancellationToken::new()).unwrap().is_err());
    project.engine.document_closed(doc);
    let (doc, pos) = project.open("app/Http/Probe.php", "<?php\nview('billing::invoices.in/*|*/dex');\n");
    let range = project.engine.prepare_rename(doc, pos).unwrap().unwrap();
    assert_eq!(range, Range::new(Pos::new(1, 15), Pos::new(1, 29)));
    // An unknown view can't be renamed.
    let (doc, pos) = project.open("app/Http/Probe.php", "<?php\nview('posts.no/*|*/pe');\n");
    assert_eq!(project.engine.prepare_rename(doc, pos), Some(None));
}

#[test]
fn reports_undefined_views_with_a_create_fix() {
    let mut project = Project::app();
    let source = "<?php\nview('posts.index');\nview('posts.missing');\nview('pkg::x');\nview('billing::nope');\n$x = 'nope.other';\n";
    let (doc, _) = project.open("app/Http/Probe.php", &format!("{source}/*|*/"));
    let inspected = project.engine.inspect(doc, &CancellationToken::new()).unwrap();
    let found: Vec<(u32, String)> = inspected
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_deref() == Some("PhpUndefinedView"))
        .map(|diagnostic| (diagnostic.range.start.line, diagnostic.message.clone()))
        .collect();
    assert_eq!(
        found,
        [(2, "View 'posts.missing' is not defined".to_owned()), (4, "View 'billing::nope' is not defined".to_owned())]
    );
    let fixes = |line: u32| {
        let range = Range::new(Pos::new(line, 8), Pos::new(line, 8));
        project
            .engine
            .code_actions(doc, range, &[])
            .unwrap()
            .into_iter()
            .find(|action| action.title.starts_with("Create view"))
    };
    let create = fixes(2).expect("Create view");
    assert_eq!(create.title, "Create view 'posts.missing'");
    assert!(create.preferred);
    let [FileEdit::Create { path, overwrite: false }] = create.edit.files.as_slice() else { panic!("{create:?}") };
    assert_eq!(PathBuf::from(path.clone()), project.root.join("resources/views/posts/missing.blade.php"));
    let create = fixes(4).expect("Create view");
    let [FileEdit::Create { path, .. }] = create.edit.files.as_slice() else { panic!("{create:?}") };
    assert_eq!(PathBuf::from(path.clone()), project.root.join("Modules/Billing/resources/views/nope.blade.php"));
}

#[test]
fn completes_the_variables_passed_to_a_view_in_its_template() {
    let mut project = Project::app();
    // `compact()` in `PostController::show()`.
    let show = project.root.join("resources/views/posts/show.blade.php");
    let variables = project.engine.laravel_view_variables(&show);
    let names: Vec<&str> = variables.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, ["post", "published", "title"]);
    assert_eq!(variables[0].1, "App\\Models\\Post");
    // An array, from a controller and from `@include` in two templates.
    let welcome = project.engine.laravel_view_variables(&project.root.join("resources/views/welcome.blade.php"));
    assert_eq!(welcome.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["latest"]);
    let card = project.engine.laravel_view_variables(&project.root.join("resources/views/posts/_card.blade.php"));
    assert_eq!(card.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["post"]);

    // `->with()` chained on the call, and an open buffer.
    project.open(
        "app/Http/Probe.php",
        "<?php\nfunction probe() { return view('about', ['year' => 2024])->with('author', 'Ann'); }\n/*|*/",
    );
    let about = project.engine.laravel_view_variables(&project.root.join("resources/views/about.blade.php"));
    assert_eq!(*about, [("author".to_owned(), "string".to_owned()), ("year".to_owned(), "int".to_owned())]);

    // Completion and hover in the template.
    let (doc, path, text, pos) =
        project.blade("resources/views/posts/show.blade.php", "<h1>{{ $ti/*|*/ }}</h1>\n<p>{{ $post->tit }}</p>\n");
    let blade = BladeDocument { doc, path: &path, version: 1, text: &text };
    let found = project.engine.blade_completion(&blade, pos, None, &CancellationToken::new()).unwrap();
    assert!(found.items.iter().any(|item| item.label == "$title"), "{:?}", found.items);
    let found = project.engine.blade_completion(&blade, Pos::new(1, 16), None, &CancellationToken::new()).unwrap();
    assert!(found.items.iter().any(|item| item.label == "title"), "{:?}", found.items);
}

#[test]
fn view_kind_validates_values() {
    let project = Project::app();
    let cx = project.engine.ref_context().unwrap();
    assert!(ViewName.is_known(&cx, "posts.show"));
    assert!(ViewName.is_known(&cx, "posts/show"));
    assert!(ViewName.is_known(&cx, "billing::invoices.index"));
    assert!(!ViewName.is_known(&cx, "posts.nope"));
    assert!(ViewName.valid_name("a.b-c_d"));
    assert!(!ViewName.valid_name("a..b") && !ViewName.valid_name("") && !ViewName.valid_name("a/b"));
    assert_eq!(ViewTable::default().views().len(), 0);
}
