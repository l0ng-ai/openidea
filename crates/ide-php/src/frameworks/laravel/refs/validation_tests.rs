//! Validation rules (`validationRule`) and request fields (`requestField`):
//! caret fixtures, the unknown-rule inspection and the rule-array
//! intentions on the fixture app (`fixtures/laravel-app` with
//! `fixtures/laravel-stubs` as its `vendor/`).

use super::*;

const PROBE: &str = "app/Http/Controllers/Probe.php";

/// A controller of the app with `body` as the body of its `run` method.
fn controller(body: &str) -> String {
    format!(
        "<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Http\\Requests\\StorePostRequest;\nuse Illuminate\\Http\\Request;\nuse Illuminate\\Support\\Facades\\Validator;\n\nclass Probe extends Controller\n{{\n    public function run(Request $request, StorePostRequest $form): void\n    {{\n        {body}\n    }}\n}}\n"
    )
}

impl Project {
    fn write_file(&self, rel: &str, text: &str) {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        self.engine.files_changed(&[path], &[]);
        assert!(self.engine.wait_idle(std::time::Duration::from_secs(60)));
    }

    fn validation_kind_at(&mut self, body: &str) -> Option<&'static str> {
        let (doc, pos) = self.open(PROBE, &controller(body));
        let parsed = self.engine.parsed_document(doc).unwrap();
        let resolver = self.engine.resolver();
        let offset = parsed.line_index().byte(pos);
        let kind = site_at(&parsed, &resolver, offset).and_then(|site| kind_of(&site, &resolver)).map(|kind| kind.id());
        self.engine.document_closed(doc);
        kind
    }

    fn labels(&mut self, rel: &str, source: &str) -> Vec<String> {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        found.items.into_iter().map(|item| item.label).collect()
    }

    fn goto(&mut self, rel: &str, source: &str) -> Vec<(String, u32, String)> {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.definition(doc, pos).unwrap_or_default();
        let out = found.iter().map(|target| self.describe(&target.path, target.range)).collect();
        self.engine.document_closed(doc);
        out
    }

    /// The unknown-rule problems of a probe controller: `(line, message)`.
    fn rule_problems(&mut self, body: &str) -> Vec<(u32, String)> {
        let (doc, _) = self.open(PROBE, &format!("{}/*|*/", controller(body)));
        let inspected = self.engine.inspect(doc, &CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        inspected
            .diagnostics
            .iter()
            .filter(|d| d.code.as_deref() == Some("PhpUnknownValidationRule"))
            .map(|d| (d.range.start.line, d.message.clone()))
            .collect()
    }

    /// The context actions at the caret: `(title, new texts)`.
    fn rewrites(&mut self, source: &str) -> Vec<(String, Vec<String>)> {
        let (doc, pos) = self.open(PROBE, source);
        let actions = self
            .engine
            .code_actions(doc, Range::new(pos, pos), &[crate::imports::REWRITE.to_owned()])
            .unwrap()
            .into_iter()
            .filter(|action| action.title.contains("rule string"))
            .map(|action| {
                let texts = action
                    .edit
                    .files
                    .iter()
                    .flat_map(|file| match file {
                        FileEdit::Edit { edits, .. } => edits.iter().map(|e| e.new_text.clone()).collect(),
                        _ => Vec::new(),
                    })
                    .collect();
                (action.title, texts)
            })
            .collect();
        self.engine.document_closed(doc);
        actions
    }
}

#[test]
fn place_patterns_match_validation_strings() {
    let mut project = Project::app();
    let table: &[(&str, Option<&str>)] = &[
        ("$request->validate(['title' => 'required|/*|*/max:255']);", Some("validationRule")),
        ("$request->validate(['title' => ['required', '/*|*/max:255']]);", Some("validationRule")),
        ("$request->validate(['ti/*|*/tle' => 'required']);", None),
        ("$request->validateWithBag('post', ['title' => '/*|*/required']);", Some("validationRule")),
        ("Validator::make($request->all(), ['title' => '/*|*/required']);", Some("validationRule")),
        ("Validator::make(['title' => '/*|*/x'], []);", None),
        ("validator([], ['title' => '/*|*/required']);", Some("validationRule")),
        ("$request->input('/*|*/title');", Some("requestField")),
        ("$form->validated('/*|*/title');", Some("requestField")),
        ("$request->only(['/*|*/title', 'body']);", Some("requestField")),
        ("$request->input('title', '/*|*/x');", None),
    ];
    for (body, expected) in table {
        assert_eq!(project.validation_kind_at(body), *expected, "{body}");
    }
}

#[test]
fn form_request_rules_are_rule_strings() {
    let mut project = Project::app();
    let source = std::fs::read_to_string(project.root.join("app/Http/Requests/StorePostRequest.php")).unwrap();
    let probe = source.replace("'required|string|max:255'", "'required|string|ma/*|*/x:255'");
    let labels = project.labels("app/Http/Requests/StorePostRequest.php", &probe);
    assert!(labels.contains(&"max".to_owned()), "{labels:?}");
    assert!(labels.contains(&"max_digits".to_owned()), "{labels:?}");
    assert!(!labels.contains(&"required".to_owned()), "{labels:?}");
    // `messages()` returns no rules.
    let probe = source.replace("'slug.unique' =>", "'slug.uni/*|*/que' =>");
    assert!(!project.labels("app/Http/Requests/StorePostRequest.php", &probe).contains(&"max".to_owned()));
}

