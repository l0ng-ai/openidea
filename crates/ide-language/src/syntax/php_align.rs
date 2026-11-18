//! PHP Code Style › Align key-value pairs and Align consecutive assignments (PhpStorm's
//! options of the same names), applied to text a formatter has already formatted.
//!
//! A block is a run of array elements, or of assignment statements, on consecutive lines of
//! the same array or statement list, one per line and each on a single line. A blank line,
//! a comment line, another statement or element, or one spanning several lines ends it.
//! Within a block the operators line up one space after the longest left-hand side; nested
//! arrays form blocks of their own. Only the whitespace before an operator token of the
//! syntax tree changes, so `=>` and `=` inside strings and comments are never touched.

use crate::{LanguageId, Syntax};
use tree_sitter::{Node, Tree};

/// Which alignments to apply.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PhpAlignment {
    /// `=>` of the elements of multi-line arrays.
    pub key_value_pairs: bool,
    /// `=` of consecutive assignment statements.
    pub assignments: bool,
}

impl PhpAlignment {
    pub fn any(self) -> bool {
        self.key_value_pairs || self.assignments
    }
}

impl Syntax {
    /// `text` with its PHP alignment applied, changing only lines `lines` (0-based, inclusive;
    /// `None`: all). A block reaching outside them still aligns with its lines there.
    /// `None` when nothing changes or `lang` is not parsed with the PHP grammar.
    pub fn align_php(
        &self,
        lang: &LanguageId,
        text: &str,
        lines: Option<(usize, usize)>,
        options: PhpAlignment,
    ) -> Option<String> {
        if !options.any() {
            return None;
        }
        self.analyze(lang, text, |g, tree, text| (g.spec.name == "php").then(|| align(tree, text, lines, options)))
            .flatten()
    }
}

/// One line's operator: the whitespace `gap` before it and the width of the line up to it.
#[derive(Clone, Copy, Debug)]
struct Entry {
    line: usize,
    gap: (usize, usize),
    /// Characters from the start of the line to the end of the left-hand side.
    width: usize,
}

fn align(tree: &Tree, text: &str, lines: Option<(usize, usize)>, options: PhpAlignment) -> Option<String> {
    let mut gaps: Vec<(usize, usize, usize)> = Vec::new();
    let mut cursor = tree.walk();
    visit(&mut cursor, &mut |node| {
        // Error recovery can read string content as code, where whitespace matters.
        if node.is_error() {
            return;
        }
        let entries = match node.kind() {
            "array_creation_expression" if options.key_value_pairs => run(node, text, key_value),
            _ if options.assignments => run(node, text, assignment),
            _ => return,
        };
        for block in blocks(&entries) {
            let column = block.iter().map(|e| e.width).max().unwrap_or(0) + 1;
            for e in block {
                if lines.is_none_or(|(first, last)| (first..=last).contains(&e.line)) {
                    gaps.push((e.gap.0, e.gap.1, column - e.width));
                }
            }
        }
    });
    gaps.sort_unstable();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut changed = false;
    for (from, to, spaces) in gaps {
        if text[from..to].len() == spaces && text[from..to].bytes().all(|b| b == b' ') {
            continue;
        }
        out.push_str(&text[at..from]);
        out.extend(std::iter::repeat_n(' ', spaces));
        at = to;
        changed = true;
    }
    if !changed {
        return None;
    }
    out.push_str(&text[at..]);
    Some(out)
}

/// The named children of `parent` as alignment candidates in order: `None` breaks a block.
/// A comment ending the line of the child before it (`'a' => 1, // why`) is skipped; two
/// children sharing a line are both left alone.
fn run(parent: Node, text: &str, entry: fn(Node, &str) -> Option<Entry>) -> Vec<Option<Entry>> {
    let mut out: Vec<Option<Entry>> = Vec::new();
    let mut previous_end: Option<usize> = None;
    let mut cursor = parent.walk();
    for child in parent.named_children(&mut cursor) {
        let start = child.start_position().row;
        let shares_line = previous_end == Some(start);
        if child.kind() == "comment" && shares_line {
            continue;
        }
        if shares_line && let Some(last) = out.last_mut() {
            *last = None;
        }
        out.push(if shares_line { None } else { entry(child, text) });
        previous_end = Some(child.end_position().row);
    }
    out
}

