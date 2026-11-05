//! Module facts of a TS/JS source (see `docs/vue-ts-semantic-index.md`):
//! declarations, imports and re-exports walked directly off the tree —
//! the kinds are stable across the bundled grammar versions (dumped
//! 2026-11-05, see the plan's §17). Name nodes differ by declaration:
//! `identifier` for functions/variables/enums, `type_identifier` for
//! classes/interfaces/type aliases — both are matched.
//!
//! Only module-level declarations are taken (the program's direct
//! children); locals belong to the scope analysis in `ide-syntax`.

use super::lines::LineIndex;
use crate::{Decl, Facts, Import, ImportName, Reexport, ScriptRegion};
use ide_core::{Range, SymbolKind};
use tree_sitter::{Node, Tree};

/// Extracts the facts of one TS/JS source text. `idx` indexes the document
/// the text belongs to and `base` is the text's byte offset into it (0 for a
/// whole file, the block offset for a `<script>` region): ranges come out
/// document-absolute — the region's first line maps onto the document line
/// containing `base`, columns carry over (one conversion, E8).
pub(crate) fn facts(tree: &Tree, text: &str, region: &ScriptRegion) -> Facts {
    let local = LineIndex::new(text);
    let doc_range = |n: Node| -> Range {
        let r = local.range(n.start_byte(), n.end_byte());
        region.shift(r)
    };
    let mut out = Facts::default();
    let mut c = tree.root_node().walk();
    for n in tree.root_node().children(&mut c) {
        match n.kind() {
            "import_statement" => import_statement(n, text, &doc_range, &mut out),
            "export_statement" => export_statement(n, text, &doc_range, &mut out),
            "function_declaration"
            | "class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration" => declaration(n, text, &doc_range, &mut out, false),
            "lexical_declaration" => {
                let mut c = n.walk();
                for ch in n.children(&mut c).filter(|ch| ch.kind() == "variable_declarator") {
                    declaration(ch, text, &doc_range, &mut out, false);
                }
            }
            _ => {}
        }
    }
    out
}

/// A declaration's name node: `identifier` or `type_identifier` (see module docs).
fn name_node<'t>(n: Node<'t>) -> Option<Node<'t>> {
    let mut c = n.walk();
    n.children(&mut c).find(|ch| matches!(ch.kind(), "identifier" | "type_identifier"))
}

/// The first child of `n` whose kind is in `kinds`, as text.
fn child_text<'t>(n: Node<'t>, text: &'t str, kinds: &[&str]) -> Option<&'t str> {
    let mut c = n.walk();
    n.children(&mut c).find(|ch| kinds.contains(&ch.kind())).and_then(|ch| ch.utf8_text(text.as_bytes()).ok())
}

fn symbol_kind(decl: &str) -> SymbolKind {
    match decl {
        "function_declaration" => SymbolKind::Function,
        "class_declaration" => SymbolKind::Class,
        "interface_declaration" => SymbolKind::Interface,
        "type_alias_declaration" => SymbolKind::TypeAlias,
        "enum_declaration" => SymbolKind::Enum,
        _ => SymbolKind::Variable,
    }
}

/// `import { a as b, c }` / `export { a as b }` specifiers.
fn specifiers(clause: Node, text: &str) -> Vec<ImportName> {
    let mut out = Vec::new();
    let mut c = clause.walk();
    for ch in clause.children(&mut c) {
        if !matches!(ch.kind(), "import_specifier" | "export_specifier") {
            continue;
        }
        // `a as b`: two identifiers; bare `a`: one.
        let mut wc = ch.walk();
        let mut names = ch.children(&mut wc).filter(|g| g.kind() == "identifier");
        let (Some(imported), local) = (names.next(), names.next()) else { continue };
        let imported = imported.utf8_text(text.as_bytes()).unwrap_or("");
        out.push(match local {
            Some(local) => ImportName::Named {
                imported: imported.to_string(),
                local: local.utf8_text(text.as_bytes()).unwrap_or("").to_string(),
            },
            None => ImportName::Named { imported: imported.to_string(), local: imported.to_string() },
        });
    }
    out
}

