use super::members::ClassMembers;
use super::{Adjustment, ChainFacts, TextEdit};
use crate::Rejection;
use ide_syntax::SyntaxTree;
use std::collections::HashSet;
use tree_sitter::Node;

/// Where a node sits relative to the chain's lambdas.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Ctx {
    /// Evaluated in the frame itself.
    Chain,
    /// Compiled into a lambda, outside the frame's class.
    Lambda,
    /// Inside a class body nested in the chain: names resolve against that class.
    Nested,
}

pub(super) struct Collector<'a, 't> {
    pub(super) t: &'a SyntaxTree<'t>,
    pub(super) chain: Node<'t>,
    /// Innermost first.
    pub(super) classes: Vec<ClassMembers<'t>>,
    pub(super) declared: HashSet<&'t str>,
    pub(super) facts: ChainFacts,
}

fn is_reserved(name: &str) -> bool {
    name.starts_with("__oi") || name.starts_with("__c_") || name == "__r"
}

impl<'t> Collector<'_, 't> {
    pub(super) fn text(&self, n: Node) -> &'t str {
        &self.t.text[n.byte_range()]
    }

    pub(super) fn block(&mut self, reason: Rejection) {
        if !self.facts.blockers.contains(&reason) {
            self.facts.blockers.push(reason);
        }
    }

    /// `start..end` are file bytes.
    pub(super) fn edit_range(&mut self, start: usize, end: usize, text: String, adjustment: Adjustment) {
        let base = self.chain.start_byte();
        self.facts.edits.push(TextEdit { start: start - base, end: end - base, text, adjustment });
    }

    fn replace(&mut self, n: Node, text: String, adjustment: Adjustment) {
        self.edit_range(n.start_byte(), n.end_byte(), text, adjustment);
    }

    pub(super) fn visit(&mut self, n: Node<'t>, ctx: Ctx) {
        match n.kind() {
            "identifier" => {
                let name = self.text(n);
                if is_reserved(name) {
                    self.block(Rejection::ReservedIdentifier { name: name.into() });
                }
                if ctx == Ctx::Lambda
                    && is_variable_use(n)
                    && let Some(with) = self.static_field(name)
                {
                    self.replace(n, with.clone(), Adjustment::StaticQualified { name: name.into(), with });
                }
            }
            // tree-sitter parses switch statements as `switch_expression` too.
            "switch_expression" if !is_statement(n) => self.block(Rejection::SwitchExpression),
            "lambda_expression" => self.drop_param_types(n),
            "method_invocation" if ctx == Ctx::Lambda => self.call_in_lambda(n),
            "method_reference" if ctx != Ctx::Nested => self.method_reference(n),
            "instanceof_expression" => self.pattern(n, ctx),
            _ => {}
        }
        let mut cursor = n.walk();
        for child in n.children(&mut cursor) {
            let child_ctx = match n.kind() {
                "class_body" => Ctx::Nested,
                "lambda_expression" if ctx == Ctx::Chain && n.child_by_field_name("body") == Some(child) => Ctx::Lambda,
                _ => ctx,
            };
            self.visit(child, child_ctx);
        }
    }

    /// The qualified name for `name` when the nearest class declaring a
    /// field of that name declares it static.
    pub(super) fn static_field(&self, name: &str) -> Option<String> {
        if self.declared.contains(name) {
            return None;
        }
        let class = self.classes.iter().find(|c| c.fields.iter().any(|(f, _)| *f == name))?;
        class.fields.iter().any(|&(f, is_static)| f == name && is_static).then(|| format!("{}.{name}", class.path))
    }

    /// Rule 2: `(Integer a, final Integer b) ->` becomes `(a, b) ->`.
    fn drop_param_types(&mut self, lambda: Node<'t>) {
        let Some(params) = lambda.child_by_field_name("parameters").filter(|p| p.kind() == "formal_parameters") else {
            return;
        };
        let mut cursor = params.walk();
        let names: Vec<_> = params
            .named_children(&mut cursor)
            .filter_map(|p| match p.kind() {
                "formal_parameter" => p.child_by_field_name("name"),
                "spread_parameter" => {
                    let mut cursor = p.walk();
                    let declarator = p.named_children(&mut cursor).find(|c| c.kind() == "variable_declarator");
                    declarator.and_then(|d| d.child_by_field_name("name"))
                }
                _ => None,
            })
            .map(|n| self.text(n))
            .collect();
        // `() ->` is an empty `formal_parameters` too.
        if names.is_empty() {
            return;
        }
        self.replace(params, format!("({})", names.join(", ")), Adjustment::LambdaParamTypesRemoved);
    }

    /// Rules 4 and 5 for a call compiled into a lambda.
    fn call_in_lambda(&mut self, call: Node<'t>) {
        let Some(name_node) = call.child_by_field_name("name") else { return };
        let name = self.text(name_node);
        let class = match call.child_by_field_name("object") {
            None => self.classes.iter().find(|c| c.methods.iter().any(|m| m.name == name)),
            Some(o) if o.kind() == "this" => self.classes.first(),
            Some(_) => return,
        };
        let Some(class) = class else { return };
        let overloads: Vec<_> = class.methods.iter().filter(|m| m.name == name).collect();
        if overloads.iter().any(|m| m.private) {
            self.block(Rejection::PrivateMethodInLambda { name: name.into() });
        } else if call.child_by_field_name("object").is_none() && overloads.iter().all(|m| m.is_static) {
            let with = format!("{}.{name}", class.path);
            let adjustment = Adjustment::StaticQualified { name: name.into(), with: with.clone() };
            self.replace(name_node, with, adjustment);
        }
    }

    /// Rule 5 for method references, which are lambdas wherever they appear.
    fn method_reference(&mut self, r: Node<'t>) {
        let Some(receiver) = r.child(0) else { return };
        match receiver.kind() {
            "super" => self.block(Rejection::SuperMethodReference),
            "this" => {
                let Some(name) = r.named_child(r.named_child_count().saturating_sub(1)) else { return };
                let name = self.text(name);
                let private =
                    self.classes.first().is_some_and(|c| c.methods.iter().any(|m| m.name == name && m.private));
                if private {
                    self.block(Rejection::PrivateMethodInLambda { name: name.into() });
                }
            }
            _ => {}
        }
    }
}

