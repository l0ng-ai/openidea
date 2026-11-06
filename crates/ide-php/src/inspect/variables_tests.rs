//! Tests of the variable inspections.

use super::*;

/// `(id, message)` of each variable problem.
fn messages(inspected: &Inspected) -> Vec<(&'static str, String)> {
    inspected.problems.iter().map(|p| (p.inspection, p.message.clone())).collect()
}

fn project() -> Project {
    let p = Project::with_files(&[(
        "src/lib.php",
        "<?php\nnamespace App;\n\nfunction fill(?array &$out): void { $out = []; }\nfunction stop(): never { exit; }\n",
    )]);
    p.engine.set_inspections(Inspections::new(vec![
        Arc::new(variables::UndefinedVariable),
        Arc::new(variables::UnusedVariable),
    ]));
    p
}

fn undefined(name: &str) -> (&'static str, String) {
    ("PhpUndefinedVariable", format!("Undefined variable '${name}'"))
}

fn maybe(name: &str) -> (&'static str, String) {
    ("PhpUndefinedVariable", format!("Variable '${name}' might not have been defined"))
}

fn unused(name: &str) -> (&'static str, String) {
    ("PhpUnusedLocalVariable", format!("Unused local variable '${name}'"))
}

#[test]
fn undefined_and_possibly_undefined() {
    let mut p = project();
    let text = r#"<?php
namespace App;

function f(bool $flag, array $items)
{
    echo $nope;
    if ($flag) {
        $some = 1;
    }
    echo $some;
    if ($flag) {
        $both = 1;
    } else {
        $both = 2;
    }
    echo $both;
    foreach ($items as $item) {
        $last = $item;
    }
    echo $last, $item;
    $total .= 'x';
    $count++;
    try {
        $tried = g();
    } catch (\Exception $e) {
        return;
    }
    echo $tried, $e;
    if (!$flag) {
        stop();
    } else {
        $after = 1;
    }
    echo $after;
    return $total . $count;
}
"#;
    let found = p.inspect(text);
    assert_eq!(
        messages(&found),
        [
            undefined("nope"),
            maybe("some"),
            maybe("last"),
            maybe("item"),
            undefined("total"),
            undefined("count"),
            undefined("e"),
        ]
    );
    let nope = &found.problems[0];
    let d = nope.to_diagnostic();
    assert_eq!(
        (d.severity, d.code.as_deref(), d.source.as_deref()),
        (Severity::Warning, Some("PhpUndefinedVariable"), Some("php"))
    );
    let line = text.lines().position(|l| l.contains("echo $nope")).unwrap() as u32;
    assert_eq!(d.range, Range::new(Pos::new(line, 9), Pos::new(line, 14)));
    assert_eq!(found.problems[1].severity, Severity::Info);
}

#[test]
fn reads_that_tolerate_missing_variables() {
    let mut p = project();
    let found = p.inspect(
        r#"<?php
namespace App;

function f(array $rows)
{
    if (isset($a)) { echo $a; }
    if (isset($b['k'])) { echo $b['k']; }
    if (!empty($c)) { echo $c; }
    if (!empty($o->p)) { echo $o->p; }
    echo $d ?? 'none';
    $e ??= [];
    echo @$f, $e;
    $g[] = 1;
    $h['k']['l'] = 2;
    echo count($g) + count($h);
    preg_match('/x/', 'x', $matches);
    fill($filled);
    unknown_function($maybe_out);
    $cb = function () use (&$byRef) { $byRef = 1; };
    $cb();
    echo $matches[0], $filled, $maybe_out, $byRef, $_GET['q'], $GLOBALS['x'], $this;
    $ref = &$created;
    echo $ref;
}
"#,
    );
    assert!(found.problems.is_empty(), "{:?}", messages(&found));
}

#[test]
fn global_static_closures_and_arrows() {
    let mut p = project();
    let found = p.inspect(
        r#"<?php
namespace App;

function f(int $n)
{
    global $config;
    static $calls = 0;
    $calls++;
    echo $config;
    $outer = 1;
    $closure = function ($x) use ($outer, $missing) {
        echo $outer, $missing, $x, $inner;
    };
    $closure(1);
    $base = 2;
    $arrow = fn($y) => $base + $y + $gone;
    return $arrow($n);
}
"#,
    );
    assert_eq!(messages(&found), [undefined("missing"), undefined("inner"), undefined("gone")]);
}

#[test]
fn dynamic_variables_turn_the_check_off() {
    let mut p = project();
    let found = p.inspect(
        r#"<?php
namespace App;

function dynamic(string $name)
{
    $$name = 1;
    $unused = 2;
    echo $anything;
}

function extracted(array $vars)
{
    extract($vars);
    echo $title;
}

function included()
{
    include __DIR__ . '/vars.php';
    echo $fromInclude;
}

function defined_vars()
{
    $kept = 1;
    return get_defined_vars();
}

function opaque(string $key)
{
    $value = 1;
    return compact($key);
}
"#,
    );
    assert!(found.problems.is_empty(), "{:?}", messages(&found));
}

#[test]
fn unused_variables() {
    let mut p = project();
    let text = r#"<?php
namespace App;

function f(array $rows, int $param)
{
    $unused = 1;
    $used = 2;
    echo $used;
    $twice = 1;
    $twice = 2;
    $appended = '';
    $appended .= 'x';
    $i = 0;
    $i++;
    [$first, $second] = $rows;
    echo $second;
    foreach ($rows as $key => $row) {}
    try { g(); } catch (\Exception $e) {}
    $param = 3;
    $compacted = 1;
    $captured = 1;
    $inArrow = 1;
    $byRefTarget = 1;
    $alias = &$byRefTarget;
    $alias = 2;
    $_ = 5;
    $fn = fn() => $inArrow;
    $closure = function () use ($captured) {
        $local = 1;
    };
    if ($assigned = g()) {}
    return [compact('compacted'), $fn, $closure];
}
"#;
    let found = p.inspect(text);
    assert_eq!(
        messages(&found),
        [
            unused("unused"),
            unused("twice"),
            unused("twice"),
            unused("appended"),
            unused("appended"),
            unused("i"),
            unused("i"),
            unused("first"),
            unused("local"),
            unused("assigned"),
        ]
    );
    let first = &found.problems[0];
    assert!(first.unnecessary);
    let line = text.lines().position(|l| l.contains("$unused = 1")).unwrap() as u32;
    assert_eq!(first.range, Range::new(Pos::new(line, 4), Pos::new(line, 11)));
}

#[test]
fn top_level_methods_and_suppression() {
    let mut p = project();
    let found = p.inspect(
        r#"<?php
namespace App;

// The top level shares its variables with other files.
echo $fromElsewhere;
$template = 1;
$top = fn() => $fromElsewhere;

final class Shelf
{
    private array $books = [];
    public static $count;

    public function add(string $title): void
    {
        self::$count++;
        $this->books[] = $title;
        /** @noinspection PhpUndefinedVariableInspection */
        echo $quiet;
        echo $loud;
    }
}

new class {
    public function run(): void { echo $anon; }
};
"#,
    );
    assert_eq!(messages(&found), [undefined("loud"), undefined("anon")]);
}

#[test]
fn quiet_in_dumb_mode() {
    let mut p = project();
    p.engine.shutdown();
    let found = p.inspect("<?php\nfunction f() { echo $x; $y = 1; }\n");
    assert!(found.problems.is_empty(), "{:?}", messages(&found));
}
