//! Tests of the undefined-symbol inspections.

use super::*;

/// `(id, message)` of each problem.
fn messages(inspected: &Inspected) -> Vec<(&'static str, String)> {
    inspected.problems.iter().map(|p| (p.inspection, p.message.clone())).collect()
}

fn project() -> Project {
    let p = Project::with_files(&[
        ("src/Model/Book.php", "<?php\nnamespace App\\Model;\n\nclass Book {}\n"),
        (
            "src/functions.php",
            "<?php\nnamespace App;\n\nfunction helper() {}\nconst LIMIT = 3;\ndefine('LEGACY_FLAG', true);\n",
        ),
    ]);
    // The variable inspections have tests of their own.
    p.engine.set_inspections(super::without_variables());
    p
}

#[test]
fn classes_functions_and_constants() {
    let mut p = project();
    let text = r#"<?php
namespace App;

use Lib\Missing;
use App\Model\Book;

interface Shelf extends Gone {}

#[\Attribute]
final class Here extends Nope implements \Countable, Absent
{
    use NoTrait;

    public function count(): int
    {
        return COUNT_X + \PHP_INT_MAX + LOCAL + LIMIT + LEGACY_FLAG + \App\LIMIT;
    }

    public function f(Book $b, Ghost $g): ?Here
    {
        strlen('x');
        helper();
        missing_fn();
        \App\helper();
        Missing::run();
        self::f($b, $g);
        $x = Model\Book::class;
        $y = Model\Lost::class;
        $f = gone_too(...);
        try {
        } catch (\RuntimeException | Phantom $e) {
        }
        $z = true || null || FALSE;
        return $b instanceof Absent2 ? null : new Here();
    }
}

const LOCAL = 1;
"#;
    let found = p.inspect(text);
    assert_eq!(
        messages(&found),
        [
            ("PhpUndefinedClass", "Undefined interface 'Gone'".to_owned()),
            ("PhpUndefinedClass", "Undefined class 'Nope'".into()),
            ("PhpUndefinedClass", "Undefined interface 'Absent'".into()),
            ("PhpUndefinedClass", "Undefined trait 'NoTrait'".into()),
            ("PhpUndefinedConstant", "Undefined constant 'COUNT_X'".into()),
            ("PhpUndefinedClass", "Undefined class 'Ghost'".into()),
            ("PhpUndefinedFunction", "Undefined function 'missing_fn'".into()),
            ("PhpUndefinedClass", "Undefined class 'Missing'".into()),
            ("PhpUndefinedClass", "Undefined class 'Model\\Lost'".into()),
            ("PhpUndefinedFunction", "Undefined function 'gone_too'".into()),
            ("PhpUndefinedClass", "Undefined class 'Phantom'".into()),
            ("PhpUndefinedClass", "Undefined class 'Absent2'".into()),
        ]
    );
    let ghost = found.problems.iter().find(|p| p.message.contains("Ghost")).unwrap();
    let d = ghost.to_diagnostic();
    assert_eq!(
        (d.severity, d.code.as_deref(), d.source.as_deref()),
        (Severity::Warning, Some("PhpUndefinedClass"), Some("php"))
    );
    let line = text.lines().position(|l| l.contains("Ghost $g")).unwrap() as u32;
    let col = text.lines().nth(line as usize).unwrap().find("Ghost").unwrap() as u32;
    assert_eq!(d.range, Range::new(Pos::new(line, col), Pos::new(line, col + 5)));
}

#[test]
fn global_code_and_open_buffers() {
    let mut p = project();
    // Declared only in an unsaved buffer.
    p.open("src/New.php", "<?php\nnamespace App;\nclass Fresh {}\nfunction fresh_fn() {}\n");
    let found = p.inspect(
        r#"<?php
use App\Fresh;
use function App\fresh_fn;

new Fresh();
fresh_fn();
new \DateTime();
new DateTimeImmutable();
echo PHP_EOL, E_ALL, Nowhere::X, nowhere();
helper();
"#,
    );
    assert_eq!(
        messages(&found),
        [
            ("PhpUndefinedClass", "Undefined class 'Nowhere'".to_owned()),
            ("PhpUndefinedFunction", "Undefined function 'nowhere'".into()),
            // Global code doesn't fall back into `App`.
            ("PhpUndefinedFunction", "Undefined function 'helper'".into()),
        ]
    );
}

