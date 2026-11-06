use super::*;
use crate::navigate::hover;

const SHOP_ITEM: &str = "<?php\nnamespace App\\Model;\n\nabstract class Item\n{\n    /** The price in cents. */\n    protected int $price = 0;\n\n    /**\n     * Gives the label shown in lists.\n     *\n     * @param string $prefix put in front\n     * @return string\n     */\n    abstract public function label(string $prefix = ''): string;\n}\n";
const SHOP_BOOK: &str = "<?php\nnamespace App\\Model;\n\n/**\n * A book on the shelf.\n */\nfinal class Book extends Item\n{\n    public const LIMIT = 3;\n\n    public function __construct(public string $title, public ?Book $sequel = null) {}\n\n    /** {@inheritDoc} */\n    public function label(string $prefix = ''): string { return $prefix . $this->title; }\n\n    public static function make(string $title): static { return new static($title); }\n\n    public function sequel(): ?Book { return $this->sequel; }\n}\n";
const SHOP_GENRE: &str = "<?php\nnamespace App\\Model;\n\nenum Genre: string\n{\n    case Fiction = 'f';\n}\n";
const SHOP_BOX: &str = "<?php\nnamespace App;\n\n/** @template T */\nfinal class Box\n{\n    /** @return T */\n    public function get() { return null; }\n}\n\n/** @return Box<\\App\\Model\\Book> */\nfunction books(): Box { return new Box(); }\n";

fn shop() -> Project {
    Project::new(&[
        ("src/Model/Item.php", SHOP_ITEM),
        ("src/Model/Book.php", SHOP_BOOK),
        ("src/Model/Genre.php", SHOP_GENRE),
        ("src/Box.php", SHOP_BOX),
        ("src/functions.php", FUNCTIONS),
    ])
}

/// `bin/run.php` in namespace `App` importing the model classes, then
/// `body` from line 5.
fn run(body: &str) -> String {
    format!("<?php\nnamespace App;\n\nuse App\\Model\\{{Book, Genre, Item}};\n\n{body}\n")
}

impl Project {
    fn type_definition(&mut self, rel: &str, source: &str) -> Option<Vec<(String, u32, String)>> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let targets = self.engine.type_definition(doc, pos);
        let found =
            targets.map(|targets| targets.iter().map(|target| self.describe(&target.path, target.range)).collect());
        self.engine.document_closed(doc);
        found
    }

    fn hover(&mut self, rel: &str, source: &str) -> Option<String> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let hover = self.engine.hover(doc, pos);
        self.engine.document_closed(doc);
        hover.map(|hover| hover.markdown)
    }
}

/// The files and lines of the targets.
fn lines(found: Option<Vec<(String, u32, String)>>) -> Lines {
    found.expect("handled").into_iter().map(|(file, line, _)| (file, line)).collect()
}

/// Targets as `(relative path, line)`.
type Lines = Vec<(String, u32)>;

fn at(file: &str, line: u32) -> Lines {
    vec![(file.to_owned(), line)]
}

#[test]
fn goto_members_through_the_receiver_type() {
    let mut project = shop();
    let book = "src/Model/Book.php";
    let cases: &[(&str, Lines, &str)] = &[
        ("$book = new Book('x');\n$book->lab/*|*/el();", at(book, 13), "a method"),
        ("$book = new Book('x');\necho $book->tit/*|*/le;", at(book, 10), "a promoted property"),
        ("$book = new Book('x');\necho $book->pri/*|*/ce;", at("src/Model/Item.php", 6), "an inherited property"),
        ("$book = new Book('x');\necho $book->sequel()->tit/*|*/le;", at(book, 10), "on a call's result"),
        ("$book = new Book('x');\necho $book?->sequel/*|*/()?->title;", at(book, 17), "nullsafe"),
        ("$b = Book::ma/*|*/ke('x');", at(book, 15), "a static method"),
        ("echo Book::LIM/*|*/IT;", at(book, 8), "a class constant"),
        ("echo Genre::Fic/*|*/tion->value;", at("src/Model/Genre.php", 5), "an enum case"),
        ("$g = (new Book('x'))->label/*|*/(...);", at(book, 13), "a first-class callable"),
        ("echo books()->ge/*|*/t()->title;", at("src/Box.php", 7), "a generic receiver"),
    ];
    for (body, want, what) in cases {
        assert_eq!(lines(project.definition("bin/run.php", &run(body))), *want, "{what}");
    }
    let source = run("$book = new Book('x');\n$book->miss/*|*/ing();");
    assert_eq!(project.definition("bin/run.php", &source), Some(vec![]), "an unknown member");
}

