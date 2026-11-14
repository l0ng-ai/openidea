//! Python class facts the inheritance inspections need: base names as written, parameter
//! lists, decorator semantics and what a method body does. They come from the syntax tree in
//! one pass, so the frontend reasons about the inheritance graph without parsing source text.
//!
//! Deliberately small: a fact exists here only when a check can decide it without guessing.

use super::lines::LineIndex;
use crate::{LanguageId, Syntax};
use serde::{Deserialize, Serialize};
use specta::Type;
use tree_sitter::{Node, Tree};

/// One Python module's classes, in source order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PythonFacts {
    pub classes: Vec<PythonClassFacts>,
}

/// A class definition and the methods it declares.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PythonClassFacts {
    pub name: String,
    /// The class name identifier (selection range).
    pub selection: crate::Range,
    /// Base names as written, a qualified name reduced to its last segment.
    pub bases: Vec<String>,
    pub methods: Vec<PythonMethodFacts>,
}

/// A method definition the inspections can reason about.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PythonMethodFacts {
    pub name: String,
    /// The method name identifier (selection range).
    pub selection: crate::Range,
    /// Parameter names in order; `None` for a form whose forwarding cannot be compared
    /// (`*args`, `**kwargs`, keyword-only, positional-only).
    pub params: Option<Vec<String>>,
    /// Decorated with `abstractmethod` (`abc.abstractmethod` included).
    pub abstract_method: bool,
    /// Decorated with `override` from `typing` / `typing_extensions`.
    pub override_decorated: bool,
    pub body: MethodBody,
}

/// What a method body does, for the shapes a check can decide without guessing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MethodBody {
    /// `pass`, `...`, a docstring, or nothing at all.
    Empty,
    /// Exactly one `super().name(args)` call, optionally `return`ed.
    SuperCall { returns: bool, target: String, args: Vec<String> },
    /// Anything else.
    Other,
}

impl Syntax {
    /// The classes of a Python `text` with the facts the inheritance checks need.
    /// Every other language returns an empty result.
    pub fn python_facts(&self, lang: &LanguageId, text: &str) -> PythonFacts {
        self.analyze(lang, text, |g, tree, text| (g.spec.name == "python").then(|| extract(tree, text)))
            .unwrap_or_default()
    }
}

fn extract(tree: &Tree, text: &str) -> PythonFacts {
    let idx = LineIndex::new(text);
    let imports = ImportBindings::collect(tree, text);
    let mut classes = Vec::new();
    let mut cursor = tree.walk();
    visit(&mut cursor, &mut |node| {
        if node.kind() != "class_definition" {
            return;
        }
        let Some(name_node) = node.child_by_field_name("name") else { return };
        let name = text_of(name_node, text);
        if name.is_empty() {
            return;
        }
        classes.push(PythonClassFacts {
            name,
            selection: idx.range(name_node.start_byte(), name_node.end_byte()),
            bases: super::inheritance::class_base_names(node, text),
            methods: methods_of(node, text, &idx, &imports),
        });
    });
    PythonFacts { classes }
}

/// The methods declared directly in `class`.
fn methods_of(class: Node, text: &str, idx: &LineIndex, imports: &ImportBindings) -> Vec<PythonMethodFacts> {
    let Some(body) = class.child_by_field_name("body") else { return Vec::new() };
    let mut out = Vec::new();
    let mut cursor = body.walk();
    for member in body.named_children(&mut cursor) {
        // A decorated method is a `decorated_definition` wrapping the `function_definition`.
        let method = match member.kind() {
            "function_definition" => member,
            "decorated_definition" => match member.child_by_field_name("definition") {
                Some(inner) if inner.kind() == "function_definition" => inner,
                _ => continue,
            },
            _ => continue,
        };
        let Some(name_node) = method.child_by_field_name("name") else { continue };
        let name = text_of(name_node, text);
        if name.is_empty() {
            continue;
        }
        let decorators = decorators_of(method, text);
        out.push(PythonMethodFacts {
            name,
            selection: idx.range(name_node.start_byte(), name_node.end_byte()),
            params: parameters_of(method, text),
            abstract_method: decorators.iter().any(|d| last_segment(d) == "abstractmethod"),
            override_decorated: decorators.iter().any(|d| imports.is_typing_override(d)),
            body: body_of(method, text),
        });
    }
    out
}

