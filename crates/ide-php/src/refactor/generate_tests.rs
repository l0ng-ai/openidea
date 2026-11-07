//! Generate: implement / override methods, constructors, getters and
//! setters and property PHPDoc, the text before and after.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ide_core::{DocId, FileEdit, IdeEvent, Pos, Range, SharedSink};

use super::generate::{GENERATE_ACCESSORS, GENERATE_CONSTRUCTOR, IMPLEMENT_METHODS, OVERRIDE_METHODS};
use crate::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use crate::imports::{ACTION_KINDS, REWRITE};
use crate::project::LayoutConfig;
use crate::stubs::{PhpVersion, StubFilter};

const WAIT: Duration = Duration::from_secs(60);
const CARET: &str = "/*|*/";

struct Project {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
    next_doc: u32,
}

impl Project {
    /// A project with `files` under `src/`, indexed before the engine is
    /// ready.
    fn new(version: PhpVersion, files: &[(&str, &str)]) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        for (name, text) in files {
            std::fs::write(root.join("src").join(name), text).unwrap();
        }
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::all_extensions(version),
        };
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(WAIT));
        Self { _tmp: tmp, root, engine, next_doc: 1 }
    }

    /// The actions of `kind` with the caret (or selection) marked in
    /// `marked`, opened as `src/a.php`: their titles and the text after
    /// each.
    fn actions(&mut self, marked: &str, kind: &str) -> Vec<(String, String)> {
        let (text, range) = selection(marked);
        let doc = DocId(self.next_doc);
        self.next_doc += 1;
        self.engine.document_opened(doc, &self.root.join("src/a.php"), 1, &text);
        let actions = self.engine.code_actions(doc, range, &[kind.to_owned()]).expect("open");
        self.engine.document_closed(doc);
        actions
            .into_iter()
            .map(|action| {
                assert!(action.kind.starts_with(kind), "{}", action.kind);
                (action.title.clone(), applied(&text, &action.edit))
            })
            .collect()
    }

    fn titles(&mut self, marked: &str, kind: &str) -> Vec<String> {
        self.actions(marked, kind).into_iter().map(|(title, _)| title).collect()
    }

    /// The text after the action titled `title`.
    fn after(&mut self, marked: &str, kind: &str, title: &str) -> String {
        let found = self.actions(marked, kind);
        found
            .iter()
            .find(|(t, _)| t == title)
            .unwrap_or_else(|| panic!("no '{title}' in {:?}", found.iter().map(|(t, _)| t).collect::<Vec<_>>()))
            .1
            .clone()
    }
}

fn pos(text: &str, at: usize) -> Pos {
    let before = &text[..at];
    let line = before.matches('\n').count() as u32;
    let col = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
    Pos::new(line, col)
}

/// The text without the markers and the range they mark.
fn selection(marked: &str) -> (String, Range) {
    let first = marked.find(CARET).expect("a marker");
    let text = marked.replacen(CARET, "", 1);
    match text.find(CARET) {
        Some(second) => {
            let text = text.replacen(CARET, "", 1);
            (text.clone(), Range::new(pos(&text, first), pos(&text, second)))
        }
        None => (text.clone(), Range::new(pos(&text, first), pos(&text, first))),
    }
}

fn applied(text: &str, edit: &ide_core::WorkspaceEdit) -> String {
    let [FileEdit::Edit { edits, .. }] = edit.files.as_slice() else { panic!("one file: {edit:?}") };
    let mut document = ide_text::Document::new(text);
    document.apply_edits(edits).unwrap();
    document.text().to_string()
}

const SHAPES: &str = "<?php
namespace App\\Shapes;

use App\\Model\\Color;

interface Shape
{
    public function area(): float;

    public function scale(float $factor, ?Color $tint = null): self;
}

abstract class Base implements Shape
{
    abstract protected function name(): string;

    public function describe(string $prefix = '', string ...$tags): string
    {
        return $prefix . $this->name();
    }

    public function reset(): void
    {
    }

    final public function id(): int
    {
        return 1;
    }

    private function secret(): void
    {
    }

    public static function make(array &$options): static
    {
        return new static();
    }
}
";

const COLOR: &str = "<?php
namespace App\\Model;

class Color
{
}
";

// ------------------------------------------------------------ implement

