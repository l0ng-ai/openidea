use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ide_core::{IdeEvent, Pos, SharedSink};

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;

const WAIT: Duration = Duration::from_secs(60);

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
        std::fs::create_dir_all(&root).unwrap();
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(WAIT));
        Self { _tmp: tmp, root, engine, next_doc: 1 }
    }

    fn open(&mut self, rel: &str, text: &str) -> DocId {
        let doc = DocId(self.next_doc);
        self.next_doc += 1;
        self.engine.document_opened(doc, &self.root.join(rel), 1, text);
        doc
    }

    /// The actions for the whole of `text`, opened as `rel`.
    fn actions(&mut self, rel: &str, text: &str, only: &[&str]) -> Vec<ImportAction> {
        let lines = text.split('\n').count() as u32;
        self.actions_in(rel, text, Range::new(Pos::new(0, 0), Pos::new(lines, 0)), only)
    }

    fn actions_in(&mut self, rel: &str, text: &str, range: Range, only: &[&str]) -> Vec<ImportAction> {
        let doc = self.open(rel, text);
        let only: Vec<String> = only.iter().map(|s| s.to_string()).collect();
        let found = self.engine.import_actions(doc, range, &only).expect("handled");
        self.engine.document_closed(doc);
        found
    }
}

/// `text` with the action's edits applied.
fn applied(text: &str, action: &ImportAction) -> String {
    let [FileEdit::Edit { edits, .. }] = action.edit.files.as_slice() else { panic!("one file: {:?}", action.edit) };
    let mut document = ide_text::Document::new(text);
    document.apply_edits(edits).unwrap();
    document.text().to_string()
}

fn titles(actions: &[ImportAction]) -> Vec<&str> {
    actions.iter().map(|a| a.title.as_str()).collect()
}

fn action<'a>(actions: &'a [ImportAction], title: &str) -> &'a ImportAction {
    actions.iter().find(|a| a.title == title).unwrap_or_else(|| panic!("{title} in {:?}", titles(actions)))
}

/// Optimize Imports on `text`; `None` when it offers nothing.
fn organized(project: &mut Project, text: &str) -> Option<String> {
    let found = project.actions("src/x.php", text, &["source.organizeImports"]);
    assert!(found.len() <= 1, "{:?}", titles(&found));
    found.first().map(|a| {
        assert_eq!((a.title.as_str(), a.kind, a.preferred), ("Optimize imports", ORGANIZE_IMPORTS, true));
        applied(text, a)
    })
}

const GENRE: &str = "<?php\nnamespace App\\Model;\n\nenum Genre: string\n{\n    case Fiction = 'f';\n}\n";
const BOOK: &str = "<?php\nnamespace App\\Model;\n\nfinal class Book {}\n";
const OTHER_BOOK: &str = "<?php\nnamespace App\\Legacy;\n\nfinal class Book {}\n";
const UTIL: &str =
    "<?php\nnamespace App\\Util;\n\nconst LIMIT = 3;\n\nfunction slugify(string $s): string { return $s; }\n";
const CONTAINER: &str = "<?php\nnamespace App;\n\nfinal class Container {}\n";

fn shop() -> Project {
    Project::new(&[
        ("src/Model/Genre.php", GENRE),
        ("src/Model/Book.php", BOOK),
        ("src/Legacy/Book.php", OTHER_BOOK),
        ("src/Util/util.php", UTIL),
        ("src/Container.php", CONTAINER),
    ])
}

#[test]
fn unresolved_names_get_import_fixes() {
    let mut project = shop();
    let text = "<?php\nnamespace App\\Http;\n\nuse App\\Container;\n\nfunction show(Container $c): void\n{\n    $g = Genre::Fiction;\n    $s = slugify('x');\n    echo LIMIT, strlen('a'), PHP_EOL;\n    $d = new DateTime();\n    $b = new Book();\n}\n";
    let found = project.actions("src/Http/show.php", text, &["quickfix"]);
    assert_eq!(
        titles(&found),
        [
            r"Import class 'App\Model\Genre'",
            r"Import function 'App\Util\slugify'",
            r"Import constant 'App\Util\LIMIT'",
            "Import class 'DateTime'",
            r"Import class 'App\Legacy\Book'",
            r"Import class 'App\Model\Book'",
        ]
    );
    assert!(found.iter().all(|a| a.kind == QUICKFIX));
    // Preferred only when unambiguous.
    assert!(action(&found, r"Import class 'App\Model\Genre'").preferred);
    assert!(!action(&found, r"Import class 'App\Model\Book'").preferred);

    // Classes join the class imports (sorted); functions and constants
    // start their own groups after a blank line.
    let genre = applied(text, action(&found, r"Import class 'App\Model\Genre'"));
    assert!(genre.contains("use App\\Container;\nuse App\\Model\\Genre;\n\nfunction show"), "{genre}");
    let date = applied(text, action(&found, "Import class 'DateTime'"));
    assert!(date.contains("use App\\Container;\nuse DateTime;\n"), "{date}");
    let slugify = applied(text, action(&found, r"Import function 'App\Util\slugify'"));
    assert!(slugify.contains("use App\\Container;\n\nuse function App\\Util\\slugify;\n\nfunction"), "{slugify}");
    let limit = applied(text, action(&found, r"Import constant 'App\Util\LIMIT'"));
    assert!(limit.contains("use App\\Container;\n\nuse const App\\Util\\LIMIT;\n"), "{limit}");

    // Only the names in the range (the imports are organized already, so
    // Optimize Imports isn't offered).
    let line = Range::new(Pos::new(7, 0), Pos::new(7, 30));
    let found = project.actions_in("src/Http/show.php", text, line, &[]);
    assert_eq!(titles(&found), [r"Import class 'App\Model\Genre'"]);
    // Asking for other kinds gives nothing.
    assert!(project.actions_in("src/Http/show.php", text, line, &["refactor"]).is_empty());
}

