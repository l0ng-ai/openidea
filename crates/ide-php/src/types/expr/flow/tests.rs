//! Snippet → type tables for local variables through branches, loops and
//! narrowing, plus definedness and unreachable code.

use super::Defined;
use crate::types::expr::tests::{check, flow_at_caret};

#[test]
fn branches_merge() {
    check(&[
        ("if ($c) { $x = 1; } else { $x = 'a'; }\n$x/*|*/;", "int|string"),
        ("if ($c) { $x = new Book; }\n$x/*|*/;", r"Lib\Book"),
        ("$x = 1;\nif ($c) { $x = 'a'; } elseif ($d) { $x = 1.5; }\n$x/*|*/;", "string|float|int"),
        ("$x = 1;\nif ($c) { $x = 'a'; return; }\n$x/*|*/;", "int"),
        ("$x = 1;\nif ($c): $x = 'a'; else: $x = true; endif;\n$x/*|*/;", "string|true"),
        // Inside a branch, the branch's own assignment.
        ("$x = 1;\nif ($c) { $x = 'a'; $x/*|*/; }", "string"),
        ("$x = null;\nswitch ($k) { case 1: $x = 1; break; case 2: $x = 'a'; break; }\n$x/*|*/;", "int|string|null"),
        // Fall-through from `case 1` into `case 2`.
        ("switch ($k) { case 1: $x = 1; case 2: $x = 'a'; break; default: $x = true; }\n$x/*|*/;", "string|true"),
        ("switch ($k) { case 1: $y = 1; case 2: $y/*|*/; }", "int"),
        ("$x = match ($k) { 1 => new Book, default => null };\n$x/*|*/;", r"?Lib\Book"),
        ("$c ? $x = 1 : $x = 'a';\n$x/*|*/;", "int|string"),
        ("$c && $x = 1;\n$x/*|*/;", "int"),
        ("try { $x = make_book(); } catch (\\RuntimeException $e) { $x = null; }\n$x/*|*/;", r"?Lib\Book"),
        ("try { $x = 1; $x = 'a'; } catch (\\Exception $e) { $x/*|*/; }", "int|string"),
        ("try { $x = 1; } finally { $x/*|*/; }", "int"),
    ]);
}

/// A key added under each of many consecutive `if`s doesn't make a union
/// of every combination of keys (2^n shapes): past a few the shapes merge
/// into one array.
#[test]
fn many_optional_keys_stay_small() {
    let mut body = String::from("$m = [];\n");
    for i in 0..24 {
        body.push_str(&format!("if ($c{i}) {{ $m['k{i}'] = {i}; }}\n"));
    }
    body.push_str("$m/*|*/;");
    let started = std::time::Instant::now();
    check(&[(body.as_str(), "array<string, int>")]);
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());

    // The same nested inside a large literal (WordPress's REST schemas).
    let fields: Vec<String> = (0..40).map(|i| format!("'f{i}' => ['type' => 'string', 'n' => {i}]")).collect();
    let mut body = format!("$s = ['properties' => [{}]];\n", fields.join(", "));
    for i in 0..24 {
        body.push_str(&format!("if ($c{i}) {{ $s['properties']['k{i}'] = ['type' => 'int', 'i' => {i}]; }}\n"));
    }
    body.push_str("$s/*|*/;");
    let started = std::time::Instant::now();
    assert!(crate::types::expr::tests::type_at_caret(&body).is_some());
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
}

