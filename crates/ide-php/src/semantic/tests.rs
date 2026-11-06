use std::sync::Arc;
use std::time::Duration;

use ide_core::{IdeEvent, SharedSink};

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;

const WAIT: Duration = Duration::from_secs(60);

const MODEL: &str = r#"<?php
namespace App\Model;

interface HasIsbn
{
    public function isbn(): string;
}

enum Status: string
{
    case Available = 'a';
    case Lent = 'l';
}

trait Stamps
{
    public static int $created = 0;
}

class Book implements HasIsbn
{
    use Stamps;

    public const PREFIX = 'isbn:';

    public function __construct(public readonly string $code, public Status $status = Status::Available) {}

    public function isbn(): string { return self::PREFIX . $this->code; }

    /** @deprecated use isbn() */
    public function oldIsbn(): string { return $this->isbn(); }

    public static function make(string $code): static { return new static($code); }
}

const LIMIT = 10;

function shelve(Book $book, int $count = 1): void {}
"#;

/// The tokens of `text`, one `line:col text type modifiers` per line.
fn golden(text: &str) -> String {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/Model.php"), MODEL).unwrap();
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let config = EngineConfig {
        cache_dir: base.join("cache").join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
        stubs: StubFilter::default(),
    };
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(WAIT));
    let doc = DocId(1);
    engine.document_opened(doc, &root.join("src/Use.php"), 1, text);
    let tokens = engine.semantic_tokens(doc).expect("handled");
    engine.shutdown();
    render(text, &tokens)
}

fn render(text: &str, tokens: &[SemanticToken]) -> String {
    let lines: Vec<Vec<u16>> = text.lines().map(|line| line.encode_utf16().collect()).collect();
    let mut out = String::new();
    for token in tokens {
        let line = &lines[token.start.line as usize];
        let start = token.start.col as usize;
        let word = String::from_utf16(&line[start..start + token.len as usize]).unwrap();
        let modifiers: Vec<&str> = TOKEN_MODIFIERS
            .iter()
            .enumerate()
            .filter(|(bit, _)| token.modifiers & (1 << bit) != 0)
            .map(|(_, name)| *name)
            .collect();
        out.push_str(&format!("{}:{} {word} {}", token.start.line, token.start.col, token.ty.as_str()));
        if !modifiers.is_empty() {
            out.push_str(&format!(" [{}]", modifiers.join(" ")));
        }
        out.push('\n');
    }
    out
}

#[test]
fn legend_matches_the_enums() {
    for (i, name) in TOKEN_TYPES.iter().enumerate() {
        let ty = [
            TokenType::Class,
            TokenType::Interface,
            TokenType::Enum,
            TokenType::Function,
            TokenType::Method,
            TokenType::Property,
            TokenType::EnumMember,
            TokenType::Parameter,
            TokenType::Variable,
        ][i];
        assert_eq!(ty.as_str(), *name);
        assert_eq!(ty.index() as usize, i);
    }
    assert_eq!(1 << TOKEN_MODIFIERS.iter().position(|m| *m == "deprecated").unwrap(), modifier::DEPRECATED);
    assert_eq!(1 << TOKEN_MODIFIERS.iter().position(|m| *m == "defaultLibrary").unwrap(), modifier::DEFAULT_LIBRARY);
}

#[test]
fn golden_tokens_of_the_model_file() {
    let expected = "\
3:10 HasIsbn interface [declaration]
5:20 isbn method [declaration]
8:5 Status enum [declaration]
10:9 Available enumMember [declaration]
11:9 Lent enumMember [declaration]
14:6 Stamps class [declaration]
16:22 $created property [declaration static]
19:6 Book class [declaration]
19:22 HasIsbn interface
21:8 Stamps class
23:17 PREFIX variable [declaration static readonly]
25:20 __construct method [declaration]
25:55 $code parameter [declaration]
25:69 Status enum
25:76 $status parameter [declaration]
25:86 Status enum
25:94 Available enumMember
27:20 isbn method [declaration]
27:50 PREFIX variable [static readonly]
27:66 code property [readonly]
30:20 oldIsbn method [declaration deprecated]
30:54 isbn method
32:27 make method [declaration static]
32:39 $code parameter [declaration]
32:74 $code parameter
35:6 LIMIT variable [declaration static readonly]
37:9 shelve function [declaration]
37:16 Book class
37:21 $book parameter [declaration]
37:32 $count parameter [declaration]
";
    assert_eq!(golden(MODEL), expected);
}

#[test]
fn golden_tokens_of_uses() {
    let text = r#"<?php
namespace App;

use App\Model\Book;
use App\Model\Status;
use function App\Model\shelve;
use const App\Model\LIMIT;

function lend(Book $book, ?string $note = null): int
{
    $count = strlen($book->isbn()) + LIMIT;
    $legacy = $book->oldIsbn();
    $made = Book::make(code: 'x');
    $iterator = new \ArrayIterator([]);
    $iterator->count();
    $status = $book?->status === Status::Lent;
    $created = Book::$created;
    shelve($made, count: $count);
    $f = fn(int $n) => $n + $count + PHP_INT_MAX;
    $g = function ($x) use ($note) { return $x . $note . $_GET['q']; };
    return $count;
}
"#;
    let expected = "\
3:4 App\\Model\\Book class
4:4 App\\Model\\Status enum
5:13 App\\Model\\shelve function
6:10 App\\Model\\LIMIT variable [static readonly]
8:9 lend function [declaration]
8:14 Book class
8:19 $book parameter [declaration]
8:34 $note parameter [declaration]
10:4 $count variable
10:13 strlen function [defaultLibrary]
10:20 $book parameter
10:27 isbn method
10:37 LIMIT variable [static readonly]
11:4 $legacy variable
11:14 $book parameter
11:21 oldIsbn method [deprecated]
12:4 $made variable
12:12 Book class
12:18 make method [static]
12:23 code parameter
13:4 $iterator variable
13:20 \\ArrayIterator class [defaultLibrary]
14:4 $iterator variable
14:15 count method [defaultLibrary]
15:4 $status variable
15:14 $book parameter
15:22 status property
15:33 Status enum
15:41 Lent enumMember
16:4 $created variable
16:15 Book class
16:21 $created property [static]
17:4 shelve function
17:11 $made variable
17:18 count parameter
17:25 $count variable
18:4 $f variable
18:16 $n parameter [declaration]
18:23 $n parameter
18:28 $count variable
18:37 PHP_INT_MAX variable [static readonly defaultLibrary]
19:4 $g variable
19:19 $x parameter [declaration]
19:28 $note variable
19:44 $x parameter
19:49 $note variable
20:11 $count variable
";
    assert_eq!(golden(text), expected);
}

#[test]
fn long_chains_are_not_typed_link_by_link() {
    let chain = "->isbn()".repeat(400);
    let text = format!(
        "<?php\nnamespace App;\n\nuse App\\Model\\Book;\n\nfunction f(Book $book) {{ $book->oldIsbn(){chain}; $book->oldIsbn(); }}\n"
    );
    let tokens = golden(&text);
    // The links are methods; the short call is still typed (deprecated).
    assert_eq!(tokens.lines().filter(|line| line.ends_with(" isbn method")).count(), 400);
    assert!(tokens.lines().any(|line| line.ends_with("oldIsbn method [deprecated]")), "{tokens}");
}
