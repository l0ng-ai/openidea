//! Blade components, complete ([`crate::frameworks::laravel::components`]):
//! caret fixtures in Blade templates of the fixture app with a class
//! component rendering its own view, provider registrations, a vendor
//! package's components, slots, `<x-dynamic-component>`, the attribute type
//! check and the quick-fixes.

use super::blade_tests::{PAGE, Template};
use super::*;
use crate::frameworks::laravel::components::{ComponentRegistrations, default_alias};

const USER_CARD: &str = r#"<?php

namespace App\View\Components;

use App\Models\Post;
use Illuminate\View\Component;

class UserCard extends Component
{
    public string $initials = '';

    public function __construct(public Post $post, public int $size = 32)
    {
    }

    public function isLarge(): bool
    {
        return $this->size > 64;
    }

    public function render()
    {
        return view('cards.user');
    }
}
"#;

const USER_CARD_VIEW: &str = "<div>{{ $title }}</div>\n<p>{{ $post->title }} {{ $initials }}</p>\n{{ $footer ?? '' }}\n@foreach ($post->tags as $tag) {{ $tag }} @endforeach\n";

const PROVIDER: &str = r#"<?php

namespace App\Providers;

use App\Ui\Button;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\ServiceProvider;

class ComponentServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Blade::component('primary-button', Button::class);
        Blade::component(\App\Ui\Icon::class);
        Blade::components([Button::class => 'btn'], 'ui');
        Blade::componentNamespace('App\\Ui\\Kit', 'kit');
        Blade::anonymousComponentPath(__DIR__.'/../../resources/dashboard', 'dash');
        Blade::anonymousComponentNamespace('emails.parts', 'mail');
    }
}
"#;

const INSTALLED: &str = r#"{
    "packages": [
        {
            "name": "laravel/framework",
            "version": "v11.31.0",
            "type": "library",
            "autoload": { "classmap": ["src/"], "files": ["helpers.php"] },
            "install-path": "../laravel/framework"
        },
        {
            "name": "nwidart/laravel-modules",
            "version": "v10.0.6",
            "type": "library",
            "autoload": { "files": ["src/helpers.php"] },
            "install-path": "../nwidart/laravel-modules"
        },
        {
            "name": "acme/ui",
            "version": "1.0.0",
            "type": "library",
            "autoload": { "psr-4": { "Acme\\Ui\\": "src/" } },
            "extra": { "laravel": { "providers": ["Acme\\Ui\\UiServiceProvider"] } },
            "install-path": "../acme/ui"
        }
    ],
    "dev": true,
    "dev-package-names": []
}
"#;

const VENDOR_PROVIDER: &str = r#"<?php

namespace Acme\Ui;

use Illuminate\Support\Facades\Blade;
use Illuminate\Support\ServiceProvider;

class UiServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $this->loadViewsFrom(__DIR__.'/../resources/views', 'acme');
        Blade::componentNamespace('Acme\\Ui\\Components', 'acme');
    }
}
"#;

fn class(namespace: &str, name: &str, body: &str) -> String {
    format!(
        "<?php\n\nnamespace {namespace};\n\nuse Illuminate\\View\\Component;\n\nclass {name} extends Component\n{{\n{body}\n}}\n"
    )
}

/// The fixture app with the components of this module's fixtures.
fn components_app() -> Project {
    let button = class("App\\Ui", "Button", "    public function __construct(public string $kind = 'primary') {}");
    let icon = class("App\\Ui", "Icon", "    public function __construct(public string $name) {}");
    let chip = class("App\\Ui\\Kit", "Chip", "    public function __construct(public string $label) {}");
    let input = class("App\\Ui\\Kit\\Forms", "Input", "    public function __construct(public string $name) {}");
    let toast = class("Acme\\Ui\\Components", "Toast", "    public function __construct(public string $level) {}");
    Project::app_with(&[
        ("app/View/Components/UserCard.php", USER_CARD),
        ("resources/views/cards/user.blade.php", USER_CARD_VIEW),
        ("resources/views/components/plain.blade.php", "<div>{{ $slot }}</div>\n"),
        ("app/Providers/ComponentServiceProvider.php", PROVIDER),
        ("app/Ui/Button.php", &button),
        ("app/Ui/Icon.php", &icon),
        ("app/Ui/Kit/Chip.php", &chip),
        ("app/Ui/Kit/Forms/Input.php", &input),
        ("resources/dashboard/panel.blade.php", "@props(['heading'])\n<section></section>\n"),
        ("resources/dashboard/chart/index.blade.php", "<canvas></canvas>\n"),
        ("resources/views/emails/parts/footer.blade.php", "<footer></footer>\n"),
        ("vendor/composer/installed.json", INSTALLED),
        ("vendor/acme/ui/src/UiServiceProvider.php", VENDOR_PROVIDER),
        ("vendor/acme/ui/src/Components/Toast.php", &toast),
        ("vendor/acme/ui/resources/views/components/banner.blade.php", "@props(['tone'])\n<div></div>\n"),
    ])
}

