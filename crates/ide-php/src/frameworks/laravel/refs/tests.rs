use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ide_core::{CancellationToken, DocId, FileEdit, IdeEvent, Pos, Range, SharedSink};

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use crate::frameworks::laravel::ConfigKeys;
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;
use crate::syntax::LineIndex;

const CARET: &str = "/*|*/";

/// The text without the caret marker, and the caret's position.
fn caret(source: &str) -> (String, Pos) {
    let at = source.find(CARET).expect("a /*|*/ caret");
    let text = format!("{}{}", &source[..at], &source[at + CARET.len()..]);
    let pos = LineIndex::new(&text).pos(at as u32);
    (text, pos)
}

const COMPOSER: &str = r#"{"require": {"laravel/framework": "^11.0"}, "autoload": {"psr-4": {"App\\": "app/"}}}"#;

const APP_CONFIG: &str =
    "<?php\n\nreturn [\n    'name' => env('APP_NAME', 'Laravel'),\n    'env' => 'production',\n];\n";

const BLOG_CONFIG: &str = r#"<?php

return [
    'posts_per_page' => 10,
    'feed' => [
        'enabled' => true,
        'title' => 'Latest posts',
    ],
];
"#;

const MAIL_CONFIG: &str = "<?php\n\nreturn ['driver' => 'smtp'];\n";

const FEED: &str = r#"<?php
namespace App;

use Illuminate\Support\Facades\Config;

class Feed
{
    public function build(): void
    {
        if (config('blog.feed.enabled')) {
            echo Config::get('blog.feed.title');
        }
        echo config('blog.posts_per_page');
    }
}
"#;

const SETTINGS: &str = r#"<?php
namespace App;

class Settings
{
    public function on(): bool
    {
        return (bool) config('blog.feed.enabled', false);
    }
}
"#;

struct Project {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
    next_doc: u32,
}

impl Project {
    fn new(files: &[(&str, &str)]) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        for (rel, text) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(Duration::from_secs(60)));
        Self { _tmp: tmp, root: crate::project::normalize(&root), engine, next_doc: 1 }
    }

    fn laravel() -> Self {
        Self::new(&[
            ("composer.json", COMPOSER),
            ("config/app.php", APP_CONFIG),
            ("config/blog.php", BLOG_CONFIG),
            ("config/services/mail.php", MAIL_CONFIG),
            ("app/Feed.php", FEED),
            ("app/Settings.php", SETTINGS),
        ])
    }

    fn open(&mut self, rel: &str, source: &str) -> (DocId, Pos) {
        let (text, pos) = caret(source);
        let doc = DocId(self.next_doc);
        self.next_doc += 1;
        self.engine.document_opened(doc, &self.root.join(rel), 1, &text);
        (doc, pos)
    }

    /// The kind of the string at the caret of `body`, put in a method of
    /// a class of the app.
    fn kind_at(&mut self, body: &str) -> Option<&'static str> {
        let source = format!("<?php\nnamespace App\\Http;\n\nuse Illuminate\\Support\\Facades\\Config;\n\n{body}\n");
        let (doc, pos) = self.open("app/Http/Probe.php", &source);
        let parsed = self.engine.parsed_document(doc).unwrap();
        let resolver = self.engine.resolver();
        let offset = parsed.line_index().byte(pos);
        let kind = site_at(&parsed, &resolver, offset).and_then(|site| kind_of(&site, &resolver)).map(|kind| kind.id());
        self.engine.document_closed(doc);
        kind
    }

    fn complete(&mut self, source: &str) -> Vec<String> {
        let (doc, pos) = self.open("app/Http/Probe.php", source);
        let found = self.engine.completion(doc, pos, None, &CancellationToken::new()).unwrap();
        self.engine.document_closed(doc);
        found.items.into_iter().map(|item| item.label).collect()
    }

    /// `(relative path, line, text)` of a range.
    fn describe(&self, path: &Path, range: Range) -> (String, u32, String) {
        let text = match self.engine.open_document(path) {
            Some(document) => document.text.to_string(),
            None => std::fs::read_to_string(path).unwrap(),
        };
        let index = LineIndex::new(&text);
        let (start, end) = index.byte_range(range);
        let rel = path.strip_prefix(&self.root).unwrap().to_string_lossy().replace('\\', "/");
        (rel, range.start.line, text[start as usize..end as usize].to_owned())
    }

    fn definition(&mut self, source: &str) -> Option<Vec<(String, u32, String)>> {
        let (doc, pos) = self.open("app/Http/Probe.php", source);
        let found = self.engine.definition(doc, pos);
        self.engine.document_closed(doc);
        found.map(|targets| targets.iter().map(|target| self.describe(&target.path, target.range)).collect())
    }

    fn references(&mut self, rel: &str, source: &str) -> Vec<(String, u32, String, UsageKind)> {
        let (doc, pos) = self.open(rel, source);
        let found = self.engine.references(doc, pos, true, &CancellationToken::new()).unwrap().unwrap();
        let out = found
            .iter()
            .map(|usage| {
                let (path, line, text) = self.describe(&usage.path, usage.range);
                (path, line, text, usage.kind)
            })
            .collect();
        self.engine.document_closed(doc);
        out
    }

    /// The rename's edits as `(relative path, line, replaced text)`, sorted.
    fn rename(&mut self, rel: &str, source: &str, new_name: &str) -> Vec<(String, u32, String)> {
        let (doc, pos) = self.open(rel, source);
        let edit = self.engine.rename(doc, pos, new_name, &CancellationToken::new()).unwrap().unwrap();
        let mut out = Vec::new();
        for file in &edit.files {
            let FileEdit::Edit { path, edits, .. } = file else { panic!("only text edits") };
            let path = PathBuf::from(path.clone());
            for edit in edits {
                assert_eq!(edit.new_text, new_name);
                out.push(self.describe(&path, edit.range));
            }
        }
        self.engine.document_closed(doc);
        out.sort();
        out
    }
}

