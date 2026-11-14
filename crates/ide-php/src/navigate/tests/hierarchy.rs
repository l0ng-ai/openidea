use super::*;
use crate::navigate::{Direction, HierarchyEntry};

const SHAPE: &str = r"<?php
namespace App;

interface Shape
{
    public function area(): float;
    public function name(): string;
}
";

const POLYGON: &str = r"<?php
namespace App;

interface Polygon extends Shape
{
    public function sides(): int;
}
";

const BASE: &str = r"<?php
namespace App;

abstract class Base implements Polygon
{
    public function name(): string { return 'base'; }
    abstract public function sides(): int;
    private function secret(): void {}
}
";

const NAMED: &str = r"<?php
namespace App;

trait Named
{
    public function area(): float { return 0.0; }
}
";

const SQUARE: &str = r"<?php
namespace App;

class Square extends Base
{
    use Named;

    public function sides(): int { return 4; }
}
";

const CUBE: &str = r"<?php
namespace App;

final class Cube extends Square implements \Countable
{
    public function area(): float { return 6.0; }
    public function name(): string { return 'cube'; }
    public function count(): int { return 6; }
}
";

const CIRCLE: &str = r"<?php
namespace App;

class Circle implements Shape
{
    public function __construct(private float $r) {}
    public function area(): float { return M_PI * $this->r * $this->r; }
    public function name(): string { return 'circle'; }
}
";

fn shapes() -> Project {
    Project::new(&[
        ("src/Shape.php", SHAPE),
        ("src/Polygon.php", POLYGON),
        ("src/Base.php", BASE),
        ("src/Named.php", NAMED),
        ("src/Square.php", SQUARE),
        ("src/Cube.php", CUBE),
        ("src/Circle.php", CIRCLE),
    ])
}

type Described = (String, u32, String);
/// name, kind, detail, relative path, lines of the calls.
type Caller = (String, SymbolKind, Option<String>, String, Vec<u32>);

impl Project {
    fn implementations(&mut self, rel: &str, source: &str) -> Vec<Described> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let found = self.engine.implementations(doc, &[pos], &CancellationToken::new()).expect("open").unwrap();
        let mut out: Vec<Described> = found[0].iter().map(|target| self.describe(&target.path, target.range)).collect();
        out.sort();
        self.engine.document_closed(doc);
        out
    }

    fn entries(&self, entries: &[HierarchyEntry]) -> Vec<(String, SymbolKind, Option<String>, Described)> {
        entries
            .iter()
            .map(|entry| {
                let described = self.describe(&entry.path, entry.selection_range);
                (entry.name.clone(), entry.kind, entry.detail.clone(), described)
            })
            .collect()
    }

    fn type_hierarchy(&mut self, rel: &str, source: &str, direction: Direction) -> Option<Vec<HierarchyEntry>> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let found = self.engine.type_hierarchy(doc, pos, direction).map(Result::unwrap);
        self.engine.document_closed(doc);
        found
    }

    fn call_hierarchy(&mut self, rel: &str, source: &str, direction: Direction) -> Option<Vec<HierarchyEntry>> {
        let (text, pos) = caret(source);
        let doc = self.open(rel, &text);
        let found = self.engine.call_hierarchy(doc, pos, direction, &CancellationToken::new()).map(Result::unwrap);
        self.engine.document_closed(doc);
        found
    }
}

fn at(rel: &str, line: u32, text: &str) -> Described {
    (rel.to_owned(), line, text.to_owned())
}

#[test]
fn implementations_of_interfaces_and_classes_are_transitive() {
    let mut project = shapes();
    let source = SHAPE.replace("interface Shape", "interface Sh/*|*/ape");
    assert_eq!(
        project.implementations("src/Shape.php", &source),
        [
            at("src/Base.php", 3, "Base"),
            at("src/Circle.php", 3, "Circle"),
            at("src/Cube.php", 3, "Cube"),
            at("src/Square.php", 3, "Square"),
        ],
        "every class below the interface, through the sub-interface and the class chain; no interfaces"
    );
    let source = CUBE.replace("extends Square", "extends Squ/*|*/are");
    assert_eq!(project.implementations("src/Cube.php", &source), [at("src/Cube.php", 3, "Cube")]);
    let source = CUBE.replace("final class Cube", "final class Cu/*|*/be");
    assert!(project.implementations("src/Cube.php", &source).is_empty(), "nothing extends Cube");
}