#[test]
fn import_fixes_skip_what_resolves() {
    let mut project = shop();
    // Imported, qualified, declared in the namespace or the file, global
    // built-ins without a namespace, `self` and `true`.
    let text = "<?php\nnamespace App\\Model;\n\nuse App\\Util;\n\nfinal class Shelf\n{\n    public function f(): ?self\n    {\n        $a = new Book();\n        $b = new \\App\\Container();\n        $c = Util\\slugify('x');\n        $d = new Shelf();\n        return true ? null : null;\n    }\n}\n";
    assert_eq!(titles(&project.actions("src/Model/Shelf.php", text, &["quickfix"])), Vec::<&str>::new());
    let text = "<?php\n$d = new DateTime();\n$g = new Genre();\n";
    let found = project.actions("bin/run.php", text, &["quickfix"]);
    assert_eq!(titles(&found), [r"Import class 'App\Model\Genre'"]);
    // A global file gets the import after the opening tag.
    assert_eq!(applied(text, &found[0]), "<?php\n\nuse App\\Model\\Genre;\n$d = new DateTime();\n$g = new Genre();\n");
}

#[test]
fn import_fixes_find_unsaved_declarations() {
    let mut project = shop();
    let _draft = project.open("src/Model/Draft.php", "<?php\nnamespace App\\Model;\n\nfinal class Draft {}\n");
    let text = "<?php\nnamespace App;\n\n$d = new Draft();\n";
    let found = project.actions("src/run.php", text, &["quickfix"]);
    assert_eq!(titles(&found), [r"Import class 'App\Model\Draft'"]);
    assert_eq!(applied(text, &found[0]), "<?php\nnamespace App;\n\nuse App\\Model\\Draft;\n\n$d = new Draft();\n");
}

#[test]
fn optimize_imports_removes_sorts_and_groups() {
    let mut project = shop();
    let text = "<?php\nnamespace App;\n\nuse function App\\Util\\slugify;\nuse App\\Model\\Genre;\nuse App\\Unused;\nuse const App\\Util\\LIMIT;\nuse App\\Model\\Book as Volume;\nuse App\\Model\\Genre;\nuse App\\Legacy;\nuse Attr\\Marker;\nuse Doc\\Only;\nuse function App\\Util\\unused;\nuse Psr\\Log\\LoggerInterface;\n\n#[Marker]\nfinal class Shelf\n{\n    /** @var list<Only> */\n    private array $docs = [];\n\n    public function f(Volume $v): Genre\n    {\n        new Legacy\\Book();\n        echo slugify('a'), LIMIT;\n        return Genre::Fiction;\n    }\n}\n";
    let out = organized(&mut project, text).expect("changes");
    let expected_imports = "use App\\Legacy;\nuse App\\Model\\Book as Volume;\nuse App\\Model\\Genre;\nuse Attr\\Marker;\nuse Doc\\Only;\n\nuse function App\\Util\\slugify;\n\nuse const App\\Util\\LIMIT;\n\n#[Marker]";
    assert!(out.contains(&format!("namespace App;\n\n{expected_imports}")), "{out}");
    assert!(!out.contains("Unused") && !out.contains("unused") && !out.contains("LoggerInterface"), "{out}");
    // Organized already: nothing to offer.
    assert_eq!(organized(&mut project, &out), None);

    // Group `use` statements are written out; constants match by case.
    let text = "<?php\nnamespace App;\n\nuse App\\Model\\{Genre, Book};\nuse const App\\Util\\{LIMIT, limit};\n\necho Genre::Fiction, LIMIT;\n";
    let out = organized(&mut project, text).expect("changes");
    assert_eq!(
        out,
        "<?php\nnamespace App;\n\nuse App\\Model\\Genre;\n\nuse const App\\Util\\LIMIT;\n\necho Genre::Fiction, LIMIT;\n"
    );
}