const CARD_VIEW: &str = "resources/views/cards/user.blade.php";

#[test]
fn registrations_of_a_provider() {
    let project = components_app();
    let laravel = project.engine.laravel().unwrap();
    let path = project.root.join("app/Providers/ComponentServiceProvider.php");
    let found = ComponentRegistrations::read(&laravel, &path, PROVIDER);
    assert_eq!(
        found.aliases,
        [
            ("primary-button".to_owned(), "App\\Ui\\Button".to_owned()),
            ("icon".to_owned(), "App\\Ui\\Icon".to_owned()),
            ("ui-btn".to_owned(), "App\\Ui\\Button".to_owned()),
        ]
    );
    assert_eq!(found.namespaces, [("kit".to_owned(), "App\\Ui\\Kit".to_owned())]);
    assert_eq!(found.anonymous_paths, [(Some("dash".to_owned()), project.root.join("resources/dashboard"))]);
    assert_eq!(found.anonymous_namespaces, [("mail".to_owned(), "emails.parts".to_owned())]);
    // The alias Laravel guesses, and nothing without the facade.
    assert_eq!(default_alias("App\\View\\Components\\Forms\\Input"), "forms:input");
    assert_eq!(default_alias("Acme\\Thing\\DatePicker"), "date-picker");
    assert!(ComponentRegistrations::read(&laravel, &path, "<?php\ncomponent('a', B::class);\n").aliases.is_empty());
}

#[test]
fn registered_namespaced_and_vendor_components_are_in_the_catalog() {
    let project = components_app();
    let catalog = project.engine.laravel_blade().unwrap();
    let rel = |path: &PathBuf| path.strip_prefix(&project.root).unwrap().to_string_lossy().replace('\\', "/");
    let describe = |tag: &str| -> (Option<String>, Option<String>) {
        let component = catalog.component(tag).unwrap_or_else(|| panic!("no component {tag}"));
        (component.class.as_ref().map(|(class, _)| class.clone()), component.view.as_ref().map(rel))
    };
    assert_eq!(describe("primary-button"), (Some("App\\Ui\\Button".to_owned()), None));
    assert_eq!(describe("icon"), (Some("App\\Ui\\Icon".to_owned()), None));
    assert_eq!(describe("ui-btn"), (Some("App\\Ui\\Button".to_owned()), None));
    assert_eq!(describe("kit::chip"), (Some("App\\Ui\\Kit\\Chip".to_owned()), None));
    assert_eq!(describe("kit::forms.input"), (Some("App\\Ui\\Kit\\Forms\\Input".to_owned()), None));
    assert_eq!(describe("dash::panel"), (None, Some("resources/dashboard/panel.blade.php".to_owned())));
    assert_eq!(describe("dash::chart"), (None, Some("resources/dashboard/chart/index.blade.php".to_owned())));
    assert_eq!(describe("mail::footer"), (None, Some("resources/views/emails/parts/footer.blade.php".to_owned())));
    // A vendor package's: its namespace's classes and its anonymous views.
    assert_eq!(describe("acme::toast"), (Some("Acme\\Ui\\Components\\Toast".to_owned()), None));
    assert_eq!(
        describe("acme::banner"),
        (None, Some("vendor/acme/ui/resources/views/components/banner.blade.php".to_owned()))
    );
    // A class component's view is the one its `render()` names.
    assert_eq!(describe("user-card"), (Some("App\\View\\Components\\UserCard".to_owned()), Some(CARD_VIEW.to_owned())));
    let card = catalog.component("user-card").unwrap();
    assert!(card.class.as_ref().unwrap().1.ends_with("app/View/Components/UserCard.php"));

    // Tags, attributes and goto work for them like for the others.
    let labels = project.blade_labels(PAGE, "<x-/*|*/");
    for tag in ["x-primary-button", "x-kit::forms.input", "x-dash::panel", "x-acme::toast", "x-acme::banner"] {
        assert!(labels.contains(&tag.to_owned()), "{tag}: {labels:?}");
    }
    assert_eq!(project.blade_labels(PAGE, "<x-kit::chip /*|*/"), ["label"]);
    assert_eq!(project.blade_labels(PAGE, "<x-dash::panel /*|*/"), ["heading"]);
    assert_eq!(
        project.blade_goto(PAGE, "<x-acme::to/*|*/ast level=\"info\" />"),
        [("vendor/acme/ui/src/Components/Toast.php".to_owned(), 6, "Toast".to_owned())]
    );
}

