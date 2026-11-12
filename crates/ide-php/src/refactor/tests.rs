//! Extract variable / constant / method: the text before and after, and
//! the suggested names.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ide_core::{DocId, FileEdit, IdeEvent, Pos, Range, SharedSink};

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;

const WAIT: Duration = Duration::from_secs(60);
const CARET: &str = "/*|*/";

struct Project {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
    next_doc: u32,
}

impl Project {
    fn new(version: PhpVersion) -> Self {
        Self::with_files(version, &[])
    }

    /// A project with more files under `src/` (indexed before the engine
    /// is ready).
    fn with_files(version: PhpVersion, files: &[(&str, &str)]) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/consts.php"), "<?php\nnamespace App;\n\nconst TAKEN = 1;\n").unwrap();
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

    /// The actions of `kind` for `marked`: one `/*|*/` is a caret, two
    /// surround a selection. Each with the text after its edit.
    fn actions(&mut self, marked: &str, kind: &str) -> Vec<(String, String)> {
        self.kinds(marked, kind).into_iter().map(|(_, title, text)| (title, text)).collect()
    }

    /// As [`Project::actions`], with each action's kind first.
    fn kinds(&mut self, marked: &str, kind: &str) -> Vec<(&'static str, String, String)> {
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
                let after = match action.edit.files.len() {
                    1 => applied(&text, &action.edit),
                    n => format!("<{n} files>"),
                };
                (action.kind, action.title.clone(), after)
            })
            .collect()
    }

    /// The text after the one action of exactly `kind`, `None` without one.
    fn extract(&mut self, marked: &str, kind: &str) -> Option<String> {
        let mut found: Vec<_> = self.kinds(marked, kind).into_iter().filter(|(k, ..)| *k == kind).collect();
        assert!(found.len() <= 1, "{found:?}");
        found.pop().map(|(_, _, text)| text)
    }

    fn variable(&mut self, marked: &str) -> Option<String> {
        self.extract(marked, EXTRACT_VARIABLE)
    }

    fn constant(&mut self, marked: &str) -> Option<String> {
        self.extract(marked, EXTRACT_CONSTANT)
    }

    /// Extract method or function, whichever is offered.
    fn method(&mut self, marked: &str) -> Option<String> {
        self.extract(marked, EXTRACT_METHOD).or_else(|| self.extract(marked, EXTRACT_FUNCTION))
    }

    /// The Extract Method dialog's data for `marked`, and the text after
    /// resolving it with the defaults changed by `change`.
    fn dialog(
        &mut self,
        marked: &str,
        change: impl FnOnce(&mut ExtractChoice),
    ) -> (Option<ExtractMethod>, Result<String, String>) {
        let (text, range) = selection(marked);
        let doc = DocId(self.next_doc);
        self.next_doc += 1;
        self.engine.document_opened(doc, &self.root.join("src/a.php"), 1, &text);
        let info = self.engine.extract_method_info(doc, range);
        let result = match &info {
            None => Err("no dialog".to_owned()),
            Some(info) => {
                let mut choice = info.defaults.clone();
                change(&mut choice);
                let data = ExtractMethod { change: Some(choice), ..info.clone() };
                match self.engine.extract_method_edit(doc, &data).expect("open") {
                    Ok(edit) => Ok(applied(&text, &edit)),
                    Err(e) => Err(e.to_string()),
                }
            }
        };
        self.engine.document_closed(doc);
        (info, result)
    }

    /// Inline variable.
    fn inline_variable(&mut self, marked: &str) -> Option<String> {
        self.extract(marked, INLINE_VARIABLE)
    }

    /// Inline method or function, whichever is offered.
    fn inline_call(&mut self, marked: &str) -> Option<String> {
        self.extract(marked, INLINE_METHOD).or_else(|| self.extract(marked, INLINE_FUNCTION))
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

fn method(body: &str) -> String {
    format!(
        "<?php\nclass Shop\n{{\n    public function total(Cart $cart, array $items): int\n    {{\n{body}\n    }}\n}}\n"
    )
}

// ------------------------------------------------------------ variables

#[test]
fn extract_a_selected_expression_into_a_variable() {
    let mut p = Project::new(PhpVersion::LATEST);
    assert_eq!(
        p.variable(&method("        return /*|*/$cart->getProducts()/*|*/->count() * 2;")).as_deref(),
        Some(method("        $products = $cart->getProducts();\n        return $products->count() * 2;").as_str())
    );
    // Blank space around the selection doesn't matter; the declaration
    // keeps the statement's indentation.
    assert_eq!(
        p.variable(&method("        if ($cart) {\n            echo/*|*/ strlen('abc') + 1/*|*/;\n        }"))
            .as_deref(),
        Some(
            method(
                "        if ($cart) {\n            $value = strlen('abc') + 1;\n            echo $value;\n        }"
            )
            .as_str()
        )
    );
    // Top-level code, a statement sharing the opening tag's line.
    assert_eq!(
        p.variable("<?php\n$b = /*|*/new StringBuilder()/*|*/;\n").as_deref(),
        Some("<?php\n$stringBuilder = new StringBuilder();\n$b = $stringBuilder;\n")
    );
    assert_eq!(p.variable("<?php echo /*|*/1 + 2/*|*/;\n").as_deref(), Some("<?php $value = 1 + 2; echo $value;\n"));
    // The `if` condition, the `foreach` subject, the `for` initializer.
    assert_eq!(
        p.variable("<?php\nif (/*|*/$user->isAdmin()/*|*/) {\n    exit;\n}\n").as_deref(),
        Some("<?php\n$admin = $user->isAdmin();\nif ($admin) {\n    exit;\n}\n")
    );
    assert_eq!(
        p.variable("<?php\nforeach (/*|*/$repo->findAll()/*|*/ as $row) {\n}\n").as_deref(),
        Some("<?php\n$all = $repo->findAll();\nforeach ($all as $row) {\n}\n")
    );
    assert_eq!(
        p.variable("<?php\nfor ($i = /*|*/count($a)/*|*/; $i > 0; $i--) {\n}\n").as_deref(),
        Some("<?php\n$count = count($a);\nfor ($i = $count; $i > 0; $i--) {\n}\n")
    );
    // Inside a closure the declaration goes in the closure's body.
    assert_eq!(
        p.variable("<?php\n$f = function ($x) {\n    return /*|*/$x * 2/*|*/;\n};\n").as_deref(),
        Some("<?php\n$f = function ($x) {\n    $value = $x * 2;\n    return $value;\n};\n")
    );
}

#[test]
fn a_caret_extracts_the_innermost_expression_around_it() {
    let mut p = Project::new(PhpVersion::LATEST);
    // On the function name: the call, not the name.
    assert_eq!(
        p.variable(&method("        return str/*|*/len('abc') > 3 ? 1 : 0;")).as_deref(),
        Some(method("        $strlen = strlen('abc');\n        return $strlen > 3 ? 1 : 0;").as_str())
    );
    // On a variable: the expression using it.
    assert_eq!(
        p.variable(&method("        return count($it/*|*/ems);")).as_deref(),
        Some(method("        $count = count($items);\n        return $count;").as_str())
    );
}

#[test]
fn names_already_used_in_the_function_are_skipped() {
    let mut p = Project::new(PhpVersion::LATEST);
    // `$items` is a parameter, so the next suggestion.
    assert_eq!(
        p.variable(&method("        return /*|*/$cart->getItems()/*|*/->count();")).as_deref(),
        Some(method("        $value = $cart->getItems();\n        return $value->count();").as_str())
    );
    // Every suggestion taken: numbered.
    assert_eq!(
        p.variable(&method("        $value = 1;\n        return /*|*/$cart->getItems()/*|*/->count();")).as_deref(),
        Some(
            method("        $value = 1;\n        $items1 = $cart->getItems();\n        return $items1->count();")
                .as_str()
        )
    );
}

#[test]
fn extract_variable_is_refused_where_it_would_change_the_code() {
    let mut p = Project::new(PhpVersion::LATEST);
    let refused = [
        // Evaluated again on each iteration, or only sometimes.
        "<?php\nwhile (/*|*/next($a)/*|*/) {\n}\n",
        "<?php\ndo {\n} while (/*|*/next($a)/*|*/);\n",
        "<?php\nfor ($i = 0; $i < /*|*/count($a)/*|*/; $i++) {\n}\n",
        "<?php\nif ($a) {\n} elseif (/*|*/f($b)/*|*/) {\n}\n",
        "<?php\nif ($a) echo /*|*/f($b)/*|*/;\n",
        "<?php\n$f = fn($x) => /*|*/$x * 2/*|*/;\n",
        // Written to, or must stay a variable.
        "<?php\n/*|*/$a['x']/*|*/ = 1;\n",
        "<?php\n/*|*/$a['x']/*|*/['y'] = 1;\n",
        "<?php\n/*|*/$a->b/*|*/++;\n",
        "<?php\nif (isset(/*|*/$a['x']/*|*/)) {\n}\n",
        "<?php\nunset(/*|*/$a['x']/*|*/);\n",
        "<?php\necho /*|*/$a['x']/*|*/ ?? 1;\n",
        "<?php\n$r = &/*|*/$a['x']/*|*/;\n",
        // Not worth it, or nowhere to declare it.
        "<?php\necho /*|*/$a/*|*/;\n",
        "<?php\n/*|*/f(1)/*|*/;\n",
        "<?php\nclass A\n{\n    private $x = /*|*/1 + 2/*|*/;\n}\n",
        "<?php\nfunction f($x = /*|*/1 + 2/*|*/) {\n}\n",
        "<?php\nstatic $x = /*|*/1 + 2/*|*/;\n",
        // Not an expression.
        "<?php\necho /*|*/1 + /*|*/2;\n",
        "<?php\n/*|*/$a = 1; $b = 2;/*|*/\n",
        // Syntax errors.
        "<?php\necho /*|*/f(1)/*|*/ +;\n",
    ];
    for marked in refused {
        assert_eq!(p.variable(marked), None, "{marked}");
    }
    // The index of an assignment target and the value of `??` are fine.
    assert_eq!(
        p.variable("<?php\n$a[/*|*/key()/*|*/] = 1;\n").as_deref(),
        Some("<?php\n$key = key();\n$a[$key] = 1;\n")
    );
    assert_eq!(
        p.variable("<?php\necho $a ?? /*|*/f(1)/*|*/;\n").as_deref(),
        Some("<?php\n$f = f(1);\necho $a ?? $f;\n")
    );
}

// ------------------------------------------------------------ constants

#[test]
fn extract_a_class_constant() {
    let mut p = Project::new(PhpVersion::LATEST);
    let before = "<?php\nclass Mailer\n{\n    private const RETRIES = 3;\n\n    public function host(): string\n    {\n        return /*|*/'smtp host'/*|*/;\n    }\n}\n";
    let after = "<?php\nclass Mailer\n{\n    private const RETRIES = 3;\n    private const SMTP_HOST = 'smtp host';\n\n    public function host(): string\n    {\n        return self::SMTP_HOST;\n    }\n}\n";
    assert_eq!(p.constant(before).as_deref(), Some(after));
    // The first constant goes first (`VALUE` is a global constant here).
    let before = "<?php\nclass Timer\n{\n    public function wait(): int\n    {\n        return /*|*/60 * 60/*|*/ + VALUE;\n    }\n}\n";
    let after = "<?php\nclass Timer\n{\n    private const VALUE = 60 * 60;\n\n    public function wait(): int\n    {\n        return self::VALUE + VALUE;\n    }\n}\n";
    assert_eq!(p.constant(before).as_deref(), Some(after));
    let before = "<?php\nenum Size\n{\n    case VALUE;\n    public function px(): int\n    {\n        return /*|*/60 * 60/*|*/;\n    }\n}\n";
    let after = "<?php\nenum Size\n{\n    private const VALUE1 = 60 * 60;\n\n    case VALUE;\n    public function px(): int\n    {\n        return self::VALUE1;\n    }\n}\n";
    assert_eq!(p.constant(before).as_deref(), Some(after));
    // From a property default; `LIST` is a reserved word.
    let before = "<?php\nclass A\n{\n    private array $flags = /*|*/['on', 'off']/*|*/;\n}\n";
    let after =
        "<?php\nclass A\n{\n    private const ITEMS = ['on', 'off'];\n\n    private array $flags = self::ITEMS;\n}\n";
    assert_eq!(p.constant(before).as_deref(), Some(after));
}

#[test]
fn class_constant_visibility_follows_the_class_and_the_language_level() {
    let interface = "<?php\ninterface Api\n{\n    public function f($x = /*|*/'v1'/*|*/);\n}\n";
    let trait_ = "<?php\ntrait T\n{\n    public function f()\n    {\n        return /*|*/'v1'/*|*/;\n    }\n}\n";
    let class = "<?php\nclass C\n{\n    public function f()\n    {\n        return /*|*/'v1'/*|*/;\n    }\n}\n";

    let mut p = Project::new(PhpVersion::new(8, 2));
    let found = p.constant(interface).unwrap();
    assert!(found.contains("{\n    public const V1 = 'v1';\n\n    public function f($x = self::V1);"), "{found}");
    let found = p.constant(trait_).unwrap();
    assert!(found.contains("    private const V1 = 'v1';\n"), "{found}");

    let mut p = Project::new(PhpVersion::new(8, 1));
    assert_eq!(p.constant(trait_), None, "trait constants need PHP 8.2");

    let mut p = Project::new(PhpVersion::new(7, 0));
    let found = p.constant(class).unwrap();
    assert!(found.contains("{\n    const V1 = 'v1';\n"), "{found}");
}

#[test]
fn extract_a_global_constant() {
    let mut p = Project::new(PhpVersion::LATEST);
    assert_eq!(
        p.constant("<?php\nnamespace App;\n\nfunction timeout(): int\n{\n    return /*|*/60 * 60/*|*/;\n}\n")
            .as_deref(),
        Some("<?php\nnamespace App;\n\nconst VALUE = 60 * 60;\n\nfunction timeout(): int\n{\n    return VALUE;\n}\n")
    );
    // A braced namespace; `App\TAKEN` is declared in another file.
    assert_eq!(
        p.constant("<?php\nnamespace App {\n    echo /*|*/'taken'/*|*/;\n}\n").as_deref(),
        Some("<?php\nnamespace App {\n    const S = 'taken';\n    echo S;\n}\n")
    );
    assert_eq!(
        p.constant("<?php\n$x = /*|*/\"Hello world\"/*|*/ . $name;\n").as_deref(),
        Some("<?php\nconst HELLO_WORLD = \"Hello world\";\n$x = HELLO_WORLD . $name;\n")
    );
}

#[test]
fn extract_constant_needs_a_constant_expression() {
    let mut p = Project::new(PhpVersion::LATEST);
    let refused = [
        "<?php\necho /*|*/$a + 1/*|*/;\n",
        "<?php\necho /*|*/f(1)/*|*/;\n",
        "<?php\necho /*|*/\"a $b\"/*|*/;\n",
        "<?php\necho /*|*/PHP_EOL/*|*/;\n",
        "<?php\nclass A\n{\n    const X = 1;\n    public function f() { return /*|*/self::X/*|*/; }\n}\n",
        "<?php\n$o = new class {\n    public function f() { return /*|*/1 + 2/*|*/; }\n};\n",
        "<?php\ntrait T\n{\n    public function f() { return /*|*/static::class/*|*/; }\n}\n",
    ];
    for marked in refused {
        assert_eq!(p.constant(marked), None, "{marked}");
    }
    // Both actions on one expression when it's constant (and Extract
    // function, which takes any expression).
    let titles: Vec<String> =
        p.actions("<?php\necho /*|*/1 + 2/*|*/;\n", "refactor.extract").into_iter().map(|(t, _)| t).collect();
    assert_eq!(titles, ["Extract variable", "Extract constant", "Extract function"]);
    // Not when only other kinds are asked for.
    assert!(p.actions("<?php\necho /*|*/1 + 2/*|*/;\n", crate::imports::REWRITE).is_empty());
}

// ------------------------------------------------------------ names

/// The names suggested for the expression `expr`.
fn suggested(expr: &str, constant: bool) -> Vec<String> {
    let text = format!("<?php\n$_ = {expr};\n");
    let parsed = ParsedFile::parse("x.php", text.as_str());
    let start = text.find(expr).unwrap() as u32;
    let end = start + expr.len() as u32;
    let nodes = path_to(Node::Program(parsed.program()), start, end);
    let i = chosen(&nodes, (start, end), |_| true).expect("an expression");
    names::suggest(expression(&nodes[i]), constant)
}

#[test]
fn names_follow_the_frontend_conventions() {
    let table: &[(&str, &[&str])] = &[
        ("$this->getUserName()", &["userName", "name", "value"]),
        ("get_user_name()", &["userName", "name", "value"]),
        ("$user->isActive()", &["active", "isActive", "value"]),
        ("$users->find(1)", &["user", "value"]),
        ("Factory::create()", &["factory", "value"]),
        ("$x->get()", &["value"]),
        ("new \\App\\HttpClient()", &["httpClient", "client"]),
        ("new StringBuilder", &["stringBuilder", "builder"]),
        ("$items[$i]", &["item", "element"]),
        ("$this->categories[0]", &["category", "item", "element"]),
        ("$order->totalPrice", &["totalPrice", "price", "value"]),
        ("$cart->getTotal", &["total", "value"]),
        ("'user name'", &["userName", "s", "text"]),
        ("'a/b'", &["s", "text"]),
        ("\"Hi $name\"", &["s", "text"]),
        ("42", &["i", "value"]),
        ("4.2", &["value", "v"]),
        ("true", &["b", "flag"]),
        ("$a === $b", &["b", "flag"]),
        ("!$a", &["b", "flag"]),
        ("isset($a)", &["b", "flag"]),
        ("$a . 'x'", &["s", "text"]),
        ("[1, 2]", &["list", "items"]),
        ("fn() => 1", &["callback"]),
        ("($a + $b)", &["value"]),
        ("@file('x')", &["file", "value"]),
        ("clone $this->order", &["order", "value"]),
        ("Status::Active", &["active", "value"]),
    ];
    for (expr, expected) in table {
        assert_eq!(suggested(expr, false), *expected, "{expr}");
    }
    assert_eq!(suggested("'smtp host'", true), ["SMTP_HOST", "S", "TEXT"]);
    assert_eq!(suggested("60 * 60", true), ["VALUE"]);
    // Keywords are dropped, and reserved words for constants.
    assert_eq!(suggested("new Default_()", false), ["value"]);
    assert_eq!(suggested("[1, 2]", true), ["ITEMS"]);
}

#[test]
fn words_and_unique_names() {
    assert_eq!(names::split_words("getHTTPResponse"), ["get", "http", "response"]);
    assert_eq!(names::split_words("$user_name2"), ["user", "name2"]);
    let taken = ["user", "value", "user1"];
    let names = ["user".to_owned(), "value".to_owned()];
    assert_eq!(names::unique(&names, |n| taken.contains(&n)), "user2");
    assert_eq!(names::unique(&names, |n| n == "user"), "value");
}

// ------------------------------------------------------------ methods

#[test]
fn extract_statements_into_a_method_with_parameters_and_a_result() {
    let mut p = Project::new(PhpVersion::LATEST);
    let before = "<?php\nclass Shop\n{\n    private int $rate = 2;\n\n    /** @param int[] $items */\n    public function total(array $items): int\n    {\n        $sum = 0;\n        /*|*/foreach ($items as $item) {\n            $sum += $item * $this->rate;\n        }/*|*/\n        return $sum;\n    }\n}\n";
    let after = "<?php\nclass Shop\n{\n    private int $rate = 2;\n\n    /** @param int[] $items */\n    public function total(array $items): int\n    {\n        $sum = 0;\n        $sum = $this->extracted($items, $sum);\n        return $sum;\n    }\n\n    private function extracted(array $items, int $sum): int\n    {\n        foreach ($items as $item) {\n            $sum += $item * $this->rate;\n        }\n\n        return $sum;\n    }\n}\n";
    assert_eq!(p.method(before).as_deref(), Some(after));
    // Nothing comes out: `void`; the body is indented for its new place.
    let before = "<?php\nclass Log\n{\n    public function write(string $line, bool $loud): void\n    {\n        if ($loud) {\n            /*|*/$line = strtoupper($line);\n            echo $line;/*|*/\n        }\n    }\n}\n";
    let after = "<?php\nclass Log\n{\n    public function write(string $line, bool $loud): void\n    {\n        if ($loud) {\n            $this->extracted($line);\n        }\n    }\n\n    private function extracted(string $line): void\n    {\n        $line = strtoupper($line);\n        echo $line;\n    }\n}\n";
    assert_eq!(p.method(before).as_deref(), Some(after));
    let titles: Vec<String> = p.actions(before, "refactor.extract").into_iter().map(|(t, _)| t).collect();
    assert_eq!(titles, ["Extract method"]);
}

#[test]
fn several_results_come_back_as_an_array() {
    let body =
        "        /*|*/$count = count($items);\n        $first = $items[0];/*|*/\n        return $count + $first;";
    let mut p = Project::new(PhpVersion::LATEST);
    assert_eq!(
        p.method(&method(body)).as_deref(),
        Some(
            "<?php\nclass Shop\n{\n    public function total(Cart $cart, array $items): int\n    {\n        [$count, $first] = $this->extracted($items);\n        return $count + $first;\n    }\n\n    private function extracted(array $items): array\n    {\n        $count = count($items);\n        $first = $items[0];\n\n        return [$count, $first];\n    }\n}\n"
        )
    );
    // `list()` before PHP 7.1, and no `void`.
    let mut p = Project::new(PhpVersion::new(7, 0));
    let found = p.method(&method(body)).unwrap();
    assert!(found.contains("        list($count, $first) = $this->extracted($items);\n"), "{found}");
    assert!(found.contains("    private function extracted(array $items): array\n"), "{found}");
    let found = p.method(&method("        /*|*/echo count($items);/*|*/\n        return 1;")).unwrap();
    assert!(found.contains("    private function extracted(array $items)\n"), "{found}");
}

#[test]
fn a_value_assigned_in_a_loop_and_read_on_the_next_pass_is_a_result() {
    let mut p = Project::new(PhpVersion::LATEST);
    let before = "<?php\nfunction show(array $items): void\n{\n    $last = null;\n    foreach ($items as $item) {\n        echo $last;\n        /*|*/$last = strval($item);/*|*/\n    }\n}\n";
    let after = "<?php\nfunction show(array $items): void\n{\n    $last = null;\n    foreach ($items as $item) {\n        echo $last;\n        $last = extracted($item);\n    }\n}\n\nfunction extracted($item): string\n{\n    $last = strval($item);\n\n    return $last;\n}\n";
    assert_eq!(p.method(before).as_deref(), Some(after));
}

#[test]
fn extract_an_expression_in_a_static_method() {
    let mut p = Project::new(PhpVersion::LATEST);
    let before = "<?php\nclass Circle\n{\n    public static function area(float $r): float\n    {\n        return /*|*/M_PI * $r * $r/*|*/;\n    }\n}\n";
    let after = "<?php\nclass Circle\n{\n    public static function area(float $r): float\n    {\n        return self::extracted($r);\n    }\n\n    private static function extracted(float $r): float\n    {\n        return M_PI * $r * $r;\n    }\n}\n";
    assert_eq!(p.method(before).as_deref(), Some(after));
    // `$this` and an arrow function's free variables come along.
    let before = "<?php\nclass A\n{\n    private array $all = [];\n\n    public function pick(int $min): array\n    {\n        return /*|*/array_filter($this->all, fn($x) => $x > $min)/*|*/;\n    }\n}\n";
    let found = p.method(before).unwrap();
    assert!(found.contains("        return $this->extracted($min);\n"), "{found}");
    assert!(
        found.contains(
            "    private function extracted(int $min): array\n    {\n        return array_filter($this->all, fn($x) => $x > $min);\n    }\n"
        ),
        "{found}"
    );
}

#[test]
fn extract_a_function_from_a_function_and_from_top_level_code() {
    let mut p = Project::new(PhpVersion::LATEST);
    let before = "<?php\nnamespace App;\n\nfunction greet(string $name): string\n{\n    /*|*/$text = 'Hello ' . $name;\n    $text = trim($text);/*|*/\n    return $text;\n}\n";
    let after = "<?php\nnamespace App;\n\nfunction greet(string $name): string\n{\n    $text = extracted($name);\n    return $text;\n}\n\nfunction extracted(string $name): string\n{\n    $text = 'Hello ' . $name;\n    $text = trim($text);\n\n    return $text;\n}\n";
    assert_eq!(p.method(before).as_deref(), Some(after));
    let titles: Vec<String> = p.actions(before, "refactor.extract").into_iter().map(|(t, _)| t).collect();
    assert_eq!(titles, ["Extract function"]);
    assert_eq!(
        p.method("<?php\n$a = 1;\n/*|*/echo $a + 1;/*|*/\n").as_deref(),
        Some("<?php\n$a = 1;\nextracted($a);\n\nfunction extracted(int $a): void\n{\n    echo $a + 1;\n}\n")
    );
    // The name is numbered when taken.
    let found = p.method("<?php\nfunction extracted() {}\n$a = 1;\n/*|*/echo $a;/*|*/\n").unwrap();
    assert!(found.contains("extracted1($a);"), "{found}");
}

#[test]
fn a_final_return_of_the_body_is_kept() {
    let mut p = Project::new(PhpVersion::LATEST);
    let before = "<?php\nfunction clamp(int $x): int\n{\n    $y = $x * 2;\n    /*|*/if ($y > 10) {\n        $y = 10;\n    }\n    return $y;/*|*/\n}\n";
    let after = "<?php\nfunction clamp(int $x): int\n{\n    $y = $x * 2;\n    return extracted($y);\n}\n\nfunction extracted(int $y): int\n{\n    if ($y > 10) {\n        $y = 10;\n    }\n    return $y;\n}\n";
    assert_eq!(p.method(before).as_deref(), Some(after));
}

#[test]
fn extract_method_is_refused_where_control_or_variables_would_change() {
    let mut p = Project::new(PhpVersion::LATEST);
    let refused = [
        // Early returns, jumps out of the selection, generators.
        "<?php\nfunction f($x)\n{\n    /*|*/if ($x) {\n        return 1;\n    }/*|*/\n    return 2;\n}\n",
        "<?php\nfunction f($x)\n{\n    if ($x) {\n        /*|*/return 1;/*|*/\n    }\n    return 2;\n}\n",
        "<?php\nfunction f($a)\n{\n    foreach ($a as $v) {\n        /*|*/if ($v) {\n            break;\n        }/*|*/\n    }\n}\n",
        "<?php\nfunction f($a)\n{\n    foreach ($a as $v) {\n        /*|*/foreach ($v as $w) {\n            continue 2;\n        }/*|*/\n    }\n}\n",
        "<?php\nfunction f($a)\n{\n    /*|*/yield $a;/*|*/\n}\n",
        // References, scope declarations, dynamic variables.
        "<?php\nfunction f($a)\n{\n    /*|*/$r = &$a;/*|*/\n    $r = 1;\n}\n",
        "<?php\nfunction f()\n{\n    /*|*/global $g;/*|*/\n    return $g;\n}\n",
        "<?php\nfunction f($n)\n{\n    /*|*/echo $$n;/*|*/\n}\n",
        "<?php\nfunction f($n)\n{\n    extract($n);\n    /*|*/echo $a;/*|*/\n}\n",
        // A result that might not exist.
        "<?php\nfunction f($c)\n{\n    /*|*/if ($c) {\n        $z = 1;\n    }/*|*/\n    echo $z;\n}\n",
        // Not whole statements or one expression; nothing selected.
        "<?php\nfunction f($a)\n{\n    /*|*/$b = 1;\n    $c/*|*/ = 2;\n}\n",
        "<?php\nfunction f($a)\n{\n    echo /*|*/$a/*|*/ + 1;\n}\n",
        "<?php\nfunction f($a)\n{\n    echo /*|*/$a + 1;\n}\n",
        // Expressions that write.
        "<?php\nfunction f($a)\n{\n    echo /*|*/($a = 1) + 2/*|*/;\n}\n",
        "<?php\nfunction f($a)\n{\n    echo /*|*/$a++ + 2/*|*/;\n}\n",
        // Inside anonymous classes, defaults (closures: see
        // `extract_from_closures_and_arrow_functions`).
        "<?php\n$o = new class {\n    public function f($a) {\n        /*|*/echo $a;/*|*/\n    }\n};\n",
        "<?php\nfunction f($a = /*|*/1 + 2/*|*/) {\n}\n",
        // Declarations.
        "<?php\nfunction f()\n{\n    /*|*/function g() {}/*|*/\n}\n",
        // Syntax errors.
        "<?php\nfunction f($a)\n{\n    /*|*/echo $a;/*|*/\n    echo +;\n}\n",
    ];
    for marked in refused {
        assert_eq!(p.method(marked), None, "{marked}");
    }
    // A `break` inside a loop that is selected whole is fine.
    let found = p
        .method(
            "<?php\nfunction f($a)\n{\n    /*|*/foreach ($a as $v) {\n        if ($v) {\n            break;\n        }\n    }/*|*/\n}\n",
        )
        .unwrap();
    assert!(found.contains("    extracted($a);\n"), "{found}");
    // Not when only other kinds are asked for.
    assert!(p.actions("<?php\n$a = 1;\n/*|*/echo $a;/*|*/\n", EXTRACT_VARIABLE).is_empty());
}

#[test]
fn extract_from_closures_and_arrow_functions() {
    let mut p = Project::new(PhpVersion::LATEST);
    // Statements of a closure in a method: a method of the class, called
    // with `$this` inside the closure.
    let before = "<?php\nclass Shop\n{\n    public function run(array $items, int $rate): array\n    {\n        return array_map(function (int $item) use ($rate) {\n            /*|*/$price = $item * $rate;\n            echo $price;/*|*/\n            return $price;\n        }, $items);\n    }\n}\n";
    let after = "<?php\nclass Shop\n{\n    public function run(array $items, int $rate): array\n    {\n        return array_map(function (int $item) use ($rate) {\n            $price = $this->extracted($item, $rate);\n            return $price;\n        }, $items);\n    }\n\n    private function extracted(int $item, int $rate): int\n    {\n        $price = $item * $rate;\n        echo $price;\n\n        return $price;\n    }\n}\n";
    assert_eq!(p.method(before).as_deref(), Some(after));
    // The closure's last return is kept.
    let found = p
        .method("<?php\nfunction f(array $a): array\n{\n    return array_map(function (int $x): int {\n        /*|*/$y = $x + 1;\n        return $y * 2;/*|*/\n    }, $a);\n}\n")
        .unwrap();
    assert!(found.contains("        return extracted($x);\n"), "{found}");
    assert!(found.contains("function extracted(int $x): int\n{\n    $y = $x + 1;\n    return $y * 2;\n}\n"), "{found}");
    // A static closure makes a static method.
    let found = p
        .method("<?php\nclass A\n{\n    public function f(array $a): array\n    {\n        return array_map(static function (int $x) {\n            /*|*/echo $x;/*|*/\n            return $x;\n        }, $a);\n    }\n}\n")
        .unwrap();
    assert!(found.contains("            self::extracted($x);\n"), "{found}");
    assert!(found.contains("    private static function extracted(int $x): void\n"), "{found}");
    // An arrow function's expression, at the top level.
    assert_eq!(
        p.method("<?php\n$f = fn(int $a) => /*|*/$a * 2 + 1/*|*/;\n").as_deref(),
        Some(
            "<?php\n$f = fn(int $a) => extracted($a);\n\nfunction extracted(int $a): int\n{\n    return $a * 2 + 1;\n}\n"
        )
    );
    // Top-level closure statements.
    let found = p.method("<?php\n$f = function ($a) {\n    /*|*/echo $a;/*|*/\n};\n").unwrap();
    assert!(found.contains("    extracted($a);\n};\n\nfunction extracted($a): void\n"), "{found}");
    // `$this` in a static closure is refused; the whole closure is an
    // expression of the method.
    assert_eq!(
        p.method("<?php\nclass A\n{\n    private int $n = 1;\n\n    public function f()\n    {\n        $g = static function () {\n            /*|*/echo $this->n;/*|*/\n        };\n    }\n}\n"),
        None
    );
    let found = p
        .method("<?php\nclass A\n{\n    public function f(int $k)\n    {\n        $g = /*|*/fn($x) => $x + $k/*|*/;\n        return $g;\n    }\n}\n")
        .unwrap();
    assert!(found.contains("        $g = $this->extracted($k);\n"), "{found}");
}

#[test]
fn the_dialog_chooses_name_parameters_visibility_and_return_type() {
    let mut p = Project::new(PhpVersion::LATEST);
    let before = "<?php\nclass Shop\n{\n    public function total(int $a, int $b): int\n    {\n        /*|*/$c = $a * 2 + $b;/*|*/\n        return $c;\n    }\n}\n";
    let (info, after) = p.dialog(before, |c| {
        c.name = "combine".into();
        c.parameters.reverse();
        c.parameters[1].name = "first".into();
        c.parameters[0].ty = "float|int".into();
        c.visibility = "protected".into();
        c.is_static = true;
        c.return_type = String::new();
    });
    let info = info.unwrap();
    assert!(!info.function);
    assert_eq!(info.class_name, "Shop");
    assert_eq!(info.defaults.name, "extracted");
    assert_eq!(info.defaults.visibility, "private");
    assert_eq!(info.defaults.return_type, "int");
    assert_eq!(info.duplicates, 0);
    assert!(!info.static_required && !info.uses_this);
    let names: Vec<(&str, &str)> =
        info.defaults.parameters.iter().map(|p| (p.old_name.as_str(), p.ty.as_str())).collect();
    assert_eq!(names, [("a", "int"), ("b", "int")]);
    assert_eq!(
        after.unwrap(),
        "<?php\nclass Shop\n{\n    public function total(int $a, int $b): int\n    {\n        $c = self::combine($b, $a);\n        return $c;\n    }\n\n    protected static function combine(float|int $b, int $first)\n    {\n        $c = $first * 2 + $b;\n\n        return $c;\n    }\n}\n"
    );
    // An excluded parameter isn't passed.
    let (_, after) = p.dialog(before, |c| c.parameters[1].included = false);
    let after = after.unwrap();
    assert!(after.contains("$c = $this->extracted($a);"), "{after}");
    assert!(after.contains("private function extracted(int $a): int\n"), "{after}");
    // Refused choices.
    type Change = Box<dyn Fn(&mut ExtractChoice)>;
    let refused: [(&str, Change); 6] = [
        ("not a valid name", Box::new(|c| c.name = "1x".into())),
        ("already has a method named 'Total'", Box::new(|c| c.name = "Total".into())),
        ("two parameters named '$a'", Box::new(|c| c.parameters[1].name = "a".into())),
        ("already used by the extracted code", Box::new(|c| c.parameters[0].name = "c".into())),
        ("not a visibility", Box::new(|c| c.visibility = "internal".into())),
        (
            "don't match the selection",
            Box::new(|c| {
                c.parameters.pop();
            }),
        ),
    ];
    for (message, change) in refused {
        let (_, after) = p.dialog(before, |c| change(c));
        let error = after.unwrap_err();
        assert!(error.contains(message), "{message}: {error}");
    }
    // `$this` keeps it an instance method; a static method keeps it static.
    let this = "<?php\nclass A\n{\n    private int $n = 1;\n\n    public function f(): int\n    {\n        return /*|*/$this->n + 1/*|*/;\n    }\n}\n";
    let (info, after) = p.dialog(this, |c| c.is_static = true);
    assert!(info.unwrap().uses_this);
    assert!(after.unwrap_err().contains("can't be static"));
    let statics = "<?php\nclass A\n{\n    public static function f(int $n): int\n    {\n        return /*|*/$n + 1/*|*/;\n    }\n}\n";
    let (info, after) = p.dialog(statics, |c| c.is_static = false);
    let info = info.unwrap();
    assert!(info.static_required && info.defaults.is_static);
    assert!(after.unwrap_err().contains("must be static"));
    // Functions: no visibility.
    let (info, after) = p.dialog("<?php\n$a = 1;\n/*|*/echo $a;/*|*/\n", |c| c.name = "show".into());
    assert!(info.unwrap().function);
    assert_eq!(after.unwrap(), "<?php\n$a = 1;\nshow($a);\n\nfunction show(int $a): void\n{\n    echo $a;\n}\n");
    // Nothing to extract: no dialog.
    assert!(p.dialog("<?php\n$a = 1;\necho /*|*/$a/*|*/;\n", |_| {}).0.is_none());
}

#[test]
fn duplicates_of_the_extracted_code_are_found_and_replaced() {
    let mut p = Project::new(PhpVersion::LATEST);
    let class = |a: &str, b: &str, c: &str| {
        format!(
            "<?php\nclass Report\n{{\n    public function a(array $rows): int\n    {{\n{a}\n    }}\n\n    public function b(array $lines): int\n    {{\n{b}\n    }}\n\n    public static function c(array $xs): int\n    {{\n{c}\n    }}\n}}\n"
        )
    };
    // Statements: the same code with other names (and spacing); a
    // different constant isn't a copy.
    let before = class(
        "        /*|*/$total = count($rows) * 2;/*|*/\n        return $total;",
        "        $sum = count($lines)  *  2;\n        $other = count($lines) * 3;\n        return $sum + $other;",
        "        $n = count($xs) * 2;\n        return $n;",
    );
    let (info, after) = p.dialog(&before, |_| {});
    let info = info.unwrap();
    assert_eq!(info.duplicates, 2);
    assert!(info.defaults.replace_duplicates);
    // The copy in the static method needs a static method.
    assert_eq!(
        after.unwrap(),
        class(
            "        $total = $this->extracted($rows);\n        return $total;",
            "        $sum = $this->extracted($lines);\n        $other = count($lines) * 3;\n        return $sum + $other;",
            "        $n = count($xs) * 2;\n        return $n;",
        )
        .replace(
            "    public function b(",
            "    private function extracted(array $rows): int\n    {\n        $total = count($rows) * 2;\n\n        return $total;\n    }\n\n    public function b("
        )
    );
    let (_, after) = p.dialog(&before, |c| c.is_static = true);
    let after = after.unwrap();
    assert!(after.contains("$n = self::extracted($xs);"), "{after}");
    assert!(after.contains("$sum = self::extracted($lines);"), "{after}");
    // Not replaced when not asked.
    let (_, after) = p.dialog(&before, |c| c.replace_duplicates = false);
    assert!(after.unwrap().contains("$sum = count($lines)  *  2;"));
    // Expressions; two uses of one variable must stay one variable.
    let before = class(
        "        return /*|*/$rows[0] + $rows[1]/*|*/;",
        "        $k = [1];\n        return $lines[0] + $lines[1] + $k[0] + $k[2];",
        "        return $xs[0] + 1;",
    );
    let (info, after) = p.dialog(&before, |_| {});
    assert_eq!(info.unwrap().duplicates, 1);
    let after = after.unwrap();
    assert!(after.contains("return $this->extracted($lines) + $k[0] + $k[2];"), "{after}");
    // A copy whose variable is read later where the selection's isn't is
    // not replaced.
    let before = class(
        "        /*|*/$t = count($rows);\n        echo $t;/*|*/\n        return 1;",
        "        $t = count($lines);\n        echo $t;\n        return $t;",
        "        return 1;",
    );
    assert_eq!(p.dialog(&before, |_| {}).0.unwrap().duplicates, 0);
    // Functions: copies anywhere in the file.
    let (info, after) = p.dialog(
        "<?php\nfunction f(int $a): int\n{\n    return /*|*/$a * 3/*|*/;\n}\n\n$b = 2;\necho $b * 3;\n",
        |_| {},
    );
    assert_eq!(info.unwrap().duplicates, 1);
    let after = after.unwrap();
    assert!(after.contains("echo extracted($b);\n"), "{after}");
}

// ------------------------------------------------------------ inline

#[test]
fn inline_a_variable_into_every_read() {
    let mut p = Project::new(PhpVersion::LATEST);
    // A stable value goes into every read, in parentheses where needed;
    // the caret may be on the assignment or on a read.
    let before = method("        $limit/*|*/ = 10 + 5;\n        echo $limit;\n        return $limit * 2;");
    let after = method("        echo 10 + 5;\n        return (10 + 5) * 2;");
    assert_eq!(p.inline_variable(&before).as_deref(), Some(after.as_str()));
    let before = method("        $limit = 10 + 5;\n        echo $limit;\n        return /*|*/$limit * 2;");
    assert_eq!(p.inline_variable(&before).as_deref(), Some(after.as_str()));
    // Into arrow functions, and as an argument (no parentheses).
    assert_eq!(
        p.inline_variable(&method(
            "        $k = 2;\n        $items = array_map(fn ($v) => $v * $k, $items);\n        return max(/*|*/$k, 1);"
        ))
        .as_deref(),
        Some(method("        $items = array_map(fn ($v) => $v * 2, $items);\n        return max(2, 1);").as_str())
    );
    // A call goes into its one read in the next statement.
    assert_eq!(
        p.inline_variable(&method("        $count = count($items);\n        return /*|*/$count + 1;")).as_deref(),
        Some(method("        return count($items) + 1;").as_str())
    );
    assert_eq!(
        p.inline_variable(&method(
            "        $c/*|*/ = $cart->total();\n        if ($c > 1) {\n            return 1;\n        }\n        return 0;"
        ))
        .as_deref(),
        Some(method("        if ($cart->total() > 1) {\n            return 1;\n        }\n        return 0;").as_str())
    );
    // Top-level code.
    assert_eq!(
        p.inline_variable("<?php\n$a = 'x';\n$b/*|*/ = $a . 'y';\necho $b;\n").as_deref(),
        Some("<?php\n$a = 'x';\necho $a . 'y';\n")
    );
}

#[test]
fn inline_variable_is_refused_where_the_value_would_change() {
    let mut p = Project::new(PhpVersion::LATEST);
    let refused = [
        // A call read twice, later than the next statement, in a loop or a branch.
        "        $c/*|*/ = count($items);\n        echo $c;\n        return $c;",
        "        $c/*|*/ = count($items);\n        echo 1;\n        return $c;",
        "        $c/*|*/ = count($items);\n        foreach ($items as $i) {\n            echo $c;\n        }\n        return 1;",
        "        $c/*|*/ = count($items);\n        if ($items) {\n            echo $c;\n        }\n        return 1;",
        "        $c/*|*/ = count($items);\n        return $items && $c;",
        // Written again, a parameter, read before or undefined.
        "        $x/*|*/ = 1;\n        $x += 2;\n        return $x;",
        "        $x/*|*/ = 1;\n        $x++;\n        return $x;",
        "        foreach ($items as $x) {\n        }\n        $x/*|*/ = 1;\n        return $x;",
        "        return count($it/*|*/ems);",
        "        if ($cart) {\n            $x = 1;\n        }\n        return $x/*|*/;",
        // A read that must stay a variable.
        "        $x/*|*/ = 1;\n        return isset($x) ? 1 : 0;",
        "        $x/*|*/ = [];\n        $x[] = 1;\n        return 1;",
        "        $x/*|*/ = 1;\n        $f = function () use ($x) {\n            return $x;\n        };\n        return $f();",
        "        $x/*|*/ = 1;\n        return \"n $x\";",
        "        $x/*|*/ = [1];\n        sort($x);\n        return 1;",
        // What the value reads changes in between.
        "        $a = 1;\n        $b/*|*/ = $a;\n        $a = 2;\n        return $b;",
        // Variables the flow can't follow.
        "        $x/*|*/ = 1;\n        return compact('x');",
        "        $x/*|*/ = 1;\n        extract($items);\n        return $x;",
        // Not assigned by a statement of its own; never read; `$this`.
        "        return ($x/*|*/ = 1) + $x;",
        "        $x/*|*/ = 1;\n        return 0;",
        "        return $th/*|*/is;",
    ];
    for body in refused {
        let marked = method(body);
        assert_eq!(p.inline_variable(&marked), None, "{marked}");
    }
}

#[test]
fn inline_a_method_whose_body_is_one_return() {
    let mut p = Project::new(PhpVersion::LATEST);
    let class = |call: &str| {
        format!(
            "<?php\nclass Shop\n{{\n    private int $rate = 2;\n\n    public function total(array $items): int\n    {{\n        {call}\n    }}\n\n    private function double(int $n): int\n    {{\n        return $n * $this->rate;\n    }}\n}}\n"
        )
    };
    // Stable arguments are substituted.
    assert_eq!(
        p.inline_call(&class("return $this->dou/*|*/ble(3) + 1;")).as_deref(),
        Some(class("return (3 * $this->rate) + 1;").as_str())
    );
    // Others are assigned first.
    assert_eq!(
        p.inline_call(&class("return $this->/*|*/double(count($items)) + 1;")).as_deref(),
        Some(class("$n = count($items);\n        return ($n * $this->rate) + 1;").as_str())
    );
    // A static method through `self::`, and one without `$this` called on
    // another object.
    let statics = "<?php\nfinal class Money\n{\n    public static function cents(int $v): int\n    {\n        return $v * 100;\n    }\n\n    public function f(Money $m): int\n    {\n        return self::/*|*/cents(2) + $m->cents(3);\n    }\n}\n";
    assert_eq!(
        p.inline_call(statics).as_deref(),
        Some(statics.replace("self::/*|*/cents(2) + $m->cents(3)", "(2 * 100) + $m->cents(3)").as_str())
    );
    let other = statics.replace("self::/*|*/cents(2) + $m->cents(3)", "self::cents(2) + $m->ce/*|*/nts(3)");
    assert_eq!(
        p.inline_call(&other).as_deref(),
        Some(statics.replace("self::/*|*/cents(2) + $m->cents(3)", "self::cents(2) + (3 * 100)").as_str())
    );
}

#[test]
fn inline_a_function_into_a_statement() {
    let mut p = Project::new(PhpVersion::LATEST);
    let greet = "<?php\nfunction greet(string $name): string\n{\n    $message = 'Hello ' . $name;\n    $message .= '!';\n    return $message;\n}\n\n";
    // Statements before the return; a local the caller also uses is renamed.
    assert_eq!(
        p.inline_call(&format!(
            "{greet}function run(): void\n{{\n    $message = 'x';\n    $out = /*|*/greet('Ann');\n    echo $message, $out;\n}}\n"
        ))
        .as_deref(),
        Some(
            format!(
                "{greet}function run(): void\n{{\n    $message = 'x';\n    $message1 = 'Hello ' . 'Ann';\n    $message1 .= '!';\n    $out = $message1;\n    echo $message, $out;\n}}\n"
            )
            .as_str()
        )
    );
    assert_eq!(
        p.inline_call(&format!("{greet}function run(string $who): string\n{{\n    return gr/*|*/eet($who);\n}}\n"))
            .as_deref(),
        Some(
            format!(
                "{greet}function run(string $who): string\n{{\n    $message = 'Hello ' . $who;\n    $message .= '!';\n    return $message;\n}}\n"
            )
            .as_str()
        )
    );
    // A body without a value, as a statement; a last bare `return;` goes.
    let log = "<?php\nfunction log_it(string $m): void\n{\n    if ($m === '') {\n        echo '-';\n    }\n    echo $m, PHP_EOL;\n    return;\n}\n\n";
    assert_eq!(
        p.inline_call(&format!("{log}function run($x): void\n{{\n    /*|*/log_it($x);\n    echo 1;\n}}\n")).as_deref(),
        Some(
            format!(
                "{log}function run($x): void\n{{\n    if ($x === '') {{\n        echo '-';\n    }}\n    echo $x, PHP_EOL;\n    echo 1;\n}}\n"
            )
            .as_str()
        )
    );
    // Defaults and named arguments; an unused argument still runs.
    let scale = "<?php\nfunction scale(int $v, int $by = 2, $unused = null): int\n{\n    return $v * $by;\n}\n";
    assert_eq!(
        p.inline_call(&format!("{scale}$r = /*|*/scale(by: 3, v: 5);\n")).as_deref(),
        Some(format!("{scale}$r = 5 * 3;\n").as_str())
    );
    assert_eq!(
        p.inline_call(&format!("{scale}$s = /*|*/scale(4);\n")).as_deref(),
        Some(format!("{scale}$s = 4 * 2;\n").as_str())
    );
    assert_eq!(
        p.inline_call(&format!("{scale}$t = /*|*/scale(4, 1, print('x'));\n")).as_deref(),
        Some(format!("{scale}print('x');\n$t = 4 * 1;\n").as_str())
    );
    // A call statement whose value isn't needed.
    assert_eq!(
        p.inline_call(&format!("{scale}/*|*/scale(1);\necho 2;\n")).as_deref(),
        Some(format!("{scale}echo 2;\n").as_str())
    );
}

#[test]
fn inlined_names_are_qualified_for_another_namespace() {
    let util = "<?php\nnamespace App\\Util;\n\nuse App\\Model\\Item;\n\nfunction make(int $n): Item\n{\n    return new Item(strlen('a') + $n);\n}\n";
    let item = "<?php\nnamespace App\\Model;\n\nclass Item\n{\n    public function __construct(public int $n) {}\n}\n";
    let mut p = Project::with_files(PhpVersion::LATEST, &[("Util.php", util), ("Item.php", item)]);
    assert_eq!(
        p.inline_call("<?php\nnamespace App;\n\n$x = Util\\/*|*/make(1);\n").as_deref(),
        Some("<?php\nnamespace App;\n\n$x = new \\App\\Model\\Item(\\strlen('a') + 1);\n")
    );
}

#[test]
fn inline_inside_closures() {
    let mut p = Project::new(PhpVersion::LATEST);
    // A closure's own variable.
    assert_eq!(
        p.inline_variable("<?php\n$f = function (int $a) {\n    $b/*|*/ = $a + 1;\n    return $b * 2;\n};\n")
            .as_deref(),
        Some("<?php\n$f = function (int $a) {\n    return ($a + 1) * 2;\n};\n")
    );
    assert_eq!(
        p.inline_variable(&method(
            "        return array_map(function ($i) {\n            $k = 3;\n            return $i * /*|*/$k;\n        }, $items);"
        ))
        .as_deref(),
        Some(method("        return array_map(function ($i) {\n            return $i * 3;\n        }, $items);").as_str())
    );
    // Parameters and captures stay.
    assert_eq!(p.inline_variable("<?php\n$f = function (int $a) {\n    return $a/*|*/ + 1;\n};\n"), None);
    assert_eq!(
        p.inline_variable("<?php\n$c = 1;\n$f = function () use ($c) {\n    $c = 2;\n    return $c/*|*/;\n};\n"),
        None
    );
    // A call inside a closure.
    let greet = "<?php\nfunction greet(string $name): string\n{\n    return 'Hello ' . $name;\n}\n\n";
    assert_eq!(
        p.inline_call(&format!("{greet}$f = function (string $who) {{\n    echo gr/*|*/eet($who);\n}};\n")).as_deref(),
        Some(format!("{greet}$f = function (string $who) {{\n    echo 'Hello ' . $who;\n}};\n").as_str())
    );
}

#[test]
fn inline_all_calls_and_remove_the_declaration() {
    let util = "<?php\nnamespace App;\n\n/**\n * Twice.\n */\nfunction twice(int $n): int\n{\n    return $n * 2;\n}\n\necho twice(1);\n";
    let mut p = Project::with_files(
        PhpVersion::LATEST,
        &[("util.php", util), ("Other.php", "<?php\nnamespace App;\n\n$x = twice(5) + 1;\n")],
    );
    // From a call or the declaration: every call, in every file, and the
    // function with its doc comment.
    let marked = "<?php\nnamespace App;\n\n$y = twi/*|*/ce(3);\n";
    let (text, range) = selection(marked);
    let doc = DocId(100);
    p.engine.document_opened(doc, &p.root.join("src/a.php"), 1, &text);
    let actions = p.engine.code_actions(doc, range, &[INLINE_FUNCTION_ALL.to_owned()]).unwrap();
    p.engine.document_closed(doc);
    let [action] = actions.as_slice() else { panic!("{actions:?}") };
    assert_eq!(action.title, "Inline all calls of 'twice' and remove the function");
    let mut changed: Vec<(String, String)> = action
        .edit
        .files
        .iter()
        .map(|file| {
            let FileEdit::Edit { path, edits, .. } = file else { panic!("{file:?}") };
            let path: PathBuf = path.to_path_buf();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let before = if name == "a.php" { text.clone() } else { std::fs::read_to_string(&path).unwrap() };
            let mut document = ide_text::Document::new(&before);
            document.apply_edits(edits).unwrap();
            (name, document.text().to_string())
        })
        .collect();
    changed.sort();
    assert_eq!(
        changed,
        [
            ("Other.php".to_owned(), "<?php\nnamespace App;\n\n$x = (5 * 2) + 1;\n".to_owned()),
            ("a.php".to_owned(), "<?php\nnamespace App;\n\n$y = 3 * 2;\n".to_owned()),
            ("util.php".to_owned(), "<?php\nnamespace App;\n\necho 1 * 2;\n".to_owned()),
        ]
    );
    // Methods: from the declaration's name.
    let class = "<?php\nclass Shop\n{\n    public function total(int $a): int\n    {\n        return $this->double($a) + $this->double(1);\n    }\n\n    private function dou/*|*/ble(int $n): int\n    {\n        return $n * 2;\n    }\n}\n";
    let found = p.actions(class, INLINE_METHOD_ALL);
    let [(title, after)] = found.as_slice() else { panic!("{found:?}") };
    assert_eq!(title, "Inline all calls of 'double' and remove the method");
    assert_eq!(
        after,
        "<?php\nclass Shop\n{\n    public function total(int $a): int\n    {\n        return ($a * 2) + (1 * 2);\n    }\n}\n"
    );
    // Refused: a call that can't be inlined, a callable string, an
    // overriding method, no calls.
    let refused = [
        "<?php\nfunction f($n)\n{\n    if ($n) {\n        return 1;\n    }\n    return 2;\n}\n$a = /*|*/f(1);\n",
        "<?php\nfunction g($n)\n{\n    return $n;\n}\n$a = /*|*/g(1);\n$b = array_map('g', [1]);\n",
        "<?php\nclass A\n{\n    public function v()\n    {\n        return 1;\n    }\n}\n\nfinal class B extends A\n{\n    public function v()\n    {\n        return 2;\n    }\n\n    public function w()\n    {\n        return $this->/*|*/v();\n    }\n}\n",
        "<?php\nfunction unused/*|*/_one($n)\n{\n    return $n;\n}\n",
    ];
    for marked in refused {
        assert!(p.actions(marked, INLINE_FUNCTION_ALL).is_empty(), "{marked}");
        assert!(p.actions(marked, INLINE_METHOD_ALL).is_empty(), "{marked}");
    }
}

#[test]
fn inline_call_is_refused_where_behaviour_would_change() {
    let mut p = Project::new(PhpVersion::LATEST);
    let refused = [
        // Recursion, early returns, generators, static variables, func_get_args().
        "<?php\nfunction f($n)\n{\n    return f($n - 1);\n}\necho /*|*/f(1);\n",
        "<?php\nfunction f($n)\n{\n    if ($n) {\n        return 1;\n    }\n    return 2;\n}\n$a = /*|*/f(1);\n",
        "<?php\nfunction f()\n{\n    yield 1;\n}\n$a = /*|*/f();\n",
        "<?php\nfunction f()\n{\n    static $n = 0;\n    return ++$n;\n}\n$a = /*|*/f();\n",
        "<?php\nfunction f()\n{\n    return func_get_args();\n}\n$a = /*|*/f(1);\n",
        // Statements before the value, or no value, where an expression is needed.
        "<?php\nfunction f($n)\n{\n    $m = $n + 1;\n    return $m;\n}\necho /*|*/f(1);\n",
        "<?php\nfunction f($n)\n{\n    echo $n;\n}\n$a = /*|*/f(1);\n",
        // By-reference and variadic parameters, spread, extra and missing arguments.
        "<?php\nfunction f(&$n)\n{\n    return $n;\n}\n$a = /*|*/f($b);\n",
        "<?php\nfunction f(...$n)\n{\n    return $n;\n}\n$a = /*|*/f(1, 2);\n",
        "<?php\nfunction f($n)\n{\n    return $n;\n}\n$a = /*|*/f(...[1]);\n",
        "<?php\nfunction f($n)\n{\n    return $n;\n}\n$a = /*|*/f(1, 2);\n",
        "<?php\nfunction f($n)\n{\n    return $n;\n}\n$a = /*|*/f();\n",
        // Stubs.
        "<?php\n$a = /*|*/strlen('x');\n",
        // Overridden methods, `$this` from outside, receivers that run code,
        // nullsafe calls, interface methods.
        "<?php\nclass A\n{\n    public function v()\n    {\n        return 1;\n    }\n\n    public function w()\n    {\n        return $this->/*|*/v();\n    }\n}\n\nclass B extends A\n{\n    public function v()\n    {\n        return 2;\n    }\n}\n",
        "<?php\nclass A\n{\n    private $r = 1;\n\n    public function v()\n    {\n        return $this->r;\n    }\n}\n\nclass C\n{\n    public function w(A $a)\n    {\n        return $a->/*|*/v();\n    }\n}\n",
        "<?php\nfinal class A\n{\n    public function v()\n    {\n        return 1;\n    }\n\n    public function me(): A\n    {\n        return $this;\n    }\n\n    public function w()\n    {\n        return $this->me()->/*|*/v();\n    }\n}\n",
        "<?php\nfinal class A\n{\n    public function v()\n    {\n        return 1;\n    }\n\n    public function w(?A $a)\n    {\n        return $a?->/*|*/v();\n    }\n}\n",
        "<?php\ninterface I\n{\n    public function v();\n}\n\nfunction g(I $i)\n{\n    return $i->/*|*/v();\n}\n",
    ];
    for marked in refused {
        assert_eq!(p.inline_call(marked), None, "{marked}");
    }
}

/// `compact('a')` reads `$a`: a variable it names after the selection is a
/// result; one it names inside the selection, or names it can't tell,
/// refuse the extraction.
#[test]
fn variables_compact_reads_after_the_selection_are_results() {
    let mut p = Project::new(PhpVersion::LATEST);
    let before = "<?php\nfunction show(object $post): array\n{\n    /*|*/$title = $post->title;\n    $year = 2024;/*|*/\n\n    return compact('post', 'title', ['year']);\n}\n";
    let after = "<?php\nfunction show(object $post): array\n{\n    [$title, $year] = extracted($post);\n\n    return compact('post', 'title', ['year']);\n}\n\nfunction extracted(object $post): array\n{\n    $title = $post->title;\n    $year = 2024;\n\n    return [$title, $year];\n}\n";
    assert_eq!(p.method(before).as_deref(), Some(after));
    for refused in [
        "<?php\nfunction show($post)\n{\n    /*|*/$title = $post->title;/*|*/\n    return compact($names);\n}\n",
        "<?php\nfunction show($post)\n{\n    $title = $post->title;\n    /*|*/return compact('title');/*|*/\n}\n",
    ] {
        assert_eq!(p.method(refused), None, "{refused}");
    }
}
