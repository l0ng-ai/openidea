//! Change signature: the signature offered, and the text of every file
//! before and after.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ide_core::{CancellationToken, DocId, FileEdit, IdeEvent, Pos, Range, SharedSink};

use super::signature::{CHANGE_SIGNATURE, ChangeSignature, Signature, SignatureParameter};
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
    /// The files as written, by name under `src/`.
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
fn fixture(version: PhpVersion, files: &[(&str, &str)]) -> Fixture {
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
        stubs: StubFilter::all_extensions(version),
    };
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(WAIT));
    let doc = DocId(1);
    engine.document_opened(doc, &root.join("src").join(&open), 1, &written[&open]);
    Fixture { _tmp: tmp, root, engine, doc, caret, files: written }
}

impl Fixture {
    fn info(&self) -> Option<ChangeSignature> {
        self.engine.change_signature_info(self.doc, Range::new(self.caret, self.caret))
    }

    fn signature(&self) -> Signature {
        self.info().expect("Change signature is offered").signature
    }

    /// The files the change edits, with their new text.
    fn change(&self, edit: impl FnOnce(&mut Signature)) -> Result<BTreeMap<String, String>, String> {
        let mut signature = self.signature();
        edit(&mut signature);
        let result = self.engine.change_signature(self.doc, self.caret, &signature, &CancellationToken::new());
        let edit = result.expect("open").map_err(|e| e.message)?;
        let mut out = BTreeMap::new();
        for file in &edit.files {
            let FileEdit::Edit { path, edits, .. } = file else { panic!("only text edits: {file:?}") };
            let name = path.strip_prefix(self.root.join("src")).unwrap().to_string_lossy().replace('\\', "/");
            let mut document = ide_text::Document::new(&self.files[&name]);
            document.apply_edits(edits).unwrap();
            out.insert(name, document.text().to_string());
        }
        Ok(out)
    }

    fn refused(&self, edit: impl FnOnce(&mut Signature)) -> String {
        self.change(edit).expect_err("refused")
    }
}

fn added(name: &str, ty: &str, default: &str, call: &str) -> SignatureParameter {
    SignatureParameter {
        old_index: None,
        name: name.into(),
        ty: ty.into(),
        default_value: default.into(),
        call_value: call.into(),
        ..SignatureParameter::default()
    }
}

fn names(signature: &Signature) -> Vec<&str> {
    signature.parameters.iter().map(|p| p.name.as_str()).collect()
}

#[test]
fn the_action_carries_the_current_signature() {
    let util = "<?php\nnamespace App;\n\nfunction repeat(int $count, string $label = 'x', &...$rest): string\n{\n    return str_repeat($label, $count);\n}\n";
    let main = "<?php\nnamespace App;\n\necho re/*|*/peat(3, 'a');\necho strlen('a');\n";
    let f = fixture(PhpVersion::LATEST, &[("util.php", util), ("main.php", main)]);
    let signature = f.signature();
    assert_eq!(signature.name, "App\\repeat");
    assert_eq!(signature.return_type, "string");
    assert!(!signature.constructor);
    assert_eq!(names(&signature), ["count", "label", "rest"]);
    let label = &signature.parameters[1];
    assert_eq!((label.old_index, label.ty.as_str(), label.default_value.as_str()), (Some(1), "string", "'x'"));
    let rest = &signature.parameters[2];
    assert!(rest.by_ref && rest.variadic && rest.ty.is_empty());

    // The `data` the editor gets back and fills in.
    let json = serde_json::to_value(f.info().unwrap()).unwrap();
    assert_eq!(json["signature"]["parameters"][1]["defaultValue"], "'x'");
    assert_eq!(json["signature"]["parameters"][1]["type"], "string");
    assert_eq!(json["signature"]["parameters"][0]["oldIndex"], 0);
    assert!(json["change"].is_null());
    let back: ChangeSignature = serde_json::from_value(serde_json::json!({
        "position": { "line": 0, "col": 0 },
        "signature": { "name": "f", "parameters": [{ "name": "a", "oldIndex": null }] },
    }))
    .unwrap();
    assert_eq!(back.signature.parameters[0].old_index, None);

    // Built-in functions can't be changed.
    let main = "<?php\necho str/*|*/len('a');\n";
    assert!(fixture(PhpVersion::LATEST, &[("main.php", main)]).info().is_none());
}

