use super::*;
use crate::navigate::UsageKind;

type Found = (String, u32, String, UsageKind);

impl Project {
    /// Find usages at the caret of `source`, opened as `rel`: `(relative
    /// path, line, the text at the range, kind)`, sorted.
    fn references(&mut self, rel: &str, source: &str, include_declaration: bool) -> Vec<Found> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let usages = self.engine.references(doc, pos, include_declaration, &CancellationToken::new());
        let found = usages
            .expect("something at the caret")
            .unwrap()
            .iter()
            .map(|usage| {
                let (rel, line, text) = self.describe(&usage.path, usage.range);
                (rel, line, text, usage.kind)
            })
            .collect();
        self.engine.document_closed(doc);
        found
    }
}

fn usage(rel: &str, line: u32, text: &str, kind: UsageKind) -> Found {
    (rel.to_owned(), line, text.to_owned(), kind)
}

fn lines(found: &[Found]) -> Vec<(&str, u32)> {
    found.iter().map(|usage| (usage.0.as_str(), usage.1)).collect()
}

#[test]
fn references_of_a_class_across_files_docs_and_strings() {
    let shelf = r"<?php
namespace App;

use App\Model\Book;
use App\Model\Book as Volume;

class Shelf
{
    /** @var list<Book> */
    private array $books = [];

    /**
     * @param Book|null $book the Book to add
     * @return Book
     */
    public function add(?Book $book): Volume { return new Volume(); }

    public function name(): string { return Book::class . 'App\\Model\\Book' . 'Book'; }
}
";
    let other = r"<?php
namespace Other;

class Book {}
function make(): Book { return new \App\Model\Book(); }
";
    let mut project = Project::new(&[
        ("src/Model/Book.php", BOOK),
        ("src/Model/Item.php", ITEM),
        ("src/Shelf.php", shelf),
        ("src/Other.php", other),
    ]);
    let source = BOOK.replace("final class Book", "final class Bo/*|*/ok");
    let found = project.references("src/Model/Book.php", &source, true);
    assert_eq!(
        found,
        [
            usage("src/Model/Book.php", 3, "Book", UsageKind::Declaration),
            usage("src/Other.php", 4, r"\App\Model\Book", UsageKind::Code),
            usage("src/Shelf.php", 3, r"App\Model\Book", UsageKind::Code),
            usage("src/Shelf.php", 4, r"App\Model\Book", UsageKind::Code),
            usage("src/Shelf.php", 8, "Book", UsageKind::Doc),
            usage("src/Shelf.php", 12, "Book", UsageKind::Doc),
            usage("src/Shelf.php", 13, "Book", UsageKind::Doc),
            usage("src/Shelf.php", 15, "Book", UsageKind::Code),
            usage("src/Shelf.php", 15, "Volume", UsageKind::Code),
            usage("src/Shelf.php", 15, "Volume", UsageKind::Code),
            usage("src/Shelf.php", 17, "Book", UsageKind::Code),
            usage("src/Shelf.php", 17, r"App\\Model\\Book", UsageKind::String),
        ]
    );
    // From a usage, without the declaration.
    let source = shelf.replace("?Book $book", "?Bo/*|*/ok $book");
    let found = project.references("src/Shelf.php", &source, false);
    assert_eq!(found.len(), 11, "{found:?}");
    assert!(found.iter().all(|usage| usage.3 != UsageKind::Declaration));
}

#[test]
fn references_of_methods_follow_the_hierarchy() {
    let repository = "<?php\nnamespace App;\n\ninterface Repository { public function find(int $id): ?object; }\n";
    let books = "<?php\nnamespace App;\n\nclass Books implements Repository\n{\n    public function find(int $id): ?object { return $this->find($id - 1); }\n}\n";
    let other = "<?php\nnamespace App;\n\nclass Other { public function find(int $id): ?object { return null; } }\n";
    let user = "<?php\nnamespace App;\n\nfunction use_them(Repository $r, Books $b, Other $o): void\n{\n    $r->find(1);\n    $b->FIND(2);\n    $o->find(3);\n    $f = $b->find(...);\n}\n";
    let mut project = Project::new(&[
        ("src/Repository.php", repository),
        ("src/Books.php", books),
        ("src/Other.php", other),
        ("src/use.php", user),
    ]);
    let source = repository.replace("function find", "function fi/*|*/nd");
    let found = project.references("src/Repository.php", &source, true);
    assert_eq!(
        found,
        [
            usage("src/Books.php", 5, "find", UsageKind::Code),
            usage("src/Repository.php", 3, "find", UsageKind::Declaration),
            usage("src/use.php", 5, "find", UsageKind::Code),
            usage("src/use.php", 6, "FIND", UsageKind::Code),
            usage("src/use.php", 8, "find", UsageKind::Code),
        ]
    );
    // From the implementation: calls through the interface count too.
    let source = user.replace("$b->FIND(2)", "$b->FI/*|*/ND(2)");
    let found = project.references("src/use.php", &source, false);
    assert_eq!(lines(&found), [("src/Books.php", 5), ("src/use.php", 5), ("src/use.php", 6), ("src/use.php", 8)]);
}

