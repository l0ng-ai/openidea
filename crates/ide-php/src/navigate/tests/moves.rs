use super::*;

const COMPOSER: &str = r#"{"autoload": {"psr-4": {"App\\": "src/"}}}"#;

impl Project {
    /// The edit for moving `from` to `to` (relative paths), applied: the
    /// edited files' texts by relative path.
    fn moved(&self, moves: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        let moves: Vec<(PathBuf, PathBuf)> =
            moves.iter().map(|(from, to)| (self.root.join(from), self.root.join(to))).collect();
        let edit = self.engine.file_moves_edit(&moves, &CancellationToken::new()).unwrap();
        self.apply(&edit)
    }
}

const BOOK: &str = "<?php\nnamespace App\\Model;\n\nuse App\\Support\\Clock;\n\n/** A book. */\nfinal class Book extends Item\n{\n    /** @return Author|null */\n    public function author(): ?Author { return new Author(Clock::now()); }\n}\n";
const ITEM: &str = "<?php\nnamespace App\\Model;\n\nabstract class Item {}\n";
const AUTHOR: &str = "<?php\nnamespace App\\Model;\n\nfinal class Author {}\n";
const CLOCK: &str =
    "<?php\nnamespace App\\Support;\n\nfinal class Clock { public static function now(): int { return 0; } }\n";
const SHELF: &str = "<?php\nnamespace App\\Model;\n\nfinal class Shelf\n{\n    /** @var list<Book> */\n    private array $books = [];\n\n    public function add(Book $book): void { $this->books[] = $book; }\n}\n";
const LIBRARY: &str = "<?php\nnamespace App;\n\nuse App\\Model\\Book;\nuse App\\Model\\Book as Volume;\n\nfunction lend(Book $a, Volume $b, \\App\\Model\\Book $c): string\n{\n    return 'App\\\\Model\\\\Book' . \\App\\Model\\Book::class;\n}\n";
const GROUPED: &str =
    "<?php\nnamespace App;\n\nuse App\\Model\\{Book, Author};\n\nfunction pair(Book $b, Author $a): void {}\n";

fn shelf_project() -> Project {
    Project::new(&[
        ("composer.json", COMPOSER),
        ("src/Model/Book.php", BOOK),
        ("src/Model/Item.php", ITEM),
        ("src/Model/Author.php", AUTHOR),
        ("src/Model/Shelf.php", SHELF),
        ("src/Support/Clock.php", CLOCK),
        ("src/Library.php", LIBRARY),
        ("src/Grouped.php", GROUPED),
    ])
}

#[test]
fn moving_a_class_changes_its_namespace_references_and_imports() {
    let project = shelf_project();
    let files = project.moved(&[("src/Model/Book.php", "src/Entity/Book.php")]);
    assert_eq!(
        files["src/Model/Book.php"],
        "<?php\nnamespace App\\Entity;\n\nuse App\\Support\\Clock;\nuse App\\Model\\Author;\nuse App\\Model\\Item;\n\n/** A book. */\nfinal class Book extends Item\n{\n    /** @return Author|null */\n    public function author(): ?Author { return new Author(Clock::now()); }\n}\n",
        "the namespace follows the folder; old siblings are imported"
    );
    assert_eq!(
        files["src/Model/Shelf.php"],
        "<?php\nnamespace App\\Model;\n\nuse App\\Entity\\Book;\n\nfinal class Shelf\n{\n    /** @var list<Book> */\n    private array $books = [];\n\n    public function add(Book $book): void { $this->books[] = $book; }\n}\n",
        "a sibling left behind imports it"
    );
    assert_eq!(
        files["src/Library.php"],
        "<?php\nnamespace App;\n\nuse App\\Entity\\Book;\nuse App\\Entity\\Book as Volume;\n\nfunction lend(Book $a, Volume $b, \\App\\Entity\\Book $c): string\n{\n    return 'App\\\\Entity\\\\Book' . \\App\\Entity\\Book::class;\n}\n",
        "imports, aliases, fully qualified names and strings"
    );
    assert_eq!(
        files["src/Grouped.php"],
        GROUPED.replace("(Book $b", "(\\App\\Entity\\Book $b"),
        "an item of a group `use` whose prefix no longer fits: written fully qualified"
    );
    assert!(!files.contains_key("src/Model/Item.php"), "untouched files aren't edited");
    assert!(!files.contains_key("src/Support/Clock.php"));
}

#[test]
fn renaming_the_file_renames_its_class() {
    let project = shelf_project();
    let files = project.moved(&[("src/Model/Author.php", "src/Model/Writer.php")]);
    assert_eq!(files["src/Model/Author.php"], "<?php\nnamespace App\\Model;\n\nfinal class Writer {}\n");
    assert_eq!(
        files["src/Model/Book.php"],
        BOOK.replace("?Author { return new Author(", "?Writer { return new Writer(")
            .replace("@return Author", "@return Writer")
    );
    assert_eq!(
        files["src/Grouped.php"],
        "<?php\nnamespace App;\n\nuse App\\Model\\{Book, Writer};\n\nfunction pair(Book $b, Writer $a): void {}\n",
        "an item of a group `use`"
    );
    // Moved and renamed at once.
    let files = project.moved(&[("src/Model/Author.php", "src/People/Writer.php")]);
    assert_eq!(files["src/Model/Author.php"], "<?php\nnamespace App\\People;\n\nfinal class Writer {}\n");
    assert!(files["src/Model/Book.php"].contains("use App\\Support\\Clock;\nuse App\\People\\Writer;\n"));
    assert!(files["src/Model/Book.php"].contains("?Writer { return new Writer("));
}

