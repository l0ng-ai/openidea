//! The native PHP engine as the editor drives it: documents opened, typed into, saved and
//! closed in several files at once, with completion, navigation, hover and diagnostics asked
//! between the edits through the same `ops` the app's commands call. What one file's edit
//! changes must show in the answers for the others, and what it doesn't change must not go
//! stale (positions after a body edit, an unsaved buffer closed, a buffer saved).

use ide_core::{ChangeSet, DocId, IdeEvent, Location, Pos, RequestId, SharedSink, TextChange};
use ide_host::{Host, HostConfig, ops};
use ide_lsp::types::GotoKind;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WINDOW: &str = "main";
const WAIT: Duration = Duration::from_secs(60);

fn utf16(s: &str) -> u32 {
    s.encode_utf16().count() as u32
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

struct Session {
    host: Arc<Host>,
    root: PathBuf,
    events: Arc<Mutex<Vec<IdeEvent>>>,
    _tmp: tempfile::TempDir,
}

impl Session {
    /// Opens a copy of `fixtures/<fixture>` (with `fixtures/<vendor>` as its `vendor/`) and
    /// waits for the engine to finish indexing it.
    async fn start(fixture: &str, vendor: Option<&str>) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join(fixture);
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        copy_dir(&fixtures.join(fixture), &root);
        if let Some(vendor) = vendor {
            copy_dir(&fixtures.join(vendor), &root.join("vendor"));
        }
        let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
        let app = base.join("app");
        let host = Arc::new(Host::new(HostConfig {
            config_dir: app.join("config"),
            data_dir: app.join("data"),
            local_data_dir: app.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new({
                let events = events.clone();
                move |_| {
                    let events = events.clone();
                    let sink: SharedSink = Arc::new(move |e: IdeEvent| events.lock().push(e));
                    sink
                }
            }),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.trust.decide(&root, true, false).unwrap();
        let project = host.open_project(WINDOW, &root).unwrap();
        let deadline = Instant::now() + WAIT;
        while project.php.engine().is_none() {
            assert!(Instant::now() < deadline, "the engine didn't start");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(project.php.engine().unwrap().wait_idle(Duration::from_secs(120)));
        Session { host, root, events, _tmp: tmp }
    }

    fn path(&self, file: &str) -> PathBuf {
        self.root.join(file)
    }

    async fn open(&self, file: &str) -> DocId {
        ops::doc::open(&self.host, WINDOW, self.path(file)).await.unwrap().id
    }

    async fn text(&self, doc: DocId) -> String {
        ops::doc::snapshot(&self.host, WINDOW, doc).await.unwrap().text
    }

    async fn splice(&self, doc: DocId, from: usize, to: usize, insert: &str) {
        let info = ops::doc::snapshot(&self.host, WINDOW, doc).await.unwrap();
        let (from, to) = (utf16(&info.text[..from]), utf16(&info.text[..to]));
        let changes = ChangeSet { changes: vec![TextChange { from, to, insert: insert.into() }] };
        ops::doc::edit(&self.host, WINDOW, doc, info.version, changes).unwrap();
    }

    /// Replaces the first occurrence of `what`.
    async fn replace(&self, doc: DocId, what: &str, with: &str) {
        let text = self.text(doc).await;
        let at = text.find(what).unwrap_or_else(|| panic!("no {what:?} in\n{text}"));
        self.splice(doc, at, at + what.len(), with).await;
    }

    /// Inserts `lines` (each on its own line) after the first line containing `after`, and
    /// returns the position at the end of the last one.
    async fn type_after(&self, doc: DocId, after: &str, lines: &str) -> Pos {
        let text = self.text(doc).await;
        let at = text.find(after).unwrap_or_else(|| panic!("no {after:?} in\n{text}"));
        let eol = at + text[at..].find('\n').unwrap_or(text.len() - at);
        let eol = if text[..eol].ends_with('\r') { eol - 1 } else { eol };
        self.splice(doc, eol, eol, &format!("\n{lines}")).await;
        let line = text[..eol].matches('\n').count() + lines.matches('\n').count() + 1;
        Pos::new(line as u32, utf16(lines.rsplit('\n').next().unwrap()))
    }

    /// The position of `word` on the first line containing `line` (the `nth` occurrence of
    /// the word on it, from 0).
    async fn pos(&self, doc: DocId, line: &str, word: &str) -> Pos {
        let text = self.text(doc).await;
        let (index, content) =
            text.lines().enumerate().find(|(_, l)| l.contains(line)).unwrap_or_else(|| panic!("no line {line:?}"));
        let col = content.find(word).unwrap_or_else(|| panic!("no {word:?} on {content:?}"));
        Pos::new(index as u32, utf16(&content[..col]))
    }

    /// The 0-based line of the first line of `file` (as open, or on disk) containing `needle`.
    async fn line_of(&self, doc: DocId, needle: &str) -> u32 {
        let text = self.text(doc).await;
        text.lines().position(|l| l.contains(needle)).unwrap_or_else(|| panic!("no line {needle:?}")) as u32
    }

    async fn goto(&self, doc: DocId, pos: Pos) -> Vec<Location> {
        ops::lsp::lsp_goto(&self.host, WINDOW, doc, pos, GotoKind::Definition).await.unwrap()
    }

    async fn completion(&self, doc: DocId, pos: Pos, trigger: Option<&str>) -> Vec<String> {
        let list =
            ops::lsp::lsp_completion(&self.host, WINDOW, RequestId(1), doc, pos, trigger.map(str::to_owned)).await;
        list.unwrap().items.into_iter().map(|i| i.label).collect()
    }

    async fn hover(&self, doc: DocId, pos: Pos) -> String {
        let found = ops::lsp::lsp_hover(&self.host, WINDOW, RequestId(2), doc, pos).await.unwrap();
        found.map(|h| h.contents.value).unwrap_or_default()
    }

    /// The messages of the latest diagnostics published for `file`.
    fn diagnostics(&self, file: &str) -> Option<Vec<String>> {
        let path = self.path(file);
        self.events.lock().iter().rev().find_map(|e| match e {
            IdeEvent::Diagnostics { path: p, items, .. } if **p == *path => {
                Some(items.iter().map(|d| d.message.clone()).collect())
            }
            _ => None,
        })
    }

    /// Waits until the latest diagnostics of `file` satisfy `f`.
    async fn diagnostics_until(&self, file: &str, what: &str, f: impl Fn(&[String]) -> bool) {
        let deadline = Instant::now() + WAIT;
        loop {
            let latest = self.diagnostics(file);
            if latest.as_deref().is_some_and(&f) {
                return;
            }
            assert!(Instant::now() < deadline, "{file}: timed out waiting for {what}; latest: {latest:?}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn lands_on(&self, found: &[Location], file: &str, line: u32) -> bool {
        let want = self.path(file);
        found.iter().any(|l| *l.path == *want && l.range.start.line == line)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.host.close_project(WINDOW);
    }
}

fn has(items: &[String], label: &str) -> bool {
    items.iter().any(|i| i == label)
}

/// Lines typed into a method body of one file move the declarations after them: navigation
/// from another file lands on their new lines, while the file is unsaved, and back on the
/// old ones once the buffer is closed without saving.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn navigation_follows_declarations_moved_by_a_body_edit() {
    let s = Session::start("php-app", None).await;
    let library = s.open("src/Library.php").await;
    let book = s.open("src/Model/Book.php").await;
    let call = s.pos(library, "$lent = $book->withAvailability(false);", "withAvailability").await;
    let declared = s.line_of(book, "public function withAvailability").await;
    assert!(s.lands_on(&s.goto(library, call).await, "src/Model/Book.php", declared));

    s.type_after(
        book,
        "throw new InvalidArgumentException",
        "            // one\n            // two\n            // three",
    )
    .await;
    let moved = s.line_of(book, "public function withAvailability").await;
    assert_eq!(moved, declared + 3);
    let found = s.goto(library, call).await;
    assert!(s.lands_on(&found, "src/Model/Book.php", moved), "after the edit: {found:?}");
    // And from inside the edited file itself, to a method of another class.
    let label = s.pos(book, "$this->genre->label()", "label").await;
    let genre = s.open("src/Model/Genre.php").await;
    let genre_label = s.line_of(genre, "function label").await;
    assert!(s.lands_on(&s.goto(book, label).await, "src/Model/Genre.php", genre_label));

    ops::doc::close(&s.host, WINDOW, book).unwrap();
    let found = s.goto(library, call).await;
    assert!(s.lands_on(&found, "src/Model/Book.php", declared), "closed unsaved: {found:?}");
}

/// A member added to, renamed in or removed from an unsaved buffer shows at once in another
/// file's completion and hover, and closing the buffer without saving takes it back.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn completion_and_hover_follow_another_files_unsaved_declarations() {
    let s = Session::start("php-app", None).await;
    let library = s.open("src/Library.php").await;
    let book = s.open("src/Model/Book.php").await;
    let lent = "$lent = $book->withAvailability(false);";

    let at = s.type_after(library, lent, "        $lent->").await;
    let items = s.completion(library, at, Some(">")).await;
    assert!(has(&items, "label") && !has(&items, "shelfMark"), "{items:?}");

    // A new method, typed in another file and not saved.
    s.type_after(
        book,
        "public const MAX_TITLE = 200;",
        "\n    /** Where the book stands. */\n    public function shelfMark(): int\n    {\n        return 1;\n    }",
    )
    .await;
    let items = s.completion(library, at, Some(">")).await;
    assert!(has(&items, "shelfMark"), "the new method is offered: {items:?}");

    // Its return type, changed: hover on a call in the other file shows it.
    s.replace(library, "        $lent->", "        $lent->shelfMark();").await;
    let call = s.pos(library, "$lent->shelfMark();", "shelfMark").await;
    let shown = s.hover(library, call).await;
    assert!(shown.contains("shelfMark(): int"), "{shown}");
    s.replace(book, "shelfMark(): int", "shelfMark(): string").await;
    let shown = s.hover(library, call).await;
    assert!(shown.contains("shelfMark(): string"), "{shown}");

    // Closed without saving: the method is gone again.
    ops::doc::close(&s.host, WINDOW, book).unwrap();
    s.replace(library, "        $lent->shelfMark();", "        $lent->").await;
    let items = s.completion(library, at, Some(">")).await;
    assert!(!has(&items, "shelfMark") && has(&items, "label"), "{items:?}");
}

/// An open file's problems follow edits of the files it uses: a call to a method that
/// doesn't exist is reported, stops being reported when another buffer declares it, and is
/// reported again when that buffer is closed unsaved.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn diagnostics_follow_declarations_in_other_buffers() {
    let s = Session::start("php-app", None).await;
    let library = s.open("src/Library.php").await;
    let file = "src/Library.php";
    s.diagnostics_until(file, "the first inspection", |_| true).await;
    s.type_after(library, "$lent = $book->withAvailability(false);", "        $lent->shelfMark();").await;
    let undefined = |d: &[String]| d.iter().any(|m| m.contains("shelfMark"));
    s.diagnostics_until(file, "the undefined method", undefined).await;

    let book = s.open("src/Model/Book.php").await;
    s.type_after(book, "public const MAX_TITLE = 200;", "\n    public function shelfMark(): int { return 1; }").await;
    s.diagnostics_until(file, "the method to be found in the other buffer", |d| !undefined(d)).await;

    ops::doc::close(&s.host, WINDOW, book).unwrap();
    s.diagnostics_until(file, "the method to be missing again", undefined).await;
}

/// A buffer edited, saved and closed at once (before its own inspection ran): the other
/// open files still see the edit.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn diagnostics_follow_a_buffer_saved_and_closed_at_once() {
    let s = Session::start("php-app", None).await;
    let file = "src/Library.php";
    let library = s.open(file).await;
    s.type_after(library, "$lent = $book->withAvailability(false);", "        $lent->shelfMark();").await;
    let undefined = |d: &[String]| d.iter().any(|m| m.contains("shelfMark"));
    s.diagnostics_until(file, "the undefined method", undefined).await;

    let book = s.open("src/Model/Book.php").await;
    s.type_after(book, "public const MAX_TITLE = 200;", "\n    public function shelfMark(): int { return 1; }").await;
    ops::doc::save(&s.host, WINDOW, book).await.unwrap();
    ops::doc::close(&s.host, WINDOW, book).unwrap();
    s.diagnostics_until(file, "the method saved in the closed file", |d| !undefined(d)).await;
}

/// The same through a parent class, in the Laravel fixture, with the buffer saved right after
/// the edit (the editor's autosave when the tab loses focus).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn diagnostics_follow_a_parent_class_edited_and_saved() {
    let s = Session::start("laravel-app", Some("laravel-stubs")).await;
    let file = "app/Http/Controllers/PostController.php";
    s.open(file).await;
    let undefined = |d: &[String]| d.iter().any(|m| m.contains("forgetCachedFeed"));
    s.diagnostics_until(file, "the fixture's undefined method", undefined).await;

    let parent = s.open("app/Http/Controllers/Controller.php").await;
    s.replace(parent, "//", "protected function forgetCachedFeed(): void\n    {\n    }").await;
    ops::doc::save(&s.host, WINDOW, parent).await.unwrap();
    s.diagnostics_until(file, "the method declared in the saved parent", |d| !undefined(d)).await;

    // And back: removed and saved, the call is reported again.
    s.replace(parent, "protected function forgetCachedFeed(): void\n    {\n    }", "//").await;
    ops::doc::save(&s.host, WINDOW, parent).await.unwrap();
    s.diagnostics_until(file, "the method removed from the saved parent", undefined).await;
}

/// Saving a buffer keeps answering from the same text; editing after the save goes on
/// from it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn saving_keeps_the_answers_and_edits_go_on() {
    let s = Session::start("php-app", None).await;
    let library = s.open("src/Library.php").await;
    let book = s.open("src/Model/Book.php").await;
    s.type_after(book, "public const MAX_TITLE = 200;", "\n    public function shelfMark(): int { return 1; }").await;
    ops::doc::save(&s.host, WINDOW, book).await.unwrap();
    assert!(std::fs::read_to_string(s.path("src/Model/Book.php")).unwrap().contains("shelfMark"));
    let engine = s.host.project(WINDOW).unwrap().php.engine().unwrap();
    assert!(engine.wait_idle(WAIT));

    let at = s.type_after(library, "$lent = $book->withAvailability(false);", "        $lent->").await;
    assert!(has(&s.completion(library, at, Some(">")).await, "shelfMark"));
    // After the save, a body edit that moves the method down: goto still lands on it.
    s.type_after(book, "throw new InvalidArgumentException", "            // moved").await;
    s.replace(library, "        $lent->", "        $lent->shelfMark();").await;
    let call = s.pos(library, "$lent->shelfMark();", "shelfMark").await;
    let line = s.line_of(book, "function shelfMark").await;
    let found = s.goto(library, call).await;
    assert!(s.lands_on(&found, "src/Model/Book.php", line), "{found:?}");
    // Closed after the save and an unsaved edit: the saved version is what's left.
    ops::doc::close(&s.host, WINDOW, book).unwrap();
    let on_disk = std::fs::read_to_string(s.path("src/Model/Book.php")).unwrap();
    let saved_line = on_disk.lines().position(|l| l.contains("function shelfMark")).unwrap() as u32;
    let found = s.goto(library, call).await;
    assert!(s.lands_on(&found, "src/Model/Book.php", saved_line), "{found:?}");
}

