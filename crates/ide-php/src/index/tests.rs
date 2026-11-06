use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use ide_core::CancellationToken;
use ide_core::error::ErrorKind;

use super::*;

const MODEL: &str = r#"<?php
namespace App\Models;

interface HasName {}

abstract class Model implements HasName {}

final class User extends Model implements \Countable {
    public function count(): int { return 0; }
}
"#;

const HELPERS: &str = r#"<?php
namespace App\Support;

const VERSION = '1.0';
define('APP_DEBUG', true);

function helper(): void {}

enum Status: string { case On = 'on'; }
"#;

const POST: &str = r#"<?php
namespace App\Models;

class Post extends Model {}
"#;

struct Project {
    dir: tempfile::TempDir,
}

impl Project {
    fn new(files: &[(&str, &str)]) -> Self {
        let project = Self { dir: tempfile::tempdir().unwrap() };
        for (name, text) in files {
            project.write(name, text);
        }
        project
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join("src").join(name)
    }

    fn cache(&self) -> PathBuf {
        self.dir.path().join("cache")
    }

    fn write(&self, name: &str, text: &str) {
        let path = self.path(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
    }

    /// Moves the mtime forward so a rewrite is noticed even on file systems
    /// with a coarse clock.
    fn bump_mtime(&self, name: &str, secs: u64) {
        let file = fs::File::options().write(true).open(self.path(name)).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(secs)).unwrap();
    }

    fn files(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in fs::read_dir(self.dir.path().join("src")).unwrap() {
            out.push(entry.unwrap().path());
        }
        out.sort();
        out
    }
}

fn token() -> CancellationToken {
    CancellationToken::new()
}

fn fqns(decls: &[Decl]) -> Vec<String> {
    decls.iter().map(|d| d.fqn.clone()).collect()
}

fn file_name(decl: &Decl) -> &str {
    Path::new(&decl.file).file_name().unwrap().to_str().unwrap()
}

#[test]
fn build_answers_every_table() {
    let p = Project::new(&[("Model.php", MODEL), ("helpers.php", HELPERS), ("Post.php", POST)]);
    let index = PhpIndex::open(&p.cache()).unwrap();
    assert!(index.is_persistent());
    let stats = index.sync(&p.files(), &token()).unwrap();
    assert_eq!(stats, IndexStats { parsed: 3, ..Default::default() });
    assert_eq!(index.files().unwrap().len(), 3);

    // FQN → declaration: class-likes and functions ignore case, a leading `\` is fine.
    let user = index.declarations(NameKind::ClassLike, "\\app\\models\\USER").unwrap();
    assert_eq!(user.len(), 1);
    assert_eq!(user[0].kind, DeclKind::ClassLike(ClassKind::Class));
    assert_eq!((user[0].fqn.as_str(), file_name(&user[0]), user[0].index), ("App\\Models\\User", "Model.php", 2));
    assert_eq!(
        fqns(&index.declarations(NameKind::Function, "App\\Support\\HELPER").unwrap()),
        ["App\\Support\\helper"]
    );
    assert!(index.declarations(NameKind::ClassLike, "App\\Support\\helper").unwrap().is_empty());
    // Constants keep the case of their name, not of their namespace.
    assert_eq!(
        fqns(&index.declarations(NameKind::Constant, "app\\support\\VERSION").unwrap()),
        ["App\\Support\\VERSION"]
    );
    assert!(index.declarations(NameKind::Constant, "App\\Support\\version").unwrap().is_empty());
    assert_eq!(fqns(&index.declarations(NameKind::Constant, "APP_DEBUG").unwrap()), ["APP_DEBUG"]);
    let status = index.declarations(NameKind::ClassLike, "App\\Support\\Status").unwrap();
    assert_eq!(status[0].kind, DeclKind::ClassLike(ClassKind::Enum));

    // The declaration points into the stored summary.
    let summary = index.summary(&user[0].path()).unwrap().unwrap();
    assert_eq!(summary.class_likes[user[0].index as usize].fqn, "App\\Models\\User");

    // Short names, lower-cased.
    assert_eq!(fqns(&index.by_short_name("USER").unwrap()), ["App\\Models\\User"]);
    assert_eq!(fqns(&index.by_short_name("app_debug").unwrap()), ["APP_DEBUG"]);

    // Direct subclasses and implementers only.
    let mut model_children = fqns(&index.direct_subclasses("App\\Models\\Model").unwrap());
    model_children.sort();
    assert_eq!(model_children, ["App\\Models\\Post", "App\\Models\\User"]);
    assert_eq!(fqns(&index.direct_subclasses("app\\models\\hasname").unwrap()), ["App\\Models\\Model"]);
    assert_eq!(fqns(&index.direct_subclasses("\\Countable").unwrap()), ["App\\Models\\User"]);

    // Namespace children: declarations, and child namespaces listed once.
    let root = index.namespace_children("").unwrap();
    assert!(root.iter().any(|d| d.kind == DeclKind::Constant && d.fqn == "APP_DEBUG"));
    assert_eq!(root.iter().filter(|d| d.kind == DeclKind::Namespace).count(), 1);
    let app = index.namespace_children("App").unwrap();
    let mut app_ns = fqns(&app).to_vec();
    app_ns.sort();
    assert_eq!(app_ns, ["App\\Models", "App\\Support"]);
    let mut models = fqns(&index.namespace_children("app\\models").unwrap());
    models.sort();
    assert_eq!(models, ["App\\Models\\HasName", "App\\Models\\Model", "App\\Models\\Post", "App\\Models\\User"]);
}

