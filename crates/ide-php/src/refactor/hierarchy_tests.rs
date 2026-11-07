//! Pull members up / push members down: what the dialog is offered, and the
//! text of every file before and after.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ide_core::{CancellationToken, DocId, FileEdit, IdeEvent, Pos, SharedSink};

use super::hierarchy::{HierarchyChoice, HierarchyInfo, HierarchyKind, HierarchyMove, MovableKind, ProblemSeverity};
use crate::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use crate::project::LayoutConfig;
use crate::stubs::{PhpVersion, StubFilter};

const WAIT: Duration = Duration::from_secs(60);
const CARET: &str = "/*|*/";

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
    doc: DocId,
    caret: Pos,
    files: BTreeMap<String, String>,
}

fn pos(text: &str, at: usize) -> Pos {
    let before = &text[..at];
    let line = before.matches('\n').count() as u32;
    let col = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
    Pos::new(line, col)
}

/// A project with `files` under `src/`; the one with the `/*|*/` caret is
/// open in the editor.
fn fixture(files: &[(&str, &str)]) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(root.join("src")).unwrap();
    let mut written = BTreeMap::new();
    let mut open = None;
    for (name, marked) in files {
        let text = marked.replacen(CARET, "", 1);
        if let Some(at) = marked.find(CARET) {
            open = Some((name.to_string(), pos(&text, at)));
        }
        std::fs::write(root.join("src").join(name), &text).unwrap();
        written.insert(name.to_string(), text);
    }
    let (open, caret) = open.expect("a caret");
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let config = EngineConfig {
        cache_dir: base.join("cache").join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
        stubs: StubFilter::all_extensions(PhpVersion::new(8, 3)),
    };
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(WAIT));
    let doc = DocId(1);
    engine.document_opened(doc, &root.join("src").join(&open), 1, &written[&open]);
    Fixture { _tmp: tmp, root, engine, doc, caret, files: written }
}

fn choose(ids: &[&str]) -> Vec<HierarchyChoice> {
    ids.iter().map(|id| HierarchyChoice { id: id.to_string(), make_abstract: false }).collect()
}

fn abstract_(id: &str) -> HierarchyChoice {
    HierarchyChoice { id: id.into(), make_abstract: true }
}

impl Fixture {
    fn info(&self, kind: HierarchyKind) -> Result<HierarchyInfo, String> {
        let found = self.engine.hierarchy_members(self.doc, self.caret, kind, &CancellationToken::new());
        found.expect("open").map_err(|e| e.message)
    }

    fn run(&self, kind: HierarchyKind, target: Option<&str>, choices: &[HierarchyChoice]) -> HierarchyMove {
        let result =
            self.engine.hierarchy_refactor(self.doc, self.caret, kind, target, choices, &CancellationToken::new());
        result.expect("open").expect("checked")
    }

    /// The files the move edits, with their new text.
    fn after(&self, moved: &HierarchyMove) -> BTreeMap<String, String> {
        let edit = moved.edit.as_ref().unwrap_or_else(|| panic!("an edit: {:?}", moved.problems));
        let mut out = BTreeMap::new();
        for file in &edit.files {
            let FileEdit::Edit { path, edits, .. } = file else { panic!("only text edits: {file:?}") };
            let name = path.strip_prefix(self.root.join("src")).unwrap().to_string_lossy().replace('\\', "/");
            let mut document = ide_text::Document::new(&self.files[&name]);
            document.apply_edits(edits).unwrap();
            out.insert(name, document.text().to_string());
        }
        out
    }

    fn pull_up(&self, target: &str, choices: &[HierarchyChoice]) -> HierarchyMove {
        self.run(HierarchyKind::PullUp, Some(target), choices)
    }

    fn push_down(&self, choices: &[HierarchyChoice]) -> HierarchyMove {
        self.run(HierarchyKind::PushDown, None, choices)
    }
}

fn fatal(moved: &HierarchyMove) -> String {
    assert!(moved.edit.is_none(), "no edit");
    let problem = moved.problems.iter().find(|p| p.severity == ProblemSeverity::Fatal).expect("a fatal problem");
    problem.message.clone()
}

fn warnings(moved: &HierarchyMove) -> Vec<&str> {
    moved.problems.iter().filter(|p| p.severity == ProblemSeverity::Warning).map(|p| p.message.as_str()).collect()
}

