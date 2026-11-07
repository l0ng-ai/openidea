//! Completion, hover and goto for the members Laravel only has through
//! magic methods (facades, Eloquent forwarding, scopes, attributes), on the
//! stubs of the Laravel provider's tests.

use super::*;
use crate::complete::{CompletionData, CompletionKind, Completions};
use crate::types::provider::laravel::tests::{APP, APPLICATION, FRAMEWORK, PROJECT};

const MAIN: &str = "bin/main.php";

/// `bin/main.php` importing the stubs' classes, then `body`.
fn main(body: &str) -> String {
    format!(
        "<?php\nnamespace Main;\n\nuse App\\Models\\{{User, Post, Invoice}};\nuse App\\Facades\\{{Payments, Cache}};\n\n{body}\n"
    )
}

fn laravel(installed: bool) -> Project {
    let mut files = vec![("lib/framework.php", FRAMEWORK), ("lib/app.php", APP), ("lib/project.php", PROJECT)];
    if installed {
        files.push(("lib/application.php", APPLICATION));
    }
    Project::new(&files)
}

/// The 0-based line of the first line of `text` containing `needle`.
fn line_of(text: &str, needle: &str) -> u32 {
    text.lines().position(|line| line.contains(needle)).unwrap_or_else(|| panic!("{needle}")) as u32
}

impl Project {
    fn complete(&mut self, body: &str) -> Completions {
        let (text, pos) = caret(&main(body));
        let doc = self.open(MAIN, &text);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).expect("handled");
        self.engine.document_closed(doc);
        found
    }

    fn hover_at(&mut self, body: &str) -> String {
        let (text, pos) = caret(&main(body));
        let doc = self.open(MAIN, &text);
        let hover = self.engine.hover(doc, pos);
        self.engine.document_closed(doc);
        hover.unwrap_or_else(|| panic!("a hover in {body}")).markdown
    }

    fn documentation(&mut self, data: &CompletionData) -> Option<String> {
        let doc = self.open(MAIN, &main(""));
        let found = self.engine.completion_documentation(doc, data);
        self.engine.document_closed(doc);
        found
    }
}

/// `(kind, label detail, detail)` of the item called `label` (the property
/// when there is a method of the same name too).
fn item(found: &Completions, label: &str) -> (CompletionKind, Option<String>, Option<String>) {
    let labels: Vec<&str> = found.items.iter().map(|item| item.label.as_str()).collect();
    let named = || found.items.iter().filter(|item| item.label == label);
    let item = named()
        .find(|item| item.kind == CompletionKind::Property)
        .or_else(|| named().next())
        .unwrap_or_else(|| panic!("{label} in {labels:?}"));
    (item.kind, item.label_detail.clone(), item.detail.clone())
}

fn has(found: &Completions, label: &str) -> bool {
    found.items.iter().any(|item| item.label == label)
}

#[test]
fn completion_lists_facade_and_builder_methods() {
    let mut project = laravel(true);

    // A facade: its service's methods, as static.
    let found = project.complete("Payments::/*|*/");
    assert_eq!(item(&found, "charge"), (CompletionKind::Method, Some("(int $cents)".into()), Some("bool".into())));
    let found = project.complete("Cache::/*|*/");
    assert_eq!(item(&found, "store").0, CompletionKind::Method);

    // A model class: its scopes (without the query parameter), the
    // builders' methods; not the magic methods, not the attributes.
    let found = project.complete("User::/*|*/");
    assert_eq!(item(&found, "active").1.as_deref(), Some("()"));
    for label in ["where", "orderBy", "count", "first", "query"] {
        assert!(has(&found, label), "{label}");
    }
    for label in ["__call", "scopeActive", "posts", "paid"] {
        assert!(!has(&found, label), "{label}");
    }
    let data = found.items.iter().find(|item| item.label == "where").and_then(|item| item.data.clone());
    assert_eq!(
        data,
        Some(CompletionData::Method { class: "Illuminate\\Database\\Query\\Builder".into(), name: "where".into() })
    );

    // A builder and a relation: scopes and the query builder's methods.
    let found = project.complete("User::where('a', 1)->/*|*/");
    for label in ["active", "orderBy", "count", "first"] {
        assert!(has(&found, label), "{label}");
    }
    let found = project.complete("(new User())->posts()->/*|*/");
    for label in ["first", "where", "count"] {
        assert!(has(&found, label), "{label}");
    }
    // Nothing for dynamic wheres.
    assert!(!found.items.iter().any(|item| item.label.starts_with("whereT")));
}

#[test]
fn completion_lists_model_attributes() {
    let mut project = laravel(true);
    let found = project.complete("$user = new User();\n$user->/*|*/");
    let collection = "Illuminate\\Database\\Eloquent\\Collection<int, App\\Models\\Post>";
    assert_eq!(item(&found, "posts"), (CompletionKind::Property, None, Some(collection.into())));
    assert_eq!(item(&found, "full_name").2.as_deref(), Some("string"));
    assert_eq!(item(&found, "age").2.as_deref(), Some("int"));
    // The methods are still there, as methods.
    assert_eq!(item(&found, "plain").0, CompletionKind::Method);
    assert!(found.items.iter().any(|item| item.label == "posts" && item.kind == CompletionKind::Method));
    assert!(!has(&found, "active"), "scopes are called statically or on a builder");

    let found = project.complete("$invoice = new Invoice();\n$invoice->/*|*/");
    for (label, detail) in [
        ("paid", "bool"),
        ("status", "App\\Support\\Status"),
        ("note", "?string"),
        ("label", "?string"),
        ("number", "int"),
        ("created_at", "?Illuminate\\Support\\Carbon"),
    ] {
        assert_eq!(item(&found, label), (CompletionKind::Property, None, Some(detail.into())), "{label}");
    }
    let data = found.items.iter().find(|item| item.label == "paid").and_then(|item| item.data.clone()).unwrap();
    assert_eq!(data, CompletionData::MagicProperty { class: "App\\Models\\Invoice".into(), name: "paid".into() });
    let docs = project.documentation(&data).expect("documentation");
    assert!(docs.contains("public bool $paid"), "{docs}");

    // Without laravel/framework, none of it.
    let mut project = laravel(false);
    assert!(!has(&project.complete("Payments::/*|*/"), "charge"));
    assert!(!has(&project.complete("(new Invoice())->/*|*/"), "paid"));
}