#[test]
fn definitions() {
    check(&[
        ("[$a, $b] = [1, 'x'];\n$b/*|*/;", "string"),
        ("list($a, $b) = [1, new Book];\n$b/*|*/;", r"Lib\Book"),
        ("['k' => $v] = ['k' => new Book];\n$v/*|*/;", r"Lib\Book"),
        ("[[$a, $b]] = [[1, new Book]];\n$b/*|*/;", r"Lib\Book"),
        ("[, $second] = [1, 'x'];\n$second/*|*/;", "string"),
        (
            "/** @param list<Book> $books */\nfunction f(array $books) { [$first] = $books; return $first/*|*/; }",
            r"Lib\Book",
        ),
        ("try { make_book(); } catch (\\RuntimeException $e) { $e/*|*/; }", "RuntimeException"),
        (
            "try { make_book(); } catch (\\RuntimeException | \\LogicException $e) { $e/*|*/; }",
            "RuntimeException|LogicException",
        ),
        ("function f() { global $config; return $config/*|*/; }", "mixed"),
        ("function f() { static $count = 0; return $count/*|*/; }", "int"),
        // Writing into arrays.
        ("$a = [];\n$a['k'] = new Book;\n$a/*|*/;", r"array{k: Lib\Book}"),
        ("$a = [];\n$a[] = 1;\n$a[] = 'x';\n$a/*|*/;", "list{int, string}"),
        ("$a['x']['y'] = 1;\n$a/*|*/;", "array{x: array{y: int}}"),
        ("$a = ['n' => 1];\n$a['n'] = 'one';\n$a['n']/*|*/;", "string"),
        // Increments.
        ("$i = 0;\n$i++;\n$i/*|*/;", "int"),
        ("$f = 1.5;\n--$f;\n$f/*|*/;", "float"),
        // `unset` removes; a reference creates.
        ("$x = 1;\nunset($x);\n$x/*|*/;", "mixed"),
        ("$f = function () use (&$r) {};\n$r/*|*/;", "null"),
        // By-reference parameters write their arguments.
        ("function fill(?array &$out): void {}\nfill($m);\n$m/*|*/;", "?array"),
        ("function fill(&$out): void {}\n$m = 1;\nfill($m);\n$m/*|*/;", "int"),
    ]);
}

#[test]
fn loops() {
    check(&[
        ("$i = 0;\nwhile ($i < 10) { $i = $i + 1; }\n$i/*|*/;", "int"),
        ("$x = 1;\nwhile ($c) { $x = 'a'; }\n$x/*|*/;", "int|string"),
        // At the top of the body, the previous iteration's value too.
        ("$x = 1;\nwhile ($c) { $x/*|*/; $x = 'a'; }", "int|string"),
        ("$x = null;\nforeach ($items as $item) { $x = new Book; }\n$x/*|*/;", r"?Lib\Book"),
        ("$a = [];\nforeach ($items as $item) { $a[] = new Book; }\n$a/*|*/;", r"list<Lib\Book>"),
        ("$a = [];\nfor ($i = 0; $i < 3; $i++) { $a[] = $i; }\n$a/*|*/;", "list<int>"),
        ("for ($i = 0; $i < 3; $i++) { $i/*|*/; }", "int"),
        ("do { $x = 1; } while ($c);\n$x/*|*/;", "int"),
        ("while ($c) { if ($d) { $x = 1; break; } $x = 'a'; }\n$x/*|*/;", "string|int"),
        ("while (true) { $x = new Book; if ($c) { break; } }\n$x/*|*/;", r"Lib\Book"),
        ("foreach ($rows as $row) { if ($c) { $x = 1; continue; } $x = 'a'; }\n$x/*|*/;", "string|int"),
        // `break 2` leaves both loops.
        ("while ($c) { while ($d) { $x = 1; break 2; } $x = 'a'; }\n$x/*|*/;", "string|int"),
        // Growing arrays converge.
        ("$x = [];\nwhile ($c) { $x = [$x]; }\n$x/*|*/;", "mixed"),
    ]);
}