const ANIMAL: &str = "<?php
namespace App;

abstract class Animal
{
    protected string $name = '';

    public function name(): string
    {
        return $this->name;
    }
}
";

const DOG: &str = "<?php
namespace App;

class Dog extends Animal implements Pet
{
    public const SOUND = 'woof';

    /** @var int */
    private int $legs = 4;

    /**
     * Barks.
     */
    public function /*|*/bark(int $times): string
    {
        return str_repeat(self::SOUND, $times);
    }

    private function wag(): void
    {
        echo $this->legs;
    }
}
";

const PET: &str = "<?php
namespace App;

interface Pet
{
}
";

#[test]
fn lists_destinations_and_members_with_the_one_at_the_caret_selected() {
    let f = fixture(&[("Animal.php", ANIMAL), ("Dog.php", DOG), ("Pet.php", PET)]);
    let info = f.info(HierarchyKind::PullUp).unwrap();
    assert_eq!(info.class_name, "Dog");
    let targets: Vec<(&str, bool)> = info.targets.iter().map(|t| (t.qualified_name.as_str(), t.interface)).collect();
    assert_eq!(targets, [("App\\Animal", false), ("App\\Pet", true)]);
    let members: Vec<(&str, MovableKind, bool, bool)> =
        info.members.iter().map(|m| (m.label.as_str(), m.kind, m.selected, m.abstractable)).collect();
    assert_eq!(
        members,
        [
            ("SOUND", MovableKind::Field, false, false),
            ("$legs: int", MovableKind::Field, false, false),
            ("bark(int $times): string", MovableKind::Method, true, true),
            ("wag(): void", MovableKind::Method, false, false),
        ]
    );
    assert_eq!(info.members[2].id, "method:bark");
}

#[test]
fn a_class_without_project_parents_or_subclasses_is_refused() {
    let f =
        fixture(&[("Solo.php", "<?php\nclass Solo extends \\ArrayObject\n{\n    public function /*|*/a() {}\n}\n")]);
    assert!(f.info(HierarchyKind::PullUp).unwrap_err().contains("no parent class or interface in the project"));
    assert!(f.info(HierarchyKind::PushDown).unwrap_err().contains("no subclasses"));
}

#[test]
fn pulls_a_method_and_the_constant_it_uses_up_to_the_parent_class() {
    let f = fixture(&[("Animal.php", ANIMAL), ("Dog.php", DOG), ("Pet.php", PET)]);
    let moved = f.pull_up("App\\Animal", &choose(&["method:bark", "constant:SOUND"]));
    assert!(moved.problems.is_empty(), "{:?}", moved.problems);
    let after = f.after(&moved);
    assert_eq!(
        after["Animal.php"],
        "<?php
namespace App;

abstract class Animal
{
    public const SOUND = 'woof';

    protected string $name = '';

    public function name(): string
    {
        return $this->name;
    }

    /**
     * Barks.
     */
    public function bark(int $times): string
    {
        return str_repeat(self::SOUND, $times);
    }
}
"
    );
    assert_eq!(
        after["Dog.php"],
        "<?php
namespace App;

class Dog extends Animal implements Pet
{
    /** @var int */
    private int $legs = 4;

    private function wag(): void
    {
        echo $this->legs;
    }
}
"
    );
}

#[test]
fn a_private_member_pulled_up_becomes_protected_and_what_it_uses_is_reported() {
    let f = fixture(&[("Animal.php", ANIMAL), ("Dog.php", DOG), ("Pet.php", PET)]);
    let moved = f.pull_up("App\\Animal", &choose(&["method:wag"]));
    assert_eq!(warnings(&moved), ["Method wag() uses property $legs, which is not pulled up to 'Animal'"]);
    let after = f.after(&moved);
    assert!(
        after["Animal.php"]
            .contains("    protected function wag(): void\n    {\n        echo $this->legs;\n    }\n}\n"),
        "{}",
        after["Animal.php"]
    );
    assert!(
        after["Dog.php"].ends_with("    private int $legs = 4;\n\n    /**\n     * Barks.\n     */\n    public function bark(int $times): string\n    {\n        return str_repeat(self::SOUND, $times);\n    }\n}\n"),
        "no blank line is left before the brace: {}",
        after["Dog.php"]
    );

    // Pulled up together, nothing is left behind.
    let moved = f.pull_up("App\\Animal", &choose(&["method:wag", "property:legs"]));
    assert!(warnings(&moved).is_empty(), "{:?}", moved.problems);
    let animal = &f.after(&moved)["Animal.php"];
    assert!(
        animal.contains("    protected string $name = '';\n    /** @var int */\n    protected int $legs = 4;\n"),
        "{animal}"
    );
}

