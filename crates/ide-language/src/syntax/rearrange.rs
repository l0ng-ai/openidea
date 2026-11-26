//! Rearrange Code: class members in arrangement order. Python only for now: within each class,
//! `__new__` / `__init__` / `__post_init__`, other dunder methods, public, `_protected`, then
//! `__private` methods, each group in its original order. The docstring and class attributes
//! before the first method stay put; a method moves with its decorators and the comment lines
//! directly above it; definitions sharing a name (property accessors, `@overload` stubs) move
//! together. A class is left alone when moving could change it: other statements or standalone
//! comments among its methods, or a decorator, default or annotation naming another method.

use crate::{LanguageId, Syntax};
use std::ops::Range;
use tree_sitter::Node;

impl Syntax {
    /// `text` with its class members rearranged; `None` when nothing moves, the text has syntax
    /// errors, or the language has no arrangement.
    pub fn rearranged(&self, lang: &LanguageId, text: &str) -> Option<String> {
        self.analyze(lang, text, |g, tree, text| {
            (g.spec.name == "python").then(|| python_rearranged(tree.root_node(), text)).flatten()
        })
    }
}

/// One class whose methods move: their line ranges, the blank lines between them (which stay in
/// place), and the order to write the methods in.
struct Change {
    region: Range<usize>,
    methods: Vec<Range<usize>>,
    gaps: Vec<Range<usize>>,
    order: Vec<usize>,
}

/// Every class of the parsed `text` rearranged in one pass: a moved method carries the classes
/// rearranged inside it.
fn python_rearranged(root: Node, text: &str) -> Option<String> {
    if root.has_error() {
        return None;
    }
    let mut changes = Vec::new();
    let mut cursor = root.walk();
    'walk: loop {
        let node = cursor.node();
        // An empty block (`if x:` with nothing under it) is an error the parser lets through.
        if node.kind() == "block" && node.named_child_count() == 0 {
            return None;
        }
        if node.kind() == "class_definition"
            && let Some(change) = class_change(node, text)
        {
            changes.push(change);
        }
        if cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                break 'walk;
            }
        }
    }
    if changes.is_empty() {
        return None;
    }
    changes.sort_by_key(|c| c.region.start);
    let mut out = String::with_capacity(text.len());
    emit(text, &changes, 0..text.len(), &mut out);
    (out != text).then_some(out)
}

/// `text[range]` with the changes inside it applied.
fn emit(text: &str, changes: &[Change], range: Range<usize>, out: &mut String) {
    let mut pos = range.start;
    let first = changes.partition_point(|c| c.region.start < range.start);
    for change in &changes[first..] {
        if change.region.start >= range.end {
            break;
        }
        // Inside a change already written, or the change `range` is a method of.
        if change.region.start < pos || change.region.end > range.end {
            continue;
        }
        out.push_str(&text[pos..change.region.start]);
        for (position, &method) in change.order.iter().enumerate() {
            emit(text, changes, change.methods[method].clone(), out);
            if !out.ends_with('\n') {
                out.push('\n');
            }
            if let Some(gap) = change.gaps.get(position) {
                out.push_str(&text[gap.clone()]);
            }
        }
        if !text[..change.region.end].ends_with('\n') {
            out.pop();
        }
        pos = change.region.end;
    }
    out.push_str(&text[pos..range.end]);
}

fn method_name<'a>(member: Node, text: &'a str) -> Option<&'a str> {
    function_of(member)?.child_by_field_name("name").map(|n| &text[n.byte_range()])
}

fn function_of(member: Node) -> Option<Node> {
    match member.kind() {
        "function_definition" => Some(member),
        "decorated_definition" => {
            member.child_by_field_name("definition").filter(|d| d.kind() == "function_definition")
        }
        _ => None,
    }
}

/// Arrangement group of a method name.
fn group(name: &str) -> u8 {
    match name {
        "__new__" | "__init__" | "__post_init__" => 0,
        _ if name.starts_with("__") && name.ends_with("__") => 1,
        _ if name.starts_with("__") => 4,
        _ if name.starts_with('_') => 3,
        _ => 2,
    }
}

fn line_start(text: &str, offset: usize) -> usize {
    text[..offset].rfind('\n').map_or(0, |i| i + 1)
}

/// Just past the end of the line holding `offset` (a char boundary).
fn line_end(text: &str, offset: usize) -> usize {
    text[offset..].find('\n').map_or(text.len(), |i| offset + i + 1)
}

/// Whether `node` is the first thing on its line.
fn starts_line(node: Node, text: &str) -> bool {
    text[line_start(text, node.start_byte())..node.start_byte()].trim().is_empty()
}

/// Whether the comments `above` sit on the lines right above `node`, at its column.
fn directly_above(above: &[Node], node: Node, text: &str) -> bool {
    let mut next = node;
    above.iter().rev().all(|comment| {
        let fits = comment.start_position().column == node.start_position().column
            && comment.end_position().row + 1 == next.start_position().row
            && starts_line(*comment, text);
        next = *comment;
        fits
    })
}