#[test]
fn foreach_keys_and_values() {
    check(&[
        (
            "/** @param list<Book> $books */\nfunction f(array $books) { foreach ($books as $b) { $b/*|*/; } }",
            r"Lib\Book",
        ),
        (
            "/** @param array<string, Book> $m */\nfunction f(array $m) { foreach ($m as $k => $b) { $k/*|*/; } }",
            "string",
        ),
        ("foreach (['a' => 1, 'b' => 'x'] as $k => $v) { $v/*|*/; }", "int|string"),
        ("foreach (['a' => 1, 'b' => 'x'] as $k => $v) { $k/*|*/; }", "string"),
        ("foreach ([[1, 'a']] as [$n, $s]) { $s/*|*/; }", "string"),
        ("foreach ([new Book] as &$b) { $b/*|*/; }", r"Lib\Book"),
        (
            "class It { public function current(): Book {} public function key(): int {} }\nforeach (new It as $k => $v) { $v/*|*/; }",
            r"Lib\Book",
        ),
        (
            "class It { public function current(): Book {} public function key(): int {} }\nclass Agg { public function getIterator(): It {} }\nforeach (new Agg as $k => $v) { $k/*|*/; }",
            "int",
        ),
        ("foreach ($unknown as $v) { $v/*|*/; }", "mixed"),
        // A plain object: its property names and values.
        ("foreach (new Book as $k => $v) { $k/*|*/; }", "string"),
        ("foreach (new Book as $k => $v) { $v/*|*/; }", "mixed"),
        // Not when an ancestor is unknown (it might be Traversable).
        ("class Sub extends Missing {}\nforeach (new Sub as $k => $v) { $k/*|*/; }", "mixed"),
        // `false` stays beside other types once literals are widened.
        ("function g(): int|false { return 1; }\n$p = g();\n$p/*|*/;", "int|false"),
        ("$t = true;\n$t/*|*/;", "bool"),
        // `false` in the iterated type adds nothing.
        ("/** @return string[]|false */\nfunction parts() {}\nforeach (parts() as $p) { $p/*|*/; }", "string"),
        // Superglobals are arrays everywhere.
        ("function f() { $_COOKIE['a'] = 1; return $_COOKIE/*|*/; }", "array"),
        ("$_SERVER/*|*/;", "array"),
        // A `void` call's result is stored as `null`.
        ("function e() { echo 1; }\nfunction s(): ?string { return null; }\n$v = e();\n$v/*|*/;", "null"),
        ("function e() { echo 1; }\n$v = $c ? 'a' : e();\n$v/*|*/;", "?string"),
        ("$f = function () {};\n$f/*|*/;", "Closure(): void"),
    ]);
}

#[test]
fn narrowing() {
    check(&[
        ("function f(?Book $b) { if ($b !== null) { $b/*|*/; } }", r"Lib\Book"),
        ("function f(?Book $b) { if (null === $b) { $b/*|*/; } }", "null"),
        ("function f(?Book $b) { if ($b === null) { return; } $b/*|*/; }", r"Lib\Book"),
        ("function f(?Book $b) { if ($b == null) { return; } $b/*|*/; }", r"Lib\Book"),
        // `=== false` / `!== false` on `T|false`.
        ("function f(Book|false $b) { if (false === $b) { return; } $b/*|*/; }", r"Lib\Book"),
        ("function f(Book|false $b) { if ($b !== false) { $b/*|*/; } }", r"Lib\Book"),
        ("function f(Book|false $b) { if ($b === false) { $b/*|*/; } }", "bool"),
        ("function f(Book|true $b) { if (true === $b) { return; } $b/*|*/; }", r"Lib\Book"),
        // A loose comparison with a bool doesn't narrow.
        ("function f(Book|false $b) { if ($b == false) { return; } $b/*|*/; }", r"Lib\Book|false"),
        ("function f(?Book $b) { if (!$b) { return; } $b/*|*/; }", r"Lib\Book"),
        ("function f(?Book $b) { if ($b) { $b/*|*/; } }", r"Lib\Book"),
        ("function f(?Book $b) { if (isset($b)) { $b/*|*/; } }", r"Lib\Book"),
        ("function f(?Book $b) { if (empty($b)) { return; } $b/*|*/; }", r"Lib\Book"),
        ("function f(?Book $b) { if ($b === null) { throw new \\Exception(); } $b/*|*/; }", r"Lib\Book"),
        ("function f(?Book $b) { $b ??= new Book; $b/*|*/; }", r"Lib\Book"),
        ("function f(?Book $b) { assert($b !== null); $b/*|*/; }", r"Lib\Book"),
        ("function f(?Book $b) { assert($b instanceof Novel); $b/*|*/; }", r"Lib\Novel"),
        ("function f($x) { if ($x instanceof Book) { $x/*|*/; } }", r"Lib\Book"),
        ("function f(Book $x) { if ($x instanceof Novel) { $x/*|*/; } }", r"Lib\Novel"),
        ("function f(Book|Author $x) { if ($x instanceof Book) { return; } $x/*|*/; }", r"Lib\Author"),
        ("function f(Book|Author $x) { if (!$x instanceof Author) { $x/*|*/; } }", r"Lib\Book"),
        ("function f(Book|Author $x) { if (!($x instanceof Author)) { return; } $x/*|*/; }", r"Lib\Author"),
        ("function f(int|string $x) { if (is_string($x)) { $x/*|*/; } }", "string"),
        ("function f(int|string $x) { if (is_string($x)) { return; } $x/*|*/; }", "int"),
        ("function f(int|string|null $x) { if (is_null($x)) { $x/*|*/; } }", "null"),
        ("function f(int|string|null $x) { if (\\is_int($x)) { $x/*|*/; } }", "int"),
        ("function f(mixed $x) { if (is_array($x)) { $x/*|*/; } }", "array"),
        ("function f(int|string $x) { if (is_numeric($x)) { return; } $x/*|*/; }", "int|string"),
        // `&&`, `||` and the ternary.
        ("function f(?Book $b, ?Author $a) { if ($b !== null && $a !== null) { $a/*|*/; } }", r"Lib\Author"),
        ("function f(?Book $b) { if ($b === null || $b/*|*/->pages > 0) {} }", r"Lib\Book"),
        ("function f(?Book $b) { if ($b !== null && $b/*|*/->pages > 0) {} }", r"Lib\Book"),
        ("function f(?Book $b) { if ($b === null || $b->pages > 0) { $b/*|*/; } }", r"?Lib\Book"),
        ("function f(?Book $b) { if ($b === null || $c) { return; } $b/*|*/; }", r"Lib\Book"),
        ("function f(?Book $b) { return $b !== null ? $b/*|*/->title : ''; }", r"Lib\Book"),
        ("function f(?Book $b) { return $b === null ? '' : $b/*|*/; }", r"Lib\Book"),
        ("function f(?Book $b) { return $b instanceof Book && $b/*|*/->pages; }", r"Lib\Book"),
        // An assignment in the condition, and loops.
        ("function f() { if ($b = (new Book)->author()) { $b/*|*/; } }", r"Lib\Author"),
        ("function f(?Book $b) { while ($b === null) { $b = make_book(); } $b/*|*/; }", r"Lib\Book"),
        ("function f(?Book $b) { foreach ([1] as $i) { if ($b === null) { continue; } $b/*|*/; } }", r"Lib\Book"),
        // Narrowing ends with its branch.
        ("function f(?Book $b) { if ($b !== null) { $b->pages; } $b/*|*/; }", r"?Lib\Book"),
    ]);
}

