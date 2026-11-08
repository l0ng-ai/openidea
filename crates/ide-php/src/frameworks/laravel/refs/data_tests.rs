//! Configuration keys (packages, types, hover, the undefined inspection),
//! environment keys (`envKey`), translations (`translationKey`) and Vite
//! assets (`viteAsset`): caret fixtures and quick-fixes on the fixture app
//! (`fixtures/laravel-app` with `fixtures/laravel-stubs` as its `vendor/`).

use ide_core::{Severity, TextEdit};

use super::*;
use crate::blade::BladeDocument;
use crate::frameworks::laravel::config::value_type;
use crate::frameworks::laravel::refs::translation_key::{LocaleText, TranslationRequest, create_translation_title};

/// One problem: `(line, code, message, severity)`.
type Found = (u32, String, String, Severity);

impl Project {
    fn data_kind_at(&mut self, body: &str) -> Option<&'static str> {
        let source = format!(
            "<?php\n\nuse Illuminate\\Support\\Env;\nuse Illuminate\\Support\\Facades\\Lang;\nuse Illuminate\\Support\\Facades\\Vite;\n\n{body}\n"
        );
        let (doc, pos) = self.open("app/Http/Probe.php", &source);
        let parsed = self.engine.parsed_document(doc).unwrap();
        let resolver = self.engine.resolver();
        let offset = parsed.line_index().byte(pos);
        let kind = site_at(&parsed, &resolver, offset).and_then(|site| kind_of(&site, &resolver)).map(|kind| kind.id());
        self.engine.document_closed(doc);
        kind
    }

    /// The problems of the Laravel reference inspections in `source`.
    fn reference_problems(&mut self, source: &str) -> (DocId, Vec<Found>) {
        let (doc, _) = self.open("app/Http/Probe.php", &format!("{source}/*|*/"));
        let inspected = self.engine.inspect(doc, &CancellationToken::new()).unwrap();
        let found = inspected
            .diagnostics
            .iter()
            .filter(|d| {
                d.code.as_deref().is_some_and(|code| {
                    crate::inspect::laravel::UndefinedReference::all()
                        .iter()
                        .any(|i| crate::inspect::Inspection::id(i) == code)
                })
            })
            .map(|d| (d.range.start.line, d.code.clone().unwrap(), d.message.clone(), d.severity))
            .collect();
        (doc, found)
    }

    /// The quick-fix starting with `title` at `pos`.
    fn fix_at(&self, doc: DocId, pos: Pos, title: &str) -> Option<crate::imports::ImportAction> {
        self.engine
            .code_actions(doc, Range::new(pos, pos), &[])
            .unwrap()
            .into_iter()
            .find(|action| action.title.starts_with(title))
    }

    /// The PHP completion labels in a Blade template of the app.
    fn template_labels(&self, rel: &str, source: &str) -> Vec<String> {
        let (text, pos) = caret(source);
        let path = self.root.join(rel);
        let blade = BladeDocument { doc: DocId(91), path: &path, version: 1, text: &text };
        let found = self.engine.blade_completion(&blade, pos, None, &CancellationToken::new());
        self.engine.document_closed(DocId(91));
        found.map(|found| found.items.into_iter().map(|item| item.label).collect()).unwrap_or_default()
    }

    fn hover_text(&mut self, source: &str) -> Option<String> {
        let (doc, pos) = self.open("app/Http/Probe.php", source);
        let found = self.engine.hover(doc, pos).map(|hover| hover.markdown);
        self.engine.document_closed(doc);
        found
    }

    /// Writes a file of the project and tells the engine.
    fn write(&self, rel: &str, text: &str) {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        self.engine.files_changed(&[path], &[]);
    }
}

/// The text edits of `edit` as `(relative path, line, new text)`.
fn text_edits(project: &Project, edit: &WorkspaceEdit) -> Vec<(String, u32, String)> {
    let mut out = Vec::new();
    for file in &edit.files {
        if let FileEdit::Edit { path, edits, .. } = file {
            let path = PathBuf::from(path.clone());
            let rel = path.strip_prefix(&project.root).unwrap().to_string_lossy().replace('\\', "/");
            for TextEdit { range, new_text } in edits {
                out.push((rel.clone(), range.start.line, new_text.clone()));
            }
        }
    }
    out.sort();
    out
}