/// Laravel's string references follow unsaved edits of the files they're read from: route
/// names from the route files, config keys from `config/`, translation keys from `lang/`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn laravel_string_completion_follows_unsaved_edits() {
    let s = Session::start("laravel-app", Some("laravel-stubs")).await;
    let controller = s.open("app/Http/Controllers/PostController.php").await;
    let anchor = "$posts = Post::published()";

    let at = s.type_after(controller, anchor, "        route('").await;
    let routes = s.completion(controller, at, Some("'")).await;
    assert!(has(&routes, "dashboard.posts.destroy") && !has(&routes, "posts.feed"), "{routes:?}");
    let web = s.open("routes/web.php").await;
    s.type_after(
        web,
        "Route::view('/about', 'about')",
        "Route::get('/feed', HomeController::class)->name('posts.feed');",
    )
    .await;
    let routes = s.completion(controller, at, Some("'")).await;
    assert!(has(&routes, "posts.feed"), "a route named in an unsaved buffer: {routes:?}");
    s.replace(controller, "        route('", "        config('blog.").await;

    let at = s.pos(controller, "config('blog.", "blog.").await;
    let at = Pos::new(at.line, at.col + 5);
    let keys = s.completion(controller, at, Some(".")).await;
    // The next segment of the key after `blog.`.
    assert!(has(&keys, "feed") && !has(&keys, "archived"), "{keys:?}");
    let config = s.open("config/blog.php").await;
    s.type_after(config, "'posts_per_page' =>", "\n    'archived' => false,").await;
    let keys = s.completion(controller, at, Some(".")).await;
    assert!(has(&keys, "archived"), "a key added to an unsaved config file: {keys:?}");
    s.replace(controller, "        config('blog.", "        __('messages.").await;

    let at = s.pos(controller, "__('messages.", "messages.").await;
    let at = Pos::new(at.line, at.col + 9);
    let lang = s.open("lang/en/messages.php").await;
    s.type_after(lang, "'post_created' =>", "    'post_archived' => 'The post was archived.',").await;
    let keys = s.completion(controller, at, Some(".")).await;
    assert!(keys.iter().any(|k| k.ends_with("post_archived")), "{keys:?}");
}