#[test]
fn make_abstract_declares_the_method_above_and_keeps_its_body() {
    let parent = "<?php\nnamespace App;\n\nclass Base\n{\n}\n";
    let child = "<?php
namespace App;

class Child extends Base
{
    public function /*|*/run(int $n): int
    {
        return $n;
    }
}
";
    let f = fixture(&[("Base.php", parent), ("Child.php", child)]);
    let moved = f.pull_up("App\\Base", &[abstract_("method:run")]);
    assert_eq!(warnings(&moved), ["Class 'Base' will be made abstract"]);
    let after = f.after(&moved);
    assert_eq!(
        after["Base.php"],
        "<?php\nnamespace App;\n\nabstract class Base\n{\n    abstract public function run(int $n): int;\n}\n"
    );
    assert!(!after.contains_key("Child.php"), "the method stays as it is");
}

#[test]
fn methods_pulled_up_to_an_interface_are_only_declared_there() {
    let f = fixture(&[("Animal.php", ANIMAL), ("Dog.php", DOG), ("Pet.php", PET)]);
    let moved = f.pull_up("App\\Pet", &choose(&["method:bark", "constant:SOUND"]));
    assert!(moved.problems.is_empty(), "{:?}", moved.problems);
    let after = f.after(&moved);
    assert_eq!(
        after["Pet.php"],
        "<?php
namespace App;

interface Pet
{
    public const SOUND = 'woof';

    /**
     * Barks.
     */
    public function bark(int $times): string;
}
"
    );
    // The body stays in the class; the constant moved.
    assert!(after["Dog.php"].contains("public function bark(int $times): string\n    {"));
    assert!(!after["Dog.php"].contains("SOUND = "));
}

#[test]
fn what_can_not_go_up_is_fatal() {
    let f = fixture(&[("Animal.php", ANIMAL), ("Dog.php", DOG), ("Pet.php", PET)]);
    assert_eq!(
        fatal(&f.pull_up("App\\Pet", &choose(&["property:legs"]))),
        "Property $legs can't be pulled up: interfaces have no properties"
    );
    assert_eq!(
        fatal(&f.pull_up("App\\Pet", &choose(&["method:wag"]))),
        "Method wag() must be public to be pulled up to an interface"
    );
    assert!(fatal(&f.pull_up("App\\Nowhere", &choose(&["method:bark"]))).contains("isn't above 'Dog'"));
    assert!(fatal(&f.pull_up("App\\Animal", &choose(&["method:gone"]))).contains("open the dialog again"));

    let child = "<?php\nnamespace App;\n\nclass Cat extends Animal\n{\n    public function /*|*/name(): string\n    {\n        return 'cat';\n    }\n}\n";
    let f = fixture(&[("Animal.php", ANIMAL), ("Cat.php", child)]);
    assert_eq!(fatal(&f.pull_up("App\\Animal", &choose(&["method:name"]))), "'Animal' already declares method name()");
}

#[test]
fn names_are_imported_where_the_members_go() {
    let base = "<?php\nnamespace App\\Model;\n\nclass Base\n{\n}\n";
    let child = "<?php
namespace App\\Shop;

use App\\Model\\Base;
use App\\Money\\Price;

class Item extends Base
{
    public function /*|*/price(): Price
    {
        return new Price(1);
    }
}
";
    let price = "<?php\nnamespace App\\Money;\n\nclass Price\n{\n    public function __construct(int $v) {}\n}\n";
    let f = fixture(&[("Base.php", base), ("Item.php", child), ("Price.php", price)]);
    let moved = f.pull_up("App\\Model\\Base", &choose(&["method:price"]));
    let after = f.after(&moved);
    assert_eq!(
        after["Base.php"],
        "<?php
namespace App\\Model;

use App\\Money\\Price;

class Base
{
    public function price(): Price
    {
        return new Price(1);
    }
}
"
    );
}