#[test]
fn closures_capture_where_they_are_created() {
    check(&[
        ("$x = 1;\n$f = function () use ($x) { return $x/*|*/; };\n$x = 'a';", "int"),
        ("$x = 1;\n$f = fn() => $x/*|*/;\n$x = 'a';", "int"),
        ("function f(?Book $b) { if ($b === null) { return; } return fn() => $b/*|*/; }", r"Lib\Book"),
        ("$f = function () { $x = 1; if ($c) { $x = 'a'; } return $x/*|*/; };", "string|int"),
        // A closure created in a loop sees the merged state.
        ("$x = 1;\nwhile ($c) { $f = fn() => $x/*|*/; $x = 'a'; }", "int|string"),
    ]);
}

#[test]
fn definedness() {
    let defined = |body: &str| flow_at_caret(body).1.map(|state| state.defined);
    assert_eq!(defined("$x = 1;\n$x/*|*/;"), Some(Defined::Yes));
    assert_eq!(defined("if ($c) { $x = 1; }\n$x/*|*/;"), Some(Defined::Maybe));
    assert_eq!(defined("if ($c) { $x = 1; } else { $x = 2; }\n$x/*|*/;"), Some(Defined::Yes));
    assert_eq!(defined("if ($c) { $x = 1; } else { return; }\n$x/*|*/;"), Some(Defined::Yes));
    assert_eq!(defined("$x/*|*/;"), Some(Defined::No));
    assert_eq!(defined("$x = 1;\nunset($x);\n$x/*|*/;"), Some(Defined::No));
    assert_eq!(defined("foreach ($a as $v) {}\n$v/*|*/;"), Some(Defined::Maybe));
    assert_eq!(defined("do { $x = 1; } while ($c);\n$x/*|*/;"), Some(Defined::Yes));
    assert_eq!(defined("while (true) { $x = 1; if ($c) { break; } }\n$x/*|*/;"), Some(Defined::Yes));
    assert_eq!(defined("for ($i = 0; $i < 3; $i++) {}\n$i/*|*/;"), Some(Defined::Yes));
    assert_eq!(defined("function f(int $p) { return $p/*|*/; }"), Some(Defined::Yes));
    assert_eq!(defined("function f() { global $g; return $g/*|*/; }"), Some(Defined::Yes));
    assert_eq!(defined("try { $x = f(); } catch (\\Exception $e) { $x/*|*/; }"), Some(Defined::Maybe));
    assert_eq!(defined("if (isset($x)) { $x/*|*/; }"), Some(Defined::Yes));
    // No stubs here: a callee whose signature isn't known may take the
    // argument by reference (and create it).
    assert_eq!(defined("preg_match('/a/', 'a', $m);\n$m/*|*/;"), Some(Defined::Yes));
    assert_eq!(defined("function take($in) {}\ntake($m);\n$m/*|*/;"), Some(Defined::No));
    assert_eq!(defined("if (isset($x['k'])) { $x/*|*/; }"), Some(Defined::Yes));
    assert_eq!(defined("if (!empty($o->p)) { $o/*|*/; }"), Some(Defined::Yes));
    assert_eq!(defined("if (!empty($x)) { $x/*|*/; }"), Some(Defined::Yes));
    assert_eq!(defined("if ($c) { $x = 1; }\n$f = function () use ($x) { return $x/*|*/; };"), Some(Defined::Yes));
    assert_eq!(defined("function grab(&$out) {}\ngrab($m);\n$m/*|*/;"), Some(Defined::Yes));
    // The assigned variable itself is written there.
    assert_eq!(defined("$x/*|*/ = 1;"), Some(Defined::Yes));

    let dynamic = |body: &str| flow_at_caret(body).0.is_dynamic();
    assert!(!dynamic("$x = 1;\n$x/*|*/;"));
    assert!(dynamic("extract($row);\n$x/*|*/;"));
    assert!(dynamic("$name = 'x';\n$$name = 1;\n$x/*|*/;"));
    assert!(dynamic("include 'vars.php';\n$x/*|*/;"));
}

