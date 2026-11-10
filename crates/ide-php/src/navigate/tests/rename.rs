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
    pub(super) fn apply(&self, edit: &WorkspaceEdit) -> BTreeMap<String, String> {
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

impl Project {
    /// The reason a rename at the caret is refused.
    fn refused(&mut self, rel: &str, source: &str, new_name: &str) -> String {
        match self.rename_edit(rel, source, new_name) {
            Ok((_, files)) => panic!("renamed to {new_name}: {files:?}"),
            Err(error) => error.message,
        }
    }
}

#[test]
fn member_conflicts_in_the_class_its_parents_traits_and_subclasses() {
    let base = "<?php\nnamespace App;\n\nclass Base\n{\n    public function shared(): void {}\n    private function hidden(): void {}\n    public const LIMIT = 1;\n}\n";
    let named = "<?php\nnamespace App;\n\ntrait Named { public function label(): string { return ''; } }\n";
    let book = "<?php\nnamespace App;\n\nclass Book extends Base\n{\n    use Named;\n    public string $title = '';\n    protected int $pages = 0;\n    public function find(): void {}\n    public function load(): void {}\n    private function secret(): void {}\n    public const SIZE = 2;\n}\n";
    let novel = "<?php\nnamespace App;\n\nclass Novel extends Book { public function chapter(): void {} private function store(): void {} }\n";
    let mut project = Project::new(&[
        ("src/Base.php", base),
        ("src/Named.php", named),
        ("src/Book.php", book),
        ("src/Novel.php", novel),
    ]);
    let find = book.replace("function find", "function fi/*|*/nd");
    for (new, reason) in [
        ("load", "Method 'load' already exists in App\\Book"),
        ("LOAD", "Method 'LOAD' already exists in App\\Book"),
        ("shared", "Method 'shared' already exists in App\\Base"),
        ("label", "Method 'label' already exists in App\\Named"),
        ("chapter", "Method 'chapter' already exists in App\\Novel"),
        ("store", "Method 'store' already exists in App\\Novel"),
    ] {
        assert_eq!(project.refused("src/Book.php", &find, new), reason);
    }
    // A parent's private method isn't inherited; a case change is the same method.
    assert!(project.renamed("src/Book.php", &find, "hidden")["src/Book.php"].contains("function hidden()"));
    assert!(project.renamed("src/Book.php", &find, "Find")["src/Book.php"].contains("function Find()"));
    // A private method stays in its class: a subclass's method is no clash.
    let secret = book.replace("function secret", "function sec/*|*/ret");
    assert!(project.renamed("src/Book.php", &secret, "store")["src/Book.php"].contains("function store()"));
    assert_eq!(project.refused("src/Book.php", &secret, "load"), "Method 'load' already exists in App\\Book");

    // Properties are case-sensitive.
    let title = book.replace("string $title", "string $ti/*|*/tle");
    assert_eq!(project.refused("src/Book.php", &title, "pages"), "Property '$pages' already exists in App\\Book");
    assert!(project.renamed("src/Book.php", &title, "Pages")["src/Book.php"].contains("string $Pages"));
    // Constants, the parent's included.
    let size = book.replace("const SIZE", "const SI/*|*/ZE");
    assert_eq!(project.refused("src/Book.php", &size, "LIMIT"), "Constant 'LIMIT' already exists in App\\Base");
    assert!(project.renamed("src/Book.php", &size, "WIDTH")["src/Book.php"].contains("const WIDTH = 2"));
}

#[test]
fn name_conflicts_in_the_namespace() {
    let functions = "<?php\nnamespace App;\n\nconst VERSION = '1.0';\nconst RELEASE = '2';\n\nfunction format_price(int $cents): string { return ''; }\nfunction money(): void {}\n";
    let mut project =
        Project::new(&[("src/Model/Book.php", BOOK), ("src/Model/Item.php", ITEM), ("src/functions.php", functions)]);
    let book = BOOK.replace("final class Book", "final class Bo/*|*/ok");
    assert_eq!(project.refused("src/Model/Book.php", &book, "Item"), "Class 'App\\Model\\Item' already exists");
    assert_eq!(project.refused("src/Model/Book.php", &book, "ITEM"), "Class 'App\\Model\\ITEM' already exists");
    // Only the case changes: the class itself.
    assert!(project.renamed("src/Model/Book.php", &book, "BOOK")["src/Model/Book.php"].contains("class BOOK"));
    let price = functions.replace("function format_price", "function format_pr/*|*/ice");
    assert_eq!(project.refused("src/functions.php", &price, "Money"), "Function 'App\\Money' already exists");
    let version = functions.replace("const VERSION", "const VERS/*|*/ION");
    assert_eq!(project.refused("src/functions.php", &version, "RELEASE"), "Constant 'App\\RELEASE' already exists");
    // Constant names are case-sensitive.
    assert!(project.renamed("src/functions.php", &version, "Release")["src/functions.php"].contains("const Release"));
}

#[test]
fn a_short_name_taken_by_an_import_is_written_fully_qualified() {
    let novel = "<?php\nnamespace Lib;\n\nfinal class Novel {}\n";
    let shelf = "<?php\nnamespace App;\n\nuse App\\Model\\Book;\nuse Lib\\Novel;\n\nclass Shelf\n{\n    /** @param list<Book> $books */\n    public function add(array $books, Novel $novel): Book { return new Book(); }\n}\n";
    let user = "<?php\nnamespace App\\Model;\n\nfunction make(): Book { return new Book(); }\n";
    let mut project = Project::new(&[
        ("src/Model/Book.php", BOOK),
        ("src/Model/Item.php", ITEM),
        ("lib/Novel.php", novel),
        ("src/Shelf.php", shelf),
        ("src/user.php", user),
    ]);
    let source = BOOK.replace("final class Book", "final class Bo/*|*/ok");
    let files = project.renamed("src/Model/Book.php", &source, "Novel");
    assert_eq!(files["src/Model/Book.php"], BOOK.replace("class Book", "class Novel"));
    assert_eq!(
        files["src/Shelf.php"],
        "<?php\nnamespace App;\n\nuse Lib\\Novel;\n\nclass Shelf\n{\n    /** @param list<\\App\\Model\\Novel> $books */\n    public function add(array $books, Novel $novel): \\App\\Model\\Novel { return new \\App\\Model\\Novel(); }\n}\n"
    );
    // No clash there.
    assert_eq!(files["src/user.php"], user.replace("Book", "Novel"));

    // A function: its `use function` goes, its calls are qualified.
    let functions = "<?php\nnamespace App;\n\nfunction format_price(int $cents): string { return ''; }\n";
    let other = "<?php\nnamespace Lib;\n\nfunction money(): void {}\n";
    let web = "<?php\nnamespace Web;\n\nuse function App\\format_price;\nuse function Lib\\money;\n\necho format_price(3);\nmoney();\n";
    let mut project = Project::new(&[("src/functions.php", functions), ("lib/money.php", other), ("src/web.php", web)]);
    let source = functions.replace("function format_price", "function format_pr/*|*/ice");
    let files = project.renamed("src/functions.php", &source, "money");
    assert_eq!(
        files["src/web.php"],
        "<?php\nnamespace Web;\n\nuse function Lib\\money;\n\necho \\App\\money(3);\nmoney();\n"
    );

    // The file declaring the class can't be helped.
    let clash = "<?php\nnamespace App\\Model;\n\nuse Lib\\Novel;\n\nfinal class Paper { public function n(): Novel { return new Novel(); } }\n";
    let mut project = Project::new(&[("lib/Novel.php", novel), ("src/Model/Paper.php", clash)]);
    let source = clash.replace("final class Paper", "final class Pa/*|*/per");
    assert_eq!(
        project.refused("src/Model/Paper.php", &source, "Novel"),
        "The name 'Novel' is already used in Paper.php"
    );
}

#[test]
fn variable_conflicts_in_scope() {
    let functions = "<?php\nnamespace App;\n\nfunction slugify(string $text, int $max): string\n{\n    $slug = strtolower($text);\n    $short = fn() => substr($slug, 0, $max);\n    $other = function () { $text = 'x'; return $text; };\n    return $short();\n}\n";
    let mut project = Project::new(&[("src/functions.php", functions)]);
    let slug = functions.replace("$slug = strtolower", "$sl/*|*/ug = strtolower");
    assert_eq!(
        project.refused("src/functions.php", &slug, "text"),
        "Variable '$text' is already defined in this scope"
    );
    assert_eq!(
        project.refused("src/functions.php", &slug, "$short"),
        "Variable '$short' is already defined in this scope"
    );
    // An arrow function sees its parent's variables.
    let max = functions.replace("int $max", "int $m/*|*/ax");
    assert_eq!(project.refused("src/functions.php", &max, "slug"), "Variable '$slug' is already defined in this scope");
    // A closure without `use` has its own.
    let inner = functions.replace("$text = 'x'", "$te/*|*/xt = 'x'");
    let files = project.renamed("src/functions.php", &inner, "slug");
    assert!(files["src/functions.php"].contains("function () { $slug = 'x'; return $slug; }"), "{files:?}");
    let files = project.renamed("src/functions.php", &slug, "lower");
    assert_eq!(files["src/functions.php"], functions.replace("$slug", "$lower"));
}

#[test]
fn docblock_names_stay_in_their_own_function() {
    let functions = "<?php\nnamespace App;\n\n/** @param string $text the text */\nfunction slugify(string $text): string\n{\n    /** @var string $text */\n    $text = trim($text);\n    $each = function (array $items): array {\n        /** @var string $text */\n        $text = implode(',', $items);\n        return [$text];\n    };\n    /** @param string $text */\n    $mapped = static fn(string $other) => $other . $text;\n    return $text;\n}\n";
    let mut project = Project::new(&[("src/functions.php", functions)]);
    let source = functions.replace("$text = trim($text)", "$text = trim($te/*|*/xt)");
    let files = project.renamed("src/functions.php", &source, "title");
    assert_eq!(
        files["src/functions.php"],
        "<?php\nnamespace App;\n\n/** @param string $title the text */\nfunction slugify(string $title): string\n{\n    /** @var string $title */\n    $title = trim($title);\n    $each = function (array $items): array {\n        /** @var string $text */\n        $text = implode(',', $items);\n        return [$text];\n    };\n    /** @param string $title */\n    $mapped = static fn(string $other) => $other . $title;\n    return $title;\n}\n"
    );
    // From inside the closure: only its own docblock.
    let source = functions.replace("return [$text]", "return [$te/*|*/xt]");
    let files = project.renamed("src/functions.php", &source, "joined");
    assert_eq!(
        files["src/functions.php"],
        functions.replace(
            "        /** @var string $text */\n        $text = implode(',', $items);\n        return [$text];",
            "        /** @var string $joined */\n        $joined = implode(',', $items);\n        return [$joined];"
        )
    );
}

#[test]
fn renaming_a_define_constant_from_its_declaration_and_a_use() {
    let config = r"<?php
namespace App;

define('APP_LIMIT', 10);
define('APP_MAX', 20);

if (!defined('APP_LIMIT')) { echo constant('\APP_LIMIT') . constant('Foo::APP_LIMIT'); }
";
    let user = r"<?php
namespace Web;

echo APP_LIMIT . \APP_LIMIT . 'APP_LIMIT';
";
    let mut project = Project::new(&[("src/config.php", config), ("src/user.php", user)]);
    let renamed_config = config
        .replace("define('APP_LIMIT'", "define('LIMIT'")
        .replace("defined('APP_LIMIT')", "defined('LIMIT')")
        .replace("constant('\\APP_LIMIT')", "constant('\\LIMIT')");
    let renamed_user = "<?php\nnamespace Web;\n\necho LIMIT . \\LIMIT . 'APP_LIMIT';\n";

    // From the declaration's string.
    let source = config.replace("define('APP_LIMIT'", "define('APP_LI/*|*/MIT'");
    assert_eq!(project.prepare("src/config.php", &source).as_deref(), Some("APP_LIMIT"));
    let files = project.renamed("src/config.php", &source, "LIMIT");
    assert_eq!(files["src/config.php"], renamed_config);
    assert_eq!(files["src/user.php"], renamed_user);

    // From a use, and from `defined()`.
    let source = user.replace("echo APP_LIMIT", "echo APP_LI/*|*/MIT");
    let files = project.renamed("src/user.php", &source, "LIMIT");
    assert_eq!(files["src/config.php"], renamed_config);
    assert_eq!(files["src/user.php"], renamed_user);
    let source = config.replace("defined('APP_LIMIT')", "defined('APP_/*|*/LIMIT')");
    assert_eq!(project.prepare("src/config.php", &source).as_deref(), Some("APP_LIMIT"));
    assert_eq!(project.renamed("src/config.php", &source, "LIMIT")["src/config.php"], renamed_config);

    // Another define() constant has the name.
    assert_eq!(project.refused("src/config.php", &source, "APP_MAX"), "Constant 'APP_MAX' already exists");
    // Not a constant name.
    let other = config.replace("constant('Foo::APP_LIMIT')", "constant('Foo::APP_/*|*/LIMIT')");
    assert_eq!(project.prepare("src/config.php", &other), None);
}

impl Project {
    /// The possible usages a rename at the caret lists: (file, line, text).
    fn possible(&mut self, rel: &str, source: &str, new_name: &str) -> Vec<(String, u32, String)> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let outcome = self
            .engine
            .rename_with_possible_usages(doc, pos, new_name, &CancellationToken::new())
            .expect("the document is open")
            .unwrap();
        self.engine.document_closed(doc);
        outcome
            .possible_usages
            .iter()
            .map(|usage| {
                let file = std::fs::read_to_string(&usage.path).unwrap();
                let index = LineIndex::new(&file);
                let (start, end) = index.byte_range(usage.range);
                (self.rel(&usage.path), usage.range.start.line, file[start as usize..end as usize].to_owned())
            })
            .collect()
    }
}

