//! The Laravel fixture app (`fixtures/laravel-app`) opened with the engine.
//!
//! The fixture has no `vendor/`: the test copies it to a temporary folder together with
//! `fixtures/laravel-stubs`, a Composer vendor directory holding minimal stand-ins for
//! laravel/framework, so the engine indexes it the way it indexes an installed app.
//!
//! Checks that every PHP file indexes and inspects with no problems except the deliberate
//! ones the fixture's README lists, and that the Laravel provider is on (a model attribute
//! from a migration is typed, hovered and completed).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ide_core::{CancellationToken, DocId, IdeEvent, Pos, SharedSink};
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use ide_php::project::LayoutConfig;
use ide_php::stubs::StubFilter;

/// The problems the fixture has on purpose: `(file, inspection, message part)`.
const DELIBERATE: &[(&str, &str, &str)] =
    &[("app/Http/Controllers/PostController.php", "PhpUndefinedMethod", "forgetCachedFeed")];

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// The PHP files below `dir` (Blade templates aside), relative to `root`, sorted.
fn php_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name != "vendor") {
                php_files(root, &path, out);
            }
        } else {
            let name = path.file_name().unwrap().to_string_lossy();
            if name.ends_with(".php") && !name.ends_with(".blade.php") {
                out.push(path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

struct App {
    engine: Arc<PhpEngine>,
    root: PathBuf,
    _tmp: tempfile::TempDir,
}

impl App {
    fn open() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("laravel-app");
        copy_dir(&fixtures().join("laravel-app"), &root);
        copy_dir(&fixtures().join("laravel-stubs"), &root.join("vendor"));
        let config = EngineConfig {
            cache_dir: tmp.path().join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(Duration::from_secs(120)), "the fixture indexes");
        App { engine, root, _tmp: tmp }
    }

    /// Opens `file`; returns its id and text.
    fn doc(&self, id: u32, file: &str) -> (DocId, String) {
        let text = std::fs::read_to_string(self.root.join(file)).unwrap();
        let doc = DocId(id);
        self.engine.document_opened(doc, &self.root.join(file), 1, &text);
        (doc, text)
    }
}

/// The position of the first `word` on the first line containing `line`.
fn locate(text: &str, line: &str, word: &str) -> Pos {
    let (index, content) = text.lines().enumerate().find(|(_, l)| l.contains(line)).expect(line);
    let col = content.find(word).expect(word);
    Pos::new(index as u32, content[..col].encode_utf16().count() as u32)
}

#[test]
fn indexes_without_unexpected_problems() {
    let app = App::open();
    let mut files = Vec::new();
    php_files(&app.root, &app.root, &mut files);
    files.sort();
    assert!(files.len() >= 25, "the fixture's PHP files: {files:?}");

    let mut unexpected = Vec::new();
    let mut deliberate = Vec::new();
    for (i, file) in files.iter().enumerate() {
        let (doc, _) = app.doc(i as u32 + 1, file);
        let inspected = app.engine.inspect(doc, &CancellationToken::new()).unwrap();
        app.engine.document_closed(doc);
        for problem in &inspected.problems {
            let line = problem.range.start.line + 1;
            let found = format!("{file}:{line}: {} {}", problem.inspection, problem.message);
            let expected = DELIBERATE.iter().any(|(f, inspection, message)| {
                f == file && *inspection == problem.inspection && problem.message.contains(message)
            });
            if expected { deliberate.push(found) } else { unexpected.push(found) }
        }
    }
    assert!(unexpected.is_empty(), "unexpected problems:\n{}", unexpected.join("\n"));
    assert_eq!(deliberate.len(), DELIBERATE.len(), "the deliberate problems: {deliberate:?}");
}

#[test]
fn model_attributes_are_typed_hovered_and_completed() {
    let app = App::open();
    let (doc, text) = app.doc(1, "app/Http/Controllers/PostController.php");
    // A column from the posts migration, and a cast.
    let title = locate(&text, "$title = $post->title;", "title;");
    let ty = app.engine.type_at(doc, Pos::new(title.line, title.col + 1)).map(|ty| ty.to_string());
    assert_eq!(ty.as_deref(), Some("string"));
    let hover = app.engine.hover(doc, title).expect("hover on $post->title");
    assert!(hover.markdown.contains("public string $title"), "{}", hover.markdown);
    assert!(hover.markdown.contains("Column `title` of table `posts`"), "{}", hover.markdown);
    let published = locate(&text, "$published = $post->published_at;", "published_at");
    let hover = app.engine.hover(doc, published).expect("hover on $post->published_at");
    assert!(hover.markdown.contains("cast to `datetime`"), "{}", hover.markdown);

    // Completion after `$post->` lists columns, casts, relations and accessors.
    let line = locate(&text, "$title = $post->title;", "title;");
    let completions = app.engine.completion(doc, line, None, &CancellationToken::new()).expect("completions");
    let labels: Vec<&str> = completions.items.iter().map(|item| item.label.as_str()).collect();
    for wanted in ["title", "slug", "published_at", "comments_count", "author", "excerpt"] {
        assert!(labels.contains(&wanted), "{wanted} in {labels:?}");
    }
}