// ------------------------------------------------------------- config

#[test]
fn value_types_come_from_the_source() {
    let table = [
        ("'Laravel'", Some("string")),
        ("10", Some("int")),
        ("1_000", Some("int")),
        ("1.5", Some("float")),
        ("true", Some("bool")),
        ("null", Some("null")),
        ("['a' => 1]", Some("array")),
        ("(int) env('X', 10)", Some("int")),
        ("(bool) env('X')", Some("bool")),
        ("env('APP_NAME', 'Laravel')", Some("string")),
        ("env('APP_DEBUG', false)", Some("bool")),
        ("env('APP_KEY')", Some("mixed")),
        ("storage_path('x')", None),
    ];
    for (source, expected) in table {
        assert_eq!(value_type(source).as_deref(), expected, "{source}");
    }
}

#[test]
fn config_keys_of_packages_and_hover() {
    let project = Project::app();
    // Laravel's own defaults (Laravel 11 merges them below the app's).
    project.write("vendor/laravel/framework/config/database.php", "<?php\nreturn ['default' => 'sqlite'];\n");
    let keys = project.engine.laravel_config().unwrap();
    let currency = keys.get("billing.currency").expect("merged by the module's provider");
    assert!(currency.path.ends_with("Modules/Billing/config/config.php"), "{currency:?}");
    assert_eq!(currency.ty.as_deref(), Some("string"));
    assert!(keys.get("billing.invoices.per_page").is_some());
    assert!(keys.get("database.default").is_some());
    assert_eq!(keys.get("blog.posts_per_page").unwrap().ty.as_deref(), Some("int"));
    assert_eq!(keys.get("blog.feed.enabled").unwrap().ty.as_deref(), Some("bool"));
    assert_eq!(keys.get("app.key").unwrap().ty.as_deref(), Some("mixed"));

    let mut project = project;
    let hover = project.hover_text("<?php\nconfig('blog.posts_per/*|*/_page');\n").unwrap();
    assert!(hover.contains("`blog.posts_per_page`"), "{hover}");
    assert!(hover.contains("(int) env('BLOG_POSTS_PER_PAGE', 10)"), "{hover}");
    assert!(hover.contains("`int` · config/blog.php"), "{hover}");
    // Completion offers the package's keys; a package key can't be renamed.
    let labels = project.complete("<?php\nconfig('billing./*|*/');\n");
    assert_eq!(labels, ["currency", "invoices"]);
    let (doc, pos) = project.open("app/Http/Probe.php", "<?php\nconfig('billing.curr/*|*/ency');\n");
    assert_eq!(project.engine.prepare_rename(doc, pos), Some(None));
}

#[test]
fn reports_undefined_config_keys() {
    let mut project = Project::app();
    let source = "<?php\nconfig('blog.nope');\nconfig('app.name');\nconfig('unknown.key');\nconfig('billing.invoices.nope');\nconfig('app.name.deeper');\nconfig('blog');\n";
    let (_, found) = project.reference_problems(source);
    assert_eq!(
        found,
        [
            (
                1,
                "PhpUndefinedConfigKey".to_owned(),
                "Config key 'blog.nope' is not defined".to_owned(),
                Severity::Warning
            ),
            (
                4,
                "PhpUndefinedConfigKey".to_owned(),
                "Config key 'billing.invoices.nope' is not defined".to_owned(),
                Severity::Warning
            ),
        ]
    );
}

// ---------------------------------------------------------------- env

#[test]
fn place_patterns_match_env_keys() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("env('/*|*/APP_NAME');", Some("envKey")),
        ("env('APP_/*|*/', 'x');", Some("envKey")),
        ("env('X', '/*|*/default');", None),
        ("Env::get('/*|*/X');", Some("envKey")),
        ("Env::getOrFail('/*|*/X');", Some("envKey")),
        ("env('APP_/*|*/\n", Some("envKey")),
    ];
    for (body, expected) in table {
        assert_eq!(project.data_kind_at(body), *expected, "{body}");
    }
}