#[test]
fn dynamic_uses_are_listed_as_possible_usages() {
    let functions = r"<?php
namespace App;

function format_price(int $cents): string { return ''; }

class Repo
{
    public string $title = '';
    public function find(): void {}
}
";
    let user = r"<?php
namespace Web;

use App\Repo;
use function App\format_price;

function run(Repo $repo, string $f, string $m, string $p, array $prices): void
{
    format_price(1);
    $f(2);
    call_user_func('App\format_price', 3);
    array_map('\App\format_price', $prices);
    echo strlen('App\format_price');
    $repo->find();
    $repo->$m();
    $repo?->{$m . 'x'}();
    call_user_func([$repo, 'find']);
    call_user_func('App\Repo::find');
    echo implode(',', [$repo, 'find']);
    echo $repo->title . $repo->$p;
}
";
    let mut project = Project::new(&[("src/functions.php", functions), ("src/user.php", user)]);
    let user_line = |line: u32, text: &str| ("src/user.php".to_owned(), line, text.to_owned());

    // A function: dynamic calls and string callables, not other strings.
    let source = user.replace("    format_price(1);", "    format_pr/*|*/ice(1);");
    assert_eq!(
        project.possible("src/user.php", &source, "money"),
        [user_line(9, "$f"), user_line(10, r"App\format_price"), user_line(11, r"\App\format_price")]
    );
    let files = project.renamed("src/user.php", &source, "money");
    assert!(files["src/user.php"].contains(r"call_user_func('App\format_price', 3);"), "not edited");

    // A method: dynamic calls, `[$o, 'm']` and `'Class::m'` callables.
    let source = user.replace("$repo->find();", "$repo->fi/*|*/nd();");
    assert_eq!(
        project.possible("src/user.php", &source, "lookup"),
        [user_line(14, "$m"), user_line(15, "{$m . 'x'}"), user_line(16, "find"), user_line(17, r"App\Repo::find"),]
    );

    // A property: dynamic accesses.
    let source = user.replace("$repo->title", "$repo->ti/*|*/tle");
    assert_eq!(project.possible("src/user.php", &source, "name"), [user_line(19, "$p")]);

    // A class has none.
    let source = user.replace("function run(Repo", "function run(Re/*|*/po");
    assert_eq!(project.possible("src/user.php", &source, "Store"), []);
}