/// The parameter names of a `function_definition`, or `None` when the signature contains a
/// form whose forwarding cannot be compared without guessing.
fn parameters_of(function: Node, text: &str) -> Option<Vec<String>> {
    let params = function.child_by_field_name("parameters")?;
    let mut names = Vec::new();
    let mut cursor = params.walk();
    for param in params.named_children(&mut cursor) {
        let name = match param.kind() {
            "identifier" => text_of(param, text),
            "typed_parameter" | "default_parameter" | "typed_default_parameter" => {
                let named = param
                    .child_by_field_name("name")
                    .or_else(|| param.child_by_field_name("pattern"))
                    .or_else(|| param.named_child(0))?;
                if named.kind() != "identifier" {
                    return None;
                }
                text_of(named, text)
            }
            // `*args`, `**kwargs`, `/`, `*`: the call form cannot be compared textually.
            _ => return None,
        };
        if !name.is_empty() {
            names.push(name);
        }
    }
    Some(names)
}

/// A `function_definition`'s body, classified into the shapes a check can decide.
fn body_of(function: Node, text: &str) -> MethodBody {
    let Some(body) = function.child_by_field_name("body") else { return MethodBody::Empty };
    // A docstring is not a statement the checks care about.
    let statements: Vec<Node> = statements_of(body).into_iter().filter(|s| !is_string(*s)).collect();
    if statements.is_empty() || statements.iter().all(|s| is_noop(*s)) {
        return MethodBody::Empty;
    }
    let [only] = statements.as_slice() else { return MethodBody::Other };
    let call = match only.kind() {
        "expression_statement" => (only.named_child(0), false),
        "return_statement" => (only.named_child(0), true),
        _ => (None, false),
    };
    match call {
        (Some(call), returns) if is_super_call(call, text) => {
            let target = call
                .child_by_field_name("function")
                .and_then(|f| f.child_by_field_name("attribute"))
                .map(|a| text_of(a, text))
                .unwrap_or_default();
            let args = call
                .child_by_field_name("arguments")
                .map(|args| {
                    let mut cursor = args.walk();
                    args.named_children(&mut cursor).map(|a| text_of(a, text)).collect()
                })
                .unwrap_or_default();
            MethodBody::SuperCall { returns, target, args }
        }
        _ => MethodBody::Other,
    }
}

/// Whether `node` is a `super().name(...)` call.
fn is_super_call(node: Node, text: &str) -> bool {
    if node.kind() != "call" {
        return false;
    }
    let Some(function) = node.child_by_field_name("function") else { return false };
    if function.kind() != "attribute" {
        return false;
    }
    function.child_by_field_name("object").is_some_and(|object| {
        object.kind() == "call"
            && object
                .child_by_field_name("function")
                .is_some_and(|f| f.kind() == "identifier" && text_of(f, text) == "super")
    })
}

/// Whether `statement` is `pass` or a bare `...`.
fn is_noop(statement: Node) -> bool {
    match statement.kind() {
        "pass_statement" => true,
        "expression_statement" => statement.named_child(0).is_some_and(|child| child.kind() == "ellipsis"),
        _ => false,
    }
}

/// A string expression statement: a docstring.
fn is_string(statement: Node) -> bool {
    statement.kind() == "expression_statement" && statement.named_child(0).is_some_and(|child| child.kind() == "string")
}

/// The statements of a `block`, comments excluded.
fn statements_of(block: Node) -> Vec<Node> {
    let mut cursor = block.walk();
    block.named_children(&mut cursor).filter(|child| child.kind() != "comment").collect()
}