#[test]
fn unreachable_code() {
    // The unreachable statements' text, in order.
    let unreachable = |body: &str| {
        let (flow, _, header) = flow_at_caret(body);
        let text = body.replacen("/*|*/", "", 1);
        flow.unreachable()
            .iter()
            .map(|range| text[range.start as usize - header..range.end as usize - header].to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(unreachable("function f() { return 1; $a = 2; $b = 3; }\n$x/*|*/;"), Vec::<String>::new());
    assert_eq!(unreachable("function f() { return 1; $a = 2; $b = 3; $a/*|*/; }"), vec!["$a = 2;"]);
    assert_eq!(unreachable("function f() { throw new \\Exception(); $a/*|*/ = 2; }"), vec!["$a = 2;"]);
    assert_eq!(unreachable("function f() { exit(1); $a/*|*/ = 2; }"), vec!["$a = 2;"]);
    assert_eq!(
        unreachable("function f($c) { if ($c) { return 1; } else { return 2; } $a/*|*/ = 2; }"),
        vec!["$a = 2;"]
    );
    assert_eq!(unreachable("function f($c) { if ($c) { return 1; } $a/*|*/ = 2; }"), Vec::<String>::new());
    assert_eq!(unreachable("function f() { while (true) {} $a/*|*/ = 2; }"), vec!["$a = 2;"]);
    assert_eq!(unreachable("function f($c) { while (true) { if ($c) break; } $a/*|*/ = 2; }"), Vec::<String>::new());
    assert_eq!(unreachable("function f() { foreach ([1] as $v) { continue; $a/*|*/ = 2; } }"), vec!["$a = 2;"]);
    assert_eq!(unreachable("function stop(): never { exit; }\nfunction f() { stop(); $a/*|*/ = 2; }"), vec!["$a = 2;"]);
    // Declarations after a return are hoisted, not dead.
    assert_eq!(unreachable("function f() { return; function g() {} $a/*|*/ = 1; }"), vec!["$a = 1;"]);
    // A block no path enters is a constant condition, not code after a jump.
    assert_eq!(unreachable("function f() { if (false) { $a = 1; return; $b = 2; } $a/*|*/; }"), Vec::<String>::new());
    assert_eq!(unreachable("function f() { while (false) { $a = 1; } $a/*|*/; }"), Vec::<String>::new());
    assert_eq!(
        unreachable("function f() { return; if (true) { $a = 1; } $b/*|*/ = 1; }"),
        vec!["if (true) { $a = 1; }"]
    );
    // `switch`: a `break` after a `return` is dead.
    assert_eq!(unreachable("function f($k) { switch ($k) { case 1: return 1; break; } $a/*|*/; }"), vec!["break;"]);
}

#[test]
fn falls_through() {
    let falls = |body: &str| flow_at_caret(body).0.falls_through();
    assert!(falls("function f() { $a/*|*/ = 1; }"));
    assert!(falls("function f($c) { if ($c) { return 1; } $a/*|*/ = 1; }"));
    assert!(!falls("function f($c) { if ($c) { return 1; } $a/*|*/ = 1; return 2; }"));
    assert!(!falls("function f($c) { if ($c) { return 1; } else { throw new \\Exception(); } $a/*|*/; }"));
    assert!(falls("function f($k) { switch ($k) { case 1: return 1; } $a/*|*/; }"));
    assert!(!falls("function f($k) { switch ($k) { case 1: return 1; default: return 2; } $a/*|*/; }"));
    assert!(!falls("function f() { while (true) { $a/*|*/ = 1; } }"));
    assert!(falls("function f($c) { while (true) { if ($c) break; } $a/*|*/; }"));
    assert!(!falls("function f() { try { return 1; } finally { $a/*|*/ = 1; } }"));
    assert!(falls("function f() { try { return g(); } catch (\\Exception $e) { $a/*|*/ = 1; } }"));
    assert!(!falls("function stop(): never { exit; }\nfunction f() { $a/*|*/ = 1; stop(); }"));
}

#[test]
fn inline_var_tags() {
    check(&[
        // On an assignment, named or not.
        ("/** @var Book $b */\n$b = untyped();\n$b/*|*/;", r"Lib\Book"),
        ("/** @var Book */\n$b = untyped();\n$b/*|*/;", r"Lib\Book"),
        ("/** @var Book $b */\n$b/*|*/ = untyped();", r"Lib\Book"),
        // Naming another variable leaves the assigned one alone.
        ("/** @var Book $other */\n$b = untyped();\n$b/*|*/;", r"Lib\Author"),
        // In front of any statement, for a variable that exists.
        ("$b = untyped();\n/** @var Book $b */\n$b/*|*/;", r"Lib\Book"),
        ("$b = untyped();\n/** @var Book $b */\necho 1;\n$b/*|*/;", r"Lib\Book"),
        // On a `foreach`, for its value.
        ("/** @var Book $b */\nforeach ($list as $b) { $b/*|*/; }", r"Lib\Book"),
        ("/** @var Book[] $list */\n$list = untyped();\nforeach ($list as $b) { $b/*|*/; }", r"Lib\Book"),
        // A plain comment is no docblock.
        ("/* @var Book $b */\n$b = untyped();\n$b/*|*/;", r"Lib\Author"),
    ]);
}

#[test]
fn match_true_narrows_each_arm() {
    check(&[
        ("function f(?string $s) { $r = match (true) { is_string($s) => $s/*|*/, default => 1 }; }", "string"),
        ("function f(?string $s) { $r = match (true) { is_string($s) => 1, default => $s/*|*/ }; }", "null"),
        (
            "function f(Book|Author|null $x) { $r = match (true) { $x instanceof Book => 1, $x instanceof Author => $x/*|*/, default => 2 }; }",
            r"Lib\Author",
        ),
        // Any of an arm's conditions.
        (
            "function f(Book|Author|int $x) { $r = match (true) { $x instanceof Book, $x instanceof Author => $x/*|*/, default => 2 }; }",
            r"Lib\Book|Lib\Author",
        ),
        // Other subjects don't narrow.
        ("function f(?string $s, $k) { $r = match ($k) { is_string($s) => $s/*|*/, default => 1 }; }", "?string"),
    ]);
}

#[test]
fn assertion_tags_narrow_arguments() {
    let is_book = "/** @phpstan-assert-if-true Book $t */\nfunction is_book($t) { return true; }\n";
    let not_book = "/** @psalm-assert-if-false Book $t */\nfunction not_book($t) { return true; }\n";
    let ensure = "/** @phpstan-assert Book $t */\nfunction ensure($t) {}\n";
    let ensure_not = "/** @phpstan-assert !null $t */\nfunction ensure_not($t) {}\n";
    let generic =
        "/**\n * @template T\n * @param class-string<T> $c\n * @phpstan-assert T $t\n */\nfunction is_a_t($c, $t) {}\n";
    let cases = [
        format!("{is_book}function g(Book|Author $x) {{ if (is_book($x)) {{ $x/*|*/; }} }}"),
        // The other outcome gets the negation (WordPress's `is_wp_error()`).
        format!("{is_book}function g(Book|Author $x) {{ if (is_book($x)) {{ return; }} $x/*|*/; }}"),
        format!("{is_book}function g(Book|Author $x) {{ if (!is_book($x)) {{ $x/*|*/; }} }}"),
        format!("{not_book}function g(Book|Author $x) {{ if (not_book($x)) {{ $x/*|*/; }} }}"),
        format!("{ensure}function g(Book|Author|null $x) {{ ensure($x); $x/*|*/; }}"),
        format!("{ensure_not}function g(?Book $x) {{ ensure_not($x); $x/*|*/; }}"),
        format!("{ensure}function g(Book|Author $x) {{ ensure(t: $x); $x/*|*/; }}"),
        // Template assertions aren't applied.
        format!("{generic}function g(Book|Author $x) {{ is_a_t(Book::class, $x); $x/*|*/; }}"),
    ];
    let expected = [
        r"Lib\Book",
        r"Lib\Author",
        r"Lib\Author",
        r"Lib\Author",
        r"Lib\Book",
        r"Lib\Book",
        r"Lib\Book",
        r"Lib\Book|Lib\Author",
    ];
    let table: Vec<(&str, &str)> = cases.iter().map(String::as_str).zip(expected).collect();
    check(&table);
}

#[test]
fn closure_parameters_from_the_expected_callable() {
    let each = "/** @param callable(Book, int): void $f */\nfunction each_book(callable $f) {}\n";
    let closure = "/** @param (\\Closure(Book): mixed)|null $f */\nfunction with_book(?\\Closure $f) {}\n";
    let coll = "/** @template T */\nclass Coll {\n    /**\n     * @template U\n     * @param callable(T, int, U): void $f\n     */\n    public function each(callable $f) {}\n    /** @param callable(static): void $f */\n    public function tap(callable $f) {}\n}\n";
    let cases = [
        format!("{each}each_book(function ($b, $i) {{ $b/*|*/; }});"),
        format!("{each}each_book(function ($b, $i) {{ $i/*|*/; }});"),
        format!("{closure}with_book(fn ($b) => $b/*|*/);"),
        // A native hint wins.
        format!("{each}each_book(function (Author $b) {{ $b/*|*/; }});"),
        // Through the receiver's generic arguments; a method template or a
        // relative class is unknown.
        format!("{coll}/** @var Coll<Book> $c */\n$c = new Coll();\n$c->each(function ($b) {{ $b/*|*/; }});"),
        format!("{coll}/** @var Coll<Book> $c */\n$c = new Coll();\n$c->each(function ($b, $i, $u) {{ $u/*|*/; }});"),
        format!("{coll}/** @var Coll<Book> $c */\n$c = new Coll();\n$c->tap(function ($me) {{ $me/*|*/; }});"),
        // Not passed anywhere.
        "$f = function ($b) { $b/*|*/; };".to_owned(),
    ];
    let expected = [r"Lib\Book", "int", r"Lib\Book", r"Lib\Author", r"Lib\Book", "mixed", "mixed", "mixed"];
    let table: Vec<(&str, &str)> = cases.iter().map(String::as_str).zip(expected).collect();
    check(&table);
}

#[test]
fn by_reference_arguments_keep_a_type_that_fits() {
    let escape = "/** @param string|array $data */\nfunction escape(&$data) {}\n";
    let fill = "/** @param string[] $out */\nfunction fill(&$out) {}\n";
    let cases = [
        format!("{escape}function g(array $args) {{ escape($args); $args/*|*/; }}"),
        format!("{escape}function g(int $args) {{ escape($args); $args/*|*/; }}"),
        // A literal or a shape the callee fills in takes the declared type.
        format!("{fill}$out = [];\nfill($out);\n$out/*|*/;"),
        format!("{fill}fill($out);\n$out/*|*/;"),
    ];
    let expected = ["array", "string|array", "string[]", "string[]"];
    let table: Vec<(&str, &str)> = cases.iter().map(String::as_str).zip(expected).collect();
    check(&table);
}
