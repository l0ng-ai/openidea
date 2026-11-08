//! Blade layouts, stacks, components and custom directives
//! ([`crate::frameworks::laravel::blade`]): caret fixtures in Blade
//! templates of the fixture app (`fixtures/laravel-app` with
//! `fixtures/laravel-stubs` as its `vendor/`).

use super::*;
use crate::blade::BladeDocument;
use crate::frameworks::laravel::blade::kebab;
use crate::navigate::Target;

/// A template of the app with the caret.
struct Template {
    path: PathBuf,
    text: String,
    pos: Pos,
}

impl Template {
    fn new(project: &Project, rel: &str, source: &str) -> Self {
        let (text, pos) = caret(source);
        Self { path: project.root.join(rel), text, pos }
    }

    fn blade(&self) -> BladeDocument<'_> {
        BladeDocument { doc: DocId(90), path: &self.path, version: 1, text: &self.text }
    }
}

impl Project {
    /// The labels of the Laravel completion (directives first) at the caret.
    fn blade_labels(&self, rel: &str, source: &str) -> Vec<String> {
        let template = Template::new(self, rel, source);
        let found = self
            .engine
            .blade_directive_completion(&template.text, template.pos)
            .or_else(|| self.engine.blade_laravel_completion(&template.blade(), template.pos))
            .unwrap_or_default();
        found.items.into_iter().map(|item| item.label).collect()
    }

    /// The labels of the PHP completion at the caret.
    fn blade_php_labels(&self, rel: &str, source: &str) -> Vec<String> {
        let template = Template::new(self, rel, source);
        let found = self.engine.blade_completion(&template.blade(), template.pos, None, &CancellationToken::new());
        self.engine.document_closed(DocId(90));
        found.map(|found| found.items.into_iter().map(|item| item.label).collect()).unwrap_or_default()
    }

    /// `(relative path, line, text)` of the Laravel goto targets at the caret.
    fn blade_goto(&self, rel: &str, source: &str) -> Vec<(String, u32, String)> {
        let template = Template::new(self, rel, source);
        let targets = self.engine.blade_laravel_definition(&template.blade(), template.pos).unwrap_or_default();
        targets.iter().map(|Target { path, range }| self.describe(path, *range)).collect()
    }
}

const PAGE: &str = "resources/views/probe.blade.php";
const LAYOUT: &str = "resources/views/layouts/app.blade.php";

#[test]
fn the_fixture_apps_components_and_directives() {
    let project = Project::app();
    let catalog = project.engine.laravel_blade().unwrap();
    let tags: Vec<&str> = catalog.components.iter().map(|component| component.tag.as_str()).collect();
    assert_eq!(tags, ["alert", "badge"]);
    let alert = catalog.component("alert").unwrap();
    assert_eq!(alert.class.as_ref().map(|(class, _)| class.as_str()), Some("App\\View\\Components\\Alert"));
    assert!(alert.view.as_ref().unwrap().ends_with("resources/views/components/alert.blade.php"));
    let badge = catalog.component("badge").unwrap();
    assert!(badge.class.is_none() && badge.view.is_some());
    assert_eq!(catalog.directive_names(), ["money", "admin", "elseadmin", "endadmin", "unlessadmin"]);
    assert_eq!(catalog.directive("endadmin").map(|directive| directive.name.as_str()), Some("admin"));

    let attributes = |tag: &str| -> Vec<(String, Option<String>)> {
        let component = catalog.component(tag).unwrap();
        let found = project.engine.laravel_component_attributes(component);
        found.into_iter().map(|attribute| (attribute.name, attribute.detail)).collect()
    };
    assert_eq!(
        attributes("alert"),
        [("type".to_owned(), Some("string".to_owned())), ("message".to_owned(), Some("?string".to_owned()))]
    );
    assert_eq!(attributes("badge"), [("status".to_owned(), None)]);
    assert_eq!(kebab("InputGroup"), "input-group");
    assert_eq!(kebab("isActive"), "is-active");
}

