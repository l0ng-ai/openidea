//! Tests of the control-flow inspections.

use super::*;

/// `(id, message)` of each problem.
fn messages(inspected: &Inspected) -> Vec<(&'static str, String)> {
    inspected.problems.iter().map(|p| (p.inspection, p.message.clone())).collect()
}

/// The text each problem covers.
fn covered(text: &str, inspected: &Inspected) -> Vec<String> {
    inspected.problems.iter().map(|p| text[p.start as usize..p.end as usize].to_owned()).collect()
}

fn project() -> Project {
    let p = Project::with_files(&[(
        "src/lib.php",
        "<?php\nnamespace App;\n\nfunction stop(): never { exit; }\nclass Guard { public static function fail(): never { throw new \\Exception(); } }\n",
    )]);
    p.engine.set_inspections(Inspections::new(vec![
        Arc::new(control::UnreachableStatement),
        Arc::new(control::MissingReturn),
        Arc::new(control::VoidReturn),
        Arc::new(control::NeverReturn),
    ]));
    p
}

fn unreachable() -> (&'static str, String) {
    ("PhpUnreachableStatement", "Unreachable statement".to_owned())
}

fn missing() -> (&'static str, String) {
    ("PhpMissingReturnStatement", "Missing return statement".to_owned())
}

#[test]
fn unreachable_statements() {
    let mut p = project();
    let text = r#"<?php
namespace App;

function a() { return 1; echo 'a'; echo 'b'; }
function b() { throw new \Exception(); $x = 1; }
function c($items) {
    foreach ($items as $item) {
        continue;
        echo $item;
    }
    while (true) {
        break;
        echo 'loop';
    }
}
function d() { stop(); echo 'd'; }
function e() { Guard::fail(); echo 'e'; }
function f($c) {
    if ($c) { return 1; } else { return 2; }
    echo 'f';
}
function g() { while (true) {} echo 'g'; }
function h($k) {
    switch ($k) {
        case 1:
            return 1;
            break;
    }
    return 0;
}
// Not dead: a constant condition, a hoisted declaration, a branch only.
function quiet($c) {
    if (false) { echo 'never'; }
    if ($c) { return; }
    while (false) { echo 'never'; }
    return;
    function hoisted() {}
}
$fn = function () { exit(0); echo 'closure'; };
exit;
echo 'top';
"#;
    let found = p.inspect(text);
    assert_eq!(messages(&found), vec![unreachable(); 11]);
    assert_eq!(
        covered(text, &found),
        [
            "echo 'a';",
            "$x = 1;",
            "echo $item;",
            "echo 'loop';",
            "echo 'd';",
            "echo 'e';",
            "echo 'f';",
            "echo 'g';",
            "break;",
            "echo 'closure';",
            "echo 'top';",
        ]
    );
    assert!(found.problems.iter().all(|p| p.unnecessary && p.severity == Severity::Warning));
    let line = text.lines().position(|l| l.starts_with("function a()")).unwrap() as u32;
    assert_eq!(found.problems[0].range, Range::new(Pos::new(line, 25), Pos::new(line, 34)));
}

