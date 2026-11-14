//! Extraction of Python class base names, used to build an inheritance graph
//! without an LSP `typeHierarchyProvider`.

use super::lines::LineIndex;
use crate::{LanguageId, Syntax};
use tree_sitter::{Node, Tree};

/// A Python class definition and the base names written in its source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassBases {
    /// The class name (bare identifier).
    pub name: String,
    /// 0-based line of the class name (selection-range start).
    pub line: u32,
    /// 0-based UTF-16 column of the class name (selection-range start).
    pub col: u32,
    /// Source-written base names (last segment of a qualified name).
    pub bases: Vec<String>,
}

impl Syntax {
    /// Class definitions of `text` with their base names, in source order.
    /// Only Python is supported; every other language returns an empty vector.
    pub fn class_bases(&self, lang: &LanguageId, text: &str) -> Vec<ClassBases> {
        self.analyze(lang, text, |g, tree, text| (g.spec.name == "python").then(|| extract(tree, text)))
            .unwrap_or_default()
    }
}

fn extract(tree: &Tree, text: &str) -> Vec<ClassBases> {
    let idx = LineIndex::new(text);
    let mut out = Vec::new();
    let mut cursor = tree.walk();
    visit(&mut cursor, &mut |node| {
        if node.kind() != "class_definition" {
            return;
        }
        let Some(name_node) = node.child_by_field_name("name") else { return };
        let name = text.get(name_node.byte_range()).unwrap_or_default().to_owned();
        if name.is_empty() {
            return;
        }
        // Selection-range start of the class: its name identifier (`class Foo`
        // -> `Foo`), matching `outline.rs` and the gutter marker candidates.
        let range = idx.range(name_node.start_byte(), name_node.end_byte());
        let bases = node.child_by_field_name("superclasses").map(|args| base_names(args, text)).unwrap_or_default();
        out.push(ClassBases { name, line: range.start.line, col: range.start.col, bases });
    });
    out
}

/// Depth-first pre-order traversal of all descendants of `cursor`'s node.
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

fn base_names(args: Node, text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = args.walk();
    for arg in args.named_children(&mut cursor) {
        if let Some(name) = base_name(arg, text) {
            out.push(name);
        }
    }
    out
}

/// Bare name of one base expression, or `None` for keyword arguments and
/// expressions that are not a (possibly qualified) name.
fn base_name(arg: Node, text: &str) -> Option<String> {
    match arg.kind() {
        "identifier" => text.get(arg.byte_range()).map(str::to_owned),
        // `pkg.mod.Base` -> `Base`.
        "attribute" => {
            let attr = arg.child_by_field_name("attribute")?;
            (attr.kind() == "identifier").then(|| text.get(attr.byte_range()).unwrap_or_default().to_owned())
        }
        // `Generic[T]` -> `Generic`.
        "subscript" => {
            let value = arg.child_by_field_name("value")?;
            (value.kind() == "identifier").then(|| text.get(value.byte_range()).unwrap_or_default().to_owned())
        }
        // `metaclass=Meta`, `**kwargs`, `*bases` and other expressions.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bases(src: &str) -> Vec<ClassBases> {
        static S: std::sync::OnceLock<Syntax> = std::sync::OnceLock::new();
        S.get_or_init(Syntax::new).class_bases(&LanguageId::new("python"), src)
    }

    fn shape(src: &str) -> Vec<(String, u32, u32, Vec<String>)> {
        bases(src).into_iter().map(|c| (c.name, c.line, c.col, c.bases)).collect()
    }

    #[test]
    fn no_bases() {
        assert_eq!(shape("class A: pass"), vec![("A".to_owned(), 0, 6, vec![])]);
    }

    #[test]
    fn multiple_bases_skips_metaclass() {
        assert_eq!(
            shape("class B(A, C, metaclass=Meta): pass"),
            vec![("B".to_owned(), 0, 6, vec!["A".to_owned(), "C".to_owned()])]
        );
    }

    #[test]
    fn qualified_name_takes_last_segment() {
        assert_eq!(shape("class D(pkg.mod.Base): pass"), vec![("D".to_owned(), 0, 6, vec!["Base".to_owned()])]);
    }

    #[test]
    fn subscript_takes_value() {
        assert_eq!(shape("class E(Generic[T]): pass"), vec![("E".to_owned(), 0, 6, vec!["Generic".to_owned()])]);
    }

    #[test]
    fn multiline_bases() {
        let src = "class F(\n    A,\n    B,\n):\n    pass";
        assert_eq!(shape(src), vec![("F".to_owned(), 0, 6, vec!["A".to_owned(), "B".to_owned()])]);
    }

    #[test]
    fn nested_classes() {
        let src = "class Outer:\n    class Inner(Y):\n        pass";
        assert_eq!(
            shape(src),
            vec![("Outer".to_owned(), 0, 6, vec![]), ("Inner".to_owned(), 1, 10, vec!["Y".to_owned()]),]
        );
    }

    #[test]
    fn comments_and_strings_are_ignored() {
        let src = r#"
# class Fake(Nope): pass
doc = """
class InDocstring(X): pass
"""
s = 'class InString(Y): pass'
class Real(Base): pass
"#;
        assert_eq!(shape(src), vec![("Real".to_owned(), 6, 6, vec!["Base".to_owned()])]);
    }

    #[test]
    fn other_languages_are_empty() {
        static S: std::sync::OnceLock<Syntax> = std::sync::OnceLock::new();
        let s = S.get_or_init(Syntax::new);
        assert!(s.class_bases(&LanguageId::new("rust"), "struct A;").is_empty());
    }
}