#[test]
fn implement_methods_declares_every_missing_abstract_method() {
    let mut p = Project::new(PhpVersion::LATEST, &[("shapes.php", SHAPES), ("color.php", COLOR)]);
    // Another namespace: the classes the signatures name are imported,
    // `self` of the interface becomes its name.
    let before = "<?php
namespace App;

use App\\Shapes\\Base;

class Square extends Base
{
    private float $side = 1.0;
/*|*/
}
";
    assert_eq!(p.titles(before, IMPLEMENT_METHODS), ["Implement methods"]);
    assert_eq!(
        p.after(before, IMPLEMENT_METHODS, "Implement methods"),
        "<?php
namespace App;

use App\\Model\\Color;
use App\\Shapes\\Base;
use App\\Shapes\\Shape;

class Square extends Base
{
    private float $side = 1.0;

    protected function name(): string
    {
        // TODO: Implement name() method.
    }

    public function area(): float
    {
        // TODO: Implement area() method.
    }

    public function scale(float $factor, ?Color $tint = null): Shape
    {
        // TODO: Implement scale() method.
    }
}
"
    );
    // An empty enum implementing an interface of the same namespace.
    assert_eq!(
        p.after(
            "<?php\nnamespace App\\Shapes;\n\nenum Kind implements Shape\n{/*|*/\n}\n",
            IMPLEMENT_METHODS,
            "Implement methods"
        ),
        "<?php
namespace App\\Shapes;

use App\\Model\\Color;

enum Kind implements Shape
{
    public function area(): float
    {
        // TODO: Implement area() method.
    }

    public function scale(float $factor, ?Color $tint = null): Shape
    {
        // TODO: Implement scale() method.
    }
}
"
    );
    // Nothing missing, an interface, inside a method body: nothing.
    let done = "<?php
namespace App\\Shapes;

class Circle implements Shape
{
    public function area(): float { return 1.0; }
    public function scale(float $factor, ?\\App\\Model\\Color $tint = null): self { /*|*/return $this; }
}
";
    assert!(p.titles(done, IMPLEMENT_METHODS).is_empty());
    assert!(
        p.titles(&done.replace("/*|*/", "").replace("class Circle", "class /*|*/Circle"), IMPLEMENT_METHODS).is_empty()
    );
    assert!(
        p.titles("<?php\nnamespace App\\Shapes;\ninterface Big extends Shape\n{/*|*/\n}\n", IMPLEMENT_METHODS)
            .is_empty()
    );
}

#[test]
fn implement_methods_of_a_trait_and_a_built_in_interface() {
    let mut p = Project::new(PhpVersion::LATEST, &[]);
    assert_eq!(
        p.after(
            "<?php
trait Named
{
    abstract public static function label(int $n): string;
}

class Box implements Countable
{
    use Named;
/*|*/
}
",
            IMPLEMENT_METHODS,
            "Implement methods"
        ),
        "<?php
trait Named
{
    abstract public static function label(int $n): string;
}

class Box implements Countable
{
    use Named;

    public static function label(int $n): string
    {
        // TODO: Implement label() method.
    }

    public function count(): int
    {
        // TODO: Implement count() method.
    }
}
"
    );
}

// ------------------------------------------------------------- override

#[test]
fn override_methods_call_the_parent() {
    let mut p = Project::new(PhpVersion::LATEST, &[("shapes.php", SHAPES), ("color.php", COLOR)]);
    let before = "<?php
namespace App\\Shapes;

class Square extends Base
{
    public function describe(string $prefix = '', string ...$tags): string
    {
        return 'square';
    }
/*|*/
}
";
    // Not `describe` (declared here), `id` (final), `secret` (private) or
    // the abstract ones; nearest parent first.
    assert_eq!(
        p.titles(before, OVERRIDE_METHODS),
        ["Override method 'Base::reset()'", "Override method 'Base::make()'"]
    );
    assert_eq!(
        p.after(before, OVERRIDE_METHODS, "Override method 'Base::reset()'"),
        "<?php
namespace App\\Shapes;

class Square extends Base
{
    public function describe(string $prefix = '', string ...$tags): string
    {
        return 'square';
    }

    public function reset(): void
    {
        parent::reset();
    }
}
"
    );
    assert_eq!(
        p.after(before, OVERRIDE_METHODS, "Override method 'Base::make()'"),
        "<?php
namespace App\\Shapes;

class Square extends Base
{
    public function describe(string $prefix = '', string ...$tags): string
    {
        return 'square';
    }

    public static function make(array &$options): static
    {
        return parent::make($options);
    }
}
"
    );
    // Variadics are spread; a grand-parent comes after the parent.
    let deeper = "<?php
namespace App\\Shapes;

abstract class Middle extends Base
{
    public function extra() {}
}

class Leaf extends Middle
{
/*|*/
}
";
    let titles = p.titles(deeper, OVERRIDE_METHODS);
    assert_eq!(
        titles,
        [
            "Override method 'Middle::extra()'",
            "Override method 'Base::describe()'",
            "Override method 'Base::reset()'",
            "Override method 'Base::make()'"
        ]
    );
    let after = p.after(deeper, OVERRIDE_METHODS, "Override method 'Base::describe()'");
    assert!(
        after.contains(
            "    public function describe(string $prefix = '', string ...$tags): string
    {
        return parent::describe($prefix, ...$tags);
    }
"
        ),
        "{after}"
    );
    // No parent: nothing.
    assert!(p.titles("<?php\nclass Lone\n{\n/*|*/\n}\n", OVERRIDE_METHODS).is_empty());
}