#[test]
fn a_trait_methods_conflicts_include_the_classes_using_it() {
    let named = "<?php\nnamespace App;\n\ntrait Named { public function label(): string { return ''; } }\n";
    let titled = "<?php\nnamespace App;\n\ntrait Titled { use Named; }\n";
    let book = "<?php\nnamespace App;\n\nclass Book { use Titled; private function title(): void {} }\n";
    let novel = "<?php\nnamespace App;\n\nclass Novel extends Book { public function chapter(): void {} }\n";
    let paper = "<?php\nnamespace App;\n\nclass Paper { use Named; public function page(): void {} }\n";
    let mut project = Project::new(&[
        ("src/Named.php", named),
        ("src/Titled.php", titled),
        ("src/Book.php", book),
        ("src/Novel.php", novel),
        ("src/Paper.php", paper),
    ]);
    let label = named.replace("function label", "function la/*|*/bel");
    for (new, reason) in [
        ("page", "Method 'page' already exists in App\\Paper"),
        // Through another trait, the user's private method included.
        ("title", "Method 'title' already exists in App\\Book"),
        ("chapter", "Method 'chapter' already exists in App\\Novel"),
    ] {
        assert_eq!(project.refused("src/Named.php", &label, new), reason);
    }
    assert!(project.renamed("src/Named.php", &label, "caption")["src/Named.php"].contains("function caption()"));
}