#[test]
fn the_action_is_offered_on_the_declaration_and_its_header() {
    let marked = |at: &str| {
        let text = "<?php\nclass Book\n{\n    public function price(int $qty): int\n    {\n        return $qty * 2;\n    }\n\n    public function __toString(): string\n    {\n        return '';\n    }\n}\n";
        text.replacen(at, &format!("{CARET}{at}"), 1)
    };
    for (at, offered) in
        [("price(", true), ("int $qty", true), ("$qty)", true), ("return $qty", false), ("__toString", false)]
    {
        let text = marked(at);
        let f = fixture(PhpVersion::LATEST, &[("Book.php", &text)]);
        assert_eq!(f.info().is_some(), offered, "{at}");
        if offered {
            assert_eq!(f.signature().name, "Book::price");
        }
    }
}

#[test]
fn reorder_rename_add_and_named_arguments_of_a_function() {
    let util = "<?php\nnamespace App;\n\n/**\n * @param int $count how many\n * @param string $label the label\n */\nfunction /*|*/repeat(int $count, string $label = 'x'): string\n{\n    return str_repeat($label, $count);\n}\n";
    let main =
        "<?php\nnamespace App;\n\necho repeat(3, 'a');\necho repeat(2);\necho \\App\\repeat(label: 'b', count: 1);\n";
    let f = fixture(PhpVersion::LATEST, &[("util.php", util), ("main.php", main)]);
    let changed = f
        .change(|s| {
            let count = s.parameters.remove(0);
            s.parameters.push(SignatureParameter { name: "times".into(), ..count });
            s.parameters.push(added("upper", "bool", "", "false"));
        })
        .unwrap();
    assert_eq!(
        changed["util.php"],
        "<?php\nnamespace App;\n\n/**\n * @param int $times how many\n * @param string $label the label\n */\nfunction repeat(string $label = 'x', int $times, bool $upper): string\n{\n    return str_repeat($label, $times);\n}\n"
    );
    assert_eq!(
        changed["main.php"],
        "<?php\nnamespace App;\n\necho repeat('a', 3, false);\necho repeat(times: 2, upper: false);\necho \\App\\repeat(label: 'b', times: 1, upper: false);\n"
    );
}

#[test]
fn missing_arguments_are_named_from_php_8_and_defaults_before() {
    let text = "<?php\nfunction /*|*/wrap($text, $before = '<', $after = '>')\n{\n    return $text;\n}\necho wrap('a');\necho wrap('a', '[');\necho wrap('a', '[', ']');\n";
    let reorder = |s: &mut Signature| {
        let after = s.parameters.pop().unwrap();
        s.parameters.insert(0, after);
    };
    let decl = "function wrap($after = '>', $text, $before = '<')";
    let f = fixture(PhpVersion::new(7, 4), &[("a.php", text)]);
    let changed = f.change(reorder).unwrap();
    assert!(changed["a.php"].contains(decl), "{}", changed["a.php"]);
    assert!(
        changed["a.php"].ends_with("echo wrap('>', 'a');\necho wrap('>', 'a', '[');\necho wrap(']', 'a', '[');\n"),
        "{}",
        changed["a.php"]
    );
    let f = fixture(PhpVersion::LATEST, &[("a.php", text)]);
    let changed = f.change(reorder).unwrap();
    assert!(
        changed["a.php"]
            .ends_with("echo wrap(text: 'a');\necho wrap(text: 'a', before: '[');\necho wrap(']', 'a', '[');\n"),
        "{}",
        changed["a.php"]
    );

    // Removing a parameter drops its argument.
    let f = fixture(PhpVersion::new(7, 4), &[("a.php", text)]);
    let changed = f.change(|s| drop(s.parameters.remove(1))).unwrap();
    assert!(
        changed["a.php"].ends_with(
            "function wrap($text, $after = '>')\n{\n    return $text;\n}\necho wrap('a');\necho wrap('a');\necho wrap('a', ']');\n"
        ),
        "{}",
        changed["a.php"]
    );
}

