//! `ide.json` support ([`crate::frameworks::laravel::ide_json`]): the
//! fixture app's `ide.json` (`fixtures/laravel-app/ide.json`) and the one of
//! a package of its `vendor/` (`fixtures/laravel-stubs/acme/widgets`),
//! mapped onto string references, views and Blade.

use super::*;

/// A PHP file of the app around `body`, a statement of a function.
fn probe(body: &str) -> String {
    format!("<?php\n\nnamespace App\\Http;\n\nfunction probe()\n{{\n    {body}\n}}\n")
}

/// A component class of the app whose `template()` returns `value`.
fn component(value: &str) -> String {
    format!(
        "<?php\n\nnamespace App\\View\\Components;\n\nuse Illuminate\\View\\Component;\n\nclass Probe extends Component\n{{\n    public function template(): string\n    {{\n        return {value};\n    }}\n}}\n"
    )
}

const PROBE: &str = "app/Http/Probe.php";

impl Project {
    /// The kind of the string at the caret, with the `ide.json` rules.
    fn rule_kind_at(&mut self, rel: &str, source: &str) -> Option<&'static str> {
        let (doc, pos) = self.open(rel, source);
        let parsed = self.engine.parsed_document(doc).unwrap();
        let resolver = self.engine.resolver();
        let offset = parsed.line_index().byte(pos);
        let project = self.engine.laravel().unwrap();
        let rules = &project.ide_json.completions;
        let kind = site_at_with(&parsed, &resolver, rules, offset)
            .and_then(|site| classify(&site, &resolver, rules))
            .map(|(kind, _)| kind.id());
        self.engine.document_closed(doc);
        kind
    }

    fn rule_complete(&mut self, rel: &str, source: &str) -> Vec<String> {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        found.items.into_iter().map(|item| item.label).collect()
    }

    fn rule_definition(&mut self, rel: &str, source: &str) -> Vec<(String, u32, String)> {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.definition(doc, pos).unwrap_or_default();
        self.engine.document_closed(doc);
        found.iter().map(|target| self.describe_any(&target.path, target.range)).collect()
    }

    /// [`Project::describe`], for files whose range is empty (a file).
    fn describe_any(&self, path: &Path, range: Range) -> (String, u32, String) {
        if range == Range::default() {
            let rel = path.strip_prefix(&self.root).unwrap().to_string_lossy().replace('\\', "/");
            return (rel, 0, String::new());
        }
        self.describe(path, range)
    }
}

#[test]
fn the_fixture_apps_ide_json_files() {
    let project = Project::app();
    let laravel = project.engine.laravel().unwrap();
    let ide = &laravel.ide_json;
    let files =
        [project.root.join("ide.json"), crate::project::normalize(&project.root.join("vendor/acme/widgets/ide.json"))];
    assert_eq!(ide.files, files, "{:?}", ide.ignored);
    let kinds: Vec<&str> = ide.completions.iter().map(|rule| rule.kind.as_str()).collect();
    assert_eq!(kinds, ["routeName", "configKey", "staticStrings", "directoryFiles", "viewName"]);
    // `parameters` are 1-based in the file.
    assert_eq!(ide.completions[0].conditions[0].parameters, [1]);
    assert_eq!(ide.completions[1].options.prefix, "blog.");
    assert_eq!(ide.completions[3].options.directories, [project.root.join("resources/css")]);
    // Unknown types and keys are ignored, and say so.
    assert!(ide.ignored.iter().any(|line| line.contains("'inertiaPage' is not supported")), "{:?}", ide.ignored);
    assert!(ide.ignored.iter().any(|line| line.contains("helperCode")), "{:?}", ide.ignored);
    assert_eq!(ide.packages.disabled, ["livewire/livewire"]);
}

#[test]
fn rules_say_where_strings_of_a_kind_sit() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("nav_link('Home', '/*|*/');", Some("routeName")),
        ("nav_link('/*|*/', 'home');", None),
        ("blog_setting('/*|*/');", Some("configKey")),
        ("feed_theme('/*|*/');", Some("staticStrings")),
        ("feed_options(['theme' => '/*|*/']);", Some("staticStrings")),
        ("feed_options(['size' => '/*|*/']);", None),
        ("feed_options(['/*|*/' => 'x']);", None),
        ("stylesheet('/*|*/');", Some("directoryFiles")),
        // Not supported: ignored.
        ("inertia('/*|*/');", None),
        // The built-in patterns still hold.
        ("config('/*|*/');", Some("configKey")),
        // While typing.
        ("feed_theme('da/*|*/\n", Some("staticStrings")),
    ];
    for (body, expected) in table {
        assert_eq!(project.rule_kind_at(PROBE, &probe(body)), *expected, "{body}");
    }
    let rel = "app/View/Components/Probe.php";
    assert_eq!(project.rule_kind_at(rel, &component("'/*|*/'")), Some("viewName"));
    // Not a component: the class condition doesn't hold.
    let other = "<?php\n\nnamespace App;\n\nclass Other\n{\n    public function template(): string\n    {\n        return '/*|*/';\n    }\n}\n";
    assert_eq!(project.rule_kind_at("app/Other.php", other), None);
}