fn method(body: &str) -> String {
    format!("class Probe\n{{\n    public function run(): void\n    {{\n        {body}\n    }}\n}}")
}

#[test]
fn place_patterns_match_config_strings() {
    let mut project = Project::laravel();
    let table: &[(&str, Option<&str>)] = &[
        ("config('/*|*/app.name');", Some("configKey")),
        ("config('app.na/*|*/me', 'x');", Some("configKey")),
        ("config('app.name', '/*|*/x');", None),
        ("config(key: 'app/*|*/.name');", Some("configKey")),
        ("config(default: 'app/*|*/.name');", None),
        ("config(['app.na/*|*/me' => 'x']);", Some("configKey")),
        ("config(['app.name' => 'x/*|*/']);", None),
        ("config([['app/*|*/' => 'x']]);", None),
        ("\\config('app/*|*/');", Some("configKey")),
        ("Config::get('app/*|*/');", Some("configKey")),
        ("Config::boolean('app/*|*/', false);", Some("configKey")),
        ("\\Config::has('app/*|*/');", Some("configKey")),
        ("Config::set(['app/*|*/' => 1]);", Some("configKey")),
        ("Config::getMany(['app/*|*/', 'b' => 1]);", Some("configKey")),
        ("Config::getMany(['a' => 'app/*|*/']);", None),
        ("Config::other('app/*|*/');", None),
        ("config()->get('app/*|*/');", Some("configKey")),
        ("config()?->get('app/*|*/');", Some("configKey")),
        ("config('x')->get('app/*|*/');", None),
        ("trans('app/*|*/');", None),
        ("$x->get('app/*|*/');", None),
        ("$x = 'app/*|*/';", None),
        // Partial strings while typing.
        ("config('app.na/*|*/\n", Some("configKey")),
        ("$v = Config::get('ap/*|*/\n", Some("configKey")),
    ];
    for (body, expected) in table {
        assert_eq!(project.kind_at(&method(body)), *expected, "{body}");
    }
    // A typed repository, its contract, a subclass.
    let typed = "class Probe\n{\n    public function run(\\Illuminate\\Contracts\\Config\\Repository $c): void\n    {\n        $c->get('app/*|*/');\n    }\n}";
    assert_eq!(project.kind_at(typed), Some("configKey"));
    let subclass =
        "class Repo extends \\Illuminate\\Config\\Repository {}\nfunction f(Repo $r) { $r->set('app/*|*/', 1); }";
    assert_eq!(project.kind_at(subclass), Some("configKey"));
}

#[test]
fn nothing_outside_laravel_projects() {
    let mut project = Project::new(&[("config/app.php", APP_CONFIG), ("composer.json", "{}")]);
    let labels = project.complete("<?php\nconfig('app./*|*/');\n");
    assert!(!labels.contains(&"name".to_owned()), "{labels:?}");
    assert!(project.engine.laravel_config().is_none());
}

