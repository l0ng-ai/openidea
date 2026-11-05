//! A compact text rendering of a [`FileSummary`] for golden tests.
//!
//! One line per declaration and member, with every field that the summary
//! stores. `@l:c-l:c` is the name's range and `[l:c-l:c]` the declaration's
//! (0-based lines, UTF-16 columns).

use std::fmt::Write;

use super::{ClassLike, ConstantKind, FileSummary, Loc, Param, Property, TraitRule, TypeHint, Visibility};

pub(super) fn render(summary: &FileSummary) -> String {
    let mut out = String::new();
    if summary.has_errors {
        out.push_str("! has errors\n");
    }
    for class in &summary.class_likes {
        class_like(&mut out, class);
    }
    for function in &summary.functions {
        attributes(&mut out, "", &function.attributes);
        let by_ref = if function.by_ref_return { "&" } else { "" };
        let _ = writeln!(
            out,
            "function {by_ref}{}({}){} {} {}",
            function.fqn,
            params(&function.params),
            return_type(&function.return_type),
            name_loc(function.name_loc),
            decl_loc(function.loc)
        );
    }
    for constant in &summary.constants {
        attributes(&mut out, "", &constant.attributes);
        let keyword = match constant.kind {
            ConstantKind::Const => "const",
            ConstantKind::Define => "define",
        };
        let _ = writeln!(
            out,
            "{keyword} {} = {} {} {}",
            constant.fqn,
            constant.value,
            name_loc(constant.name_loc),
            decl_loc(constant.loc)
        );
    }
    out
}

fn pos(loc: Loc) -> String {
    let Loc { range, .. } = loc;
    format!("{}:{}-{}:{}", range.start.line, range.start.col, range.end.line, range.end.col)
}

fn name_loc(loc: Loc) -> String {
    format!("@{}", pos(loc))
}

fn decl_loc(loc: Loc) -> String {
    format!("[{}]", pos(loc))
}

fn attributes(out: &mut String, indent: &str, names: &[String]) {
    if !names.is_empty() {
        let _ = writeln!(out, "{indent}#[{}]", names.join(", "));
    }
}

fn return_type(hint: &Option<TypeHint>) -> String {
    hint.as_ref().map(|hint| format!(": {hint}")).unwrap_or_default()
}

fn set_visibility(visibility: Option<Visibility>) -> String {
    visibility.map(|visibility| format!(" {}(set)", visibility.as_str())).unwrap_or_default()
}

fn param(param: &Param) -> String {
    let mut out = String::new();
    if !param.attributes.is_empty() {
        let _ = write!(out, "#[{}] ", param.attributes.join(", "));
    }
    if let Some(promotion) = &param.promoted {
        out.push_str(promotion.visibility.as_str());
        out.push_str(&set_visibility(promotion.set_visibility));
        out.push(' ');
        if promotion.is_readonly {
            out.push_str("readonly ");
        }
    }
    if let Some(hint) = &param.type_hint {
        let _ = write!(out, "{hint} ");
    }
    if param.by_ref {
        out.push('&');
    }
    if param.variadic {
        out.push_str("...");
    }
    let _ = write!(out, "${}", param.name);
    if let Some(default) = &param.default {
        let _ = write!(out, " = {default}");
    }
    out
}

fn params(params: &[Param]) -> String {
    params.iter().map(param).collect::<Vec<_>>().join(", ")
}

fn flags(out: &mut String, flags: &[(bool, &str)]) {
    for (set, name) in flags {
        if *set {
            out.push(' ');
            out.push_str(name);
        }
    }
}

fn property(out: &mut String, property: &Property) {
    attributes(out, "  ", &property.attributes);
    let mut line = format!("  property {}{}", property.visibility.as_str(), set_visibility(property.set_visibility));
    flags(
        &mut line,
        &[
            (property.is_static, "static"),
            (property.is_abstract, "abstract"),
            (property.is_final, "final"),
            (property.is_readonly, "readonly"),
            (property.is_promoted, "promoted"),
            (property.has_hooks, "hooked"),
        ],
    );
    if let Some(hint) = &property.type_hint {
        let _ = write!(line, " {hint}");
    }
    let _ = write!(line, " ${}", property.name);
    if let Some(default) = &property.default {
        let _ = write!(line, " = {default}");
    }
    let _ = writeln!(out, "{line} {} {}", name_loc(property.name_loc), decl_loc(property.loc));
}

fn class_like(out: &mut String, class: &ClassLike) {
    attributes(out, "", &class.attributes);
    let mut header = format!("{} {}", class.kind.as_str(), class.fqn);
    flags(
        &mut header,
        &[
            (class.modifiers.is_abstract, "abstract"),
            (class.modifiers.is_final, "final"),
            (class.modifiers.is_readonly, "readonly"),
        ],
    );
    if let Some(backing) = &class.backing_type {
        let _ = write!(header, ": {backing}");
    }
    let _ = writeln!(out, "{header} {} {}", name_loc(class.name_loc), decl_loc(class.loc));
    if !class.extends.is_empty() {
        let _ = writeln!(out, "  extends {}", class.extends.join(", "));
    }
    if !class.implements.is_empty() {
        let _ = writeln!(out, "  implements {}", class.implements.join(", "));
    }
    for trait_use in &class.trait_uses {
        let _ = writeln!(out, "  use {} {}", trait_use.traits.join(", "), decl_loc(trait_use.loc));
        for rule in &trait_use.rules {
            match rule {
                TraitRule::Insteadof { trait_name, method, instead_of } => {
                    let _ = writeln!(out, "    {trait_name}::{method} insteadof {}", instead_of.join(", "));
                }
                TraitRule::Alias { trait_name, method, visibility, alias } => {
                    let target = trait_name.as_ref().map(|name| format!("{name}::")).unwrap_or_default();
                    let mut line = format!("    {target}{method} as");
                    if let Some(visibility) = visibility {
                        let _ = write!(line, " {}", visibility.as_str());
                    }
                    if let Some(alias) = alias {
                        let _ = write!(line, " {alias}");
                    }
                    let _ = writeln!(out, "{line}");
                }
            }
        }
    }
    for case in &class.cases {
        attributes(out, "  ", &case.attributes);
        let value = case.value.as_ref().map(|value| format!(" = {value}")).unwrap_or_default();
        let _ = writeln!(out, "  case {}{value} {} {}", case.name, name_loc(case.name_loc), decl_loc(case.loc));
    }
    for constant in &class.constants {
        attributes(out, "  ", &constant.attributes);
        let mut line = format!("  const {}", constant.visibility.as_str());
        flags(&mut line, &[(constant.is_final, "final")]);
        if let Some(hint) = &constant.type_hint {
            let _ = write!(line, " {hint}");
        }
        let _ = writeln!(
            out,
            "{line} {} = {} {} {}",
            constant.name,
            constant.value,
            name_loc(constant.name_loc),
            decl_loc(constant.loc)
        );
    }
    for item in &class.properties {
        property(out, item);
    }
    for method in &class.methods {
        attributes(out, "  ", &method.attributes);
        let mut line = format!("  method {}", method.visibility.as_str());
        flags(&mut line, &[(method.is_static, "static"), (method.is_abstract, "abstract"), (method.is_final, "final")]);
        let by_ref = if method.by_ref_return { "&" } else { "" };
        let _ = writeln!(
            out,
            "{line} {by_ref}{}({}){} {} {}",
            method.name,
            params(&method.params),
            return_type(&method.return_type),
            name_loc(method.name_loc),
            decl_loc(method.loc)
        );
    }
}