#[test]
fn a_class_components_members_are_variables_of_its_view() {
    let project = components_app();
    let mut variables = project.engine.laravel_component_variables(&project.root.join(CARD_VIEW));
    variables.sort();
    assert_eq!(
        variables,
        [
            ("componentName".to_owned(), "string".to_owned()),
            ("initials".to_owned(), "string".to_owned()),
            ("isLarge".to_owned(), "\\Closure".to_owned()),
            ("post".to_owned(), "App\\Models\\Post".to_owned()),
            ("size".to_owned(), "int".to_owned()),
        ]
    );
    // Other templates have none.
    assert!(project.engine.laravel_component_variables(&project.root.join(PAGE)).is_empty());
    let labels = project.blade_php_labels(CARD_VIEW, "<p>{{ $post->ti/*|*/ }}</p>");
    assert!(labels.contains(&"title".to_owned()), "{labels:?}");
    let labels = project.blade_php_labels(CARD_VIEW, "<p>{{ $is/*|*/ }}</p>");
    assert!(labels.contains(&"$isLarge".to_owned()), "{labels:?}");
    // A component view: `$attributes` and `$slot` too.
    let labels = project.blade_php_labels(CARD_VIEW, "<p {{ $attr/*|*/ }}></p>");
    assert!(labels.contains(&"$attributes".to_owned()), "{labels:?}");
}

#[test]
fn props_and_aware_entries_are_variables() {
    let project = components_app();
    let view = "resources/views/components/tone.blade.php";
    let source = "@props(['tone' => 'info', 'size'])\n@aware(['color' => 'gray'])\n<div>{{ $/*|*/ }}</div>\n";
    let labels = project.blade_php_labels(view, source);
    for name in ["$tone", "$size", "$color", "$attributes", "$slot"] {
        assert!(labels.contains(&name.to_owned()), "{name}: {labels:?}");
    }
    // The default gives the type.
    let labels = project.blade_php_labels(view, "@props(['tone' => 'info'])\n{{ $tone->/*|*/ }}");
    assert!(!labels.contains(&"title".to_owned()), "{labels:?}");
}