/// A Blade template knows the variables its controller passes, and follows edits of the
/// controller's method body (a variable added to `compact()`), saved or not.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn blade_view_variables_follow_controller_body_edits() {
    let s = Session::start("laravel-app", Some("laravel-stubs")).await;
    let view = s.open("resources/views/posts/show.blade.php").await;
    let controller = s.open("app/Http/Controllers/PostController.php").await;

    let at = s.type_after(view, "<h1>{{ $title }}</h1>", "    {{ $post->").await;
    let members = s.completion(view, at, Some(">")).await;
    assert!(has(&members, "title") || has(&members, "comments"), "the controller's Post: {members:?}");
    s.replace(view, "    {{ $post->", "    {{ $").await;
    let at = Pos::new(at.line, 8);
    let vars = s.completion(view, at, Some("$")).await;
    assert!(vars.iter().any(|v| v.trim_start_matches('$') == "published"), "{vars:?}");
    assert!(!vars.iter().any(|v| v.trim_start_matches('$') == "readers"), "{vars:?}");

    // A variable added inside the controller method's body.
    s.replace(
        controller,
        "$published = $post->published_at;",
        "$published = $post->published_at;\n        $readers = 3;",
    )
    .await;
    s.replace(controller, "compact('post', 'title', 'published')", "compact('post', 'title', 'published', 'readers')")
        .await;
    let vars = s.completion(view, at, Some("$")).await;
    assert!(vars.iter().any(|v| v.trim_start_matches('$') == "readers"), "after the body edit: {vars:?}");

    // Goto from the view name in the controller to the template.
    let name = s.pos(controller, "view('posts.show'", "posts.show").await;
    let found = s.goto(controller, Pos::new(name.line, name.col + 2)).await;
    assert!(s.lands_on(&found, "resources/views/posts/show.blade.php", 0), "{found:?}");
}