#[test]
fn nothing_is_parsed_again_when_nothing_changed() {
    let p = Project::new(&[("Model.php", MODEL), ("helpers.php", HELPERS)]);
    let index = PhpIndex::open(&p.cache()).unwrap();
    index.sync(&p.files(), &token()).unwrap();
    let again = index.sync(&p.files(), &token()).unwrap();
    assert_eq!(again, IndexStats { unchanged: 2, ..Default::default() });
    let batch = index.update(&p.files(), &[], &token()).unwrap();
    assert_eq!(batch, IndexStats { unchanged: 2, ..Default::default() });

    // Same content, new mtime: read and hashed again, not parsed.
    p.write("Model.php", MODEL);
    p.bump_mtime("Model.php", 60);
    let touched = index.update(&[p.path("Model.php")], &[], &token()).unwrap();
    assert_eq!(touched, IndexStats { rehashed: 1, ..Default::default() });
    let again = index.update(&[p.path("Model.php")], &[], &token()).unwrap();
    assert_eq!(again, IndexStats { unchanged: 1, ..Default::default() });
    assert_eq!(index.declarations(NameKind::ClassLike, "App\\Models\\User").unwrap().len(), 1);
}

#[test]
fn a_change_replaces_the_entries_of_the_file() {
    let p = Project::new(&[("Model.php", MODEL), ("Post.php", POST)]);
    let index = PhpIndex::open(&p.cache()).unwrap();
    index.sync(&p.files(), &token()).unwrap();

    p.write("Post.php", "<?php\nnamespace App\\Blog;\n\nclass Article extends \\App\\Models\\User {}\n");
    p.bump_mtime("Post.php", 60);
    let stats = index.update(&[p.path("Post.php")], &[], &token()).unwrap();
    assert_eq!(stats, IndexStats { parsed: 1, ..Default::default() });

    assert!(index.declarations(NameKind::ClassLike, "App\\Models\\Post").unwrap().is_empty());
    assert!(index.by_short_name("post").unwrap().is_empty());
    assert_eq!(fqns(&index.direct_subclasses("App\\Models\\Model").unwrap()), ["App\\Models\\User"]);
    assert_eq!(fqns(&index.direct_subclasses("App\\Models\\User").unwrap()), ["App\\Blog\\Article"]);
    assert_eq!(fqns(&index.declarations(NameKind::ClassLike, "app\\blog\\article").unwrap()), ["App\\Blog\\Article"]);
    let mut app = fqns(&index.namespace_children("App").unwrap());
    app.sort();
    assert_eq!(app, ["App\\Blog", "App\\Models"]);
    // Only the new summary and the untouched one are stored.
    assert_eq!(tables::table_sizes(&index.db), [2, 2]);
}

#[test]
fn removed_files_leave_no_entries() {
    let p = Project::new(&[("Model.php", MODEL), ("helpers.php", HELPERS), ("Post.php", POST)]);
    let index = PhpIndex::open(&p.cache()).unwrap();
    index.sync(&p.files(), &token()).unwrap();

    // A watcher removal.
    fs::remove_file(p.path("helpers.php")).unwrap();
    let stats = index.update(&[], &[p.path("helpers.php")], &token()).unwrap();
    assert_eq!(stats, IndexStats { removed: 1, ..Default::default() });
    assert!(index.declarations(NameKind::Function, "App\\Support\\helper").unwrap().is_empty());
    assert!(index.by_short_name("app_debug").unwrap().is_empty());
    assert_eq!(fqns(&index.namespace_children("App").unwrap()), ["App\\Models"]);

    // A changed path that no longer exists is dropped too.
    fs::remove_file(p.path("Post.php")).unwrap();
    let stats = index.update(&[p.path("Post.php")], &[], &token()).unwrap();
    assert_eq!(stats, IndexStats { removed: 1, ..Default::default() });

    // A file that is no longer listed is dropped by a sync.
    let stats = index.sync(&[], &token()).unwrap();
    assert_eq!(stats, IndexStats { removed: 1, ..Default::default() });
    assert!(index.files().unwrap().is_empty());
    assert!(index.namespace_children("").unwrap().is_empty());
    assert_eq!(tables::table_sizes(&index.db), [0, 0]);
}