#[test]
fn slot_names_complete_and_go_to_the_components_view() {
    let project = components_app();
    let post = "@php($post = new \\App\\Models\\Post())\n";
    let labels =
        project.blade_labels(PAGE, &format!("{post}<x-user-card :post=\"$post\">\n    <x-slot:/*|*/\n</x-user-card>"));
    assert_eq!(labels, ["title", "footer"]);
    let labels = project.blade_labels(
        PAGE,
        &format!("{post}<x-user-card :post=\"$post\">\n    <x-slot name=\"/*|*/\">\n</x-user-card>"),
    );
    assert_eq!(labels, ["title", "footer"]);
    // Tags in the component's body offer them.
    let labels =
        project.blade_labels(PAGE, &format!("{post}<x-user-card :post=\"$post\">\n    <x-/*|*/\n</x-user-card>"));
    assert!(labels.contains(&"x-slot:title".to_owned()) && labels.contains(&"x-slot:footer".to_owned()), "{labels:?}");
    // After the component is closed, nothing.
    let labels =
        project.blade_labels(PAGE, &format!("{post}<x-user-card :post=\"$post\">\n</x-user-card>\n<x-slot:/*|*/"));
    assert!(labels.is_empty(), "{labels:?}");
    // Nested components: the nearest one.
    let labels = project.blade_labels(
        PAGE,
        "<x-user-card>\n<x-alert>\n</x-alert>\n<x-plain />\n<x-slot name=\"/*|*/\"></x-slot>\n</x-user-card>",
    );
    assert_eq!(labels, ["title", "footer"]);

    let found = project.blade_goto(PAGE, "<x-user-card>\n    <x-slot:ti/*|*/tle>Hi</x-slot>\n</x-user-card>");
    assert_eq!(found, [(CARD_VIEW.to_owned(), 0, "title".to_owned())]);
    let found = project.blade_goto(PAGE, "<x-user-card>\n    <x-slot name=\"foo/*|*/ter\">Hi</x-slot>\n</x-user-card>");
    assert_eq!(found, [(CARD_VIEW.to_owned(), 2, "footer".to_owned())]);
}

#[test]
fn dynamic_components_complete_and_go_to_the_component() {
    let project = components_app();
    let labels = project.blade_labels(PAGE, "<x-dynamic-component component=\"/*|*/\" />");
    for tag in ["alert", "user-card", "kit::chip"] {
        assert!(labels.contains(&tag.to_owned()), "{tag}: {labels:?}");
    }
    assert_eq!(project.blade_labels(PAGE, "<x-dynamic-component /*|*/"), ["component"]);
    let found = project.blade_goto(PAGE, "<x-dynamic-component component=\"al/*|*/ert\" />");
    assert_eq!(
        found,
        [
            ("app/View/Components/Alert.php".to_owned(), 7, "Alert".to_owned()),
            ("resources/views/components/alert.blade.php".to_owned(), 0, String::new()),
        ]
    );
    // A bound `:component` is PHP, not a name.
    assert!(project.blade_goto(PAGE, "<x-dynamic-component :component=\"$al/*|*/ert\" />").is_empty());
}

#[test]
fn undefined_components_are_problems() {
    let project = components_app();
    let text = "<x-nope />\n<x-alert />\n<x-user-card>\n<x-slot:title>T</x-slot>\n</x-user-card>\n<x-dynamic-component component=\"x\" />\n<x-unknownpkg::thing />\n<x-acme::nope />\n<x-dash::panel />\n";
    let found: Vec<(u32, String, Option<String>)> = project
        .engine
        .blade_problems(text)
        .into_iter()
        .map(|problem| (problem.range.start.line, problem.message, problem.code))
        .collect();
    let code = Some("BladeUndefinedComponent".to_owned());
    assert_eq!(
        found,
        [
            (0, "Component 'x-nope' is not defined".to_owned(), code.clone()),
            (7, "Component 'x-acme::nope' is not defined".to_owned(), code),
        ]
    );
    // Every view of the app is still fine.
    for view in project.engine.laravel_views().unwrap().views() {
        let text = std::fs::read_to_string(&view.path).unwrap();
        assert!(project.engine.blade_problems(&text).is_empty(), "{}", view.name);
    }
}

#[test]
fn bound_attributes_are_checked_against_the_constructor() {
    let project = components_app();
    let path = project.root.join(PAGE);
    let text = "@php($user = new \\App\\Models\\User())\n@php($post = new \\App\\Models\\Post())\n<x-user-card :post=\"$user\" :size=\"[1, 2]\" />\n<x-user-card :$post :size=\"64\" />\n<x-alert :type=\"'info'\" :message=\"[1]\" />\n<x-plain :tone=\"[1]\" />\n";
    let found: Vec<(u32, String)> = project
        .engine
        .blade_file_problems(&path, text)
        .into_iter()
        .filter(|problem| problem.code.as_deref() == Some("PhpParams"))
        .map(|problem| {
            let lines = LineIndex::new(text);
            let (start, end) = lines.byte_range(problem.range);
            (problem.range.start.line, text[start as usize..end as usize].to_owned())
        })
        .collect();
    assert_eq!(found, [(2, "$user".to_owned()), (2, "[1, 2]".to_owned()), (4, "[1]".to_owned())]);
    // The bound value compiles to the constructor call: signature help shows it.
    let template = Template::new(&project, PAGE, "<x-alert :message=\"$m/*|*/\" />");
    let help = project.engine.blade_signature_help(&template.blade(), template.pos);
    project.engine.document_closed(DocId(90));
    let help = help.expect("signature help");
    assert!(help.signatures[0].label.contains("$message"), "{:?}", help.signatures[0].label);
    // Turned off with `PhpParams`.
    let mut config = crate::inspect::InspectionConfig::default();
    config.disabled.insert("PhpParams".to_owned());
    project.engine.configure_inspections(config);
    assert!(project.engine.blade_file_problems(&path, text).iter().all(|p| p.code.as_deref() != Some("PhpParams")));
}