const SHAPE: &str = "<?php
namespace App;

class Shape
{
    protected int $sides = 0;

    public function /*|*/area(): float
    {
        return 0.0;
    }

    public function describe(): string
    {
        return 'shape';
    }
}
";

const SQUARE: &str = "<?php
namespace App;

class Square extends Shape
{
    public function describe(): string
    {
        return 'square';
    }
}
";

const CIRCLE: &str = "<?php
namespace App;

class Circle extends Shape
{
}
";

#[test]
fn pushes_members_down_into_every_subclass() {
    let f = fixture(&[("Shape.php", SHAPE), ("Square.php", SQUARE), ("Circle.php", CIRCLE)]);
    let info = f.info(HierarchyKind::PushDown).unwrap();
    let targets: Vec<&str> = info.targets.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(targets, ["Circle", "Square"]);

    let moved = f.push_down(&choose(&["method:area", "property:sides"]));
    assert!(moved.problems.is_empty(), "{:?}", moved.problems);
    let after = f.after(&moved);
    assert_eq!(
        after["Circle.php"],
        "<?php
namespace App;

class Circle extends Shape
{
    protected int $sides = 0;

    public function area(): float
    {
        return 0.0;
    }
}
"
    );
    assert_eq!(
        after["Square.php"],
        "<?php
namespace App;

class Square extends Shape
{
    protected int $sides = 0;

    public function describe(): string
    {
        return 'square';
    }

    public function area(): float
    {
        return 0.0;
    }
}
"
    );
    assert_eq!(
        after["Shape.php"],
        "<?php
namespace App;

class Shape
{
    public function describe(): string
    {
        return 'shape';
    }
}
"
    );
}

#[test]
fn a_subclass_declaring_the_member_keeps_its_own() {
    let shape = SHAPE.replace("/*|*/", "").replace("function describe", "function /*|*/describe");
    let f = fixture(&[("Shape.php", &shape), ("Square.php", SQUARE), ("Circle.php", CIRCLE)]);
    let moved = f.push_down(&choose(&["method:describe"]));
    let after = f.after(&moved);
    assert!(!after.contains_key("Square.php"), "Square already has describe()");
    assert!(after["Circle.php"].contains("public function describe(): string"));
}

#[test]
fn keep_abstract_leaves_a_declaration_and_makes_the_class_abstract() {
    let f = fixture(&[("Shape.php", SHAPE), ("Square.php", SQUARE), ("Circle.php", CIRCLE)]);
    let moved = f.push_down(&[abstract_("method:area")]);
    assert_eq!(warnings(&moved), ["Class 'Shape' will be made abstract"]);
    let shape = &f.after(&moved)["Shape.php"];
    assert!(shape.contains("abstract class Shape\n"), "{shape}");
    assert!(shape.contains("    abstract public function area(): float;\n\n    public function describe()"), "{shape}");
}

#[test]
fn a_member_still_used_through_the_class_is_reported() {
    let user = "<?php\nnamespace App;\n\nfunction show(Shape $s): float\n{\n    return $s->area();\n}\n";
    let f = fixture(&[("Shape.php", SHAPE), ("Square.php", SQUARE), ("Circle.php", CIRCLE), ("show.php", user)]);
    let moved = f.push_down(&choose(&["method:area"]));
    assert_eq!(warnings(&moved), ["Method area() is still used in show.php at line 6, where 'Shape' won't have it"]);
    assert!(moved.edit.is_some(), "the user may go on");
}

#[test]
fn only_classes_push_down_and_members_declared_together_stay() {
    let f = fixture(&[("Pet.php", "<?php\ninterface Pet\n{\n    public function /*|*/a();\n}\n")]);
    assert_eq!(f.info(HierarchyKind::PushDown).unwrap_err(), "Push Members Down works on classes");

    let base = "<?php\nclass Base\n{\n    public $a, /*|*/$b;\n}\nclass Sub extends Base\n{\n}\n";
    let f = fixture(&[("Base.php", base)]);
    assert_eq!(
        fatal(&f.push_down(&choose(&["property:b"]))),
        "Property $b is declared together with other members; declare it on its own first"
    );
}
