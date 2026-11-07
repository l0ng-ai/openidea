use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ide_core::{IdeEvent, Pos, SharedSink};

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;

const WAIT: Duration = Duration::from_secs(60);
const LATEST: PhpVersion = PhpVersion::LATEST;

fn apply(text: &str, edit: Option<ByteEdit>) -> String {
    let mut out = text.to_owned();
    if let Some(edit) = edit {
        out.replace_range(edit.start as usize..edit.end as usize, &edit.text);
    }
    out
}

/// `text` formatted as a whole with `options`.
fn formatted(text: &str, options: &FormatOptions) -> String {
    apply(text, format_text(text, None, LATEST, options))
}

/// `text` with the statement or member around `selection` (its first
/// occurrence) formatted.
fn formatted_range(text: &str, selection: &str) -> String {
    let at = text.find(selection).expect("the selection is in the text") as u32;
    let edit = format_text(text, Some((at, at + selection.len() as u32)), LATEST, &FormatOptions::default());
    apply(text, edit)
}

#[test]
fn documents_get_psr12_layout() {
    let source = "<?php\nnamespace App;\nuse App\\Model\\Book;\nclass Library{\npublic function f(Book $a,$b){if($a){return [1,2];}\n$shown=[1,2];\n$total=($b+1)*2;\n}\n}\n";
    let expected = "<?php\n\nnamespace App;\n\nuse App\\Model\\Book;\n\nclass Library\n{\n    public function f(Book $a, $b)\n    {\n        if ($a) {\n            return [1, 2];\n        }\n        $shown = [1, 2];\n        $total = ($b + 1) * 2;\n    }\n}\n";
    assert_eq!(formatted(source, &FormatOptions::default()), expected);
    // Formatting is stable, and formatted text gets no edit.
    assert_eq!(format_text(expected, None, LATEST, &FormatOptions::default()), None);
}

#[test]
fn indentation_and_line_length_come_from_the_options() {
    let source = "<?php\nfunction f(){\nreturn some_function_name($argument_one, $argument_two, $argument_three);\n}\n";
    let call = "some_function_name($argument_one, $argument_two, $argument_three);";
    assert_eq!(
        formatted(source, &FormatOptions::default()),
        format!("<?php\n\nfunction f()\n{{\n    return {call}\n}}\n")
    );
    assert_eq!(
        formatted(source, &FormatOptions { use_tabs: true, ..FormatOptions::default() }),
        format!("<?php\n\nfunction f()\n{{\n\treturn {call}\n}}\n")
    );
    assert_eq!(
        formatted(source, &FormatOptions { indent: 2, use_tabs: false, line_width: 40 }),
        "<?php\n\nfunction f()\n{\n  return some_function_name(\n    $argument_one,\n    $argument_two,\n    $argument_three\n  );\n}\n"
    );
}

#[test]
fn the_language_level_decides_new_without_parentheses() {
    let source = "<?php\n$x = (new Foo())->bar();\n";
    let at = |major, minor| {
        apply(source, format_text(source, None, PhpVersion::new(major, minor), &FormatOptions::default()))
    };
    assert_eq!(at(8, 1), "<?php\n\n$x = (new Foo())->bar();\n");
    assert_eq!(at(8, 4), "<?php\n\n$x = new Foo()->bar();\n");
}

#[test]
fn ranges_format_the_statement_or_member_around_them() {
    let source = "<?php\n$a=1;\n$b=[1,2];\n$c=3;\n";
    assert_eq!(formatted_range(source, "1,2"), "<?php\n$a=1;\n$b = [1, 2];\n$c=3;\n");
    // An empty range is the statement at the caret.
    let at = source.find("$c").unwrap() as u32;
    let edit = format_text(source, Some((at, at)), LATEST, &FormatOptions::default());
    assert_eq!(apply(source, edit), "<?php\n$a=1;\n$b=[1,2];\n$c = 3;\n");
    // Inside a method: the innermost statement; on its signature: that member only.
    let class = "<?php\nclass A\n{\n    function one(){return  1;}\n    function two(){return  2;}\n}\n";
    assert_eq!(
        formatted_range(class, "return  2"),
        "<?php\nclass A\n{\n    function one(){return  1;}\n    function two(){return 2;}\n}\n"
    );
    assert_eq!(
        formatted_range(class, "function two"),
        "<?php\nclass A\n{\n    function one(){return  1;}\n    function two()\n    {\n        return 2;\n    }\n}\n"
    );
    // Reversed ranges are accepted; whitespace-only and formatted ranges change nothing.
    let (from, to) = (source.find("1,2").unwrap() as u32, source.find("1,2").unwrap() as u32 + 3);
    assert_eq!(
        apply(source, format_text(source, Some((to, from)), LATEST, &FormatOptions::default())),
        "<?php\n$a=1;\n$b = [1, 2];\n$c=3;\n"
    );
    let blank = "<?php\n$a = 1;\n\n\n$b = 2;\n";
    let gap = blank.find("\n\n\n").unwrap() as u32 + 1;
    assert_eq!(format_text(blank, Some((gap, gap + 1)), LATEST, &FormatOptions::default()), None);
    assert_eq!(formatted_range(blank, "$b = 2"), blank);
}