#[test]
fn guards() {
    let mut p = project();
    let found = p.inspect(
        r#"<?php
namespace App;

if (class_exists('Vendor\\Thing')) {
    new \Vendor\Thing();
}
if (!function_exists('polyfill')) {
    function polyfill() {}
}
polyfill();

function f()
{
    if (!\interface_exists(\Other\Opt::class)) {
        return;
    }
    \Other\Opt::make();
    if (function_exists('apcu_fetch2')) {
        apcu_fetch2('k');
    }
    echo defined('MY_FLAG') ? MY_FLAG : 0;
    $c = fn() => is_callable('later_fn') && later_fn();
    return later_fn();
}

function g()
{
    \Other\Opt::make();
    apcu_fetch2('k');
    new \Vendor\Thing();
    echo MY_FLAG;
}
"#,
    );
    assert_eq!(
        messages(&found),
        [
            // The arrow function's guard ends with it.
            ("PhpUndefinedFunction", "Undefined function 'later_fn'".to_owned()),
            ("PhpUndefinedClass", "Undefined class '\\Other\\Opt'".into()),
            ("PhpUndefinedFunction", "Undefined function 'apcu_fetch2'".into()),
            ("PhpUndefinedConstant", "Undefined constant 'MY_FLAG'".into()),
        ]
    );
}

#[test]
fn suppression_and_import_fix() {
    let mut p = project();
    let (text, pos) = caret(
        "<?php\nnamespace Other;\n\n/** @noinspection PhpUndefinedClassInspection */\nnew Ghost();\n/** @noinspection PhpUndefinedFunction */\nghost();\nnew Bo/*|*/ok();\n",
    );
    let doc = p.open("src/other.php", &text);
    let found = p.engine.inspect(doc, &CancellationToken::new()).unwrap();
    assert_eq!(messages(&found), [("PhpUndefinedClass", "Undefined class 'Book'".to_owned())]);
    let actions = p.engine.code_actions(doc, Range::new(pos, pos), &[]).unwrap();
    let titles: Vec<&str> = actions.iter().map(|a| a.title.as_str()).collect();
    assert_eq!(titles, ["Suppress 'PhpUndefinedClass' for statement", "Import class 'App\\Model\\Book'"]);
    assert!(actions[1].preferred);
    assert!(applied(&text, &actions[1].edit).contains("use App\\Model\\Book;"));
}

#[test]
fn quiet_until_the_index_is_ready() {
    let mut p = project();
    p.engine.shutdown();
    let found = p.inspect("<?php\nnew Ghost();\n");
    assert!(found.problems.is_empty(), "{:?}", messages(&found));
}

/// The fixture's code is clean; its tests only miss PHPUnit (no `vendor/`).
#[test]
fn quiet_on_the_fixture() {
    let root = dunce::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-app")).unwrap();
    let cache = tempfile::tempdir().unwrap();
    let config = EngineConfig {
        cache_dir: cache.path().join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
        stubs: StubFilter::default(),
    };
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(WAIT));
    let mut files: Vec<PathBuf> = ["bin", "src", "tests"].iter().flat_map(|dir| php_files(&root.join(dir))).collect();
    files.push(root.join(".phpstorm.meta.php"));
    files.sort();
    let mut found = Vec::new();
    for (i, path) in files.iter().enumerate() {
        let doc = DocId(i as u32 + 1);
        engine.document_opened(doc, path, 1, &std::fs::read_to_string(path).unwrap());
        let inspected = engine.inspect(doc, &CancellationToken::new()).unwrap();
        engine.document_closed(doc);
        let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        found.extend(inspected.problems.iter().map(|p| format!("{rel}: {}", p.message)));
    }
    let phpunit = |f: &String| f.starts_with("tests/") && (f.contains("TestCase") || f.contains("MockObject"));
    // The fixture's deliberate error (`ShelfReport::summary`).
    let deliberate = "src/Reports/ShelfReport.php: Undefined method 'count' in 'App\\Library'";
    assert!(found.iter().all(|f| phpunit(f) || f == deliberate), "{found:#?}");
    assert!(found.iter().any(phpunit), "PHPUnit isn't installed in the fixture");
    assert!(found.iter().any(|f| f == deliberate), "{found:#?}");
    engine.shutdown();
}

fn php_files(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(php_files(&path));
        } else if path.extension().is_some_and(|e| e == "php") {
            out.push(path);
        }
    }
    out
}