#[test]
fn the_whole_hierarchy_and_calls_through_it_change() {
    let shape = "<?php\nnamespace App;\n\ninterface Shape\n{\n    public function scale(float $factor, bool $round = false): float;\n}\n";
    let circle = "<?php\nnamespace App;\n\nclass Circle implements Shape\n{\n    /**\n     * @param float $factor\n     * @param bool $round\n     */\n    public function scale(float $factor, bool $round = false): float\n    {\n        $f = fn () => $factor * 2;\n        return $f();\n    }\n}\n";
    let big = "<?php\nnamespace App;\n\nclass Big extends Circle\n{\n    public function scale(float $factor, bool $round = false, int $extra = 0): float\n    {\n        return parent::scale($factor, $round) + $extra;\n    }\n}\n";
    let main = "<?php\nnamespace App;\n\nfunction run(Shape $s, Big $b): float\n{\n    return $s->/*|*/scale(2.0, true) + $b->scale(3.0);\n}\n";
    let f = fixture(
        PhpVersion::LATEST,
        &[("Shape.php", shape), ("Circle.php", circle), ("Big.php", big), ("main.php", main)],
    );
    assert_eq!(f.signature().name, "Shape::scale");
    let changed = f
        .change(|s| {
            s.parameters[0].name = "by".into();
            s.parameters.remove(1);
            s.return_type = "float|int".into();
        })
        .unwrap();
    assert_eq!(
        changed["Shape.php"],
        "<?php\nnamespace App;\n\ninterface Shape\n{\n    public function scale(float $by): float|int;\n}\n"
    );
    assert_eq!(
        changed["Circle.php"],
        "<?php\nnamespace App;\n\nclass Circle implements Shape\n{\n    /**\n     * @param float $by\n     */\n    public function scale(float $by): float|int\n    {\n        $f = fn () => $by * 2;\n        return $f();\n    }\n}\n"
    );
    assert_eq!(
        changed["Big.php"],
        "<?php\nnamespace App;\n\nclass Big extends Circle\n{\n    public function scale(float $by, int $extra = 0): float|int\n    {\n        return parent::scale($by) + $extra;\n    }\n}\n"
    );
    assert_eq!(
        changed["main.php"],
        "<?php\nnamespace App;\n\nfunction run(Shape $s, Big $b): float\n{\n    return $s->scale(2.0) + $b->scale(3.0);\n}\n"
    );
}

#[test]
fn an_override_with_its_own_type_keeps_it() {
    let base = "<?php\nclass Base\n{\n    public function /*|*/take(int $n): ?int\n    {\n        return $n;\n    }\n}\nclass Wide extends Base\n{\n    public function take(int|string $n): int\n    {\n        return 1;\n    }\n}\n";
    let f = fixture(PhpVersion::LATEST, &[("a.php", base)]);
    let changed = f
        .change(|s| {
            s.parameters[0].ty = "float".into();
            s.return_type = "mixed".into();
        })
        .unwrap();
    assert_eq!(
        changed["a.php"],
        "<?php\nclass Base\n{\n    public function take(float $n): mixed\n    {\n        return $n;\n    }\n}\nclass Wide extends Base\n{\n    public function take(int|string $n): int\n    {\n        return 1;\n    }\n}\n"
    );
}

#[test]
fn constructors_change_with_new_and_parent_calls() {
    let point = "<?php\nnamespace App;\n\nclass Point\n{\n    public function __con/*|*/struct(public readonly int $x, int $y = 0)\n    {\n    }\n}\n\nclass Point3 extends Point\n{\n}\n\nclass Labeled extends Point\n{\n    public function __construct(string $label)\n    {\n        parent::__construct(1, 2);\n    }\n}\n";
    let main = "<?php\nnamespace App;\n\n$a = new Point(1, 2);\n$b = new Point3(3);\n$c = new Labeled('l');\n$d = new Point;\n";
    let f = fixture(PhpVersion::LATEST, &[("Point.php", point), ("main.php", main)]);
    let signature = f.signature();
    assert!(signature.constructor && signature.parameters[0].promoted);
    assert_eq!(signature.name, "Point::__construct");
    let changed = f
        .change(|s| {
            s.parameters.swap(0, 1);
            s.parameters.push(added("z", "int", "0", ""));
        })
        .unwrap();
    assert!(
        changed["Point.php"].contains("public function __construct(int $y = 0, public readonly int $x, int $z = 0)"),
        "{}",
        changed["Point.php"]
    );
    assert!(changed["Point.php"].contains("parent::__construct(2, 1);"), "{}", changed["Point.php"]);
    assert_eq!(
        changed["main.php"],
        "<?php\nnamespace App;\n\n$a = new Point(2, 1);\n$b = new Point3(x: 3);\n$c = new Labeled('l');\n$d = new Point;\n"
    );

    // `new C` gets parentheses when it needs arguments now.
    let changed = f.change(|s| s.parameters.insert(0, added("w", "int", "", "7"))).unwrap();
    assert!(changed["main.php"].contains("$d = new Point(7);"), "{}", changed["main.php"]);

    // Promoted parameters are properties.
    assert!(f.refused(|s| s.parameters[0].name = "left".into()).contains("promoted"));
    assert!(f.refused(|s| drop(s.parameters.remove(0))).contains("promoted"));
    assert!(f.refused(|s| s.return_type = "void".into()).contains("constructor"));
}