#[test]
fn quick_fixes_create_components_and_views_and_add_props() {
    let project = components_app();
    let fixes = |source: &str| -> Vec<(String, WorkspaceEdit)> {
        let template = Template::new(&project, PAGE, source);
        let range = Range::new(template.pos, template.pos);
        project.engine.blade_quick_fixes(&template.blade(), range).into_iter().map(|a| (a.title, a.edit)).collect()
    };
    let found = fixes("<x-no/*|*/pe />");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "Create component 'x-nope'");
    let [FileEdit::Create { path, overwrite: false }] = found[0].1.files.as_slice() else { panic!("{found:?}") };
    assert_eq!(PathBuf::from(path.clone()), project.root.join("resources/views/components/nope.blade.php"));
    let found = fixes("<x-forms.no/*|*/pe />");
    let [FileEdit::Create { path, .. }] = found[0].1.files.as_slice() else { panic!("{found:?}") };
    assert_eq!(PathBuf::from(path.clone()), project.root.join("resources/views/components/forms/nope.blade.php"));

    let found = fixes("@include('posts.mis/*|*/sing')");
    assert_eq!(found.iter().map(|(title, _)| title.as_str()).collect::<Vec<_>>(), ["Create view 'posts.missing'"]);

    // An attribute the anonymous component doesn't declare.
    let found = fixes("<x-badge status=\"x\" si/*|*/ze=\"lg\" />");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "Add 'size' to the @props of <x-badge>");
    let [FileEdit::Edit { path, edits, .. }] = found[0].1.files.as_slice() else { panic!("{found:?}") };
    assert_eq!(PathBuf::from(path.clone()), project.root.join("resources/views/components/badge.blade.php"));
    assert_eq!(edits[0].new_text, ", 'size'");
    assert_eq!(edits[0].range, Range::new(Pos::new(0, 16), Pos::new(0, 16)));
    let found = fixes("<x-plain data-x=\"1\" font-si/*|*/ze=\"lg\" />");
    let [FileEdit::Edit { edits, .. }] = found[0].1.files.as_slice() else { panic!("{found:?}") };
    assert_eq!(found[0].0, "Add 'fontSize' to the @props of <x-plain>");
    assert_eq!(edits[0].new_text, "@props(['fontSize'])\n\n");
    assert_eq!(edits[0].range, Range::new(Pos::new(0, 0), Pos::new(0, 0)));
    // Not for declared props or `class`; a class component's constructor
    // gets the parameter instead.
    assert!(fixes("<x-badge sta/*|*/tus=\"x\" />").is_empty());
    let titles = |found: Vec<(String, WorkspaceEdit)>| found.into_iter().map(|(title, _)| title).collect::<Vec<_>>();
    assert_eq!(titles(fixes("<x-alert fo/*|*/o=\"x\" />")), ["Add constructor parameter '$foo' to <x-alert>"]);
    assert!(fixes("<x-badge cla/*|*/ss=\"x\" />").is_empty());
}

