use std::collections::BTreeMap;

use ide_core::{FileEdit, WorkspaceEdit};

use super::*;

impl Project {
    fn rel(&self, path: &Path) -> String {
        path.strip_prefix(&self.root).unwrap().to_string_lossy().replace('\\', "/")
    }

    /// Renames what is at the caret of `source` (opened as `rel`) to
    /// `new_name`: the edit, and the edited texts (see [`Project::apply`]).
    fn rename_edit(
        &mut self,
        rel: &str,
        source: &str,
        new_name: &str,
    ) -> IdeResult<(WorkspaceEdit, BTreeMap<String, String>)> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let edit = self.engine.rename(doc, pos, new_name, &CancellationToken::new()).expect("the document is open");
        // Applied while the buffer is open: its text is the one edited.
        let applied = edit.map(|edit| {
            let files = self.apply(&edit);
            (edit, files)
        });
        self.engine.document_closed(doc);
        applied
    }

    /// The texts of the edited files after `edit`, and the file renames as
    /// `"from -> to"` entries under the key `"renamed"`.
    fn apply(&self, edit: &WorkspaceEdit) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        let mut renamed = Vec::new();
        for file in &edit.files {
            match file {
                FileEdit::Edit { path, edits, .. } => {
                    let path: &Path = path.0.as_path();
                    let mut text = match self.engine.open_document(path) {
                        Some(document) => document.text.to_string(),
                        None => std::fs::read_to_string(path).unwrap(),
                    };
                    let index = LineIndex::new(&text);
                    let mut bytes: Vec<(u32, u32, &str)> = edits
                        .iter()
                        .map(|edit| {
                            let (start, end) = index.byte_range(edit.range);
                            (start, end, edit.new_text.as_str())
                        })
                        .collect();
                    bytes.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
                    for (start, end, new_text) in bytes {
                        text.replace_range(start as usize..end as usize, new_text);
                    }
                    out.insert(self.rel(path), text);
                }
                FileEdit::Rename { from, to } => {
                    renamed.push(format!("{} -> {}", self.rel(&from.0), self.rel(&to.0)));
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        if !renamed.is_empty() {
            out.insert("renamed".into(), renamed.join(", "));
        }
        out
    }

    /// Renames at the caret and gives the edited files' texts.
    fn renamed(&mut self, rel: &str, source: &str, new_name: &str) -> BTreeMap<String, String> {
        self.rename_edit(rel, source, new_name).unwrap().1
    }

    /// Prepare rename at the caret: the text of the range.
    fn prepare(&mut self, rel: &str, source: &str) -> Option<String> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let range = self.engine.prepare_rename(doc, pos).expect("the document is open");
        self.engine.document_closed(doc);
        range.map(|range| {
            let index = LineIndex::new(&text);
            let (start, end) = index.byte_range(range);
            text[start as usize..end as usize].to_owned()
        })
    }
}

#[test]
fn renaming_a_class_changes_imports_docs_strings_and_its_file() {
    let shelf = r"<?php
namespace App;

use App\Model\Book;
use App\Model\Book as Volume;

class Shelf
{
    /** @param list<Book> $books */
    public function add(array $books, ?\App\Model\Book $one): Volume { return new Volume(); }

    public function name(): string { return Book::class . 'App\\Model\\Book'; }
}
";
    let mut project =
        Project::new(&[("src/Model/Book.php", BOOK), ("src/Model/Item.php", ITEM), ("src/Shelf.php", shelf)]);
    let source = shelf.replace("?\\App\\Model\\Book $one", "?\\App\\Model\\Bo/*|*/ok $one");
    assert_eq!(project.prepare("src/Shelf.php", &source).as_deref(), Some("Book"));
    let files = project.renamed("src/Shelf.php", &source, "Novel");
    assert_eq!(files["src/Model/Book.php"], BOOK.replace("class Book", "class Novel"));
    assert_eq!(
        files["src/Shelf.php"],
        r"<?php
namespace App;

use App\Model\Novel;
use App\Model\Novel as Volume;

class Shelf
{
    /** @param list<Novel> $books */
    public function add(array $books, ?\App\Model\Novel $one): Volume { return new Volume(); }

    public function name(): string { return Novel::class . 'App\\Model\\Novel'; }
}
"
    );
    assert_eq!(files["renamed"], "src/Model/Book.php -> src/Model/Novel.php");
    assert_eq!(files.len(), 3, "{files:?}");

    // Not from the alias; a file declaring more than the class keeps its name.
    let alias = shelf.replace("): Volume {", "): Vol/*|*/ume {");
    assert_eq!(project.prepare("src/Shelf.php", &alias), None);
    let source = shelf.replace("\nclass Shelf", "\nfunction helper() {}\nclass Sh/*|*/elf");
    let files = project.renamed("src/Shelf.php", &source, "Rack");
    assert!(files["src/Shelf.php"].contains("class Rack"));
    assert!(!files.contains_key("renamed"), "{files:?}");
}