#[test]
fn env_keys_complete_goto_and_hover() {
    let mut project = Project::app();
    let (doc, pos) = project.open("app/Http/Probe.php", "<?php\nenv('BLOG_/*|*/');\n");
    let found = project.engine.completion(doc, pos, None, &CancellationToken::new()).unwrap();
    let items: Vec<(String, Option<String>)> =
        found.items.iter().map(|item| (item.label.clone(), item.detail.clone())).collect();
    assert_eq!(
        items,
        [
            ("BLOG_FEED_ENABLED".to_owned(), Some("true".to_owned())),
            ("BLOG_POSTS_PER_PAGE".to_owned(), Some("10".to_owned()))
        ]
    );
    let targets = project.definition("<?php\nenv('APP_N/*|*/AME');\n").unwrap();
    assert_eq!(targets, [(".env.example".to_owned(), 0, "APP_NAME".to_owned())]);

    // A local `.env`: its value comes first, and both files are targets.
    project.write(".env", "APP_NAME=\"My Blog\"\nLOCAL_ONLY=1\n");
    let targets = project.definition("<?php\nenv('APP_N/*|*/AME');\n").unwrap();
    assert_eq!(
        targets,
        [(".env".to_owned(), 0, "APP_NAME".to_owned()), (".env.example".to_owned(), 0, "APP_NAME".to_owned())]
    );
    let hover = project.hover_text("<?php\nenv('APP_N/*|*/AME');\n").unwrap();
    assert_eq!(hover, "**env** `APP_NAME`\n\n.env: `My Blog`  \n.env.example: `Laravel Blog`");
    let labels = project.complete("<?php\nenv('LOCAL/*|*/');\n");
    assert_eq!(labels.first().map(String::as_str), Some("LOCAL_ONLY"), "{labels:?}");
}

#[test]
fn reports_undefined_env_keys_with_a_fix() {
    let mut project = Project::app();
    project.write(".env", "APP_NAME=Blog\nLOCAL_ONLY=1\n");
    let source = "<?php\nenv('NOPE');\nenv('APP_NAME');\nenv('LOCAL_ONLY', 2);\n";
    let (doc, found) = project.reference_problems(source);
    assert_eq!(
        found,
        [
            (
                1,
                "PhpUndefinedEnvKey".to_owned(),
                "Environment variable 'NOPE' is not defined in .env or .env.example".to_owned(),
                Severity::Warning
            ),
            (
                3,
                "PhpUndefinedEnvKey".to_owned(),
                "Environment variable 'LOCAL_ONLY' is missing from .env.example".to_owned(),
                Severity::Info
            ),
        ]
    );
    let fix = project.fix_at(doc, Pos::new(1, 6), "Add 'NOPE'").expect("the fix");
    assert_eq!(fix.title, "Add 'NOPE' to .env.example");
    assert!(fix.preferred);
    let example = std::fs::read_to_string(project.root.join(".env.example")).unwrap();
    let last = LineIndex::new(&example).pos(example.len() as u32).line;
    assert_eq!(text_edits(&project, &fix.edit), [(".env.example".to_owned(), last, "NOPE=\n".to_owned())]);
}

// ------------------------------------------------------- translations

#[test]
fn place_patterns_match_translation_keys() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("__('/*|*/messages.welcome');", Some("translationKey")),
        ("__('messages.welcome', ['/*|*/name' => 1]);", None),
        ("trans('/*|*/x');", Some("translationKey")),
        ("trans_choice('/*|*/x', 2);", Some("translationKey")),
        ("Lang::get('/*|*/x');", Some("translationKey")),
        ("Lang::has('/*|*/x');", Some("translationKey")),
        ("Lang::choice('/*|*/x', 1);", Some("translationKey")),
        ("trans()->get('/*|*/x');", Some("translationKey")),
        ("__('messages./*|*/\n", Some("translationKey")),
    ];
    for (body, expected) in table {
        assert_eq!(project.data_kind_at(body), *expected, "{body}");
    }
}