/// A comment that marks a position rather than describing a method (`# region`, `# fmt: off`).
fn is_marker(comment: Node, text: &str) -> bool {
    let body = text[comment.byte_range()].trim_start_matches('#').trim_start();
    ["region", "endregion", "fmt:", "yapf:", "isort:", "<editor-fold", "</editor-fold"]
        .iter()
        .any(|m| body.starts_with(m))
}

/// Pre-order walk of `root`'s subtree, stopping early when `visit` returns true.
fn any_in(root: Node, mut visit: impl FnMut(Node) -> bool) -> bool {
    let mut cursor = root.walk();
    loop {
        if visit(cursor.node()) {
            return true;
        }
        if cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() || cursor.node() == root {
                return false;
            }
        }
    }
}

/// Whether a method's decorators, parameter defaults or annotations name one of `others`: they
/// run when the class body does, so they must stay below what they name.
fn header_names_any(member: Node, text: &str, others: &[&str]) -> bool {
    let mut roots = Vec::new();
    let mut cursor = member.walk();
    roots.extend(member.named_children(&mut cursor).filter(|c| c.kind() == "decorator"));
    if let Some(function) = function_of(member) {
        roots.extend(function.child_by_field_name("return_type"));
        if let Some(params) = function.child_by_field_name("parameters") {
            let mut cursor = params.walk();
            for param in params.named_children(&mut cursor) {
                roots.extend(param.child_by_field_name("type"));
                roots.extend(param.child_by_field_name("value"));
            }
        }
    }
    roots
        .into_iter()
        .any(|root| any_in(root, |node| node.kind() == "identifier" && others.contains(&&text[node.byte_range()])))
}