#[test]
fn renaming_a_method_renames_its_hierarchy() {
    let repository = "<?php\nnamespace App;\n\ninterface Repository { public function find(int $id): ?object; }\n";
    let books = "<?php\nnamespace App;\n\nclass Books implements Repository\n{\n    public function find(int $id): ?object { return $this->find($id - 1); }\n}\n";
    let cached = "<?php\nnamespace App;\n\nclass CachedBooks extends Books\n{\n    public function find(int $id): ?object { return parent::find($id); }\n}\n";
    let other = "<?php\nnamespace App;\n\nclass Other { public function find(int $id): ?object { return null; } }\n";
    let user = "<?php\nnamespace App;\n\nfunction use_them(Repository $r, CachedBooks $c, Other $o): void\n{\n    $r->find(1);\n    $c->FIND(2);\n    $o->find(3);\n}\n";
    let mut project = Project::new(&[
        ("src/Repository.php", repository),
        ("src/Books.php", books),
        ("src/CachedBooks.php", cached),
        ("src/Other.php", other),
        ("src/use.php", user),
    ]);
    // From a call on the subclass: up to the interface, down to every override.
    let source = user.replace("$c->FIND(2)", "$c->FI/*|*/ND(2)");
    assert_eq!(project.prepare("src/use.php", &source).as_deref(), Some("FIND"));
    let files = project.renamed("src/use.php", &source, "lookup");
    assert_eq!(files["src/Repository.php"], repository.replace("function find", "function lookup"));
    assert_eq!(files["src/Books.php"], books.replace("find", "lookup"));
    assert_eq!(files["src/CachedBooks.php"], cached.replace("find", "lookup"));
    assert_eq!(
        files["src/use.php"],
        user.replace("$r->find", "$r->lookup").replace("$c->FIND", "$c->lookup"),
        "Other::find is another method"
    );
    assert!(!files.contains_key("src/Other.php"));

    // A private method stays in its class.
    let private = "<?php\nnamespace App;\n\nclass Secret\n{\n    private function key(): int { return 1; }\n    public function use(): int { return $this->key(); }\n}\nclass Child extends Secret { private function key(): int { return 2; } }\n";
    let mut project = Project::new(&[("src/Secret.php", private)]);
    let source =
        private.replace("private function key(): int { return 1; }", "private function k/*|*/ey(): int { return 1; }");
    let files = project.renamed("src/Secret.php", &source, "secret");
    assert_eq!(
        files["src/Secret.php"],
        private.replacen("function key", "function secret", 1).replace("$this->key()", "$this->secret()")
    );
}

#[test]
fn renaming_parameters_and_variables_updates_docs_and_named_arguments() {
    let functions = "<?php\nnamespace App;\n\n/**\n * Makes a slug.\n * @param string $text the text\n */\nfunction slugify(string $text): string\n{\n    $slug = strtolower($text);\n    /** @var string $slug */\n    return fn() => $slug . $text;\n}\n\nfunction other(string $text): string { return $text; }\n";
    let user = "<?php\nnamespace App;\n\necho slugify(text: 'A b');\necho other(text: 'c');\n";
    let mut project = Project::new(&[("src/functions.php", functions), ("src/user.php", user)]);
    // From a use in the body.
    let source = functions.replace("strtolower($text)", "strtolower($te/*|*/xt)");
    assert_eq!(project.prepare("src/functions.php", &source).as_deref(), Some("text"));
    let files = project.renamed("src/functions.php", &source, "$title");
    assert_eq!(
        files["src/functions.php"],
        "<?php\nnamespace App;\n\n/**\n * Makes a slug.\n * @param string $title the text\n */\nfunction slugify(string $title): string\n{\n    $slug = strtolower($title);\n    /** @var string $slug */\n    return fn() => $slug . $title;\n}\n\nfunction other(string $text): string { return $text; }\n"
    );
    assert_eq!(files["src/user.php"], user.replace("slugify(text:", "slugify(title:"));

    // From a named argument.
    let source = user.replace("slugify(text:", "slugify(te/*|*/xt:");
    let files = project.renamed("src/user.php", &source, "input");
    assert!(files["src/functions.php"].contains("@param string $input the text"));
    assert!(files["src/functions.php"].contains("function other(string $text)"));
    assert_eq!(files["src/user.php"], user.replace("slugify(text:", "slugify(input:"));

    // A local variable, with its `@var`.
    let source = functions.replace("$slug = strtolower", "$sl/*|*/ug = strtolower");
    let files = project.renamed("src/functions.php", &source, "result");
    assert_eq!(files["src/functions.php"], functions.replace("$slug", "$result"));
    assert_eq!(files.len(), 1);
}