#[test]
fn optimize_imports_removes_unused_blocks_and_keeps_regions_apart() {
    let mut project = shop();
    // All unused: the lines go, without leaving a double gap.
    let text = "<?php\nnamespace App;\n\nuse App\\Model\\Book;\nuse App\\Model\\Genre;\n\nfinal class Shelf {}\n";
    assert_eq!(organized(&mut project, text).unwrap(), "<?php\nnamespace App;\n\nfinal class Shelf {}\n");
    // CRLF, and runs split by a comment are organized one by one.
    let text = "<?php\r\nnamespace App;\r\n\r\nuse B\\Two;\r\nuse A\\One;\r\n// keep\r\nuse D\\Four;\r\nuse C\\Three;\r\n\r\nnew One(); new Two(); new Three(); new Four();\r\n";
    // (The editor's document keeps `\n`; the edits themselves use `\r\n`.)
    let out = organized(&mut project, text).unwrap();
    assert_eq!(
        out,
        "<?php\nnamespace App;\n\nuse A\\One;\nuse B\\Two;\n// keep\nuse C\\Three;\nuse D\\Four;\n\nnew One(); new Two(); new Three(); new Four();\n"
    );
    let parsed = ParsedFile::parse("x.php", text);
    let edits = organize(&parsed, &FileNames::resolve(&parsed));
    let texts: Vec<&str> = edits.iter().map(|e| e.new_text.as_str()).collect();
    assert_eq!(texts, ["use A\\One;\r\nuse B\\Two;", "use C\\Three;\r\nuse D\\Four;"]);
    // Each namespace has its own imports and usages.
    let text = "<?php\nnamespace A {\n    use X\\Foo;\n    use X\\Bar;\n    new Foo();\n}\nnamespace B {\n    use X\\Foo;\n    use X\\Bar;\n    new Bar();\n}\n";
    let out = organized(&mut project, text).unwrap();
    assert_eq!(
        out,
        "<?php\nnamespace A {\n    use X\\Foo;\n    new Foo();\n}\nnamespace B {\n    use X\\Bar;\n    new Bar();\n}\n"
    );
}

fn insertion(text: &str, kind: NameKind, fqn: &str) -> String {
    let parsed = ParsedFile::parse("x.php", text);
    let at = text.find("/*here*/").unwrap_or(text.len()) as u32;
    let (offset, inserted) = import_insertion(&parsed, at, kind, fqn);
    format!("{}{inserted}{}", &text[..offset as usize], &text[offset as usize..])
}

#[test]
fn insertion_follows_the_existing_style() {
    // Sorted imports: at its place; unsorted ones: after the last.
    let text = "<?php\nnamespace App;\n\nuse App\\A;\nuse App\\C;\n\n/*here*/\n";
    assert!(insertion(text, NameKind::ClassLike, r"App\B").contains("use App\\A;\nuse App\\B;\nuse App\\C;\n"));
    assert!(insertion(text, NameKind::ClassLike, r"App\0").contains("namespace App;\n\nuse App\\0;\nuse App\\A;"));
    let text = "<?php\nnamespace App;\n\nuse App\\C;\nuse App\\A;\n\n/*here*/\n";
    assert!(insertion(text, NameKind::ClassLike, r"App\B").contains("use App\\A;\nuse App\\B;\n\n"));
    // Into a group `use` of the same namespace, single-line or multi-line.
    let text = "<?php\nnamespace App;\n\nuse App\\Model\\{Author, Genre};\n\n/*here*/\n";
    assert!(insertion(text, NameKind::ClassLike, r"App\Model\Book").contains("use App\\Model\\{Author, Book, Genre};"));
    let text = "<?php\nnamespace App;\n\nuse App\\Model\\{\n    Author,\n    Genre,\n};\n\n/*here*/\n";
    let out = insertion(text, NameKind::ClassLike, r"App\Model\Zine");
    assert!(out.contains("{\n    Author,\n    Genre,\n    Zine,\n};"), "{out}");
    // A function next to class imports: a blank line where the file has one
    // between groups, none where it doesn't.
    let text = "<?php\nnamespace App;\n\nuse App\\A;\nuse const App\\X;\n\n/*here*/\n";
    let out = insertion(text, NameKind::Function, r"App\f");
    assert!(out.contains("use App\\A;\nuse function App\\f;\nuse const App\\X;"), "{out}");
    let text = "<?php\nnamespace App;\n\nuse const App\\X;\n\n/*here*/\n";
    let out = insertion(text, NameKind::ClassLike, r"App\A");
    assert!(out.contains("namespace App;\n\nuse App\\A;\n\nuse const App\\X;"), "{out}");
    // Braced namespaces keep the indentation.
    let text = "<?php\nnamespace App {\n    use App\\A;\n\n    /*here*/\n}\n";
    assert!(insertion(text, NameKind::ClassLike, r"App\B").contains("    use App\\A;\n    use App\\B;\n"));
    let text = "<?php\nnamespace App {\n    function f() {}\n    /*here*/\n}\n";
    assert!(insertion(text, NameKind::ClassLike, r"App\B").contains("namespace App {\n    use App\\B;\n    function"));
    // No imports: after the namespace statement.
    let text = "<?php\n\nnamespace App;\n\n/*here*/\n";
    assert_eq!(insertion(text, NameKind::Constant, r"X\Y"), "<?php\n\nnamespace App;\n\nuse const X\\Y;\n\n/*here*/\n");
}