// ---------------------------------------------------------- constructor

#[test]
fn generate_a_constructor_for_the_properties_without_a_value() {
    let mut p = Project::new(PhpVersion::LATEST, &[]);
    let before = "<?php
class Book
{
    private string $title;
    /** @var list<string> */
    protected array $authors;
    private int $pages = 0;
    private static int $count;
    public $isbn;
/*|*/
    public function title(): string
    {
        return $this->title;
    }
}
";
    assert_eq!(
        p.titles(before, GENERATE_CONSTRUCTOR),
        ["Generate constructor", "Generate constructor with promoted properties"]
    );
    assert_eq!(
        p.after(before, GENERATE_CONSTRUCTOR, "Generate constructor"),
        "<?php
class Book
{
    private string $title;
    /** @var list<string> */
    protected array $authors;
    private int $pages = 0;
    private static int $count;
    public $isbn;

    public function __construct(string $title, array $authors, $isbn)
    {
        $this->title = $title;
        $this->authors = $authors;
        $this->isbn = $isbn;
    }

    public function title(): string
    {
        return $this->title;
    }
}
"
    );
    assert_eq!(
        p.after(before, GENERATE_CONSTRUCTOR, "Generate constructor with promoted properties"),
        "<?php
class Book
{
    private int $pages = 0;
    private static int $count;

    public function __construct(
        private string $title,
        /** @var list<string> */
        protected array $authors,
        public $isbn,
    ) {
    }

    public function title(): string
    {
        return $this->title;
    }
}
"
    );
    // Before PHP 8.0 there is no promotion; an empty class gets an empty
    // constructor; a class with one has nothing.
    let mut old = Project::new(PhpVersion::new(7, 4), &[]);
    assert_eq!(old.titles(before, GENERATE_CONSTRUCTOR), ["Generate constructor"]);
    assert_eq!(
        p.after("<?php\nclass Empty_\n{/*|*/\n}\n", GENERATE_CONSTRUCTOR, "Generate constructor"),
        "<?php\nclass Empty_\n{\n    public function __construct()\n    {\n    }\n}\n"
    );
    assert!(
        p.titles("<?php\nclass Made\n{\n    public function __construct() {}\n/*|*/\n}\n", GENERATE_CONSTRUCTOR)
            .is_empty()
    );
    assert!(p.titles("<?php\ninterface I\n{\n/*|*/\n}\n", GENERATE_CONSTRUCTOR).is_empty());
}

#[test]
fn a_generated_constructor_calls_the_parent_one() {
    let base = "<?php
namespace App;

class Base
{
    public function __construct(protected Clock $clock, int $retries = 3)
    {
    }
}

class Clock
{
}
";
    let mut p = Project::new(PhpVersion::LATEST, &[("base.php", base)]);
    let before = "<?php
namespace App;

class Job extends Base
{
    private string $name;
/*|*/}
";
    assert_eq!(
        p.after(before, GENERATE_CONSTRUCTOR, "Generate constructor"),
        "<?php
namespace App;

class Job extends Base
{
    private string $name;

    public function __construct(Clock $clock, int $retries, string $name)
    {
        parent::__construct($clock, $retries);
        $this->name = $name;
    }
}
"
    );
    // The properties are all that the class has: the promoted constructor
    // replaces them.
    assert_eq!(
        p.after(before, GENERATE_CONSTRUCTOR, "Generate constructor with promoted properties"),
        "<?php
namespace App;

class Job extends Base
{
    public function __construct(
        Clock $clock,
        int $retries,
        private string $name,
    ) {
        parent::__construct($clock, $retries);
    }
}
"
    );
    // Without properties of its own, the parent's defaults stay.
    assert_eq!(
        p.after(
            "<?php\nnamespace App;\n\nclass Plain extends Base\n{/*|*/\n}\n",
            GENERATE_CONSTRUCTOR,
            "Generate constructor"
        ),
        "<?php
namespace App;

class Plain extends Base
{
    public function __construct(Clock $clock, int $retries = 3)
    {
        parent::__construct($clock, $retries);
    }
}
"
    );
}

// ------------------------------------------------------------ accessors