#[test]
fn missing_returns() {
    let mut p = project();
    let text = r#"<?php
namespace App;

function a(): int { }
function b($c): ?string { if ($c) { return 'b'; } }
function c($k): mixed { switch ($k) { case 1: return 1; } }
function d(): int { return; }
abstract class K {
    public function m(): static { $this->x(); }
    abstract public function n(): int;
    public function o(): array { return []; }
}
$f = function (): bool { if (rand()) { return true; } };
// Fine: every path returns, throws or never returns.
function ok1($c): int { if ($c) { return 1; } return 2; }
function ok2($c): int { if ($c) { return 1; } throw new \Exception(); }
function ok3(): int { while (true) {} }
function ok4($k): int { switch ($k) { case 1: return 1; default: return 2; } }
function ok5(): int { stop(); }
function ok6(): int { try { return 1; } finally { echo 'x'; } }
function ok7($c): string { return match ($c) { 1 => 'a', default => 'b' }; }
// Generators, untyped and `void` functions, arrow functions.
function gen(): iterable { yield 1; }
function gen2(): \Generator { if (rand()) { return; } yield 1; }
function untyped() { }
function nothing(): void { }
$arrow = fn(): int => 1;
interface I { public function i(): int; }
"#;
    let found = p.inspect(text);
    let value = ("PhpMissingReturnStatement", "A function with a return type must return a value".to_owned());
    assert_eq!(messages(&found), [missing(), missing(), missing(), value, missing(), missing()]);
    assert_eq!(covered(text, &found), ["}", "}", "}", "return;", "}", "}"]);
    let severities: Vec<Severity> = found.problems.iter().map(|p| p.severity).collect();
    assert_eq!(
        severities,
        [
            Severity::Warning,
            Severity::Warning,
            Severity::Warning,
            Severity::Error,
            Severity::Warning,
            Severity::Warning
        ]
    );
    // The closing brace of the body.
    let line = text.lines().position(|l| l.starts_with("function a()")).unwrap() as u32;
    assert_eq!(found.problems[0].range, Range::new(Pos::new(line, 20), Pos::new(line, 21)));
}

#[test]
fn void_functions_returning_a_value() {
    let mut p = project();
    let text = r#"<?php
namespace App;

function a($c): void {
    if ($c) { return 1; }
    if (!$c) { return null; }
    $f = function () { return 2; };
    $g = fn() => 3;
    return;
}
class K {
    public function m(): void { return $this; }
    public function ok(): void { }
}
"#;
    let found = p.inspect(text);
    let void = ("PhpVoidFunctionReturnsValue", "A void function must not return a value".to_owned());
    assert_eq!(messages(&found), vec![void; 3]);
    assert_eq!(covered(text, &found), ["return 1;", "return null;", "return $this;"]);
    assert!(found.problems.iter().all(|p| p.severity == Severity::Error));
}

#[test]
fn never_functions_returning() {
    let mut p = project();
    let text = r#"<?php
namespace App;

function a(): never { return; }
function b($c): never { if ($c) { throw new \Exception(); } }
function c(): never { echo 'x'; }
// Fine.
function ok1(): never { throw new \Exception(); }
function ok2(): never { exit(1); }
function ok3(): never { stop(); }
function ok4(): never { while (true) {} }
function ok5(): never { $f = function () { return 1; }; Guard::fail(); }
"#;
    let found = p.inspect(text);
    let returns = ("PhpNeverFunctionReturns", "A never-returning function must not return".to_owned());
    let implicit = ("PhpNeverFunctionReturns", "A never-returning function must not implicitly return".to_owned());
    assert_eq!(messages(&found), [returns, implicit.clone(), implicit]);
    assert_eq!(covered(text, &found), ["return;", "}", "}"]);
    let severities: Vec<Severity> = found.problems.iter().map(|p| p.severity).collect();
    assert_eq!(severities, [Severity::Error, Severity::Warning, Severity::Warning]);
}

#[test]
fn suppressed_registered_and_quiet_in_dumb_mode() {
    let mut p = project();
    let found = p.inspect(
        "<?php\nnamespace App;\n\n/** @noinspection PhpUnreachableStatementInspection */\nfunction a() { return 1; echo 'a'; }\n/** @noinspection PhpMissingReturnStatement */\nfunction b(): int { }\n",
    );
    assert!(found.problems.is_empty(), "{:?}", messages(&found));
    let ids = Inspections::builtin().ids();
    for id in [
        "PhpUnreachableStatement",
        "PhpMissingReturnStatement",
        "PhpVoidFunctionReturnsValue",
        "PhpNeverFunctionReturns",
    ] {
        assert!(ids.contains(&id), "{id}");
    }
    p.engine.shutdown();
    let found = p.inspect("<?php\nfunction a(): int { return; echo 'a'; }\n");
    assert!(found.problems.is_empty(), "{:?}", messages(&found));
}