#[test]
fn config_keys_are_read_from_the_config_folder() {
    let project = Project::laravel();
    let keys: Arc<ConfigKeys> = project.engine.laravel_config().unwrap();
    let all: Vec<&str> = keys.entries().iter().map(|entry| entry.key.as_str()).collect();
    assert_eq!(
        all,
        [
            "app",
            "app.env",
            "app.name",
            "blog",
            "blog.feed",
            "blog.feed.enabled",
            "blog.feed.title",
            "blog.posts_per_page",
            "services.mail",
            "services.mail.driver"
        ]
    );
    let name = keys.get("app.name").unwrap();
    assert_eq!(name.value.as_deref(), Some("env('APP_NAME', 'Laravel')"));
    assert!(!name.is_array && !name.is_file);
    assert!(keys.get("blog.feed").unwrap().is_array);
    let files: Vec<&str> = keys.children(None).map(|entry| entry.key.as_str()).collect();
    assert_eq!(files, ["app", "blog", "services.mail"]);
    let feed: Vec<&str> = keys.children(Some("blog.feed")).map(|entry| entry.segment()).collect();
    assert_eq!(feed, ["enabled", "title"]);
    assert_eq!(keys.file_of("services.mail.driver").unwrap().key, "services.mail");
    // An open buffer wins over the disk.
    let mut project = project;
    project.open("config/app.php", "<?php\nreturn ['renamed' => 1];\n/*|*/");
    let keys = project.engine.laravel_config().unwrap();
    assert!(keys.get("app.renamed").is_some() && keys.get("app.name").is_none());
}

#[test]
fn completes_keys_segment_by_segment() {
    let mut project = Project::laravel();
    let top = project.complete(&format!("<?php\n{}", method("config('/*|*/');")));
    assert_eq!(top, ["app", "blog", "services.mail"]);
    let app = project.complete(&format!("<?php\n{}", method("config('app./*|*/');")));
    assert_eq!(app, ["env", "name"]);
    let feed = project.complete(&format!("<?php\n{}", method("Config::get('blog.feed.ti/*|*/');")));
    assert_eq!(feed, ["title"]);
    let folder = project.complete(&format!("<?php\n{}", method("config('services./*|*/');")));
    assert_eq!(folder, ["mail"]);
    // A partial string, and the replaced range: the segment only.
    let (doc, pos) = project.open("app/Http/Probe.php", "<?php\n$a = config('blog.fe/*|*/\n$b = 1;\n");
    let found = project.engine.completion(doc, pos, Some("'"), &CancellationToken::new()).unwrap();
    assert!(found.incomplete);
    let item = found.items.iter().find(|item| item.label == "feed").expect("feed");
    assert_eq!(item.detail.as_deref(), Some("array"));
    assert_eq!(item.replace, Range::new(Pos::new(1, 18), pos));
    assert_eq!(found.items.len(), 1);
    // In the middle of a closed string: Tab replaces the whole segment.
    let (doc, pos) = project.open("app/Http/Other.php", "<?php\n$a = config('blog.po/*|*/sts_per_page.x');\n");
    let found = project.engine.completion(doc, pos, None, &CancellationToken::new()).unwrap();
    let item = found.items.iter().find(|item| item.label == "posts_per_page").expect("posts_per_page");
    assert_eq!(item.detail.as_deref(), Some("10"));
    assert_eq!(item.replace_tab, Some(Range::new(Pos::new(1, 18), Pos::new(1, 32))));
}

#[test]
fn goto_opens_the_segment_at_the_caret() {
    let mut project = Project::laravel();
    let key = project.definition(&format!("<?php\n{}", method("config('app.na/*|*/me');")));
    assert_eq!(key, Some(vec![("config/app.php".to_owned(), 3, "name".to_owned())]));
    let file = project.definition(&format!("<?php\n{}", method("config('a/*|*/pp.name');")));
    assert_eq!(file, Some(vec![("config/app.php".to_owned(), 0, String::new())]));
    let nested = project.definition(&format!("<?php\n{}", method("Config::get('blog.fe/*|*/ed.title');")));
    assert_eq!(nested, Some(vec![("config/blog.php".to_owned(), 4, "feed".to_owned())]));
    let folder = project.definition(&format!("<?php\n{}", method("config('services.mail.dri/*|*/ver');")));
    assert_eq!(folder, Some(vec![("config/services/mail.php".to_owned(), 2, "driver".to_owned())]));
    let unknown = project.definition(&format!("<?php\n{}", method("config('app.nope/*|*/');")));
    assert_eq!(unknown, Some(vec![]));
    // Not a reference: the usual goto answers.
    let other = project.definition(&format!("<?php\n{}", method("$x = 'app.na/*|*/me';")));
    assert_ne!(other, Some(vec![("config/app.php".to_owned(), 3, "name".to_owned())]));
}