#[test]
fn restart_keeps_the_index_and_parses_nothing() {
    let p = Project::new(&[("Model.php", MODEL), ("helpers.php", HELPERS)]);
    {
        let index = PhpIndex::open(&p.cache()).unwrap();
        index.sync(&p.files(), &token()).unwrap();
    }
    p.write("Post.php", POST);
    let index = PhpIndex::open(&p.cache()).unwrap();
    assert!(index.is_persistent());
    assert_eq!(index.files().unwrap().len(), 2);
    assert_eq!(index.declarations(NameKind::ClassLike, "App\\Models\\User").unwrap().len(), 1);
    let stats = index.sync(&p.files(), &token()).unwrap();
    assert_eq!(stats, IndexStats { parsed: 1, unchanged: 2, ..Default::default() });
    assert_eq!(fqns(&index.direct_subclasses("App\\Models\\Model").unwrap()).len(), 2);
}

#[test]
fn another_schema_stamp_clears_the_index() {
    let p = Project::new(&[("Model.php", MODEL)]);
    {
        let index = PhpIndex::open(&p.cache()).unwrap();
        index.sync(&p.files(), &token()).unwrap();
        let txn = index.db.begin_write().unwrap();
        txn.open_table(META).unwrap().insert("stamp", b"ide-php-index 0 summary 0".as_slice()).unwrap();
        txn.commit().unwrap();
    }
    let index = PhpIndex::open(&p.cache()).unwrap();
    assert!(index.files().unwrap().is_empty());
    assert!(index.by_short_name("user").unwrap().is_empty());
    assert_eq!(index.sync(&p.files(), &token()).unwrap().parsed, 1);
}

#[test]
fn corrupt_or_locked_databases_still_index() {
    let p = Project::new(&[("Model.php", MODEL)]);
    fs::create_dir_all(p.cache()).unwrap();
    fs::write(p.cache().join(FILE_NAME), b"not a database").unwrap();
    let index = PhpIndex::open(&p.cache()).unwrap();
    assert!(index.is_persistent());
    assert_eq!(index.sync(&p.files(), &token()).unwrap().parsed, 1);

    // A second window on the same project gets an in-memory index.
    let second = PhpIndex::open(&p.cache()).unwrap();
    assert!(!second.is_persistent());
    assert_eq!(second.sync(&p.files(), &token()).unwrap().parsed, 1);
    assert_eq!(second.by_short_name("model").unwrap().len(), 1);
}

#[test]
fn identical_files_share_one_summary() {
    let p = Project::new(&[("a.php", POST), ("b.php", POST)]);
    let index = PhpIndex::open(&p.cache()).unwrap();
    let stats = index.sync(&[p.path("a.php")], &token()).unwrap();
    assert_eq!(stats.parsed, 1);
    let stats = index.update(&[p.path("b.php")], &[], &token()).unwrap();
    assert_eq!(stats, IndexStats { reused: 1, ..Default::default() });
    let posts = index.declarations(NameKind::ClassLike, "App\\Models\\Post").unwrap();
    assert_eq!(posts.iter().map(file_name).collect::<Vec<_>>(), ["a.php", "b.php"]);
    assert_eq!(tables::table_sizes(&index.db), [1, 1]);

    // Removing one copy keeps the other's entries and the shared summary.
    index.update(&[], &[p.path("a.php")], &token()).unwrap();
    let posts = index.declarations(NameKind::ClassLike, "App\\Models\\Post").unwrap();
    assert_eq!(posts.iter().map(file_name).collect::<Vec<_>>(), ["b.php"]);
    assert_eq!(fqns(&index.namespace_children("App").unwrap()), ["App\\Models"]);
    assert!(index.summary(&p.path("b.php")).unwrap().is_some());
    index.update(&[], &[p.path("b.php")], &token()).unwrap();
    assert_eq!(tables::table_sizes(&index.db), [0, 0]);
}

