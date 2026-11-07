//! Rule 8 for record frames, where the evaluator does not apply the file's
//! imports: every type name outside `java.lang` is written fully qualified.

use super::Adjustment;
use super::rules::Collector;
use crate::Rejection;
use crate::qualify::qualify_type;
use ide_syntax::SyntaxTree;
use tree_sitter::Node;

/// Adds the type parameters that declarations inside `chain` introduce.
pub(super) fn declared_type_params(t: &SyntaxTree, chain: Node, out: &mut Vec<String>) {
    if chain.kind() == "type_parameter" {
        let mut cursor = chain.walk();
        let name = chain.named_children(&mut cursor).find(|c| c.kind() == "type_identifier");
        out.extend(name.map(|n| t.text[n.byte_range()].to_string()));
    }
    let mut cursor = chain.walk();
    for child in chain.children(&mut cursor) {
        declared_type_params(t, child, out);
    }
}

impl<'t> Collector<'_, 't> {
    /// How the frame must write the type `simple`; `None`, with a blocker,
    /// when nothing the file can see declares it.
    fn spelled(&mut self, simple: &str) -> Option<String> {
        let Some(imports) = &self.imports else { return Some(simple.into()) };
        let qualified = qualify_type(simple, imports);
        if qualified.is_none() {
            self.block(Rejection::UnqualifiableType { name: simple.into() });
        }
        qualified
    }

    /// `ty`'s text as the frame must write it.
    pub(super) fn type_text(&mut self, ty: Node<'t>) -> Option<String> {
        let mut text = self.text(ty).to_string();
        if self.imports.is_none() {
            return Some(text);
        }
        let mut names = Vec::new();
        self.type_names(ty, &mut names);
        for n in names.into_iter().rev() {
            let with = self.spelled(self.text(n))?;
            text.replace_range(n.start_byte() - ty.start_byte()..n.end_byte() - ty.start_byte(), &with);
        }
        Some(text)
    }

    /// A dotted type name such as a bound's erasure (`Map.Entry`), qualified by its first segment.
    pub(super) fn dotted_type(&mut self, name: &str) -> Option<String> {
        let (first, rest) = name.split_once('.').map_or((name, None), |(first, rest)| (first, Some(rest)));
        let first = self.spelled(first)?;
        Some(rest.map_or(first.clone(), |rest| format!("{first}.{rest}")))
    }

    fn type_names(&self, n: Node<'t>, out: &mut Vec<Node<'t>>) {
        if n.kind() == "type_identifier" && self.names_a_type(n) {
            out.push(n);
        }
        let mut cursor = n.walk();
        for child in n.children(&mut cursor) {
            self.type_names(child, out);
        }
    }

    /// A simple type name, not a type variable, `var`, or a member type after `.`.
    fn names_a_type(&self, n: Node) -> bool {
        let name = self.text(n);
        let declares_or_follows = n.parent().is_some_and(|p| match p.kind() {
            "type_parameter" => true,
            "scoped_type_identifier" => p.named_child(0) != Some(n),
            _ => false,
        });
        name != "var" && !declares_or_follows && !self.type_params.iter().any(|p| p == name)
    }

    pub(super) fn type_identifier(&mut self, n: Node<'t>) {
        if self.imports.is_some() && self.names_a_type(n) && !self.rewritten_by_other_rules(n) {
            self.qualify(n);
        }
    }

    /// `Type` in `Type.m()`, `Type.F` and `Type::m`, told apart from a variable by its capital.
    pub(super) fn type_receiver(&mut self, n: Node<'t>) {
        let Some(p) = n.parent().filter(|_| self.imports.is_some()) else { return };
        let receiver = match p.kind() {
            "method_invocation" | "field_access" => p.child_by_field_name("object") == Some(n),
            "method_reference" => p.named_child(0) == Some(n),
            _ => false,
        };
        let name = self.text(n);
        let variable =
            self.declared.contains(name) || self.classes.iter().any(|c| c.fields.iter().any(|(f, _)| *f == name));
        let capital = name.starts_with(char::is_uppercase);
        if receiver && capital && !variable && !self.type_params.iter().any(|p| p == name) {
            self.qualify(n);
        }
    }

    fn qualify(&mut self, n: Node<'t>) {
        let name = self.text(n);
        if let Some(with) = self.spelled(name).filter(|with| with != name) {
            self.replace(n, with.clone(), Adjustment::TypeQualified { name: name.into(), with });
        }
    }

    /// Lambda parameter types (rule 2 drops them) and `instanceof` pattern
    /// types (rule 6 writes them itself).
    fn rewritten_by_other_rules(&self, n: Node<'t>) -> bool {
        let mut cur = n;
        while let Some(p) = cur.parent().filter(|_| cur != self.chain) {
            match p.kind() {
                "formal_parameters" => return p.parent().is_some_and(|l| l.kind() == "lambda_expression"),
                "instanceof_expression" => {
                    return p.child_by_field_name("right") == Some(cur) && p.child_by_field_name("name").is_some();
                }
                _ => cur = p,
            }
        }
        false
    }
}