/// Runs of entries on consecutive lines.
fn blocks(entries: &[Option<Entry>]) -> Vec<Vec<Entry>> {
    let mut out: Vec<Vec<Entry>> = Vec::new();
    let mut current: Vec<Entry> = Vec::new();
    for entry in entries {
        match entry {
            Some(e) if current.last().is_none_or(|last| last.line + 1 == e.line) => current.push(*e),
            Some(e) => out.push(std::mem::replace(&mut current, vec![*e])),
            None if current.is_empty() => {}
            None => out.push(std::mem::take(&mut current)),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// `'key' => value` alone on one line.
fn key_value(element: Node, text: &str) -> Option<Entry> {
    if element.kind() != "array_element_initializer" {
        return None;
    }
    let mut cursor = element.walk();
    let arrow = element.children(&mut cursor).find(|c| c.kind() == "=>")?;
    let key = arrow.prev_sibling()?;
    entry(element, key, arrow, text)
}

/// `$left = value;` (or `= &value`) alone on one line.
fn assignment(statement: Node, text: &str) -> Option<Entry> {
    if statement.kind() != "expression_statement" {
        return None;
    }
    let expression = statement.named_child(0)?;
    if !matches!(expression.kind(), "assignment_expression" | "reference_assignment_expression") {
        return None;
    }
    let left = expression.child_by_field_name("left")?;
    let mut cursor = expression.walk();
    let operator = expression.children(&mut cursor).find(|c| c.kind() == "=")?;
    entry(statement, left, operator, text)
}

fn entry(whole: Node, left: Node, operator: Node, text: &str) -> Option<Entry> {
    let line = whole.start_position().row;
    if whole.has_error() || whole.end_position().row != line {
        return None;
    }
    let line_start = whole.start_byte() - whole.start_position().column;
    let starts_line = text[line_start..whole.start_byte()].bytes().all(|b| b == b' ' || b == b'\t');
    let gap = (left.end_byte(), operator.start_byte());
    let blank_gap = text[gap.0..gap.1].bytes().all(|b| b == b' ' || b == b'\t');
    (starts_line && blank_gap).then(|| Entry { line, gap, width: text[line_start..gap.0].chars().count() })
}

fn visit(cursor: &mut tree_sitter::TreeCursor, f: &mut impl FnMut(Node)) {
    loop {
        f(cursor.node());
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    const BOTH: PhpAlignment = PhpAlignment { key_value_pairs: true, assignments: true };
    const PAIRS: PhpAlignment = PhpAlignment { key_value_pairs: true, assignments: false };
    const ASSIGNMENTS: PhpAlignment = PhpAlignment { key_value_pairs: false, assignments: true };

    fn syntax() -> &'static Syntax {
        static S: OnceLock<Syntax> = OnceLock::new();
        S.get_or_init(Syntax::new)
    }

    fn aligned(text: &str, lines: Option<(usize, usize)>, options: PhpAlignment) -> String {
        let out = syntax().align_php(&LanguageId::new("php"), text, lines, options);
        let result = out.clone().unwrap_or_else(|| text.to_owned());
        let strip = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        assert_eq!(strip(&result), strip(text), "only whitespace changes");
        assert_eq!(
            syntax().align_php(&LanguageId::new("php"), &result, lines, options),
            None,
            "aligning again changes nothing:\n{result}"
        );
        result
    }

    fn check(options: PhpAlignment, before: &str, after: &str) {
        assert_eq!(aligned(before, None, options), after);
    }

    #[test]
    fn aligns_the_arrows_of_a_multi_line_array() {
        check(
            PAIRS,
            "<?php\nreturn [\n    'name' => 'demo',\n    'description' => 'x',\n    'id'    => 1,\n];\n",
            "<?php\nreturn [\n    'name'        => 'demo',\n    'description' => 'x',\n    'id'          => 1,\n];\n",
        );
        check(
            PAIRS,
            "<?php\n$a = array(\n    1 => 'a',\n    1234 => 'b',\n);\n",
            "<?php\n$a = array(\n    1    => 'a',\n    1234 => 'b',\n);\n",
        );
    }

    #[test]
    fn nested_arrays_align_per_level_and_a_multi_line_value_ends_a_block() {
        check(
            PAIRS,
            "<?php\n$config = [\n    'a' => 1,\n    'bbb' => 2,\n    'nested' => [\n        'x' => 1,\n        'yyyy' => 2,\n    ],\n    'c' => 3,\n    'dd' => 4,\n];\n",
            "<?php\n$config = [\n    'a'   => 1,\n    'bbb' => 2,\n    'nested' => [\n        'x'    => 1,\n        'yyyy' => 2,\n    ],\n    'c'  => 3,\n    'dd' => 4,\n];\n",
        );
    }

    #[test]
    fn blank_lines_comment_lines_and_elements_without_a_key_end_a_block() {
        check(
            PAIRS,
            "<?php\n$a = [\n    'a' => 1,\n    'bb' => 2,\n\n    'ccc' => 3,\n    // section\n    'dddd' => 4,\n    'e' => 5,\n    6,\n    'ff' => 7,\n];\n",
            "<?php\n$a = [\n    'a'  => 1,\n    'bb' => 2,\n\n    'ccc' => 3,\n    // section\n    'dddd' => 4,\n    'e'    => 5,\n    6,\n    'ff' => 7,\n];\n",
        );
    }

    #[test]
    fn a_comment_at_the_end_of_a_line_keeps_the_block() {
        check(
            PAIRS,
            "<?php\n$a = [\n    'a' => 1, // first\n    'bb' => 2, /* second */\n    'ccc' => 3,\n];\n",
            "<?php\n$a = [\n    'a'   => 1, // first\n    'bb'  => 2, /* second */\n    'ccc' => 3,\n];\n",
        );
    }

    #[test]
    fn single_line_arrays_and_elements_sharing_a_line_stay_as_they_are() {
        for text in [
            "<?php\n$a = ['a' => 1, 'bbb' => 2];\n",
            "<?php\n$a = [\n    'a' => 1, 'bbb' => 2,\n    'cc' => 3,\n];\n",
            "<?php\n$a = ['a' => 1,\n    'bbb' => 2];\n",
        ] {
            assert_eq!(aligned(text, None, BOTH), text);
        }
    }

    #[test]
    fn arrows_and_equals_signs_outside_arrays_and_assignments_are_not_touched() {
        let text = "<?php\n\
            $s = 'a  => b';\n\
            $t = \"x   = y\";\n\
            // 'k' => 1, $v = 2\n\
            /* 'kk'  => 1 */\n\
            foreach ($items as $key   => $value) {}\n\
            $f = fn($x)   => $x;\n\
            $m = match ($x) {\n    1 => 'a',\n    100 => 'b',\n};\n\
            for ($i = 0;  $i < 3; $i++) {}\n\
            function g($a  = 1, $bbb = 2) {}\n\
            g(a: 1, bbb: 2);\n\
            $h = <<<EOT\n  'a' => 1,\n  'bbb' => 2,\nEOT;\n";
        let out = aligned(text, None, PAIRS);
        assert_eq!(out, text);
    }

    #[test]
    fn aligns_consecutive_assignments() {
        check(
            ASSIGNMENTS,
            "<?php\n$y = foo($x);\n$i = foo($i);\n$result = $result . $y . $i;\n$this->name   = 'n';\n$ref = &$y;\n",
            "<?php\n$y          = foo($x);\n$i          = foo($i);\n$result     = $result . $y . $i;\n$this->name = 'n';\n$ref        = &$y;\n",
        );
    }

    #[test]
    fn other_statements_blank_lines_and_multi_line_assignments_end_a_block() {
        check(
            ASSIGNMENTS,
            "<?php\nfunction f() {\n    $a = 1;\n    $bb = 2;\n    echo $a;\n    $ccc = 3;\n    $d = 4;\n\n    $eeeee = 5;\n    $f = 6;\n    $g .= 'x';\n    $hh = 7;\n    $i = [\n        1,\n    ];\n    $jjj = 8;\n    $k = 9;\n}\n",
            "<?php\nfunction f() {\n    $a  = 1;\n    $bb = 2;\n    echo $a;\n    $ccc = 3;\n    $d   = 4;\n\n    $eeeee = 5;\n    $f     = 6;\n    $g .= 'x';\n    $hh = 7;\n    $i = [\n        1,\n    ];\n    $jjj = 8;\n    $k   = 9;\n}\n",
        );
    }

    #[test]
    fn assignments_sharing_a_line_and_declarations_stay_as_they_are() {
        let text = "<?php\n$a = 1; $bbb = 2;\n$cc = 3;\nclass C {\n    public $x = 1;\n    public $yyy = 2;\n    const A = 1;\n    const BBB = 2;\n}\n";
        assert_eq!(aligned(text, None, ASSIGNMENTS), text);
    }

    #[test]
    fn each_option_aligns_only_its_operator() {
        let text = "<?php\n$a = [\n    'a' => 1,\n    'bbb' => 2,\n];\n$x = 1;\n$yyy = 2;\n";
        assert_eq!(
            aligned(text, None, PAIRS),
            "<?php\n$a = [\n    'a'   => 1,\n    'bbb' => 2,\n];\n$x = 1;\n$yyy = 2;\n"
        );
        assert_eq!(
            aligned(text, None, ASSIGNMENTS),
            "<?php\n$a = [\n    'a' => 1,\n    'bbb' => 2,\n];\n$x   = 1;\n$yyy = 2;\n"
        );
        assert_eq!(syntax().align_php(&LanguageId::new("php"), text, None, PhpAlignment::default()), None);
        assert_eq!(syntax().align_php(&LanguageId::new("javascript"), "a = {\n  b: 1,\n};\n", None, BOTH), None);
    }

    #[test]
    fn only_the_given_lines_change_and_they_align_with_the_whole_block() {
        let text = "<?php\n$a = [\n    'a' => 1,\n    'bb' => 2,\n    'cccc' => 3,\n];\n";
        assert_eq!(
            aligned(text, Some((2, 3)), PAIRS),
            "<?php\n$a = [\n    'a'    => 1,\n    'bb'   => 2,\n    'cccc' => 3,\n];\n"
        );
        assert_eq!(aligned(text, Some((5, 5)), PAIRS), text);
    }

    #[test]
    fn widths_count_characters_not_bytes() {
        check(
            PAIRS,
            "<?php\n$a = [\n    '名前' => 1,\n    'name' => 2,\n];\n",
            "<?php\n$a = [\n    '名前'   => 1,\n    'name' => 2,\n];\n",
        );
    }

    #[test]
    fn code_with_syntax_errors_is_aligned_only_where_it_parses() {
        let text = "<?php\n$a = [\n    'a' => 1,\n    'bbb' => ,\n    'cc' => 3,\n];\n";
        let out = aligned(text, None, PAIRS);
        assert!(out.contains("'bbb' => ,"), "{out}");
    }

    #[test]
    fn php_inside_html() {
        check(
            BOTH,
            "<html>\n<?php\n$a = 1;\n$bbb = 2;\n?>\n<p>x = y</p>\n",
            "<html>\n<?php\n$a   = 1;\n$bbb = 2;\n?>\n<p>x = y</p>\n",
        );
    }
}