#[test]
fn implementations_of_methods_include_inherited_and_trait_ones() {
    let mut project = shapes();
    let source = SHAPE.replace("function area", "function ar/*|*/ea");
    assert_eq!(
        project.implementations("src/Shape.php", &source),
        [at("src/Circle.php", 6, "area"), at("src/Cube.php", 5, "area"), at("src/Named.php", 5, "area"),],
        "the trait's method implements it for Square; Cube overrides it"
    );
    let source = SHAPE.replace("function name", "function na/*|*/me");
    assert_eq!(
        project.implementations("src/Shape.php", &source),
        [at("src/Base.php", 5, "name"), at("src/Circle.php", 7, "name"), at("src/Cube.php", 6, "name"),]
    );
    // An abstract method: its concrete declarations, not the abstract one.
    let source = BASE.replace("abstract public function sides", "abstract public function si/*|*/des");
    assert_eq!(project.implementations("src/Base.php", &source), [at("src/Square.php", 7, "sides")]);
    // At a call through the interface.
    let caller = "<?php\nnamespace App;\nfunction show(Polygon $p): int { return $p->si/*|*/des(); }\n";
    assert_eq!(project.implementations("src/show.php", caller), [at("src/Square.php", 7, "sides")]);
    // Private methods have none.
    let source = BASE.replace("function secret", "function sec/*|*/ret");
    assert!(project.implementations("src/Base.php", &source).is_empty());
}

#[test]
fn implementations_see_unsaved_subclasses() {
    let mut project = shapes();
    let triangle =
        "<?php\nnamespace App;\nclass Triangle extends Base\n{\n    public function sides(): int { return 3; }\n}\n";
    let doc = project.open("src/Triangle.php", triangle);
    let source = BASE.replace("abstract public function sides", "abstract public function si/*|*/des");
    assert_eq!(
        project.implementations("src/Base.php", &source),
        [at("src/Square.php", 7, "sides"), at("src/Triangle.php", 4, "sides")]
    );
    project.engine.document_closed(doc);
}

#[test]
fn type_hierarchy_lists_direct_supertypes_and_subtypes() {
    let mut project = shapes();
    let source = CUBE.replace("final class Cube", "final class Cu/*|*/be");
    let up = project.type_hierarchy("src/Cube.php", &source, Direction::Up).expect("a class");
    let up = project.entries(&up);
    assert_eq!(up[0], ("Square".into(), SymbolKind::Class, Some("App".into()), at("src/Square.php", 3, "Square")));
    assert_eq!(up.len(), 2);
    assert_eq!((up[1].0.as_str(), up[1].1, up[1].2.as_deref()), ("Countable", SymbolKind::Interface, None));
    assert_eq!(up[1].3.2, "Countable", "the built-in interface comes from the stubs");

    let source = SHAPE.replace("interface Shape", "interface Sh/*|*/ape");
    let down = project.type_hierarchy("src/Shape.php", &source, Direction::Down).expect("an interface");
    let names: Vec<(String, SymbolKind)> = down.iter().map(|e| (e.name.clone(), e.kind)).collect();
    assert_eq!(
        names,
        [("Circle".to_owned(), SymbolKind::Class), ("Polygon".to_owned(), SymbolKind::Interface)],
        "direct subtypes only, sorted by file"
    );
    let up = project.type_hierarchy("src/Shape.php", &source, Direction::Up).unwrap();
    assert!(up.is_empty());

    // Inside a class body, away from any name: the class around the caret.
    let source = SQUARE.replace("use Named;", "use Named;/*|*/");
    let up = project.type_hierarchy("src/Square.php", &source, Direction::Up).unwrap();
    let names: Vec<&str> = up.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["Base"], "traits are not supertypes");
    // At a use of the class name elsewhere.
    let caller = "<?php\nnamespace App;\nfunction make(): Squ/*|*/are { return new Square(); }\n";
    let down = project.type_hierarchy("src/make.php", caller, Direction::Down).unwrap();
    let names: Vec<&str> = down.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["Cube"]);
    // Outside any class-like.
    assert!(project.type_hierarchy("src/make.php", "<?php\n$x = 1;/*|*/\n", Direction::Up).is_none());
}

const SERVICE: &str = r"<?php
namespace App;

function helper(Circle $c): float
{
    return $c->area();
}

class Report
{
    public function build(): string
    {
        $circle = new Circle(2.0);
        $total = helper($circle) + $circle->area();
        $f = fn() => helper($circle);
        return strlen($circle->name()) . $total;
    }

    public function again(): float
    {
        return helper(new Circle(1.0));
    }
}

echo helper(new Circle(3.0));
";

