//! A compact text rendering of a [`FileSummary`] for golden tests.
//!
//! One line per declaration and member, with every field that the summary
//! stores. `@l:c-l:c` is the name's range and `[l:c-l:c]` the declaration's
//! (0-based lines, UTF-16 columns). Docblock tags follow their declaration,
//! indented one level further and starting with `@`; then the lazy type of
//! a value or an inferred return, starting with `~`.

use std::fmt::Write;

use super::{
    ClassLike, ConstantKind, DocBlock, DocTemplate, DocType, FileSummary, LaravelFacts, Loc, Param, Property,
    PropertyAccess, TraitRule, TypeHint, Variance, Visibility,
};
use crate::meta::{MetaDirectives, MetaValue, OverrideKind};
use crate::types::LazyType;

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
        doc(&mut out, "  ", &function.doc);
        lazy(&mut out, "  ", "returns", &function.inferred_return);
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
        doc(&mut out, "  ", &constant.doc);
        lazy(&mut out, "  ", "type", &constant.value_type);
    }
    meta(&mut out, &summary.meta);
    laravel(&mut out, &summary.laravel);
    out
}

/// Laravel bindings, migrated tables and casts, one per line.
fn laravel(out: &mut String, facts: &LaravelFacts) {
    for binding in &facts.bindings {
        let _ = writeln!(out, "laravel bind '{}' => {}", binding.id, binding.target);
    }
    for table in &facts.tables {
        let columns: Vec<String> = table
            .columns
            .iter()
            .map(|column| format!("{}: {}{}", column.name, if column.nullable { "?" } else { "" }, column.ty))
            .collect();
        let _ = writeln!(out, "laravel table '{}': {}", table.name, columns.join(", "));
    }
    for model in &facts.casts {
        let casts: Vec<String> =
            model.casts.iter().map(|cast| format!("{} => {}", cast.attribute, cast.cast)).collect();
        let _ = writeln!(out, "laravel casts {}: {}", model.class, casts.join(", "));
    }
}

/// `.phpstorm.meta.php` directives, one per line.
fn meta(out: &mut String, meta: &MetaDirectives) {
    let values = |values: &[MetaValue]| values.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ");
    for item in &meta.overrides {
        let kind = match &item.kind {
            OverrideKind::Map(entries) => {
                let entries: Vec<String> = entries.iter().map(|(key, value)| format!("'{key}' => '{value}'")).collect();
                format!("map([{}])", entries.join(", "))
            }
            OverrideKind::Type(index) => format!("type({index})"),
            OverrideKind::ElementType(index) => format!("elementType({index})"),
        };
        let _ = writeln!(out, "meta override {} arg {}: {kind}", item.callee, item.arg);
    }
    for item in &meta.expected_arguments {
        let _ = writeln!(out, "meta expectedArguments {} #{}: {}", item.callee, item.index, values(&item.values));
    }
    for item in &meta.expected_return_values {
        let _ = writeln!(out, "meta expectedReturnValues {}: {}", item.callee, values(&item.values));
    }
    for (name, set) in &meta.arguments_sets {
        let _ = writeln!(out, "meta registerArgumentsSet '{name}': {}", values(set));
    }
    for callee in &meta.exit_points {
        let _ = writeln!(out, "meta exitPoint {callee}");
    }
}

/// A lazy type, as `~ returns: …` or `~ type: …`.
fn lazy(out: &mut String, indent: &str, what: &str, ty: &Option<LazyType>) {
    if let Some(ty) = ty {
        let _ = writeln!(out, "{indent}~ {what}: {ty}");
    }
}

fn template(template: &DocTemplate) -> String {
    let variance = match template.variance {
        Variance::Invariant => "",
        Variance::Covariant => "-covariant",
        Variance::Contravariant => "-contravariant",
    };
    let mut line = format!("@template{variance} {}", template.name);
    if let Some(bound) = &template.bound {
        let _ = write!(line, " of {bound}");
    }
    if let Some(default) = &template.default {
        let _ = write!(line, " = {default}");
    }
    line
}