fn is_statement(n: Node) -> bool {
    n.parent().is_some_and(|p| match p.kind() {
        "block"
        | "switch_block_statement_group"
        | "labeled_statement"
        | "if_statement"
        | "while_statement"
        | "do_statement" => true,
        // Their header slots hold expressions.
        "for_statement" | "enhanced_for_statement" => p.child_by_field_name("body") == Some(n),
        _ => false,
    })
}

/// An identifier naming a variable, not a member after `.`, a declaration,
/// a label, a method or an enum `case`.
pub(super) fn is_variable_use(n: Node) -> bool {
    let Some(p) = n.parent() else { return false };
    let is_field = |field: &str| p.child_by_field_name(field) == Some(n);
    match p.kind() {
        "method_invocation"
        | "variable_declarator"
        | "formal_parameter"
        | "catch_formal_parameter"
        | "enhanced_for_statement"
        | "resource"
        | "instanceof_expression"
        | "marker_annotation"
        | "annotation" => !is_field("name"),
        "field_access" => !is_field("field"),
        "lambda_expression" => !is_field("parameters"),
        "method_reference"
        | "inferred_parameters"
        | "labeled_statement"
        | "break_statement"
        | "continue_statement"
        | "switch_label"
        | "type_pattern"
        | "record_pattern"
        | "record_pattern_component"
        | "scoped_identifier"
        | "element_value_pair" => false,
        _ => true,
    }
}