#[test]
fn references_of_functions_constants_and_members() {
    let library = r"<?php
namespace App;

use function App\slugify as slug;

final class Library
{
    public const MAX = 10;
    public string $title = '';

    public function name(): string
    {
        $this->title = slugify($this->title) . \App\VERSION . VERSION;
        return slug(self::MAX . static::MAX . Library::MAX);
    }
}
";
    let global = "<?php\nfunction slugify(string $s): string { return $s; }\nslugify('x');\n";
    let mut project =
        Project::new(&[("src/functions.php", FUNCTIONS), ("src/Library.php", library), ("global.php", global)]);
    // A namespaced function: the unqualified call in its namespace and the
    // imported alias, not the global function of the same name.
    let source = FUNCTIONS.replace("function slugify", "function slu/*|*/gify");
    let found = project.references("src/functions.php", &source, true);
    assert_eq!(
        found,
        [
            usage("src/Library.php", 3, r"App\slugify", UsageKind::Code),
            usage("src/Library.php", 12, "slugify", UsageKind::Code),
            usage("src/Library.php", 13, "slug", UsageKind::Code),
            usage("src/functions.php", 5, "slugify", UsageKind::Declaration),
        ]
    );
    let source = FUNCTIONS.replace("const VERSION", "const VER/*|*/SION");
    let found = project.references("src/functions.php", &source, false);
    assert_eq!(
        found,
        [
            usage("src/Library.php", 12, r"\App\VERSION", UsageKind::Code),
            usage("src/Library.php", 12, "VERSION", UsageKind::Code)
        ]
    );
    // Class constants and properties.
    let source = library.replace("public const MAX", "public const M/*|*/AX");
    let found = project.references("src/Library.php", &source, false);
    let texts: Vec<(u32, &str)> = found.iter().map(|usage| (usage.1, usage.2.as_str())).collect();
    assert_eq!(texts, [(13, "MAX"), (13, "MAX"), (13, "MAX")]);
    let source = library.replace("public string $title", "public string $ti/*|*/tle");
    let found = project.references("src/Library.php", &source, true);
    let texts: Vec<(u32, &str, UsageKind)> = found.iter().map(|usage| (usage.1, usage.2.as_str(), usage.3)).collect();
    assert_eq!(
        texts,
        [(8, "$title", UsageKind::Declaration), (12, "title", UsageKind::Code), (12, "title", UsageKind::Code)]
    );
}

#[test]
fn references_of_variables_and_parameters() {
    let functions = "<?php\nnamespace App;\n\nfunction pad(string $text, int $count = 1): string\n{\n    $count++;\n    $out = fn () => str_repeat($text, $count);\n    return $out();\n}\n\nfunction other(int $count): int { return $count; }\n";
    let user = "<?php\nnamespace App;\n\npad('x', count: 3);\nother(count: 1);\n";
    let mut project = Project::new(&[("src/functions.php", functions), ("src/use.php", user)]);
    // A parameter: its uses in the body (arrow functions see it) and the
    // named arguments of calls to its function, not another's.
    let source = functions.replace("int $count = 1", "int $co/*|*/unt = 1");
    let found = project.references("src/functions.php", &source, true);
    assert_eq!(
        found,
        [
            usage("src/functions.php", 3, "$count", UsageKind::Declaration),
            usage("src/functions.php", 5, "$count", UsageKind::Code),
            usage("src/functions.php", 6, "$count", UsageKind::Code),
            usage("src/use.php", 3, "count", UsageKind::Code),
        ]
    );
    // From the named argument: the same.
    let source = user.replace("pad('x', count: 3)", "pad('x', co/*|*/unt: 3)");
    let found = project.references("src/use.php", &source, false);
    assert_eq!(lines(&found), [("src/functions.php", 5), ("src/functions.php", 6), ("src/use.php", 3)]);
    // A local variable stays in its function.
    let source = functions.replace("return $out();", "return $o/*|*/ut();");
    let found = project.references("src/functions.php", &source, true);
    let kinds: Vec<(u32, UsageKind)> = found.iter().map(|usage| (usage.1, usage.3)).collect();
    assert_eq!(kinds, [(6, UsageKind::Declaration), (7, UsageKind::Code)]);
}

#[test]
fn references_see_unsaved_buffers_and_nothing_is_none() {
    let mut project = library();
    // A buffer that isn't on disk yet uses the function.
    project.open("src/new.php", "<?php\nnamespace App;\n\necho slugify('a');\n");
    let source = FUNCTIONS.replace("function slugify", "function slu/*|*/gify");
    let found = project.references("src/functions.php", &source, false);
    assert_eq!(found, [usage("src/new.php", 3, "slugify", UsageKind::Code)]);
    // Nothing at the caret.
    let (text, pos) = caret("<?php\n/*|*/\n");
    let doc = project.open("src/empty.php", &text);
    assert!(project.engine.references(doc, pos, true, &CancellationToken::new()).is_none());
}