#[test]
fn hover_shows_forwarded_methods_and_attribute_sources() {
    let mut project = laravel(true);

    let text = project.hover_at("Payments::cha/*|*/rge(1);");
    assert!(text.starts_with("`App\\Services\\PaymentGateway`\n\n"), "{text}");
    assert!(text.contains("public function charge(int $cents): bool"), "{text}");

    // The query builder's method, with the type the call has.
    let text = project.hover_at("User::wh/*|*/ere('a', 1);");
    assert!(text.starts_with("`Illuminate\\Database\\Query\\Builder`"), "{text}");
    let signature = "public function where(mixed $column, mixed $operator = null, mixed $value = null): \
                     Illuminate\\Database\\Eloquent\\Builder<App\\Models\\User>";
    assert!(text.contains(signature), "{text}");

    let text = project.hover_at("User::where('a', 1)->act/*|*/ive();");
    assert!(text.contains("function scopeActive("), "{text}");

    let text = project.hover_at("(new Invoice())->pa/*|*/id;");
    assert!(text.starts_with("`App\\Models\\Invoice`\n\n```php\n<?php\npublic bool $paid\n```"), "{text}");
    assert!(text.contains("cast to `boolean`"), "{text}");

    let text = project.hover_at("(new Invoice())->st/*|*/atus;");
    assert!(text.contains("public App\\Support\\Status $status"), "{text}");
    assert!(text.contains("cast to `App\\Support\\Status`"), "{text}");

    let text = project.hover_at("(new Invoice())->no/*|*/te;");
    assert!(text.contains("public ?string $note"), "{text}");
    assert!(text.contains("Column `note` of table `invoices` (`string`, nullable)"), "{text}");

    let text = project.hover_at("(new User())->po/*|*/sts;");
    assert!(text.contains("Collection<int, App\\Models\\Post> $posts"), "{text}");
    assert!(text.contains("Eloquent relation, defined by `posts()`"), "{text}");

    let text = project.hover_at("(new User())->full/*|*/_name;");
    assert!(text.contains("public string $full_name"), "{text}");
    assert!(text.contains("Eloquent accessor `getFullNameAttribute()`"), "{text}");
}

#[test]
fn goto_reaches_casts_columns_and_forwarded_methods() {
    let mut project = laravel(true);
    let mut goto = |body: &str| project.definition(MAIN, &main(body)).expect("handled");

    assert_eq!(
        goto("(new Invoice())->pa/*|*/id;"),
        [target("lib/project.php", line_of(PROJECT, "'paid' =>"), "'paid'")]
    );
    assert_eq!(
        goto("(new Invoice())->no/*|*/te;"),
        [target("lib/project.php", line_of(PROJECT, "->text('note')"), "'note'")]
    );
    // A column the method implies, and a later `Schema::table`.
    assert_eq!(
        goto("(new Invoice())->created/*|*/_at;"),
        [target("lib/project.php", line_of(PROJECT, "->timestamps()"), "timestamps")]
    );
    assert_eq!(
        goto("(new Invoice())->la/*|*/bel;"),
        [target("lib/project.php", line_of(PROJECT, "Schema::table('invoices'"), "'label'")]
    );
    // Relations and accessors: their methods.
    assert_eq!(goto("(new User())->po/*|*/sts;"), [target("lib/app.php", line_of(APP, "function posts()"), "posts")]);
    assert_eq!(
        goto("(new User())->full/*|*/_name;"),
        [target("lib/app.php", line_of(APP, "getFullNameAttribute"), "getFullNameAttribute")]
    );
    // Forwarded calls: the method they end up in.
    assert_eq!(goto("Payments::cha/*|*/rge(1);"), [target("lib/app.php", line_of(APP, "function charge("), "charge")]);
    assert_eq!(
        goto("User::act/*|*/ive();"),
        [target("lib/app.php", line_of(APP, "function scopeActive("), "scopeActive")]
    );
    assert_eq!(
        goto("User::where('a', 1)->order/*|*/By('a');"),
        [target("lib/framework.php", line_of(FRAMEWORK, "function orderBy("), "orderBy")]
    );
}

#[test]
fn magic_members_cannot_be_renamed() {
    let mut project = laravel(true);
    for body in ["(new Invoice())->pa/*|*/id;", "User::act/*|*/ive();", "Payments::cha/*|*/rge(1);"] {
        let (text, pos) = caret(&main(body));
        let doc = project.open(MAIN, &text);
        assert_eq!(project.engine.prepare_rename(doc, pos), Some(None), "{body}");
        project.engine.document_closed(doc);
    }
}