#[test]
fn a_cancelled_build_stops_and_resumes() {
    let names: Vec<String> = (0..CHUNK + 10).map(|i| format!("C{i}.php")).collect();
    let texts: Vec<String> = (0..CHUNK + 10).map(|i| format!("<?php\nnamespace N;\nclass C{i} {{}}\n")).collect();
    let files: Vec<(&str, &str)> = names.iter().map(String::as_str).zip(texts.iter().map(String::as_str)).collect();
    let p = Project::new(&files);
    let index = PhpIndex::open(&p.cache()).unwrap();

    let cancel = token();
    cancel.cancel();
    let err = index.sync(&p.files(), &cancel).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert!(index.files().unwrap().is_empty());

    // A build cut short after its first chunk resumes with the rest.
    let first: Vec<PathBuf> = p.files().into_iter().take(CHUNK).collect();
    index.sync(&first, &token()).unwrap();
    let stats = index.sync(&p.files(), &token()).unwrap();
    assert_eq!(stats, IndexStats { parsed: 10, unchanged: CHUNK, ..Default::default() });
    assert_eq!(index.namespace_children("N").unwrap().len(), CHUNK + 10);
}

#[test]
fn in_memory_index_works_without_a_directory() {
    let p = Project::new(&[("helpers.php", HELPERS)]);
    let index = PhpIndex::in_memory().unwrap();
    assert!(!index.is_persistent());
    index.sync(&p.files(), &token()).unwrap();
    assert_eq!(fqns(&index.by_short_name("Status").unwrap()), ["App\\Support\\Status"]);
}

#[test]
fn path_keys_use_one_separator() {
    let key = path_key(Path::new("src/App/User.php"));
    assert_eq!(key, "src/App/User.php");
    if cfg!(windows) {
        assert_eq!(path_key(Path::new(r"C:\p\src\User.php")), "C:/p/src/User.php");
    }
}

#[test]
fn meta_files_are_listed() {
    const META: &str = "<?php\nnamespace PHPSTORM_META;\nexitPoint(\\App\\halt());\n";
    let p = Project::new(&[("Model.php", MODEL), ("meta.php", META)]);
    let index = PhpIndex::open(&p.cache()).unwrap();
    index.sync(&p.files(), &token()).unwrap();
    assert_eq!(index.meta_files().unwrap(), [p.path("meta.php")]);

    // Removing the directives drops the file from the list.
    p.write("meta.php", "<?php\nnamespace PHPSTORM_META;\n");
    p.bump_mtime("meta.php", 10);
    index.sync(&p.files(), &token()).unwrap();
    assert!(index.meta_files().unwrap().is_empty());
}

fn word_files(index: &PhpIndex, word: &str) -> Vec<String> {
    let files = index.files_with_word(word).unwrap();
    files.iter().map(|path| path.file_name().unwrap().to_string_lossy().into_owned()).collect()
}

#[test]
fn the_word_index_follows_changes_and_removals() {
    let p = Project::new(&[("Model.php", MODEL), ("helpers.php", HELPERS), ("Post.php", POST), ("Copy.php", POST)]);
    let index = PhpIndex::open(&p.cache()).unwrap();
    index.sync(&p.files(), &token()).unwrap();
    // Any case, anywhere in the text; whole words only.
    assert_eq!(word_files(&index, "MODEL"), ["Copy.php", "Model.php", "Post.php"]);
    assert_eq!(word_files(&index, "app_debug"), ["helpers.php"]);
    assert_eq!(word_files(&index, "models"), ["Copy.php", "Model.php", "Post.php"]);
    assert!(word_files(&index, "mode").is_empty());

    p.write("Post.php", "<?php\nnamespace App\\Blog;\n\nclass Article extends \\App\\Models\\User {}\n");
    p.bump_mtime("Post.php", 60);
    index.update(&[p.path("Post.php")], &[], &token()).unwrap();
    assert_eq!(word_files(&index, "model"), ["Copy.php", "Model.php"]);
    assert_eq!(word_files(&index, "article"), ["Post.php"]);

    // Removing one of two identical files keeps the other's words.
    index.update(&[], &[p.path("Copy.php"), p.path("helpers.php")], &token()).unwrap();
    assert_eq!(word_files(&index, "model"), ["Model.php"]);
    assert!(word_files(&index, "helper").is_empty());

    // Restart: the words are persistent.
    drop(index);
    let index = PhpIndex::open(&p.cache()).unwrap();
    assert_eq!(word_files(&index, "article"), ["Post.php"]);
    index.sync(&[], &token()).unwrap();
    assert!(word_files(&index, "article").is_empty());
    assert_eq!(tables::word_table_sizes(&index.db), [0, 0, 0]);
}