#[test]
fn quick_fix_adds_constructor_parameters_to_class_components() {
    let divider =
        class("App\\View\\Components", "Divider", "    public function render()\n    {\n        return '';\n    }");
    let project = Project::app_with(&[
        ("app/Ui/Icon.php", &class("App\\Ui", "Icon", "    public function __construct(public string $name) {}")),
        ("app/View/Components/Divider.php", &divider),
        ("app/Providers/ComponentServiceProvider.php", PROVIDER),
    ]);
    let fixes = |source: &str| -> Vec<(String, WorkspaceEdit)> {
        let template = Template::new(&project, PAGE, source);
        let range = Range::new(template.pos, template.pos);
        project.engine.blade_quick_fixes(&template.blade(), range).into_iter().map(|a| (a.title, a.edit)).collect()
    };
    let edit = |found: &[(String, WorkspaceEdit)]| -> (PathBuf, TextEdit) {
        let [FileEdit::Edit { path, edits, .. }] = found[0].1.files.as_slice() else { panic!("{found:?}") };
        (PathBuf::from(path.clone()), edits[0].clone())
    };
    // After optional parameters: optional too.
    let found = fixes("<x-alert type=\"info\" font-si/*|*/ze=\"lg\" />");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "Add constructor parameter '$fontSize' to <x-alert>");
    let (path, text_edit) = edit(&found);
    assert_eq!(path, project.root.join("app/View/Components/Alert.php"));
    assert_eq!(text_edit.new_text, ", public ?string $fontSize = null");
    assert_eq!(text_edit.range, Range::new(Pos::new(9, 92), Pos::new(9, 92)));
    // A bound attribute is `mixed`.
    let found = fixes("<x-icon name=\"x\" :si/*|*/ze=\"1\" />");
    let (path, text_edit) = edit(&found);
    assert_eq!(path, project.root.join("app/Ui/Icon.php"));
    assert_eq!(text_edit.new_text, ", public mixed $size");
    assert_eq!(text_edit.range, Range::new(Pos::new(8, 51), Pos::new(8, 51)));
    // No constructor yet: a new one before the first method.
    let found = fixes("<x-divider lab/*|*/el=\"x\" />");
    let (path, text_edit) = edit(&found);
    assert_eq!(path, project.root.join("app/View/Components/Divider.php"));
    assert_eq!(text_edit.new_text, "    public function __construct(public string $label)\n    {\n    }\n\n");
    assert_eq!(text_edit.range, Range::new(Pos::new(8, 0), Pos::new(8, 0)));
    // Not for parameters it takes, `class`, `::` attributes or anonymous
    // components.
    assert!(fixes("<x-alert ty/*|*/pe=\"x\" />").is_empty());
    assert!(fixes("<x-icon cla/*|*/ss=\"x\" />").is_empty());
    assert!(fixes("<x-icon ::si/*|*/ze=\"x\" />").is_empty());
    assert!(fixes("<x-badge sta/*|*/tus=\"x\" />").is_empty());
}

#[test]
fn aware_completes_the_props_of_enclosing_components() {
    let project = Project::app_with(&[
        ("resources/views/components/menu.blade.php", "@props(['color' => 'gray', 'size'])\n<ul>{{ $slot }}</ul>\n"),
        ("resources/views/components/menu/item.blade.php", "<li>{{ $slot }}</li>\n"),
        ("resources/views/components/lonely.blade.php", "<p></p>\n"),
        (
            "resources/views/nav.blade.php",
            "<x-menu color=\"red\">\n    <x-alert>\n        <x-menu.item>Home</x-menu.item>\n    </x-alert>\n</x-menu>\n<x-menu.item />\n",
        ),
    ]);
    let item = "resources/views/components/menu/item.blade.php";
    let labels = project.blade_labels(item, "@aware(['/*|*/'])\n<li>{{ $slot }}</li>\n");
    assert_eq!(labels, ["color", "size", "type", "message"]);
    // Not the entries listed already; keys with defaults too.
    let labels = project.blade_labels(item, "@aware(['color' => 'gray', 'si/*|*/'])\n<li></li>\n");
    assert_eq!(labels, ["size", "type", "message"]);
    // Not in the default's value, nor in a component no tag encloses.
    assert!(project.blade_labels(item, "@aware(['color' => '/*|*/'])\n").is_empty());
    let lonely = "resources/views/components/lonely.blade.php";
    assert!(project.blade_labels(lonely, "@aware(['/*|*/'])\n").is_empty());
    // The parents themselves.
    let catalog = project.engine.laravel_blade().unwrap();
    let parents = project.engine.laravel_parent_components(catalog.component("menu.item").unwrap());
    assert_eq!(parents.iter().map(|parent| parent.tag.as_str()).collect::<Vec<_>>(), ["menu", "alert"]);
}

