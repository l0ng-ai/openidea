//! The names a Python module offers to `from module import name`, for import suggestions of
//! library symbols: its `__all__`, else its public top-level definitions.

use crate::{LanguageId, Syntax};
use tree_sitter::{Node, Tree};

impl Syntax {
    /// The public names of a Python module `text`, sorted: the names its `__all__` lists, else its
    /// top-level functions, classes, assignments and type aliases, and the names it re-exports
    /// as `import a as a` / `from m import a as a` (the stub convention). Top-level `if` / `try`
    /// / `with` blocks count as top level. Names with a leading underscore are left out.
    pub fn python_exports(&self, text: &str) -> Vec<String> {
        self.analyze(&LanguageId::new("python"), text, |_, tree, text| Some(exports(tree, text))).unwrap_or_default()
    }
}

#[derive(Default)]
struct Exports {
    /// The literal names of `__all__`; None when the module has none.
    all: Option<Vec<String>>,
    /// `__all__` is also built from something other than literals (`other.__all__ + [...]`).
    dynamic: bool,
    defined: Vec<String>,
}

fn exports(tree: &Tree, text: &str) -> Vec<String> {
    let mut found = Exports::default();
    found.block(tree.root_node(), text);
    let mut names = match found.all {
        Some(all) if found.dynamic => all.into_iter().chain(found.defined).collect(),
        Some(all) => all,
        None => found.defined,
    };
    names.retain(|n| is_public(n));
    names.sort();
    names.dedup();
    names
}

impl Exports {
    fn block(&mut self, node: Node, text: &str) {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            self.statement(child, text);
        }
    }

    fn statement(&mut self, node: Node, text: &str) {
        match node.kind() {
            "function_definition" | "class_definition" | "type_alias_statement" => {
                if let Some(name) = node.child_by_field_name("name").filter(|n| n.kind() == "identifier") {
                    self.defined.push(src(name, text).to_owned());
                } else if let Some(left) = node.child_by_field_name("left") {
                    // `type X = ...`: the alias is the `left` type.
                    self.defined.push(src(left, text).to_owned());
                }
            }
            "decorated_definition" => {
                if let Some(definition) = node.child_by_field_name("definition") {
                    self.statement(definition, text);
                }
            }
            "expression_statement" => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    self.expression(child, text);
                }
            }
            "import_statement" | "import_from_statement" => self.reexports(node, text),
            "block" => self.block(node, text),
            "if_statement"
            | "elif_clause"
            | "else_clause"
            | "try_statement"
            | "except_clause"
            | "except_group_clause"
            | "finally_clause"
            | "with_statement" => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if matches!(
                        child.kind(),
                        "block"
                            | "elif_clause"
                            | "else_clause"
                            | "except_clause"
                            | "except_group_clause"
                            | "finally_clause"
                    ) {
                        self.statement(child, text);
                    }
                }
            }
            _ => {}
        }
    }

    fn expression(&mut self, node: Node, text: &str) {
        match node.kind() {
            "assignment" => {
                let (Some(left), right) = (node.child_by_field_name("left"), node.child_by_field_name("right")) else {
                    return;
                };
                if src(left, text) == "__all__" {
                    if let Some(right) = right {
                        self.all = Some(Vec::new());
                        self.extend_all(right, text);
                    }
                    return;
                }
                self.targets(left, text);
                // `a = b = 1`
                if let Some(right) = right.filter(|r| r.kind() == "assignment") {
                    self.expression(right, text);
                }
            }
            "augmented_assignment" => {
                let left = node.child_by_field_name("left");
                if left.is_some_and(|l| src(l, text) == "__all__")
                    && let Some(right) = node.child_by_field_name("right")
                {
                    self.extend_all(right, text);
                }
            }
            // `__all__.extend([...])`, `__all__.append("name")`
            "call" => {
                let function = node.child_by_field_name("function").map(|f| src(f, text));
                if !matches!(function, Some("__all__.extend" | "__all__.append")) {
                    return;
                }
                let Some(args) = node.child_by_field_name("arguments") else { return };
                let mut cursor = args.walk();
                for arg in args.named_children(&mut cursor) {
                    self.extend_all(arg, text);
                }
            }
            _ => {}
        }
    }

    /// Names bound by an assignment target: `a`, `a, b`, `(a, b)`, `[a, b]`.
    fn targets(&mut self, node: Node, text: &str) {
        match node.kind() {
            "identifier" => self.defined.push(src(node, text).to_owned()),
            "pattern_list" | "tuple_pattern" | "list_pattern" => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    self.targets(child, text);
                }
            }
            _ => {}
        }
    }

    /// Adds the string literals of `node` (a list, tuple, string or a `+` of them) to `__all__`.
    fn extend_all(&mut self, node: Node, text: &str) {
        let all = self.all.get_or_insert_with(Vec::new);
        match node.kind() {
            "string" => match string_value(node, text) {
                Some(name) => all.push(name),
                None => self.dynamic = true,
            },
            "list" | "tuple" | "parenthesized_expression" | "binary_operator" => {
                let mut cursor = node.walk();
                let children: Vec<Node> = node.named_children(&mut cursor).collect();
                for child in children {
                    self.extend_all(child, text);
                }
            }
            _ => self.dynamic = true,
        }
    }

    /// `import a as a` and `from m import a as a`: re-exported in a stub, and by convention in a module.
    fn reexports(&mut self, node: Node, text: &str) {
        let mut cursor = node.walk();
        for item in node.children_by_field_name("name", &mut cursor) {
            if item.kind() != "aliased_import" {
                continue;
            }
            let (Some(name), Some(alias)) = (item.child_by_field_name("name"), item.child_by_field_name("alias"))
            else {
                continue;
            };
            if src(name, text) == src(alias, text) {
                self.defined.push(src(alias, text).to_owned());
            }
        }
    }
}