#[test]
fn syntax_errors_get_no_edits() {
    for source in ["<?php\n$x = ;\n", "<?php\nclass A {\n", "<?php\n$x=1;\n$y = ;\n"] {
        assert_eq!(format_text(source, None, LATEST, &FormatOptions::default()), None, "{source:?}");
    }
    let broken = "<?php\n$x=1;\n$y = ;\n";
    let at = broken.find("$x").unwrap() as u32;
    assert_eq!(format_text(broken, Some((at, at + 2)), LATEST, &FormatOptions::default()), None);
}

#[test]
fn edits_are_minimal_and_on_character_boundaries() {
    // Only the part that differs is replaced.
    let edit = minimal_edit("abcXdef", 0, 7, "abcYYdef").unwrap();
    assert_eq!(edit, ByteEdit { start: 3, end: 4, text: "YY".into() });
    assert_eq!(minimal_edit("same", 0, 4, "same"), None);
    // `é` (C3 A9) and `è` (C3 A8) share their first byte: the edit starts at the character.
    let edit = minimal_edit("aé", 0, 3, "aè").unwrap();
    assert_eq!(edit, ByteEdit { start: 1, end: 3, text: "è".into() });
    // `é` and `ʩ` (CA A9) share their last byte: the edit ends after the character.
    let edit = minimal_edit("éz", 0, 3, "ʩz").unwrap();
    assert_eq!(edit, ByteEdit { start: 0, end: 2, text: "ʩ".into() });
    // Insertions and deletions.
    assert_eq!(minimal_edit("ab", 0, 2, "a b").unwrap(), ByteEdit { start: 1, end: 1, text: " ".into() });
    assert_eq!(minimal_edit("a  b", 0, 4, "a b").unwrap(), ByteEdit { start: 2, end: 3, text: String::new() });
    // Within a slice of the text, offsets stay those of the whole text.
    assert_eq!(minimal_edit("xx[a  b]", 3, 7, "a b").unwrap(), ByteEdit { start: 5, end: 6, text: String::new() });
}

#[test]
fn edits_use_utf16_positions() {
    let text = "<?php\n$y=['🎉'=>  'é'];\n";
    let lines = LineIndex::new(text);
    let edits = format_edits(text, &lines, None, LATEST, &FormatOptions::default());
    let mut document = text.to_owned();
    for edit in edits.iter().rev() {
        let (start, end) = lines.byte_range(edit.range);
        document.replace_range(start as usize..end as usize, &edit.new_text);
    }
    assert_eq!(document, "<?php\n\n$y = ['🎉' => 'é'];\n");
    // The edit after the emoji is at UTF-16 columns: `🎉` counts two.
    let after = format_edits(
        "<?php\n\n$y = ['🎉'=>  'é'];\n",
        &LineIndex::new("<?php\n\n$y = ['🎉'=>  'é'];\n"),
        None,
        LATEST,
        &FormatOptions::default(),
    );
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].range.start, Pos::new(2, 10));
    assert_eq!(after[0].range.end, Pos::new(2, 13));
    assert_eq!(after[0].new_text, " =>");
}

struct Project {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
}

impl Project {
    fn new(version: PhpVersion) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/Model.php"), "<?php\nclass Model {}\n").unwrap();
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::all_extensions(version),
        };
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(WAIT));
        Self { _tmp: tmp, root, engine }
    }
}

#[test]
fn the_engine_formats_open_documents_at_the_project_level() {
    let project = Project::new(PhpVersion::new(8, 4));
    let doc = DocId(1);
    assert_eq!(project.engine.format(doc, None, &FormatOptions::default()), None, "not open");
    let text = "<?php\n$x = (new Foo())->bar();\nfunction f(){return  1;}\n";
    project.engine.document_opened(doc, &project.root.join("src/Use.php"), 1, text);
    let lines = LineIndex::new(text);
    let apply_edits = |edits: Vec<TextEdit>| {
        let mut document = text.to_owned();
        for edit in edits.iter().rev() {
            let (start, end) = lines.byte_range(edit.range);
            document.replace_range(start as usize..end as usize, &edit.new_text);
        }
        document
    };
    let whole = project.engine.format(doc, None, &FormatOptions::default()).unwrap();
    assert_eq!(apply_edits(whole), "<?php\n\n$x = new Foo()->bar();\nfunction f()\n{\n    return 1;\n}\n");
    // A range on the second line formats only that function.
    let range = Range::new(Pos::new(2, 0), Pos::new(2, 3));
    let part = project.engine.format(doc, Some(range), &FormatOptions { use_tabs: true, ..FormatOptions::default() });
    assert_eq!(apply_edits(part.unwrap()), "<?php\n$x = (new Foo())->bar();\nfunction f()\n{\n\treturn 1;\n}\n");
    // A syntax error typed into the document: nothing to format.
    project.engine.document_changed(doc, 2, "<?php\n$x = ;\n");
    assert_eq!(project.engine.format(doc, None, &FormatOptions::default()), Some(Vec::new()));
}