fn types(out: &mut String, indent: &str, tag: &str, types: &[DocType]) {
    for ty in types {
        let _ = writeln!(out, "{indent}@{tag} {ty}");
    }
}

fn doc(out: &mut String, indent: &str, doc: &Option<Box<DocBlock>>) {
    let Some(doc) = doc else { return };
    if let Some(deprecated) = &doc.deprecated {
        let _ = writeln!(out, "{indent}@deprecated {deprecated}");
    }
    for item in &doc.templates {
        let _ = writeln!(out, "{indent}{}", template(item));
    }
    for alias in &doc.type_aliases {
        match (&alias.ty, &alias.imported_from) {
            (_, Some((class, name))) => {
                let _ = writeln!(out, "{indent}@import-type {name} from {class} as {}", alias.name);
            }
            (Some(ty), None) => {
                let _ = writeln!(out, "{indent}@type {} = {ty}", alias.name);
            }
            (None, None) => {}
        }
    }
    types(out, indent, "extends", &doc.extends);
    types(out, indent, "implements", &doc.implements);
    types(out, indent, "use", &doc.uses);
    types(out, indent, "mixin", &doc.mixins);
    for property in &doc.properties {
        let access = match property.access {
            PropertyAccess::ReadWrite => "",
            PropertyAccess::Read => "-read",
            PropertyAccess::Write => "-write",
        };
        let ty = property.ty.as_ref().map(|ty| format!("{ty} ")).unwrap_or_default();
        let _ = writeln!(out, "{indent}@property{access} {ty}${} {}", property.name, name_loc(property.name_loc));
    }
    for method in &doc.methods {
        let mut line = format!("{indent}@method ");
        if method.is_static {
            line.push_str("static ");
        }
        if let Some(ty) = &method.return_type {
            let _ = write!(line, "{ty} ");
        }
        line.push_str(&method.name);
        if !method.templates.is_empty() {
            let templates: Vec<String> = method
                .templates
                .iter()
                .map(|item| template(item).replacen("@template", "", 1).trim().to_owned())
                .collect();
            let _ = write!(line, "<{}>", templates.join(", "));
        }
        let params: Vec<String> = method
            .params
            .iter()
            .map(|param| {
                let mut text = param.ty.as_ref().map(|ty| format!("{ty} ")).unwrap_or_default();
                if param.by_ref {
                    text.push('&');
                }
                if param.variadic {
                    text.push_str("...");
                }
                let _ = write!(text, "${}", param.name);
                if let Some(default) = &param.default {
                    let _ = write!(text, " = {default}");
                }
                text
            })
            .collect();
        let _ = writeln!(out, "{line}({}) {}", params.join(", "), name_loc(method.name_loc));
    }
    for var in &doc.vars {
        let name = var.name.as_ref().map(|name| format!(" ${name}")).unwrap_or_default();
        let _ = writeln!(out, "{indent}@var {}{name}", var.ty);
    }
    for param in &doc.params {
        let by_ref = if param.by_ref { "&" } else { "" };
        let variadic = if param.variadic { "..." } else { "" };
        let _ = writeln!(out, "{indent}@param {} {by_ref}{variadic}${}", param.ty, param.name);
    }
    if let Some(ty) = &doc.return_type {
        let _ = writeln!(out, "{indent}@return {ty}");
    }
    types(out, indent, "throws", &doc.throws);
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
    doc(out, "    ", &property.doc);
    lazy(out, "    ", "type", &property.default_type);
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
    doc(out, "  ", &class.doc);
    if !class.extends.is_empty() {
        let _ = writeln!(out, "  extends {}", class.extends.join(", "));
    }
    if !class.implements.is_empty() {
        let _ = writeln!(out, "  implements {}", class.implements.join(", "));
    }
    if let Some(repository) = &class.repository {
        let _ = writeln!(out, "  repository {repository}");
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
        doc(out, "    ", &case.doc);
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
        doc(out, "    ", &constant.doc);
        lazy(out, "    ", "type", &constant.value_type);
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
        doc(out, "    ", &method.doc);
        lazy(out, "    ", "returns", &method.inferred_return);
    }
}