/// The content of a plain string literal; none for f-strings and strings with escapes.
fn string_value(node: Node, text: &str) -> Option<String> {
    let mut cursor = node.walk();
    let parts: Vec<Node> = node.children(&mut cursor).collect();
    let start = parts.iter().find(|p| p.kind() == "string_start")?;
    let end = parts.iter().find(|p| p.kind() == "string_end")?;
    if src(*start, text).chars().any(|c| matches!(c, 'f' | 'F' | 'b' | 'B'))
        || parts.iter().any(|p| matches!(p.kind(), "interpolation" | "escape_sequence"))
    {
        return None;
    }
    text.get(start.end_byte()..end.start_byte()).map(str::to_owned)
}

fn is_public(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_alphabetic()) && chars.all(|c| c == '_' || c.is_alphanumeric())
}

fn src<'a>(node: Node, text: &'a str) -> &'a str {
    text.get(node.byte_range()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exports(text: &str) -> Vec<String> {
        Syntax::new().python_exports(text)
    }

    #[test]
    fn without_all_the_public_top_level_definitions() {
        let text = "\
\"\"\"Docs.

Example = 1 inside a docstring
\"\"\"
import os
from typing import Any
from .colors import Normalize as Normalize
import numpy as np

CONSTANT = 1
_private = 2
a, (b, _c) = 1, (2, 3)
x = y = 0
annotated: int = 3
type Alias = int

def function(): pass
async def coroutine(): pass

@decorator
class Figure:
    nested = 1
    def method(self): pass

def _helper(): pass

if sys.version_info >= (3, 11):
    def modern(): pass
else:
    def legacy(): pass

try:
    from fast import speedup
except ImportError:
    def speedup(): pass
";
        assert_eq!(
            exports(text),
            [
                "Alias",
                "CONSTANT",
                "Figure",
                "Normalize",
                "a",
                "annotated",
                "b",
                "coroutine",
                "function",
                "legacy",
                "modern",
                "speedup",
                "x",
                "y"
            ]
        );
    }

    #[test]
    fn all_lists_the_exports() {
        // `langchain/agents/__init__.py`: the name is defined in a private submodule.
        let text = "\
from langchain.agents.factory import create_agent
from langchain.agents.middleware.types import AgentState

__all__ = [
    \"AgentState\",
    \"create_agent\",
]
def not_exported(): pass
";
        assert_eq!(exports(text), ["AgentState", "create_agent"]);
        assert_eq!(
            exports("__all__ = ('a',)\n__all__ += ['b']\n__all__.extend(['c'])\n__all__.append('d')\n"),
            ["a", "b", "c", "d"]
        );
        assert_eq!(exports("__all__ = ['a', '_b'] + ['c']\n"), ["a", "c"]);
    }

    #[test]
    fn a_computed_all_adds_the_definitions() {
        let text = "from .core import *\nfrom . import core\n__all__ = core.__all__ + ['extra']\ndef extra(): pass\ndef more(): pass\n";
        assert_eq!(exports(text), ["extra", "more"]);
    }

    #[test]
    fn an_empty_all_exports_nothing() {
        assert!(exports("__all__ = []\ndef hidden(): pass\n").is_empty());
    }
}