#[test]
fn variadic_parameters_and_lists_on_several_lines() {
    let text = "<?php\nfunction /*|*/log_all(\n    string $level,\n    string ...$messages,\n) {\n    return count($messages);\n}\nlog_all('info', 'a', 'b');\nlog_all(\n    'warn',\n    'c',\n);\n";
    let f = fixture(PhpVersion::LATEST, &[("a.php", text)]);
    let changed = f.change(|s| s.parameters.insert(1, added("code", "int", "", "0"))).unwrap();
    assert_eq!(
        changed["a.php"],
        "<?php\nfunction log_all(\n    string $level,\n    int $code,\n    string ...$messages,\n) {\n    return count($messages);\n}\nlog_all('info', 0, 'a', 'b');\nlog_all(\n    'warn',\n    0,\n    'c',\n);\n"
    );
    // A variadic parameter stays last.
    assert!(f.refused(|s| s.parameters.swap(0, 1)).contains("last"));
}

#[test]
fn recursive_calls_and_renames_in_the_body_combine() {
    let text = "<?php\nfunction /*|*/countdown(int $n): int\n{\n    return $n > 0 ? countdown($n - 1) : 0;\n}\n";
    let f = fixture(PhpVersion::LATEST, &[("a.php", text)]);
    let changed = f
        .change(|s| {
            s.parameters[0].name = "$from".into();
            s.parameters.push(added("step", "int", "1", "1"));
        })
        .unwrap();
    assert_eq!(
        changed["a.php"],
        "<?php\nfunction countdown(int $from, int $step = 1): int\n{\n    return $from > 0 ? countdown($from - 1, 1) : 0;\n}\n"
    );
    // Swapping two names.
    let text = "<?php\nfunction /*|*/pair($a, $b)\n{\n    return [$a, $b];\n}\npair(1, 2);\n";
    let f = fixture(PhpVersion::LATEST, &[("a.php", text)]);
    let changed = f
        .change(|s| {
            s.parameters[0].name = "b".into();
            s.parameters[1].name = "a".into();
        })
        .unwrap();
    assert_eq!(changed["a.php"], "<?php\nfunction pair($b, $a)\n{\n    return [$b, $a];\n}\npair(1, 2);\n");
}

/// A change made to the offered signature.
type Edit = dyn FnOnce(&mut Signature);

#[test]
fn changes_that_would_break_the_code_are_refused() {
    let text =
        "<?php\nfunction /*|*/sum(int $a, int $b = 0)\n{\n    $total = $a + $b;\n    return $total;\n}\nsum(1, 2);\n";
    let f = fixture(PhpVersion::LATEST, &[("a.php", text)]);
    let cases: Vec<(Box<Edit>, &str)> = vec![
        (Box::new(|s| s.parameters[0].name = "9a".into()), "not a valid parameter name"),
        (Box::new(|s| s.parameters[0].name = "this".into()), "$this"),
        (Box::new(|s| s.parameters[1].name = "a".into()), "two parameters"),
        (Box::new(|s| s.parameters[0].variadic = true), "last"),
        (Box::new(|s| s.parameters.push(added("c", "int", "", ""))), "needs a default value"),
        (Box::new(|s| s.parameters.push(added("c", "int", "1 +", ""))), "not a valid expression"),
        (Box::new(|s| s.parameters[0].ty = "int;".into()), "not a valid type"),
        (Box::new(|s| s.parameters[0].name = "total".into()), "already used"),
        (Box::new(|s| s.parameters.push(added("total", "int", "0", ""))), "already used"),
        (Box::new(|s| s.parameters[1].old_index = Some(0)), "listed twice"),
    ];
    for (edit, message) in cases {
        let refused = f.refused(edit);
        assert!(refused.contains(message), "{refused} / {message}");
    }
    // Unchanged: no edits.
    assert!(f.change(|_| {}).unwrap().is_empty());

    // Unpacked arguments can't be mapped.
    let text = "<?php\nfunction /*|*/sum(int $a, int $b = 0)\n{\n    return $a + $b;\n}\nsum(...[1, 2]);\n";
    let f = fixture(PhpVersion::LATEST, &[("a.php", text)]);
    let refused = f.refused(|s| s.parameters.swap(0, 1));
    assert!(refused.contains("line 6") && refused.contains("unpacks"), "{refused}");
}

#[test]
fn the_kind_is_advertised() {
    assert!(crate::imports::ACTION_KINDS.contains(&CHANGE_SIGNATURE));
}