#[test]
fn generate_getters_and_setters() {
    let mut p = Project::new(PhpVersion::LATEST, &[]);
    let before = "<?php
class User
{
    private string $first_name;
    private bool $active;
    private ?bool $hasAccess;
    private readonly int $id;
    private static int $count = 0;

    public function getId(): int
    {
        return $this->id;
    }
/*|*/
}
";
    assert_eq!(
        p.titles(before, GENERATE_ACCESSORS),
        ["Generate getters", "Generate setters", "Generate getters and setters"]
    );
    let methods = |body: &str| {
        format!(
            "<?php
class User
{{
    private string $first_name;
    private bool $active;
    private ?bool $hasAccess;
    private readonly int $id;
    private static int $count = 0;

    public function getId(): int
    {{
        return $this->id;
    }}
{body}
}}
"
        )
    };
    assert_eq!(
        p.after(before, GENERATE_ACCESSORS, "Generate getters"),
        methods(
            "
    public function getFirstName(): string
    {
        return $this->first_name;
    }

    public function isActive(): bool
    {
        return $this->active;
    }

    public function hasAccess(): ?bool
    {
        return $this->hasAccess;
    }

    public static function getCount(): int
    {
        return self::$count;
    }"
        )
    );
    // No setter for the readonly id.
    assert_eq!(
        p.after(before, GENERATE_ACCESSORS, "Generate setters"),
        methods(
            "
    public function setFirstName(string $first_name): void
    {
        $this->first_name = $first_name;
    }

    public function setActive(bool $active): void
    {
        $this->active = $active;
    }

    public function setHasAccess(?bool $hasAccess): void
    {
        $this->hasAccess = $hasAccess;
    }

    public static function setCount(int $count): void
    {
        self::$count = $count;
    }"
        )
    );
}

#[test]
fn accessors_for_the_property_at_the_caret() {
    let mut p = Project::new(PhpVersion::new(7, 0), &[]);
    let before = "<?php
class Point
{
    private $x;
    /*|*/private $y;

    public function __construct($x, $y)
    {
    }
}
";
    assert_eq!(
        p.titles(before, GENERATE_ACCESSORS),
        ["Generate getter for '$y'", "Generate setter for '$y'", "Generate getter and setter for '$y'"]
    );
    // Untyped, and no `void` before PHP 7.1.
    assert_eq!(
        p.after(before, GENERATE_ACCESSORS, "Generate getter and setter for '$y'"),
        "<?php
class Point
{
    private $x;
    private $y;

    public function __construct($x, $y)
    {
    }

    public function getY()
    {
        return $this->y;
    }

    public function setY($y)
    {
        $this->y = $y;
    }
}
"
    );
    // Promoted properties count; in a method body nothing is offered.
    let mut p = Project::new(PhpVersion::LATEST, &[]);
    let promoted = "<?php
class Money
{
    public function __construct(private readonly int $amount)
    {
        /*|*/
    }
}
";
    assert!(p.titles(promoted, GENERATE_ACCESSORS).is_empty());
    assert_eq!(
        p.titles(
            &promoted.replace("        /*|*/\n", "").replace("class Money", "class /*|*/Money"),
            GENERATE_ACCESSORS
        ),
        ["Generate getters"]
    );
}

// ---------------------------------------------------------------- PHPDoc

#[test]
fn generate_phpdoc_for_a_property() {
    let mut p = Project::new(PhpVersion::LATEST, &[]);
    let titles = |p: &mut Project, marked: &str| -> Vec<String> {
        p.titles(marked, REWRITE).into_iter().filter(|t| t == "Generate PHPDoc").collect()
    };
    assert_eq!(
        p.after("<?php\nclass A\n{\n    private ?\\DateTime /*|*/$at;\n}\n", REWRITE, "Generate PHPDoc"),
        "<?php\nclass A\n{\n    /** @var ?DateTime */\n    private ?\\DateTime $at;\n}\n"
    );
    assert_eq!(
        p.after("<?php\nclass A\n{\n    private $n/*|*/ = 5;\n}\n", REWRITE, "Generate PHPDoc"),
        "<?php\nclass A\n{\n    /** @var int */\n    private $n = 5;\n}\n"
    );
    // Already documented: nothing; methods keep their own action.
    assert!(titles(&mut p, "<?php\nclass A\n{\n    /** @var int */\n    private $n/*|*/ = 5;\n}\n").is_empty());
    assert_eq!(
        titles(&mut p, "<?php\nclass A\n{\n    public function /*|*/f(int $a): int { return $a; }\n}\n"),
        ["Generate PHPDoc"]
    );
}

#[test]
fn generate_kinds_are_advertised() {
    for kind in [IMPLEMENT_METHODS, OVERRIDE_METHODS, GENERATE_CONSTRUCTOR, GENERATE_ACCESSORS] {
        assert!(ACTION_KINDS.contains(&kind), "{kind}");
        assert!(kind.starts_with("source.generate."), "{kind}");
    }
}