#[test]
fn moving_into_the_namespace_of_its_users_and_folders() {
    let project = shelf_project();
    // Into `App`: `Library.php` (namespace App) keeps its import, which still works.
    let files = project.moved(&[("src/Model/Author.php", "src/Author.php")]);
    assert_eq!(files["src/Model/Author.php"], "<?php\nnamespace App;\n\nfinal class Author {}\n");
    assert!(files["src/Model/Book.php"].contains("use App\\Author;"));
    assert_eq!(files["src/Grouped.php"], GROUPED.replace("Author $a", "\\App\\Author $a"));

    // A whole folder: the files inside keep referring to each other by short name.
    let files = project.moved(&[("src/Model", "src/Domain/Model")]);
    assert_eq!(files["src/Model/Item.php"], "<?php\nnamespace App\\Domain\\Model;\n\nabstract class Item {}\n");
    let book = &files["src/Model/Book.php"];
    assert!(book.starts_with("<?php\nnamespace App\\Domain\\Model;\n\nuse App\\Support\\Clock;\n\n"), "{book}");
    assert!(book.contains("final class Book extends Item\n"), "no import for a sibling that moves along");
    assert!(files["src/Library.php"].contains("use App\\Domain\\Model\\Book;"));
    assert_eq!(
        files["src/Grouped.php"],
        GROUPED.replace("(Book $b, Author $a)", "(\\App\\Domain\\Model\\Book $b, \\App\\Domain\\Model\\Author $a)"),
        "the group's prefix isn't rewritten (see PROGRESS)"
    );
}

#[test]
fn moves_that_change_nothing_or_leave_the_roots() {
    let project = shelf_project();
    assert!(project.moved(&[("src/Model/Book.php", "src/Model/Book.php")]).is_empty());
    assert!(project.moved(&[("src/Model/Book.php", "lib/Book.php")]).is_empty(), "outside the autoload roots");
    assert!(project.moved(&[("composer.json", "src/composer.json")]).is_empty(), "not PHP");
}

#[test]
fn global_files_functions_and_constants() {
    let project = Project::new(&[
        ("composer.json", COMPOSER),
        (
            "src/helpers.php",
            "<?php\ndeclare(strict_types=1);\n\nfunction helper(): \\Exception { return new Exception(PHP_EOL); }\n",
        ),
        (
            "src/Util/strings.php",
            "<?php\nnamespace App\\Util;\n\nconst SEP = '-';\n\nfunction slug(string $s): string { return $s . SEP; }\n",
        ),
        (
            "src/Util/Text.php",
            "<?php\nnamespace App\\Util;\n\nfinal class Text { public function go(): string { return slug('a') . SEP; } }\n",
        ),
        (
            "src/run.php",
            "<?php\nnamespace App;\n\nuse function App\\Util\\slug;\n\necho slug('x'), \\App\\Util\\SEP;\n",
        ),
    ]);
    let files = project.moved(&[("src/helpers.php", "src/Support/helpers.php")]);
    assert_eq!(
        files["src/helpers.php"],
        "<?php\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n\nuse Exception;\n\nfunction helper(): \\Exception { return new Exception(PHP_EOL); }\n",
        "a global file gets a namespace; global classes are imported, functions and constants fall back"
    );

    let files = project.moved(&[("src/Util/strings.php", "src/Text/strings.php")]);
    assert_eq!(
        files["src/Util/Text.php"],
        "<?php\nnamespace App\\Util;\n\nuse function App\\Text\\slug;\nuse const App\\Text\\SEP;\n\nfinal class Text { public function go(): string { return slug('a') . SEP; } }\n"
    );
    assert_eq!(
        files["src/run.php"],
        "<?php\nnamespace App;\n\nuse function App\\Text\\slug;\n\necho slug('x'), \\App\\Text\\SEP;\n"
    );
    assert!(files["src/Util/strings.php"].starts_with("<?php\nnamespace App\\Text;\n"));
}

#[test]
fn unsaved_buffers_are_edited() {
    let mut project = shelf_project();
    let doc = project.open(
        "src/Model/Shelf.php",
        &SHELF.replace("private array $books", "/** @var Author */ private $a;\n    private array $books"),
    );
    let files = project.moved(&[("src/Model/Book.php", "src/Entity/Book.php")]);
    assert!(files["src/Model/Shelf.php"].contains("/** @var Author */ private $a;"), "the buffer's text was edited");
    assert!(files["src/Model/Shelf.php"].contains("use App\\Entity\\Book;"));
    project.engine.document_closed(doc);
}