#[test]
fn completes_rule_names_and_parameters() {
    let mut project = Project::app();
    let labels = project.labels(PROBE, &controller("$request->validate(['title' => 'nullable|requ/*|*/']);"));
    assert!(labels.contains(&"required".to_owned()), "{labels:?}");
    assert!(labels.contains(&"required_if".to_owned()), "{labels:?}");
    assert!(!labels.contains(&"nullable".to_owned()), "{labels:?}");

    // Tables, then the columns of the table.
    let labels = project.labels(PROBE, &controller("$request->validate(['post' => 'exists:/*|*/']);"));
    assert!(["posts", "tags", "users"].iter().all(|t| labels.contains(&t.to_string())), "{labels:?}");
    let labels = project.labels(PROBE, &controller("$request->validate(['post' => ['exists:posts,sl/*|*/']]);"));
    assert_eq!(labels, ["slug"]);

    // Other fields of the same array, not the field's own.
    let labels = project.labels(
        PROBE,
        &controller(
            "$request->validate(['title' => 'required', 'body' => 'required_if:/*|*/', 'status' => 'string']);\n        $request->validate(['other' => 'string']);",
        ),
    );
    assert_eq!(labels, ["status", "title"]);
    // Values of `in:` have nothing to offer.
    let labels = project.labels(PROBE, &controller("$request->validate(['title' => 'in:/*|*/']);"));
    assert!(labels.iter().all(|label| label != "title"), "{labels:?}");
}

#[test]
fn completes_and_resolves_request_fields() {
    let mut project = Project::app();
    // A Form Request: the fields of its `rules()`.
    let labels = project.labels(PROBE, &controller("$form->validated('/*|*/');"));
    assert_eq!(labels, ["body", "published_at", "slug", "status", "title"]);
    let found = project.goto(PROBE, &controller("$form->input('sl/*|*/ug');"));
    assert_eq!(found, [("app/Http/Requests/StorePostRequest.php".to_owned(), 21, "slug".to_owned())]);

    // A plain request: the fields validated in the file.
    let labels = project.labels(
        PROBE,
        &controller(
            "$request->validate(['name' => 'required', 'email' => 'email']);\n        $request->input('/*|*/');",
        ),
    );
    assert_eq!(labels, ["email", "name"]);
}

#[test]
fn goto_from_rule_parameters() {
    let mut project = Project::app();
    let found = project.goto(PROBE, &controller("$request->validate(['post' => 'exists:posts,sl/*|*/ug']);"));
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].0.ends_with("create_posts_table.php"), "{found:?}");
    assert_eq!(found[0].2, "'slug'");
    let found = project
        .goto(PROBE, &controller("$request->validate(['password' => 'required', 'confirm' => 'same:pass/*|*/word']);"));
    assert_eq!(found, [(PROBE.to_owned(), 11, "password".to_owned())]);
}

#[test]
fn reports_unknown_rules() {
    let mut project = Project::app();
    let found = project.rule_problems(
        "$request->validate(['title' => 'required|requird|max:255', 'body' => ['strng', 'phone_number'], 'x' => 'string']);",
    );
    assert_eq!(
        found,
        [
            (11, "Unknown validation rule 'requird'".to_owned()),
            (11, "Unknown validation rule 'strng'".to_owned()),
            (11, "Unknown validation rule 'phone_number'".to_owned()),
        ]
    );
    // Registering a rule makes it known.
    let found = project.rule_problems("$request->validate(['body' => 'phone_number']);");
    assert_eq!(found, [(11, "Unknown validation rule 'phone_number'".to_owned())]);
    project.write_file(
        "app/Providers/ValidationServiceProvider.php",
        "<?php\nnamespace App\\Providers;\n\nuse Illuminate\\Support\\Facades\\Validator;\n\nclass ValidationServiceProvider\n{\n    public function boot(): void\n    {\n        Validator::extend('phone_number', fn () => true);\n    }\n}\n",
    );
    assert!(project.rule_problems("$request->validate(['body' => 'phone_number']);").is_empty());
}

#[test]
fn converts_rule_strings_to_arrays() {
    let mut project = Project::app();
    let source = controller(
        "$request->validate(['title' => 'required|max/*|*/:255', 'body' => \"nullable\", 'tags' => ['array']]);",
    );
    let found = project.rewrites(&source);
    assert_eq!(
        found,
        [
            ("Convert rule string to array".to_owned(), vec!["['required', 'max:255']".to_owned()]),
            (
                "Convert all rule strings to arrays".to_owned(),
                vec!["['required', 'max:255']".to_owned(), "[\"nullable\"]".to_owned()]
            ),
        ]
    );
    // Not on a string of a rules array already.
    let source = controller("$request->validate(['tags' => ['arr/*|*/ay']]);");
    assert!(project.rewrites(&source).is_empty());
}