#[test]
fn goto_members_from_inside_classes() {
    let mut project = shop();
    let source = run(
        "final class Paper extends Item\n{\n    public function label(string $prefix = ''): string { return parent::lab/*|*/el($prefix); }\n}",
    );
    assert_eq!(lines(project.definition("bin/run.php", &source)), at("src/Model/Item.php", 14), "parent::");
    let source = run(
        "final class Paper extends Item\n{\n    public function label(string $prefix = ''): string { return $this->pri/*|*/ce; }\n}",
    );
    assert_eq!(lines(project.definition("bin/run.php", &source)), at("src/Model/Item.php", 6), "$this->");
    let source = run(
        "final class Paper extends Item\n{\n    public const SIZE = 1;\n    public function label(string $prefix = ''): string { return self::SI/*|*/ZE; }\n}",
    );
    assert_eq!(lines(project.definition("bin/run.php", &source)), at("bin/run.php", 7), "self::");
    // At a declaration: the declaration itself.
    let source = SHOP_BOOK.replace("function sequel()", "function seq/*|*/uel()");
    assert_eq!(lines(project.definition("src/Model/Book.php", &source)), at("src/Model/Book.php", 17));
}

#[test]
fn goto_parameters_of_named_arguments() {
    let mut project = shop();
    let source = run("echo slugify(te/*|*/xt: 'A b');");
    let found = project.definition("bin/run.php", &source).unwrap();
    assert_eq!(found, vec![target("src/functions.php", 5, "$text")], "a function's parameter");
    let source = run("$book = new Book(ti/*|*/tle: 'x');");
    assert_eq!(lines(project.definition("bin/run.php", &source)), at("src/Model/Book.php", 10), "a constructor's");
    let source = run("$book = new Book('x');\necho $book->label(pre/*|*/fix: '-');");
    assert_eq!(lines(project.definition("bin/run.php", &source)), at("src/Model/Book.php", 13), "a method's");
}

#[test]
fn goto_variables() {
    let mut project = shop();
    let file = "bin/run.php";
    let cases: &[(&str, u32, &str)] = &[
        ("$a = 1;\nif ($a) {\n    $a = 2;\n}\necho $/*|*/a;", 5, "the first assignment"),
        ("function f(int $n): int\n{\n    $n = 2;\n    return $n/*|*/;\n}", 5, "a parameter"),
        ("$x = 1;\n$f = function () use ($x) {\n    return $x/*|*/;\n};", 6, "a closure's capture"),
        ("$x = 1;\n$f = fn (int $y) => $x/*|*/ + $y;", 5, "the scope around an arrow function"),
        ("$f = fn (int $y) => $y/*|*/;", 5, "an arrow function's parameter"),
        ("foreach ([1] as $k => $v) {\n    echo $v/*|*/;\n}", 5, "a foreach value"),
        ("try {\n} catch (\\Exception $e) {\n    echo $e/*|*/;\n}", 6, "a catch variable"),
        ("[$p, $q] = [1, 2];\necho $q/*|*/;", 5, "destructuring"),
    ];
    for (body, line, what) in cases {
        let found = project.definition(file, &run(body)).unwrap();
        assert_eq!(found.iter().map(|t| (t.0.as_str(), t.1)).collect::<Vec<_>>(), [(file, *line)], "{what}");
    }
    let found = project.definition(file, &run("echo $nev/*|*/er;"));
    assert_eq!(found, Some(vec![]), "an undefined variable");
    let source = run(
        "final class Paper extends Item\n{\n    public function label(string $prefix = ''): string { return $th/*|*/is->price; }\n}",
    );
    assert_eq!(lines(project.definition(file, &source)), at(file, 5), "$this: the class");
}

#[test]
fn goto_type_definition() {
    let mut project = shop();
    let book = at("src/Model/Book.php", 6);
    let cases: &[(&str, &str)] = &[
        ("$book = new Book('x');\necho $bo/*|*/ok;", "a variable"),
        ("$book = new Book('x');\necho $book->seq/*|*/uel();", "a method's (nullable) return"),
        ("$book = new Book('x');\necho $book->seq/*|*/uel;", "a property"),
        ("echo books()->ge/*|*/t();", "a bound template"),
        ("function f(Book $b) { return $/*|*/b; }", "a parameter"),
        ("$b = Bo/*|*/ok::make('x');", "a class name"),
    ];
    for (body, what) in cases {
        assert_eq!(lines(project.type_definition("bin/run.php", &run(body))), book, "{what}");
    }
    let source = run("$n = 1;\necho $/*|*/n;");
    assert_eq!(project.type_definition("bin/run.php", &source), Some(vec![]), "a scalar has no class");
}

