//! Rearrange Code: class members in arrangement order. Python only for now: within each class,
//! `__new__` / `__init__` / `__post_init__`, other dunder methods, public, `_protected`, then
//! `__private` methods, each group in its original order. The docstring and class attributes
//! before the first method stay put; a method moves with its decorators and the comments right
//! above it; definitions sharing a name (property accessors, `@overload` stubs) move together.
//! A class with other statements among its methods is left alone: they may depend on the order.

use crate::{LanguageId, Syntax};
use tree_sitter::Node;

impl Syntax {
    /// `text` with its class members rearranged; `None` when nothing moves or the language has
    /// no arrangement.
    pub fn rearranged(&self, lang: &LanguageId, text: &str) -> Option<String> {
        let mut text = text.to_owned();
        let mut changed = false;
        // One class per pass: a rearranged class shifts the classes after (and inside) it.
        // ponytail: reparses once per class that moves; fine for files of a few hundred classes.
        while let Some(next) = self.analyze(lang, &text, |g, tree, text| {
            (g.spec.name == "python").then(|| first_python_change(tree.root_node(), text)).flatten()
        }) {
            text = next;
            changed = true;
        }
        changed.then_some(text)
    }
}

/// The text with the first class (in document order) whose methods are out of order rearranged.
fn first_python_change(node: Node, text: &str) -> Option<String> {
    if node.kind() == "class_definition"
        && let Some(next) = rearrange_class(node, text)
    {
        return Some(next);
    }
    let mut cursor = node.walk();
    let children: Vec<Node> = node.named_children(&mut cursor).collect();
    children.into_iter().find_map(|child| first_python_change(child, text))
}

fn method_name<'a>(member: Node, text: &'a str) -> Option<&'a str> {
    let function = match member.kind() {
        "function_definition" => member,
        "decorated_definition" => {
            member.child_by_field_name("definition").filter(|d| d.kind() == "function_definition")?
        }
        _ => return None,
    };
    function.child_by_field_name("name").map(|n| &text[n.byte_range()])
}

/// Arrangement group of a method name.
fn group(name: &str) -> u8 {
    match name {
        "__new__" => 0,
        "__init__" => 1,
        "__post_init__" => 2,
        _ if name.starts_with("__") && name.ends_with("__") => 3,
        _ if name.starts_with("__") => 6,
        _ if name.starts_with('_') => 5,
        _ => 4,
    }
}

fn line_start(text: &str, offset: usize) -> usize {
    text[..offset].rfind('\n').map_or(0, |i| i + 1)
}

fn line_end(text: &str, offset: usize) -> usize {
    text[offset..].find('\n').map_or(text.len(), |i| offset + i + 1)
}

/// Where a method's lines start: its first line, or the comment lines right above it at its indent.
fn chunk_start(text: &str, def_start: usize) -> usize {
    let mut start = line_start(text, def_start);
    let indent = &text[start..def_start];
    while start > 0 {
        let above = line_start(text, start - 1);
        let line = &text[above..start - 1];
        if line.strip_prefix(indent).is_some_and(|rest| rest.starts_with('#')) {
            start = above;
        } else {
            break;
        }
    }
    start
}

/// The text with `class`'s methods in arrangement order; `None` when they already are, or when the
/// class has other statements among its methods.
fn rearrange_class(class: Node, text: &str) -> Option<String> {
    let body = class.child_by_field_name("body")?;
    let mut cursor = body.walk();
    let members: Vec<Node> = body.named_children(&mut cursor).collect();
    let first = members.iter().position(|m| method_name(*m, text).is_some())?;
    let mut methods = Vec::new();
    for member in &members[first..] {
        match method_name(*member, text) {
            Some(name) => methods.push((*member, name)),
            None if member.kind() == "comment" => {}
            None => return None,
        }
    }
    // Same-named definitions form one unit, placed by its first definition.
    let mut units: Vec<(u8, &str, Vec<usize>)> = Vec::new();
    for (i, (_, name)) in methods.iter().enumerate() {
        match units.iter_mut().find(|u| u.1 == *name) {
            Some(unit) => unit.2.push(i),
            None => units.push((group(name), name, vec![i])),
        }
    }
    units.sort_by_key(|u| u.0);
    let order: Vec<usize> = units.into_iter().flat_map(|u| u.2).collect();
    if order.iter().enumerate().all(|(i, &m)| i == m) {
        return None;
    }
    // Each method's lines, split into its content and the blank lines after it, which stay in place.
    let starts: Vec<usize> = methods.iter().map(|(m, _)| chunk_start(text, m.start_byte())).collect();
    let end = line_end(text, methods.last()?.0.end_byte().saturating_sub(1).max(starts[0]));
    let mut contents = Vec::new();
    let mut separators = Vec::new();
    for (i, &start) in starts.iter().enumerate() {
        let next = starts.get(i + 1).copied().unwrap_or(end);
        let chunk = &text[start..next];
        let content = chunk.trim_end_matches(|c: char| c.is_whitespace());
        let content_end = start + content.len();
        let content_end = if content_end < next { line_end(text, content_end) } else { content_end };
        let mut content = text[start..content_end].to_owned();
        if !content.ends_with('\n') {
            content.push('\n');
        }
        contents.push(content);
        separators.push(&text[content_end..next]);
    }
    let mut rearranged = String::new();
    for (position, &method) in order.iter().enumerate() {
        rearranged.push_str(&contents[method]);
        rearranged.push_str(separators[position]);
    }
    if !text[..end].ends_with('\n') {
        rearranged.pop();
    }
    Some(format!("{}{rearranged}{}", &text[..starts[0]], &text[end..]))
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
    }

    #[test]
    fn classes_with_statements_among_methods_and_other_languages_stay() {
        let text = "class A:\n    def b(self): ...\n    alias = b\n    def __init__(self): ...\n";
        assert_eq!(rearranged(text), None);
        let no_newline = "class A:\n    def b(self): ...\n\n    def __init__(self): ...";
        assert_eq!(
            rearranged(no_newline).as_deref(),
            Some("class A:\n    def __init__(self): ...\n\n    def b(self): ...")
        );
        assert_eq!(Syntax::default().rearranged(&LanguageId::new("rust"), "fn main() {}\n"), None);
    }
}