#[test]
fn translations_of_the_fixture_app() {
    let project = Project::app();
    let translations = project.engine.laravel_translations().unwrap();
    assert_eq!(translations.locales(), ["en", "fr"]);
    assert_eq!(project.engine.laravel_locales().unwrap(), ["en", "fr"]);
    let draft: Vec<(&str, Option<&str>)> =
        translations.get("messages.status.draft").map(|e| (e.locale.as_str(), e.text.as_deref())).collect();
    assert_eq!(draft, [("en", Some("Draft")), ("fr", Some("Brouillon"))]);
    let created: Vec<Option<&str>> = translations.get("messages.post_created").map(|e| e.text.as_deref()).collect();
    assert_eq!(created, [Some("The post was saved."), Some("L'article a été enregistré.")]);
    let json: Vec<&str> = translations.json_keys().iter().map(|entry| entry.key.as_str()).collect();
    assert_eq!(json, ["Invoices", "No posts yet.", "Read more"]);
    assert!(translations.get("messages.status").all(|entry| entry.is_group));
}

#[test]
fn translation_keys_complete_goto_hover_and_usages() {
    let mut project = Project::app();
    let top = project.complete("<?php\n__('/*|*/');\n");
    for label in ["messages", "Read more", "No posts yet.", "Invoices"] {
        assert!(top.contains(&label.to_owned()), "{label}: {top:?}");
    }
    let keys = project.complete("<?php\n__('messages./*|*/');\n");
    assert_eq!(keys, ["post_created", "slug_taken", "status", "welcome"]);
    let nested = project.complete("<?php\ntrans('messages.status.d/*|*/');\n");
    assert_eq!(nested, ["draft"]);

    let targets = project.definition("<?php\n__('messages.wel/*|*/come');\n").unwrap();
    assert_eq!(
        targets,
        [
            ("lang/en/messages.php".to_owned(), 4, "welcome".to_owned()),
            ("lang/fr/messages.php".to_owned(), 4, "welcome".to_owned())
        ]
    );
    let json = project.definition("<?php\n__('Read/*|*/ more');\n").unwrap();
    assert_eq!(
        json,
        [
            ("lang/en.json".to_owned(), 1, "Read more".to_owned()),
            ("lang/fr.json".to_owned(), 1, "Read more".to_owned())
        ]
    );
    let hover = project.hover_text("<?php\n__('messages.wel/*|*/come');\n").unwrap();
    assert_eq!(hover, "**en**: Welcome to :name  \n**fr**: Bienvenue sur :name");

    // Usages, from a key of a group file.
    let source = std::fs::read_to_string(project.root.join("lang/en/messages.php")).unwrap();
    let found = project.references("lang/en/messages.php", &source.replace("'post_created'", "'post_cr/*|*/eated'"));
    assert!(
        found.iter().any(|(path, _, text, kind)| path == "app/Http/Controllers/PostController.php"
            && text == "messages.post_created"
            && *kind == UsageKind::String),
        "{found:?}"
    );
    // In Blade: `@lang` and echoes.
    let labels = project.template_labels("resources/views/probe.blade.php", "@lang('messages./*|*/')\n");
    assert!(labels.contains(&"welcome".to_owned()), "{labels:?}");
    let labels = project.template_labels("resources/views/probe.blade.php", "{{ __('messages.st/*|*/') }}\n");
    assert_eq!(labels.first().map(String::as_str), Some("status"), "{labels:?}");
}