#[test]
fn finds_usages_from_a_usage_and_from_the_declaration() {
    let mut project = Project::laravel();
    let expected = vec![
        ("app/Feed.php".to_owned(), 9, "blog.feed.enabled".to_owned(), UsageKind::String),
        ("app/Settings.php".to_owned(), 7, "blog.feed.enabled".to_owned(), UsageKind::String),
        ("config/blog.php".to_owned(), 5, "enabled".to_owned(), UsageKind::Declaration),
    ];
    let mut from_usage = project.references(
        "app/Settings.php",
        &SETTINGS.replace("config('blog.feed.enabled'", "config('blog.feed.ena/*|*/bled'"),
    );
    from_usage.sort();
    assert_eq!(from_usage, expected);
    let mut from_declaration =
        project.references("config/blog.php", &BLOG_CONFIG.replace("'enabled'", "'ena/*|*/bled'"));
    from_declaration.sort();
    assert_eq!(from_declaration, expected);
}

#[test]
fn renames_a_segment_in_the_declaration_and_every_usage() {
    let mut project = Project::laravel();
    let edits = project.rename(
        "app/Settings.php",
        &SETTINGS.replace("config('blog.feed.enabled'", "config('blog.feed.ena/*|*/bled'"),
        "active",
    );
    assert_eq!(
        edits,
        [
            ("app/Feed.php".to_owned(), 9, "enabled".to_owned()),
            ("app/Settings.php".to_owned(), 7, "enabled".to_owned()),
            ("config/blog.php".to_owned(), 5, "enabled".to_owned()),
        ]
    );
    // A parent key: the keys below it change too.
    let edits = project.rename("config/blog.php", &BLOG_CONFIG.replace("'feed'", "'fe/*|*/ed'"), "news");
    assert_eq!(
        edits,
        [
            ("app/Feed.php".to_owned(), 9, "feed".to_owned()),
            ("app/Feed.php".to_owned(), 10, "feed".to_owned()),
            ("app/Settings.php".to_owned(), 7, "feed".to_owned()),
            ("config/blog.php".to_owned(), 4, "feed".to_owned()),
        ]
    );
    // The range offered, and what can't be renamed.
    let (doc, pos) = project.open("app/Http/Probe.php", "<?php\nconfig('app.na/*|*/me');\n");
    assert_eq!(project.engine.prepare_rename(doc, pos), Some(Some(Range::new(Pos::new(1, 12), Pos::new(1, 16)))));
    let (doc, pos) = project.open("app/Http/File.php", "<?php\nconfig('a/*|*/pp.name');\n");
    assert_eq!(project.engine.prepare_rename(doc, pos), Some(None));
    assert!(project.engine.rename(doc, pos, "application", &CancellationToken::new()).unwrap().is_err());
    let (doc, pos) = project.open("app/Http/Bad.php", "<?php\nconfig('app.na/*|*/me');\n");
    assert!(project.engine.rename(doc, pos, "a.b", &CancellationToken::new()).unwrap().is_err());
}

#[test]
fn highlights_usages_in_the_document() {
    let mut project = Project::laravel();
    let source = "<?php\nconfig('app.na/*|*/me');\nConfig::get('app.name');\nconfig('app.env');\n$x = 'app.name';\n";
    let (doc, pos) = project.open("app/Http/Probe.php", source);
    let found = project.engine.string_highlights(doc, pos).unwrap();
    let lines: Vec<(u32, bool)> = found.iter().map(|highlight| (highlight.range.start.line, highlight.write)).collect();
    assert_eq!(lines, [(1, false), (2, false)]);
    // In the configuration file: the declaration is a write.
    let (doc, pos) = project.open("config/app.php", &APP_CONFIG.replace("'name'", "'na/*|*/me'"));
    let found = project.engine.string_highlights(doc, pos).unwrap();
    assert_eq!(found, [StringHighlight { range: Range::new(Pos::new(3, 5), Pos::new(3, 9)), write: true }]);
    // Not on a reference.
    let (doc, pos) = project.open("app/Http/None.php", "<?php\n$x = 'app.na/*|*/me';\n");
    assert_eq!(project.engine.string_highlights(doc, pos), None);
}

#[test]
fn kinds_validate_values() {
    let project = Project::laravel();
    let cx = project.engine.ref_context().unwrap();
    assert!(ConfigKey.is_known(&cx, "app.name"));
    assert!(ConfigKey.is_known(&cx, "blog.feed"));
    assert!(!ConfigKey.is_known(&cx, "app.nope"));
}

#[path = "route_tests.rs"]
mod route_tests;

#[path = "view_tests.rs"]
mod view_tests;

#[path = "blade_tests.rs"]
mod blade_tests;