#[test]
fn components_of_classes_folders_and_modules() {
    let project = Project::new(&[
        ("composer.json", COMPOSER),
        (
            "app/View/Components/Forms/InputGroup.php",
            "<?php\nnamespace App\\View\\Components\\Forms;\nclass InputGroup { public function __construct(public string $label, public bool $inline = false) {} }\n",
        ),
        (
            "resources/views/components/card/index.blade.php",
            "@props(['title', 'isActive' => false])\n<div>{{ $slot }}</div>",
        ),
        ("resources/views/components/panel/panel.blade.php", "<div></div>"),
        ("resources/views/components/forms/input-group.blade.php", "<input>"),
        ("Modules/Billing/module.json", r#"{"name": "Billing"}"#),
        ("Modules/Billing/composer.json", r#"{"autoload": {"psr-4": {"Modules\\Billing\\": "app/"}}}"#),
        ("Modules/Billing/resources/views/components/total.blade.php", "@props(['amount'])"),
        (
            "Modules/Billing/app/View/Components/Invoice.php",
            "<?php\nnamespace Modules\\Billing\\View\\Components;\nclass Invoice { public function __construct(public int $number) {} }\n",
        ),
        ("modules_statuses.json", r#"{"Billing": true}"#),
        ("config/modules.php", "<?php\nreturn ['paths' => ['modules' => base_path('Modules')]];\n"),
    ]);
    let catalog = project.engine.laravel_blade().unwrap();
    let tags: Vec<(&str, bool, bool)> = catalog
        .components
        .iter()
        .map(|component| (component.tag.as_str(), component.class.is_some(), component.view.is_some()))
        .collect();
    assert_eq!(
        tags,
        [
            ("billing::invoice", true, false),
            ("billing::total", false, true),
            ("card", false, true),
            ("forms.input-group", true, true),
            ("panel", false, true),
        ],
        "{catalog:?}"
    );
    let card = catalog.component("card").unwrap();
    let names: Vec<String> =
        project.engine.laravel_component_attributes(card).into_iter().map(|attribute| attribute.name).collect();
    assert_eq!(names, ["title", "is-active"]);
    let input = catalog.component("forms.input-group").unwrap();
    let names: Vec<String> =
        project.engine.laravel_component_attributes(input).into_iter().map(|attribute| attribute.name).collect();
    assert_eq!(names, ["label", "inline"]);
}

#[test]
fn directive_completion_includes_custom_directives() {
    let project = Project::app();
    let labels = project.blade_labels(PAGE, "<p>\n@mon/*|*/\n</p>");
    for name in ["money", "admin", "endadmin", "unlessadmin", "foreach", "section"] {
        assert!(labels.contains(&name.to_owned()), "{name}: {labels:?}");
    }
    assert_eq!(labels.iter().filter(|label| *label == "money").count(), 1);
    let template = Template::new(&project, PAGE, "@mon/*|*/");
    let found = project.engine.blade_directive_completion(&template.text, template.pos).unwrap();
    let money = found.items.iter().find(|item| item.label == "money").unwrap();
    assert_eq!(money.detail.as_deref(), Some("Custom directive · AppServiceProvider"));
    assert_eq!(money.replace, Range::new(Pos::new(0, 1), Pos::new(0, 4)));
    // Not in PHP.
    assert!(project.engine.blade_directive_completion("{{ '@mo' }}", Pos::new(0, 7)).is_none());
}

#[test]
fn custom_directives_are_php_and_go_to_their_registration() {
    let project = Project::app();
    let labels = project.blade_php_labels(PAGE, "@php($post = new \\App\\Models\\Post())\n@money($post->ti/*|*/)");
    assert!(labels.contains(&"title".to_owned()), "{labels:?}");
    let found = project.blade_goto(PAGE, "@mon/*|*/ey(100)");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, "app/Providers/AppServiceProvider.php");
    assert_eq!(found[0].2, "money");
    let found = project.blade_goto(PAGE, "@admin\n@endad/*|*/min");
    assert_eq!(found.iter().map(|f| f.2.as_str()).collect::<Vec<_>>(), ["admin"]);
    assert!(project.blade_goto(PAGE, "@fore/*|*/ach($a as $b)").is_empty());
}

#[test]
fn section_names_complete_from_the_layout_chain() {
    let project = Project::app();
    let labels = project.blade_labels(PAGE, "@extends('layouts.app')\n@section('/*|*/')");
    assert_eq!(labels, ["title", "content"]);
    // While typing, the string not closed yet.
    let labels = project.blade_labels(PAGE, "@extends('layouts.app')\n@section('con/*|*/\n<p>");
    assert_eq!(labels, ["title", "content"]);
    // Two levels: a layout extending the app layout adds its own yields.
    let admin = project.root.join("resources/views/layouts/admin.blade.php");
    std::fs::write(
        &admin,
        "@extends('layouts.app')\n@section('content')\n@yield('toolbar')\n@yield('main')\n@endsection\n",
    )
    .unwrap();
    project.engine.files_changed(std::slice::from_ref(&admin), &[]);
    assert!(project.engine.wait_idle(Duration::from_secs(60)));
    let labels = project.blade_labels(PAGE, "@extends('layouts.admin')\n@section('/*|*/')");
    assert_eq!(labels, ["content", "toolbar", "main", "title"]);

    // In the layout, `@yield` completes what the views extending it fill.
    let labels = project.blade_labels(LAYOUT, "@yield('/*|*/')");
    assert!(labels.contains(&"title".to_owned()) && labels.contains(&"content".to_owned()), "{labels:?}");
    let template = Template::new(&project, PAGE, "@extends('layouts.app')\n@section('ti/*|*/tle', 'x')");
    let found = project.engine.blade_laravel_completion(&template.blade(), template.pos).unwrap();
    let title = found.items.iter().find(|item| item.label == "title").unwrap();
    assert_eq!(title.detail.as_deref(), Some("section · layouts.app"));
    assert_eq!(title.replace, Range::new(Pos::new(1, 10), Pos::new(1, 12)));
    assert_eq!(title.replace_tab, Some(Range::new(Pos::new(1, 10), Pos::new(1, 15))));
}

#[test]
fn sections_go_to_the_layout_and_back() {
    let project = Project::app();
    let found = project.blade_goto(PAGE, "@extends('layouts.app')\n@section('con/*|*/tent')\n@endsection");
    assert_eq!(found, [(LAYOUT.to_owned(), 21, "content".to_owned())]);
    let found = project.blade_goto(LAYOUT, "<title>@yield('ti/*|*/tle')</title>");
    let files: Vec<&str> = found.iter().map(|(file, ..)| file.as_str()).collect();
    assert_eq!(
        files,
        [
            "resources/views/about.blade.php",
            "resources/views/posts/create.blade.php",
            "resources/views/posts/index.blade.php",
            "resources/views/posts/show.blade.php",
        ]
    );
    assert!(found.iter().all(|(_, line, text)| *line == 2 && text == "title"), "{found:?}");
    // Not extending anything: nothing to go to.
    assert!(project.blade_goto(PAGE, "@section('con/*|*/tent')").is_empty());
}

#[test]
fn stacks_complete_and_go_across_views() {
    let project = Project::app();
    assert_eq!(project.blade_labels(PAGE, "@push('/*|*/')"), ["head"]);
    assert_eq!(project.blade_labels(LAYOUT, "@stack('/*|*/')"), ["head"]);
    assert_eq!(project.blade_labels(PAGE, "@pushIf($a, '/*|*/')"), ["head"]);
    let found = project.blade_goto(PAGE, "@prepend('he/*|*/ad') x @endprepend");
    assert_eq!(found, [(LAYOUT.to_owned(), 7, "head".to_owned())]);
    let found = project.blade_goto(LAYOUT, "@stack('he/*|*/ad')");
    assert_eq!(found, [("resources/views/posts/show.blade.php".to_owned(), 4, "head".to_owned())]);
}

#[test]
fn component_tags_and_attributes_complete() {
    let project = Project::app();
    assert_eq!(project.blade_labels(PAGE, "<div>\n<x-/*|*/"), ["x-alert", "x-badge"]);
    let template = Template::new(&project, PAGE, "<x-al/*|*/ert />");
    let found = project.engine.blade_laravel_completion(&template.blade(), template.pos).unwrap();
    let alert = found.items.iter().find(|item| item.label == "x-alert").unwrap();
    assert_eq!(alert.detail.as_deref(), Some("App\\View\\Components\\Alert"));
    assert_eq!(alert.replace, Range::new(Pos::new(0, 1), Pos::new(0, 5)));
    assert_eq!(alert.replace_tab, Some(Range::new(Pos::new(0, 1), Pos::new(0, 8))));

    assert_eq!(project.blade_labels(PAGE, "<x-alert /*|*/"), ["type", "message"]);
    assert_eq!(project.blade_labels(PAGE, "<x-alert type=\"info\" /*|*/ />"), ["message"]);
    assert_eq!(project.blade_labels(PAGE, "<x-alert :mes/*|*/=\"$m\" />"), ["type", "message"]);
    assert_eq!(project.blade_labels(PAGE, "<x-badge st/*|*/"), ["status"]);
    let template = Template::new(&project, PAGE, "<x-badge /*|*/");
    let found = project.engine.blade_laravel_completion(&template.blade(), template.pos).unwrap();
    assert_eq!(found.items[0].insert_text, "status=\"$0\"");
    assert!(found.items[0].is_snippet);
    let template = Template::new(&project, PAGE, "<x-badge :st/*|*/=\"$s\"");
    let found = project.engine.blade_laravel_completion(&template.blade(), template.pos).unwrap();
    assert_eq!(found.items[0].insert_text, "status");
    // Unknown components and plain HTML: nothing.
    assert!(project.blade_labels(PAGE, "<x-nope /*|*/").is_empty());
    assert!(project.blade_labels(PAGE, "<div /*|*/").is_empty());
}

#[test]
fn component_tags_and_attributes_go_to_their_declarations() {
    let project = Project::app();
    let found = project.blade_goto(PAGE, "<x-al/*|*/ert type=\"info\" />");
    assert_eq!(
        found,
        [
            ("app/View/Components/Alert.php".to_owned(), 7, "Alert".to_owned()),
            ("resources/views/components/alert.blade.php".to_owned(), 0, String::new()),
        ]
    );
    let found = project.blade_goto(PAGE, "<x-alert ty/*|*/pe=\"info\" />");
    assert_eq!(found, [("app/View/Components/Alert.php".to_owned(), 9, "$type".to_owned())]);
    let found = project.blade_goto(PAGE, "<x-badge :sta/*|*/tus=\"$s\" />");
    assert_eq!(found, [("resources/views/components/badge.blade.php".to_owned(), 0, "status".to_owned())]);
    assert!(project.blade_goto(PAGE, "<x-badge nope/*|*/=\"1\" />").is_empty());
}

#[test]
fn php_in_bound_attributes_and_class_arrays() {
    let project = Project::app();
    let prelude = "@php($post = new \\App\\Models\\Post())\n";
    let labels = project.blade_php_labels(PAGE, &format!("{prelude}<x-alert :message=\"$post->ti/*|*/\" />"));
    assert!(labels.contains(&"title".to_owned()), "{labels:?}");
    let labels = project.blade_php_labels(PAGE, &format!("{prelude}<x-badge :$po/*|*/ />"));
    assert!(labels.contains(&"$post".to_owned()), "{labels:?}");
    let labels =
        project.blade_php_labels(PAGE, &format!("{prelude}<span @class(['p-4', 'bold' => $post->ti/*|*/])></span>"));
    assert!(labels.contains(&"title".to_owned()), "{labels:?}");
    let labels = project.blade_php_labels(PAGE, &format!("{prelude}<p @style(['color: red' => $post->ti/*|*/])></p>"));
    assert!(labels.contains(&"title".to_owned()), "{labels:?}");
}

#[test]
fn unclosed_sections_are_problems_of_the_template() {
    let project = Project::app();
    let problems =
        project.engine.blade_problems("@extends('layouts.app')\n@section('content')\n<p>x</p>\n@admin\n@endadmin\n");
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert_eq!(problems[0].range.start.line, 1);
    assert_eq!(problems[0].code.as_deref(), Some("BladeUnclosedSection"));
    // Every view of the fixture app is fine.
    for view in project.engine.laravel_views().unwrap().views() {
        let text = std::fs::read_to_string(&view.path).unwrap();
        assert!(project.engine.blade_problems(&text).is_empty(), "{}", view.name);
    }
}