/// The methods of `class` in arrangement order; `None` when they already are or moving them could
/// change the class.
fn class_change(class: Node, text: &str) -> Option<Change> {
    let body = class.child_by_field_name("body")?;
    let mut cursor = body.walk();
    let members: Vec<Node> = body.named_children(&mut cursor).collect();
    let first = members.iter().position(|m| method_name(*m, text).is_some())?;
    if members.iter().any(|m| m.kind() == "comment" && is_marker(*m, text)) {
        return None;
    }
    // The comments directly above the first method move with it.
    let mut lead = first;
    while lead > 0
        && members[lead - 1].kind() == "comment"
        && directly_above(&members[lead - 1..first], members[first], text)
    {
        lead -= 1;
    }
    // Compare identifier spellings directly. Python's NFKC-equivalent spellings can differ here.
    let mut methods = Vec::new();
    let mut comments: Vec<Node> = members[lead..first].to_vec();
    for member in &members[first..] {
        if member.kind() == "comment" {
            comments.push(*member);
            continue;
        }
        let name = method_name(*member, text)?;
        let column = member.start_position().column;
        // Methods at different columns: indentation Python would reject.
        if column != members[first].start_position().column {
            return None;
        }
        // A dedented comment the parser put inside the method belongs to the class.
        let class_comment = any_in(*member, |n| n.kind() == "comment" && n.start_position().column <= column);
        if !starts_line(*member, text) || !directly_above(&comments, *member, text) || class_comment {
            return None;
        }
        let start = comments.first().map_or(member.start_byte(), |c| c.start_byte());
        methods.push((*member, name, line_start(text, start)));
        comments.clear();
    }
    // A comment after the last method belongs to no method.
    if !comments.is_empty() {
        return None;
    }
    for (member, name, _) in &methods {
        let others: Vec<&str> = methods.iter().map(|m| m.1).filter(|n| n != name).collect();
        if header_names_any(*member, text, &others) {
            return None;
        }
    }
    // Same-named definitions form one unit, placed by its first definition.
    let mut units: Vec<(u8, &str, Vec<usize>)> = Vec::new();
    for (i, (_, name, _)) in methods.iter().enumerate() {
        let name = *name;
        match units.iter_mut().find(|u| u.1 == name) {
            Some(unit) => unit.2.push(i),
            None => units.push((group(name), name, vec![i])),
        }
    }
    units.sort_by_key(|u| u.0);
    let order: Vec<usize> = units.into_iter().flat_map(|u| u.2).collect();
    if order.iter().enumerate().all(|(i, &m)| i == m) {
        return None;
    }
    let methods: Vec<Range<usize>> =
        methods.iter().map(|(member, _, start)| *start..line_end(text, member.end_byte())).collect();
    let mut gaps = Vec::new();
    for pair in methods.windows(2) {
        // Only blank lines between methods; anything else stays where it is, with the class.
        if pair[0].end > pair[1].start || !text[pair[0].end..pair[1].start].trim().is_empty() {
            return None;
        }
        gaps.push(pair[0].end..pair[1].start);
    }
    Some(Change { region: methods[0].start..methods.last()?.end, methods, gaps, order })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rearranged(text: &str) -> Option<String> {
        Syntax::default().rearranged(&LanguageId::new("python"), text)
    }

    #[test]
    fn methods_follow_the_arrangement_with_their_decorators_and_comments() {
        let text = r#"class Task:
    """A task."""

    done = False

    def _mark(self):
        pass

    # Shown in lists.
    @property
    def title(self):
        return self._title

    def __repr__(self):
        return "Task"

    def __secret(self):
        pass

    def __init__(self, title):
        self._title = title
"#;
        let expected = r#"class Task:
    """A task."""

    done = False

    def __init__(self, title):
        self._title = title

    def __repr__(self):
        return "Task"

    # Shown in lists.
    @property
    def title(self):
        return self._title

    def _mark(self):
        pass

    def __secret(self):
        pass
"#;
        assert_eq!(rearranged(text).as_deref(), Some(expected));
        assert_eq!(rearranged(expected), None);
    }

    #[test]
    fn same_named_definitions_move_together_and_nested_classes_are_rearranged() {
        let text = "class A:\n    def _helper(self): ...\n    @property\n    def x(self): ...\n    @x.setter\n    def x(self, v): ...\n    def __init__(self):\n        class B:\n            def b(self): ...\n            def __init__(self): ...\n";
        let expected = "class A:\n    def __init__(self):\n        class B:\n            def __init__(self): ...\n            def b(self): ...\n    @property\n    def x(self): ...\n    @x.setter\n    def x(self, v): ...\n    def _helper(self): ...\n";
        assert_eq!(rearranged(text).as_deref(), Some(expected));
        assert_eq!(rearranged(expected), None);
    }

    #[test]
    fn non_ascii_text_and_a_missing_final_newline_are_kept() {
        let text = "class A:\n    def b(self):\n        self.名前 = 1  # 名前\n\n    def __init__(self):\n        self.x = 1  # 初始化";
        let expected = "class A:\n    def __init__(self):\n        self.x = 1  # 初始化\n\n    def b(self):\n        self.名前 = 1  # 名前";
        assert_eq!(rearranged(text).as_deref(), Some(expected));
    }

    #[test]
    fn classes_that_moving_could_change_stay() {
        for text in [
            // A statement among the methods.
            "class A:\n    def b(self): ...\n    alias = b\n    def __init__(self): ...\n",
            // A decorator, a default and a registration naming another method.
            "class A:\n    def _retry(fn): return fn\n    @_retry\n    def fetch(self): ...\n",
            "class A:\n    def _default(self): ...\n    def run(self, cb=_default): ...\n",
            "class A:\n    @singledispatchmethod\n    def _visit(self, x): ...\n    @_visit.register\n    def visit_int(self, x: int): ...\n",
            // A section comment or region markers apart from the methods.
            "class A:\n    def b(self): ...\n\n    # ---- construction ----\n\n    def __init__(self): ...\n",
            "class A:\n    # region api\n    def b(self): ...\n    # endregion\n    def __init__(self): ...\n",
            "class A:\n    def b(self): ...\n    # fmt: off\n    def __init__(self): ...\n",
            // Two definitions on one line, and broken syntax.
            "class A:\n    def _b(self): pass; def a(self): pass\n",
            "class A:\n    def b(self): ...\n    def a(self\n    def __init__(self): ...\n",
            "class A:\n    def _b(self):\n        if x:\n\n    def a(self):\n        pass\n",
        ] {
            assert_eq!(rearranged(text), None, "{text}");
        }
        assert_eq!(Syntax::default().rearranged(&LanguageId::new("rust"), "fn main() {}\n"), None);
    }

    #[test]
    fn a_hash_line_inside_a_string_is_not_a_comment() {
        let text = "class A:\n    SQL = \"\"\"\n    # not a comment\"\"\"\n    def b(self): ...\n    def __init__(self): ...\n";
        let expected = "class A:\n    SQL = \"\"\"\n    # not a comment\"\"\"\n    def __init__(self): ...\n    def b(self): ...\n";
        assert_eq!(rearranged(text).as_deref(), Some(expected));
    }

    #[test]
    fn unicode_names_in_method_headers_match_their_source_spelling() {
        let text = "class A:\n    def _装飾(fn): return fn\n    @_装飾\n    def public(self): ...\n";
        assert_eq!(rearranged(text), None);
    }

    #[test]
    fn constructor_methods_keep_their_relative_order() {
        let text = "class A:\n    def b(self): ...\n    def __post_init__(self): ...\n    def __init__(self): ...\n    def __new__(cls): ...\n";
        let expected = "class A:\n    def __post_init__(self): ...\n    def __init__(self): ...\n    def __new__(cls): ...\n    def b(self): ...\n";
        assert_eq!(rearranged(text).as_deref(), Some(expected));
    }

    #[test]
    fn many_classes_are_rearranged_in_one_parse() {
        let class = "class A:\n    def c(self): ...\n    def _b(self): ...\n    def __init__(self): ...\n\n";
        let sorted = "class A:\n    def __init__(self): ...\n    def c(self): ...\n    def _b(self): ...\n\n";
        let started = std::time::Instant::now();
        assert_eq!(rearranged(&class.repeat(3000)), Some(sorted.repeat(3000)));
        // Linear: well under a second in release builds; a reparse per class took minutes.
        assert!(started.elapsed().as_secs() < 30);
    }
}