/// Hovering a component tag's name shows the component's class, view and
/// props; anonymous components have a view only.
#[test]
fn hovers_a_component_tag() {
    let project = Project::app();
    let template = Template::new(&project, PAGE, "<x-al/*|*/ert type=\"error\" />");
    let hover = project.engine.blade_hover(&template.blade(), template.pos).expect("a hover");
    project.engine.document_closed(DocId(90));
    let text = &hover.markdown;
    assert!(text.starts_with("**component** `<x-alert>`"), "{text}");
    assert!(text.contains(r"Class `App\View\Components\Alert` · app/View/Components/Alert.php"), "{text}");
    assert!(text.contains("View · resources/views/components/alert.blade.php"), "{text}");
    assert!(text.contains("Props: `type`") && text.contains("`message`"), "{text}");
    let template = Template::new(&project, PAGE, "<x-bad/*|*/ge :status=\"$s\" />");
    let hover = project.engine.blade_hover(&template.blade(), template.pos).expect("a hover").markdown;
    project.engine.document_closed(DocId(90));
    assert!(!hover.contains("Class") && hover.contains("components/badge.blade.php"), "{hover}");
}

/// Find usages of a class component's class lists its tags in templates.
#[test]
fn finds_a_component_class_tags_in_templates() {
    let mut project = Project::app();
    let text = std::fs::read_to_string(project.root.join("app/View/Components/Alert.php")).unwrap();
    let found = project.references("app/View/Components/Alert.php", &text.replace("class Alert", "class Al/*|*/ert"));
    let tags: Vec<String> = found.iter().filter(|usage| usage.2 == "alert").map(|usage| usage.0.clone()).collect();
    assert!(tags.contains(&"resources/views/posts/show.blade.php".to_owned()), "{found:?}");
    assert!(tags.contains(&"resources/views/layouts/app.blade.php".to_owned()), "{found:?}");
}

/// Renaming a class component renames its tags (named after the class) in
/// the templates, opening and closing.
#[test]
fn renaming_a_component_class_renames_its_tags() {
    let mut project = Project::app();
    let text = std::fs::read_to_string(project.root.join("app/View/Components/Alert.php")).unwrap();
    let edits = project.rename_edits(
        "app/View/Components/Alert.php",
        &text.replace("class Alert", "class Al/*|*/ert"),
        "NoticeBox",
    );
    let tags: Vec<(String, String, String)> =
        edits.iter().filter(|e| e.0.ends_with(".blade.php")).map(|e| (e.0.clone(), e.2.clone(), e.3.clone())).collect();
    assert_eq!(
        tags,
        [
            ("resources/views/layouts/app.blade.php".to_owned(), "alert".to_owned(), "notice-box".to_owned()),
            ("resources/views/posts/create.blade.php".to_owned(), "alert".to_owned(), "notice-box".to_owned()),
            ("resources/views/posts/show.blade.php".to_owned(), "alert".to_owned(), "notice-box".to_owned()),
        ]
    );
    // Closing tags too, not a longer name.
    let spans =
        crate::frameworks::laravel::blade::closing_tag_spans("<x-alert>a</x-alert> </x-alerts> </x-alert >", "alert");
    assert_eq!(spans, [14..19, 37..42]);
}

/// An anonymous component's props are typed from what its callers bind:
/// `$status` in `badge.blade.php` completes `PostStatus`'s members.
#[test]
fn anonymous_component_props_are_typed_from_their_callers() {
    let project = Project::app();
    let badge = "resources/views/components/badge.blade.php";
    let props = project.engine.anonymous_component_props(&project.root.join(badge));
    assert_eq!(props.as_ref(), &[("status".to_owned(), r"App\Enums\PostStatus".to_owned())]);
    let labels = project.blade_php_labels(badge, "@props(['status'])\n{{ $status->/*|*/ }}");
    assert!(labels.contains(&"label".to_owned()), "{labels:?}");
    // A class component's view: its own variables, not these.
    let alert = project.root.join("resources/views/components/alert.blade.php");
    assert!(project.engine.anonymous_component_props(&alert).is_empty());
}