/// The bindings of an `import_clause`: default, named, namespace.
fn import_names(clause: Node, text: &str) -> Vec<ImportName> {
    let mut out = Vec::new();
    let mut c = clause.walk();
    for ch in clause.children(&mut c) {
        match ch.kind() {
            "identifier" => {
                out.push(ImportName::Default { local: ch.utf8_text(text.as_bytes()).unwrap_or("").to_string() })
            }
            "named_imports" => out.extend(specifiers(ch, text)),
            "namespace_import" => {
                if let Some(local) = child_text(ch, text, &["identifier"]) {
                    out.push(ImportName::Namespace { local: local.to_string() });
                }
            }
            _ => {}
        }
    }
    out
}

/// The module specifier of an import/export statement (quotes stripped).
fn source_of<'t>(n: Node<'t>, text: &'t str) -> &'t str {
    let mut c = n.walk();
    n.children(&mut c)
        .find(|ch| ch.kind() == "string")
        .and_then(|s| child_text(s, text, &["string_fragment"]))
        .unwrap_or("")
}

fn import_statement(n: Node, text: &str, range: &impl Fn(Node) -> Range, out: &mut Facts) {
    let mut c = n.walk();
    if let Some(clause) = n.children(&mut c).find(|ch| ch.kind() == "import_clause") {
        out.imports.push(Import {
            names: import_names(clause, text),
            source: source_of(n, text).to_string(),
            range: range(n),
        });
    }
}

fn export_statement(n: Node, text: &str, range: &impl Fn(Node) -> Range, out: &mut Facts) {
    let mut c = n.walk();
    let mut clause = None;
    let mut from = false;
    let mut star = false;
    let mut namespace_export = None;
    let mut decl_node = None;
    let mut default = false;
    for ch in n.children(&mut c) {
        match ch.kind() {
            "export_clause" => clause = Some(ch),
            "from" => from = true,
            "*" => star = true,
            "namespace_export" => namespace_export = Some(ch),
            "default" => default = true,
            k if k.ends_with("_declaration") => decl_node = Some(ch),
            _ => {}
        }
    }
    if from && (clause.is_some() || star || namespace_export.is_some()) {
        // A re-export: `export { x } from`, `export * from`, `export * as ns from`.
        let mut names = clause.map(|c| specifiers(c, text)).unwrap_or_default();
        if star && namespace_export.is_none() {
            names.push(ImportName::Namespace { local: "*".to_string() });
        }
        if let Some(local) = namespace_export.and_then(|ns| child_text(ns, text, &["identifier"])) {
            names.push(ImportName::Namespace { local: local.to_string() });
        }
        out.reexports.push(Reexport { names, source: source_of(n, text).to_string(), range: range(n) });
    } else if let Some(decl) = decl_node {
        // `export <declaration>`: the declaration itself, marked exported
        // (and default when written as `export default …`).
        declaration_default(decl, text, range, out, true, default);
    } else if let Some(clause) = clause {
        // `export { x }` without a source: marks existing declarations exported;
        // the kind is resolved by the consumer matching the name.
        for name in specifiers(clause, text) {
            if let ImportName::Named { imported, .. } = name {
                out.decls.push(Decl {
                    name: imported,
                    kind: SymbolKind::Unknown,
                    range: range(n),
                    exported: true,
                    default: false,
                });
            }
        }
    }
    // `export default <expression>` has no declaration to index; the file
    // itself is the target for component navigation.
}

fn declaration(n: Node, text: &str, range: &impl Fn(Node) -> Range, out: &mut Facts, exported: bool) {
    declaration_default(n, text, range, out, exported, false);
}

/// Like [`declaration`], with the default-export flag: `export default …`.
fn declaration_default(
    n: Node,
    text: &str,
    range: &impl Fn(Node) -> Range,
    out: &mut Facts,
    exported: bool,
    default: bool,
) {
    let Some(name) = name_node(n) else { return };
    out.decls.push(Decl {
        name: name.utf8_text(text.as_bytes()).unwrap_or("").to_string(),
        kind: symbol_kind(n.kind()),
        range: range(name),
        exported,
        default,
    });
}