/// The decorators written on a definition, without the `@` or the call arguments.
fn decorators_of(definition: Node, text: &str) -> Vec<String> {
    let Some(parent) = definition.parent() else { return Vec::new() };
    if parent.kind() != "decorated_definition" {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = parent.walk();
    for decorator in parent.named_children(&mut cursor) {
        if decorator.kind() != "decorator" {
            continue;
        }
        let Some(inner) = decorator.named_child(0) else { continue };
        let target =
            if inner.kind() == "call" { inner.child_by_field_name("function").unwrap_or(inner) } else { inner };
        let name = text_of(target, text).trim().to_owned();
        if !name.is_empty() {
            out.push(name);
        }
    }
    out
}

/// The last segment of a dotted name (`typing.override` -> `override`).
fn last_segment(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

fn text_of(node: Node, text: &str) -> String {
    text.get(node.byte_range()).unwrap_or_default().to_owned()
}

/// The module-level `from ... import ...` bindings, so `override` can be told apart from a
/// same-named decorator of another library.
struct ImportBindings {
    /// (local name, module, exported name)
    bindings: Vec<(String, String, String)>,
}

impl ImportBindings {
    fn collect(tree: &Tree, text: &str) -> Self {
        let mut bindings = Vec::new();
        let mut cursor = tree.walk();
        visit(&mut cursor, &mut |node| {
            if node.kind() != "import_from_statement" {
                return;
            }
            let Some(module) = node.child_by_field_name("module_name") else { return };
            let module = text_of(module, text);
            let mut names = node.walk();
            for name in node.children_by_field_name("name", &mut names) {
                let (local, exported) = match name.kind() {
                    "aliased_import" => (
                        name.child_by_field_name("alias").map(|n| text_of(n, text)),
                        name.child_by_field_name("name").map(|n| text_of(n, text)),
                    ),
                    _ => {
                        let written = text_of(name, text);
                        (Some(written.clone()), Some(written))
                    }
                };
                if let (Some(local), Some(exported)) = (local, exported) {
                    bindings.push((local, module.clone(), exported));
                }
            }
        });
        Self { bindings }
    }

    /// Whether `decorator` names `override` from `typing` / `typing_extensions`.
    fn is_typing_override(&self, decorator: &str) -> bool {
        const MODULES: [&str; 2] = ["typing", "typing_extensions"];
        let segments: Vec<&str> = decorator.split('.').filter(|s| !s.is_empty()).collect();
        match segments.as_slice() {
            // `@typing.override`, or `@t.override` after `import typing as t`.
            [prefix, "override"] => {
                MODULES.contains(prefix)
                    || self
                        .bindings
                        .iter()
                        .find(|(local, _, _)| local == prefix)
                        .is_some_and(|(_, module, _)| MODULES.contains(&module.as_str()))
            }
            // `@override`, or `@ov` after `from typing import override as ov`.
            [local] => match self.bindings.iter().find(|(bound, _, _)| bound == local) {
                Some((_, module, exported)) => exported == "override" && MODULES.contains(&module.as_str()),
                // Nothing contradicts a bare `@override`: the usual `from typing import *`.
                None => *local == "override",
            },
            _ => false,
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    static SYNTAX: std::sync::OnceLock<Syntax> = std::sync::OnceLock::new();

    fn facts(src: &str) -> PythonFacts {
        SYNTAX.get_or_init(Syntax::new).python_facts(&LanguageId::new("python"), src)
    }

    fn method<'a>(facts: &'a PythonFacts, class: &str, method: &str) -> &'a PythonMethodFacts {
        facts
            .classes
            .iter()
            .find(|c| c.name == class)
            .and_then(|c| c.methods.iter().find(|m| m.name == method))
            .expect("method not found")
    }

    #[test]
    fn classes_carry_bases_and_methods() {
        let f = facts(
            "class Base(ABC):\n    pass\n\nclass Child(Base, pkg.Mixin):\n    def run(self, x=1):\n        pass\n",
        );
        assert_eq!(f.classes.len(), 2);
        assert_eq!(f.classes[0].name, "Base");
        assert_eq!(f.classes[0].bases, ["ABC"]);
        assert_eq!(f.classes[1].bases, ["Base", "Mixin"]);
        assert_eq!(f.classes[1].methods.len(), 1);
        assert_eq!(f.classes[1].selection.start.line, 3);
        assert_eq!(f.classes[1].selection.start.col, 6);
    }

    #[test]
    fn parameters_are_names_in_order_and_none_for_splats() {
        let f = facts(
            "class C:\n    def a(self, x: int, y=2):\n        pass\n\n    def b(self, *args):\n        pass\n\n    def c(self, *, x):\n        pass\n",
        );
        assert_eq!(
            method(&f, "C", "a").params.as_deref(),
            Some(["self".to_string(), "x".to_string(), "y".to_string()].as_slice())
        );
        assert_eq!(method(&f, "C", "b").params, None);
        assert_eq!(method(&f, "C", "c").params, None);
    }

    #[test]
    fn body_shapes_are_classified() {
        let f = facts(
            "class C:\n    def noop(self):\n        pass\n\n    def dots(self):\n        ...\n\n    def doc(self):\n        \"\"\"text\"\"\"\n\n    def forward(self, x):\n        return super().run(x)\n\n    def call(self):\n        super().run()\n\n    def other(self):\n        return 1\n",
        );
        assert_eq!(method(&f, "C", "noop").body, MethodBody::Empty);
        assert_eq!(method(&f, "C", "dots").body, MethodBody::Empty);
        assert_eq!(method(&f, "C", "doc").body, MethodBody::Empty);
        assert_eq!(
            method(&f, "C", "forward").body,
            MethodBody::SuperCall { returns: true, target: "run".into(), args: vec!["x".into()] }
        );
        assert_eq!(
            method(&f, "C", "call").body,
            MethodBody::SuperCall { returns: false, target: "run".into(), args: vec![] }
        );
        assert_eq!(method(&f, "C", "other").body, MethodBody::Other);
    }

    #[test]
    fn decorators_are_their_names_and_semantics() {
        let f = facts(
            "from abc import abstractmethod\nfrom typing import override\n\nclass C:\n    @abstractmethod\n    def a(self):\n        pass\n\n    @override\n    def b(self):\n        pass\n\n    @functools.cache\n    def c(self):\n        pass\n",
        );
        assert!(method(&f, "C", "a").abstract_method);
        assert!(!method(&f, "C", "a").override_decorated);
        assert!(method(&f, "C", "b").override_decorated);
        assert!(!method(&f, "C", "c").override_decorated);
    }

    #[test]
    fn override_of_another_library_is_not_typing_override() {
        let f = facts("from mylib import override\n\nclass C:\n    @override\n    def a(self):\n        pass\n");
        assert!(!method(&f, "C", "a").override_decorated);
    }

    #[test]
    fn aliased_override_and_qualified_forms_are_recognised() {
        let f = facts(
            "from typing import override as ov\n\nclass C:\n    @ov\n    def a(self):\n        pass\n\nclass D:\n    @typing_extensions.override\n    def b(self):\n        pass\n",
        );
        assert!(method(&f, "C", "a").override_decorated);
        assert!(method(&f, "D", "b").override_decorated);
    }

    #[test]
    fn nested_classes_and_other_languages() {
        let f = facts("class Outer:\n    class Inner:\n        def m(self):\n            pass\n");
        let names: Vec<&str> = f.classes.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Outer", "Inner"]);
        let other = SYNTAX.get_or_init(Syntax::new).python_facts(&LanguageId::new("rust"), "class C {}");
        assert_eq!(other.classes.len(), 0);
    }
}