#[test]
fn rules_complete_and_go_to_their_kinds_targets() {
    let mut project = Project::app();
    let labels = project.rule_complete(PROBE, &probe("feed_theme('/*|*/');"));
    assert_eq!(labels, ["contrast", "dark", "light"]);
    let labels = project.rule_complete(PROBE, &probe("feed_options(['theme' => 'd/*|*/']);"));
    assert_eq!(labels, ["dark"]);

    // `prefix`: the keys below `blog.`.
    let labels = project.rule_complete(PROBE, &probe("blog_setting('/*|*/');"));
    assert_eq!(labels, ["comments", "feed", "posts_per_page"]);
    let labels = project.rule_complete(PROBE, &probe("blog_setting('feed./*|*/');"));
    assert_eq!(labels, ["enabled", "limit", "title"]);
    let targets = project.rule_definition(PROBE, &probe("blog_setting('feed.ti/*|*/tle');"));
    assert_eq!(targets, [("config/blog.php".to_owned(), 8, "title".to_owned())]);

    let labels = project.rule_complete(PROBE, &probe("nav_link('Posts', 'dashboard.posts./*|*/');"));
    assert!(labels.contains(&"dashboard.posts.create".to_owned()), "{labels:?}");

    let labels = project.rule_complete(PROBE, &probe("stylesheet('/*|*/');"));
    assert_eq!(labels, ["app"]);
    let targets = project.rule_definition(PROBE, &probe("stylesheet('a/*|*/pp');"));
    assert_eq!(targets, [("resources/css/app.css".to_owned(), 0, String::new())]);

    let rel = "app/View/Components/Probe.php";
    let labels = project.rule_complete(rel, &component("'posts./*|*/'"));
    assert!(labels.contains(&"show".to_owned()), "{labels:?}");
    let targets = project.rule_definition(rel, &component("'posts.sh/*|*/ow'"));
    assert_eq!(targets, [("resources/views/posts/show.blade.php".to_owned(), 0, String::new())]);
}

#[test]
fn rule_strings_are_usages_and_are_inspected() {
    let mut project = Project::app();
    // Find usages from a prefixed string finds the declaration and itself.
    let found = project.references(PROBE, &probe("blog_setting('feed.ti/*|*/tle');"));
    assert!(
        found.iter().any(|(path, _, text, kind)| path == "config/blog.php"
            && text == "title"
            && *kind == UsageKind::Declaration),
        "{found:?}"
    );
    assert!(
        found.iter().any(|(path, _, text, kind)| path == PROBE && text == "feed.title" && *kind == UsageKind::String),
        "{found:?}"
    );
    // A prefixed string can't be renamed.
    let (doc, pos) = project.open(PROBE, &probe("blog_setting('feed.ti/*|*/tle');"));
    let parsed = project.engine.parsed_document(doc).unwrap();
    let offset = parsed.line_index().byte(pos);
    let path = project.root.join(PROBE);
    assert_eq!(project.engine.string_ref_prepare_rename(&parsed, &path, offset), Some(None));
    project.engine.document_closed(doc);

    // The "undefined" inspections see the rules' strings, with the prefix.
    let body = "nav_link('Gone', 'nope.route');\n    nav_link('Home', 'home');\n    blog_setting('feed.nope');\n    blog_setting('feed.title');\n    template_of('missing.view');/*|*/";
    let (doc, _) = project.open(PROBE, &probe(body));
    let parsed = project.engine.parsed_document(doc).unwrap();
    let found = project.engine.undefined_references(&parsed, &path, &[&ConfigKey], &CancellationToken::new());
    let values: Vec<(&str, &str)> = found
        .iter()
        .map(|site| (&parsed.text()[site.start as usize..site.end as usize], site.problem.message.as_str()))
        .collect();
    assert_eq!(values, [("feed.nope", "Config key 'blog.feed.nope' is not defined")]);
    let inspected = project.engine.inspect(doc, &CancellationToken::new()).unwrap();
    let found: Vec<(u32, String)> = inspected
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_deref() == Some("PhpUndefinedRoute"))
        .map(|diagnostic| (diagnostic.range.start.line, diagnostic.message.clone()))
        .collect();
    assert_eq!(found, [(6, "Route 'nope.route' is not defined".to_owned())]);
    project.engine.document_closed(doc);
}

#[test]
fn ide_json_views_components_and_directives() {
    let project = Project::app();
    let views = project.engine.laravel_views().unwrap();
    let panel = views.get("widgets::panel").unwrap();
    assert!(panel.path.ends_with("vendor/acme/widgets/resources/views/panel.blade.php"), "{panel:?}");

    let catalog = project.engine.laravel_blade().unwrap();
    let stat = catalog.component("widgets::stat").unwrap();
    assert!(stat.view.as_ref().unwrap().ends_with("resources/components/stat.blade.php"));
    let chart = catalog.component("widgets::chart").unwrap();
    let (class, file) = chart.class.as_ref().unwrap();
    assert_eq!(class, "Acme\\Widgets\\Chart");
    // No such class: its `ide.json`.
    assert!(file.ends_with("vendor/acme/widgets/ide.json"));

    let price = catalog.directive("price").unwrap();
    assert_eq!(project.describe(&price.path, price.range), ("ide.json".to_owned(), 37, "price".to_owned()));
    assert!(catalog.directive("endfeature").is_some_and(|directive| directive.condition));
    let labels = project.blade_directive_labels("@pri");
    assert!(labels.contains(&"price".to_owned()), "{labels:?}");
}

impl Project {
    fn blade_directive_labels(&self, typed: &str) -> Vec<String> {
        let pos = Pos::new(0, typed.len() as u32);
        let found = self.engine.blade_directive_completion(typed, pos).unwrap_or_default();
        found.items.into_iter().map(|item| item.label).collect()
    }
}