#[test]
fn reports_undefined_translations_with_a_create_fix() {
    let mut project = Project::app();
    let source = "<?php\n__('messages.nope');\n__('messages.welcome');\n__('Some sentence');\n__('pkg::x.y');\n__('messages.status.archived');\n__('Read more');\n";
    let (doc, found) = project.reference_problems(source);
    let lines: Vec<(u32, &str)> = found.iter().map(|(line, _, message, _)| (*line, message.as_str())).collect();
    assert_eq!(
        lines,
        [
            (1, "Translation key 'messages.nope' is not defined"),
            (3, "Translation key 'Some sentence' is not defined"),
            (5, "Translation key 'messages.status.archived' is not defined"),
        ]
    );
    let fix = project.fix_at(doc, Pos::new(1, 6), "Create translation key").expect("the fix");
    assert_eq!(fix.title, "Create translation key 'messages.nope'");
    assert_eq!(
        text_edits(&project, &fix.edit),
        [
            ("lang/en/messages.php".to_owned(), 12, "\n    'nope' => 'Nope',".to_owned()),
            ("lang/fr/messages.php".to_owned(), 12, "\n    'nope' => 'Nope',".to_owned()),
        ]
    );
    let fix = project.fix_at(doc, Pos::new(5, 6), "Create translation key").expect("the nested fix");
    assert_eq!(
        text_edits(&project, &fix.edit)[0],
        ("lang/en/messages.php".to_owned(), 11, "\n        'archived' => 'Archived',".to_owned())
    );
    let fix = project.fix_at(doc, Pos::new(3, 6), "Create translation key").expect("the JSON fix");
    assert_eq!(
        text_edits(&project, &fix.edit),
        [
            ("lang/en.json".to_owned(), 3, ",\n    \"Some sentence\": \"Some sentence\"".to_owned()),
            ("lang/fr.json".to_owned(), 3, ",\n    \"Some sentence\": \"Some sentence\"".to_owned()),
        ]
    );
    // The action with the texts asked for: a new group file.
    let edit = project
        .engine
        .laravel_create_translation("emails.subject", &[("en".to_owned(), "It's here".to_owned())])
        .unwrap();
    let [FileEdit::Create { path, overwrite: false }, FileEdit::Edit { edits, .. }] = edit.files.as_slice() else {
        panic!("{edit:?}")
    };
    assert_eq!(PathBuf::from(path.clone()), project.root.join("lang/en/emails.php"));
    assert_eq!(edits[0].new_text, "<?php\n\nreturn [\n    'subject' => 'It\\'s here',\n];\n");
    // A key every locale has adds nothing.
    let edit = project.engine.laravel_create_translation("messages.welcome", &[("en".to_owned(), "x".to_owned())]);
    assert_eq!(edit.map(|edit| edit.files.len()), Some(0));
}

impl Project {
    /// The "Create translation key…" request at the caret of a PHP file.
    fn translation_request(&mut self, source: &str) -> Option<TranslationRequest> {
        let (doc, pos) = self.open("app/Http/Probe.php", source);
        let found = self.engine.laravel_translation_request(doc, pos);
        self.engine.document_closed(doc);
        found
    }
}

fn locale(locale: &str, text: &str, exists: bool) -> LocaleText {
    LocaleText { locale: locale.to_owned(), text: text.to_owned(), exists }
}

#[test]
fn create_translation_key_action_asks_about_every_locale() {
    let mut project = Project::app();
    // An undefined key: every locale gets the suggested text.
    let request = project.translation_request("<?php\n__('messages.no/*|*/pe');\n").expect("the request");
    assert_eq!(
        request,
        TranslationRequest {
            key: "messages.nope".into(),
            locales: vec![locale("en", "Nope", false), locale("fr", "Nope", false)]
        }
    );
    // Whole strings go to the JSON files.
    let request = project.translation_request("<?php\ntrans('Some/*|*/ sentence');\n").expect("the JSON request");
    assert_eq!(request.locales, [locale("en", "Some sentence", false), locale("fr", "Some sentence", false)]);
    // A known key some locale lacks: the others show their text.
    project.write("lang/en/extra.php", "<?php\n\nreturn [\n    'only_en' => 'Only English',\n];\n");
    let request =
        project.translation_request("<?php\nLang::get('extra.only/*|*/_en');\n").expect("the partial request");
    assert_eq!(request.locales, [locale("en", "Only English", true), locale("fr", "Only en", false)]);
    // Not offered: a key every locale has, other strings, unknown namespaces,
    // dynamic keys, a group key whose place holds a string.
    for source in [
        "<?php\n__('messages.wel/*|*/come');\n",
        "<?php\nconfig('app./*|*/name');\n",
        "<?php\n__('pkg::x./*|*/y');\n",
        "<?php\n__(\"messages.{$x}/*|*/\");\n",
        "<?php\n__('messages.welcome.ne/*|*/sted');\n",
    ] {
        assert_eq!(project.translation_request(source), None, "{source}");
    }
    // The action's edit writes the dialog's answers.
    let edit = project.engine.laravel_create_translation("extra.only_en", &[("fr".to_owned(), "Seulement".to_owned())]);
    assert_eq!(
        text_edits(&project, &edit.unwrap()),
        [("lang/fr/extra.php".to_owned(), 0, "<?php\n\nreturn [\n    'only_en' => 'Seulement',\n];\n".to_owned())]
    );
    assert_eq!(create_translation_title("messages.nope"), "Create translation key 'messages.nope'…");

    // In Blade: `@lang` and echoes.
    let path = project.root.join("resources/views/probe.blade.php");
    for source in ["@lang('messages.ne/*|*/w_key')\n", "<p>{{ __('messages.ne/*|*/w_key') }}</p>\n"] {
        let (text, pos) = caret(source);
        let blade = BladeDocument { doc: DocId(92), path: &path, version: 1, text: &text };
        let request = project.engine.blade_translation_request(&blade, pos).expect(source);
        assert_eq!(request.key, "messages.new_key");
        assert_eq!(request.locales, [locale("en", "New key", false), locale("fr", "New key", false)]);
    }
    let (text, pos) = caret("<p>/*|*/{{ __('messages.new_key') }}</p>\n");
    let blade = BladeDocument { doc: DocId(92), path: &path, version: 1, text: &text };
    assert_eq!(project.engine.blade_translation_request(&blade, pos), None);
    project.engine.document_closed(DocId(92));
}