#[test]
fn call_hierarchy_callers_are_grouped_by_function() {
    let mut project = Project::new(&[
        ("src/Shape.php", SHAPE),
        ("src/Circle.php", CIRCLE),
        ("src/Service.php", SERVICE),
        ("src/imports.php", "<?php\nnamespace Other;\nuse function App\\helper;\nhelper(new \\App\\Circle(1.0));\n"),
    ]);
    let source = SERVICE.replace("function helper(", "function hel/*|*/per(");
    let callers = project.call_hierarchy("src/Service.php", &source, Direction::Up).expect("a function");
    let found: Vec<Caller> = callers
        .iter()
        .map(|e| {
            let rel = e.path.strip_prefix(&project.root).unwrap().to_string_lossy().replace('\\', "/");
            (e.name.clone(), e.kind, e.detail.clone(), rel, e.from_ranges.iter().map(|r| r.start.line).collect())
        })
        .collect();
    assert_eq!(
        found,
        [
            (
                "build".to_owned(),
                SymbolKind::Method,
                Some("App\\Report".to_owned()),
                "src/Service.php".to_owned(),
                vec![13, 14]
            ),
            (
                "again".to_owned(),
                SymbolKind::Method,
                Some("App\\Report".to_owned()),
                "src/Service.php".to_owned(),
                vec![20]
            ),
            ("Service.php".to_owned(), SymbolKind::File, None, "src/Service.php".to_owned(), vec![24]),
            ("imports.php".to_owned(), SymbolKind::File, None, "src/imports.php".to_owned(), vec![3]),
        ],
        "calls inside an arrow function count for the method; the `use function` import is no call"
    );

    // Callers of a method through an interface, and of a constructor through `new`.
    let source = CIRCLE.replace("function area", "function ar/*|*/ea");
    let callers = project.call_hierarchy("src/Circle.php", &source, Direction::Up).unwrap();
    let names: Vec<(&str, usize)> = callers.iter().map(|e| (e.name.as_str(), e.from_ranges.len())).collect();
    assert_eq!(names, [("helper", 1), ("build", 1)]);
    let source = CIRCLE.replace("function __construct", "function __con/*|*/struct");
    let callers = project.call_hierarchy("src/Circle.php", &source, Direction::Up).unwrap();
    let names: Vec<(&str, usize)> = callers.iter().map(|e| (e.name.as_str(), e.from_ranges.len())).collect();
    assert_eq!(names, [("build", 1), ("again", 1), ("Service.php", 1), ("imports.php", 1)]);
}

#[test]
fn call_hierarchy_callees_resolve_each_call() {
    let mut project =
        Project::new(&[("src/Shape.php", SHAPE), ("src/Circle.php", CIRCLE), ("src/Service.php", SERVICE)]);
    let source = SERVICE.replace("public function build", "public function bu/*|*/ild");
    let callees = project.call_hierarchy("src/Service.php", &source, Direction::Down).expect("a method");
    let found: Vec<(String, SymbolKind, Option<String>, Vec<u32>)> = callees
        .iter()
        .map(|e| (e.name.clone(), e.kind, e.detail.clone(), e.from_ranges.iter().map(|r| r.start.line).collect()))
        .collect();
    assert_eq!(
        found,
        [
            ("__construct".to_owned(), SymbolKind::Constructor, Some("App\\Circle".to_owned()), vec![12]),
            ("helper".to_owned(), SymbolKind::Function, Some("App".to_owned()), vec![13, 14]),
            ("area".to_owned(), SymbolKind::Method, Some("App\\Circle".to_owned()), vec![13]),
            ("strlen".to_owned(), SymbolKind::Function, None, vec![15]),
            ("name".to_owned(), SymbolKind::Method, Some("App\\Circle".to_owned()), vec![15]),
        ],
        "in source order, grouped by callee; built-ins from the stubs"
    );
    let entry = &callees[1];
    assert_eq!(project.describe(&entry.path, entry.selection_range), at("src/Service.php", 3, "helper"));

    // Inside the body, away from any name: the function around the caret.
    let source = SERVICE.replace("return $c->area();", "return $c->area();/*|*/");
    let callees = project.call_hierarchy("src/Service.php", &source, Direction::Down).unwrap();
    let names: Vec<&str> = callees.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["area"]);
    // An interface method has no body.
    let source = SHAPE.replace("function area", "function ar/*|*/ea");
    assert!(project.call_hierarchy("src/Shape.php", &source, Direction::Down).unwrap().is_empty());
    // Not in a function-like.
    assert!(project.call_hierarchy("src/x.php", "<?php\n$x = 1;/*|*/\n", Direction::Down).is_none());
}