#[test]
fn renaming_a_promoted_property_renames_its_parameter() {
    let book = "<?php\nnamespace App;\n\nfinal class Book\n{\n    /** @param string $title the title */\n    public function __construct(public readonly string $title, private int $pages = 0)\n    {\n        assert($title !== '');\n    }\n\n    public function label(): string { return $this->title . $this->pages; }\n}\n";
    let user = "<?php\nnamespace App;\n\n$b = new Book(title: 'Dune', pages: 3);\necho $b->title;\n";
    let mut project = Project::new(&[("src/Book.php", book), ("src/user.php", user)]);
    let expected_book = book.replace("$title", "$name").replace("->title", "->name");
    let expected_user = user.replace("title:", "name:").replace("->title", "->name");
    // From a property fetch.
    let source = user.replace("$b->title", "$b->ti/*|*/tle");
    let files = project.renamed("src/user.php", &source, "name");
    assert_eq!(files["src/Book.php"], expected_book);
    assert_eq!(files["src/user.php"], expected_user);
    // From the parameter.
    let source = book.replace("string $title,", "string $ti/*|*/tle,");
    let files = project.renamed("src/Book.php", &source, "name");
    assert_eq!(files["src/Book.php"], expected_book);
    assert_eq!(files["src/user.php"], expected_user);
    // A private promoted property from a named argument.
    let source = user.replace("pages: 3", "pa/*|*/ges: 3");
    let files = project.renamed("src/user.php", &source, "length");
    assert_eq!(files["src/Book.php"], book.replace("$pages", "$length").replace("->pages", "->length"));
    assert_eq!(files["src/user.php"], user.replace("pages:", "length:"));
}

#[test]
fn renaming_functions_constants_and_class_constants() {
    let functions = "<?php\nnamespace App;\n\nconst VERSION = '1.0';\n\nfunction format_price(int $cents): string { return (string) $cents; }\n\nenum Genre: string\n{\n    case Fiction = 'f';\n    const DEFAULT = self::Fiction;\n}\n";
    let user = "<?php\nnamespace Web;\n\nuse function App\\format_price;\nuse const App\\VERSION;\nuse App\\Genre;\n\necho format_price(3) . \\App\\format_price(4) . VERSION . \\App\\VERSION;\necho Genre::Fiction->value . Genre::DEFAULT->value;\n";
    let mut project = Project::new(&[("src/functions.php", functions), ("src/user.php", user)]);
    let source = user.replace("echo format_price(3)", "echo format_pr/*|*/ice(3)");
    let files = project.renamed("src/user.php", &source, "money");
    assert_eq!(files["src/functions.php"], functions.replace("format_price", "money"));
    assert_eq!(files["src/user.php"], user.replace("format_price", "money"));

    let source = user.replace(". VERSION .", ". VERS/*|*/ION .");
    let files = project.renamed("src/user.php", &source, "RELEASE");
    assert_eq!(files["src/functions.php"], functions.replace("VERSION", "RELEASE"));
    assert_eq!(files["src/user.php"], user.replace("VERSION", "RELEASE"));

    let source = user.replace("Genre::Fiction->", "Genre::Fic/*|*/tion->");
    let files = project.renamed("src/user.php", &source, "Novel");
    assert_eq!(files["src/functions.php"], functions.replace("Fiction", "Novel"));
    assert_eq!(files["src/user.php"], user.replace("Fiction", "Novel"));
    // Enums aren't renamed with their file unless it is named after them.
    assert!(!files.contains_key("renamed"));
}

#[test]
fn what_cannot_be_renamed() {
    let book = "<?php\nnamespace App;\n\nfinal class Book implements \\Countable\n{\n    public function __construct() {}\n    public function count(): int { return strlen('x'); }\n    public function me(): static { return $this; }\n}\n";
    let mut project = Project::new(&[("src/Book.php", book)]);
    for (from, to) in [
        ("return $this;", "return $th/*|*/is;"),
        ("strlen('x')", "str/*|*/len('x')"),
        ("function __construct", "function __con/*|*/struct"),
        ("function count", "function co/*|*/unt"),
        ("\\Countable", "\\Count/*|*/able"),
        ("): static", "): sta/*|*/tic"),
        ("{ return strlen", "{ ret/*|*/urn strlen"),
    ] {
        let source = book.replace(from, to);
        assert_eq!(project.prepare("src/Book.php", &source), None, "{to}");
    }
    let source = book.replace("function me", "function m/*|*/e");
    assert_eq!(project.prepare("src/Book.php", &source).as_deref(), Some("me"));
    for bad in ["", "1st", "two words", "App\\me"] {
        assert!(project.rename_edit("src/Book.php", &source, bad).is_err(), "{bad:?}");
    }
    let source = book.replace("final class Book", "final class Bo/*|*/ok");
    assert!(project.rename_edit("src/Book.php", &source, "parent").is_err());
    // The same name: nothing to change.
    assert_eq!(project.rename_edit("src/Book.php", &source, "Book").unwrap().0, WorkspaceEdit::default());
}