// --------------------------------------------------------------- vite

#[test]
fn place_patterns_match_vite_assets() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("Vite::asset('/*|*/resources/js/app.js');", Some("viteAsset")),
        ("Vite::content('/*|*/x');", Some("viteAsset")),
        ("Vite::withEntryPoints(['/*|*/x']);", Some("viteAsset")),
        ("Vite::asset('x', '/*|*/build');", None),
    ];
    for (body, expected) in table {
        assert_eq!(project.data_kind_at(body), *expected, "{body}");
    }
}

#[test]
fn vite_assets_complete_goto_and_report() {
    let project = Project::app();
    let assets = project.engine.laravel_assets().unwrap();
    assert_eq!(assets.entries().collect::<Vec<_>>(), ["resources/css/app.css", "resources/js/app.js"]);
    assert!(assets.is_known("resources/js/app.js") && !assets.is_known("resources/js/nope.js"));
    // The build manifest counts too.
    project.write("public/build/manifest.json", r#"{"resources/js/legacy.js": {"file": "assets/legacy.js"}}"#);
    assert!(project.engine.laravel_assets().unwrap().is_known("resources/js/legacy.js"));

    let mut project = project;
    let labels = project.template_labels("resources/views/probe.blade.php", "@vite('resources//*|*/')\n");
    assert_eq!(labels, ["css/", "js/"]);
    let labels = project.template_labels("resources/views/probe.blade.php", "@vite(['resources/css//*|*/'])\n");
    assert_eq!(labels, ["app.css"]);
    let targets =
        project.definition("<?php\n\\Illuminate\\Support\\Facades\\Vite::asset('resources/js/a/*|*/pp.js');\n");
    assert_eq!(targets, Some(vec![("resources/js/app.js".to_owned(), 0, String::new())]));

    let source = "<?php\nuse Illuminate\\Support\\Facades\\Vite;\nVite::asset('resources/img/nope.png');\nVite::asset('resources/js/app.js');\n";
    let (_, found) = project.reference_problems(source);
    assert_eq!(
        found,
        [(
            2,
            "PhpUndefinedViteAsset".to_owned(),
            "Vite asset 'resources/img/nope.png' is not found".to_owned(),
            Severity::Warning
        )]
    );
}

#[test]
fn blade_templates_report_undefined_references() {
    let project = Project::app();
    let text = "@vite('resources/js/missing.js')\n<p>{{ __('messages.nope') }}</p>\n<p>{{ config('blog.nope') }}</p>\n<p>{{ env('NOPE') }}</p>\n@lang('messages.welcome')\n";
    let problems = project.engine.blade_problems(text);
    let found: Vec<(u32, Option<&str>)> =
        problems.iter().map(|problem| (problem.range.start.line, problem.code.as_deref())).collect();
    assert_eq!(
        found,
        [
            (0, Some("PhpUndefinedViteAsset")),
            (1, Some("PhpUndefinedTranslation")),
            (2, Some("PhpUndefinedConfigKey")),
            (3, Some("PhpUndefinedEnvKey")),
        ]
    );
    assert_eq!(problems[1].range, Range::new(Pos::new(1, 10), Pos::new(1, 23)));
}