#[test]
fn hover_shows_signatures_types_and_docs() {
    let mut project = shop();
    let hover = |project: &mut Project, body: &str| project.hover("bin/run.php", &run(body)).expect("a hover");

    let text = hover(&mut project, "$book = new Book('x');\necho $book->lab/*|*/el();");
    assert!(
        text.starts_with(
            "`App\\Model\\Book`\n\n```php\n<?php\npublic function label(string $prefix = ''): string\n```"
        ),
        "{text}"
    );
    assert!(text.contains("Gives the label shown in lists."), "the inherited docblock: {text}");
    assert!(text.contains("*@param* `string` `$prefix` put in front"), "{text}");

    let text = hover(&mut project, "$book = new Book('x');\necho $book->pri/*|*/ce;");
    assert!(text.contains("protected int $price"), "{text}");
    assert!(text.contains("`App\\Model\\Item`") && text.contains("The price in cents."), "{text}");

    let text = hover(&mut project, "$b/*|*/ook = Book::make('x');");
    assert!(text.contains("App\\Model\\Book $book"), "a variable: its type: {text}");

    let text = hover(&mut project, "echo books()->ge/*|*/t();");
    assert!(text.contains("public function get(): App\\Model\\Book"), "the template bound: {text}");

    let text = hover(&mut project, "$b = Bo/*|*/ok::make('x');");
    assert!(text.contains("namespace App\\Model;\nfinal class Book extends \\App\\Model\\Item"), "{text}");
    assert!(text.contains("A book on the shelf."), "{text}");

    let text = hover(&mut project, "echo slug/*|*/ify('x');");
    assert!(text.contains("function slugify(string $text): string"), "{text}");

    let text = hover(&mut project, "$book = new Book('x');\necho $book->label(pre/*|*/fix: '-');");
    assert!(text.contains("`App\\Model\\Book::label()`") && text.contains("string $prefix = ''"), "{text}");
    assert!(text.contains("put in front"), "the @param description: {text}");

    let text = hover(&mut project, "echo Genre::Fic/*|*/tion;");
    assert!(text.contains("case Fiction = 'f';"), "{text}");
    let text = hover(&mut project, "echo Book::LIM/*|*/IT;");
    assert!(text.contains("public const LIMIT = 3;"), "{text}");

    assert_eq!(project.hover("bin/run.php", &run("$x = 1 /*|*/ + 2;")), None, "nothing at the caret");
}

#[test]
fn hover_on_built_ins_reads_the_stub_docs() {
    let mut project = shop();
    let text = project.hover("bin/run.php", &run("echo str/*|*/len('x');")).expect("a hover");
    assert!(text.contains("function strlen(string $string): "), "{text}");
    assert!(text.contains("Get string length"), "{text}");
    assert!(text.contains("---"), "the stub's docblock: {text}");
}

#[test]
fn doc_text_renders_phpdoc_as_markdown() {
    let doc = "/**\n     * Finds a book.\n     *\n     * Longer `text`.\n     *\n     * @param int|string $id the id,\n     *   or the ISBN\n     * @param callable(int): bool ...$filters\n     * @return Book|null\n     * @throws \\DomainException when lost\n     * @deprecated use get()\n     */";
    let parsed = hover::DocText::parse(doc);
    assert_eq!(parsed.description, "Finds a book.\n\nLonger `text`.");
    assert_eq!(
        parsed.markdown(),
        "Finds a book.\n\nLonger `text`.\n\n*@param* `int|string` `$id` the id, or the ISBN  \n*@param* `callable(int): bool` `...$filters`  \n*@return* `Book|null`  \n*@throws* `\\DomainException` when lost  \n*@deprecated* use get()"
    );
    let text = "<?php\n/** Doc. */\n#[Attr]\nfunction f() {}\n/* plain */\nfunction g() {}\n";
    assert_eq!(hover::doc_comment_before(text, text.find("#[Attr]").unwrap() as u32), Some("/** Doc. */"));
    assert_eq!(hover::doc_comment_before(text, text.find("function g").unwrap() as u32), None);
}
