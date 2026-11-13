//! Outline / symbol extraction driven by `queries/<lang>/outline.scm`.
//!
//! Capture vocabulary:
//! - `@def.<kind>`: a definition; shown in the outline and emitted as a [`SymbolTag`].
//! - `@outline.<kind>`: shown in the outline only (JSON keys, Markdown headings, ...).
//! - `@name`: the identifier (several `@name` captures are joined with `.`).
//! - `@detail`: short extra text (signature, value).
//! - `@trait`: Rust `impl Trait for Type`.
//! - `@container`: explicit container for tags (Go method receivers).
//!
//! Kinds: class interface struct enum enum_member trait function method
//! constructor field property variable constant module namespace package type
//! macro event operator key heading impl extension.

use super::Grammar;
use super::lines::{LineIndex, shift_range};
use crate::SymbolTag;
use ide_core::{LanguageId, OutlineItem, Pos, SymbolKind, Visibility};
use std::collections::HashMap;
use tree_sitter::{Node, Query, QueryCursor, StreamingIterator, Tree};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ItemKind {
    Symbol(SymbolKind),
    /// Rust `impl` block: named `impl [Trait for] Type`, contains methods of `Type`.
    Impl,
    /// Swift/Kotlin/Dart `extension`: contains members of the extended type.
    Extension,
    Heading,
}

impl ItemKind {
    fn parse(s: &str) -> Option<Self> {
        use SymbolKind as K;
        Some(Self::Symbol(match s {
            "class" => K::Class,
            "interface" => K::Interface,
            "struct" => K::Struct,
            "enum" => K::Enum,
            "enum_member" => K::EnumMember,
            "trait" => K::Trait,
            "function" => K::Function,
            "method" => K::Method,
            "constructor" => K::Constructor,
            "field" => K::Field,
            "property" => K::Property,
            "variable" => K::Variable,
            "constant" => K::Constant,
            "module" => K::Module,
            "namespace" => K::Namespace,
            "package" => K::Package,
            "type" => K::TypeAlias,
            "macro" => K::Macro,
            "event" => K::Event,
            "operator" => K::Operator,
            "key" => K::Key,
            "impl" => return Some(Self::Impl),
            "extension" => return Some(Self::Extension),
            "heading" => return Some(Self::Heading),
            _ => return None,
        }))
    }

    fn symbol_kind(self) -> SymbolKind {
        match self {
            Self::Symbol(k) => k,
            Self::Impl | Self::Extension => SymbolKind::Namespace,
            Self::Heading => SymbolKind::Key,
        }
    }

    /// Whether functions declared directly inside are methods.
    fn holds_methods(self) -> bool {
        match self {
            Self::Impl | Self::Extension => true,
            Self::Symbol(k) => matches!(
                k,
                SymbolKind::Class | SymbolKind::Interface | SymbolKind::Struct | SymbolKind::Enum | SymbolKind::Trait
            ),
            Self::Heading => false,
        }
    }
}

#[derive(Clone, Copy)]
enum Role {
    Def { kind: ItemKind, tag: bool },
    Name,
    Detail,
    Trait,
    Container,
    Ignore,
}

pub(crate) struct OutlineQuery {
    query: Query,
    roles: Vec<Role>,
    /// Whether any pattern yields symbol tags (`@def.*`).
    pub(crate) has_tags: bool,
}

impl OutlineQuery {
    pub(crate) fn new(language: &tree_sitter::Language, source: &str) -> Result<Self, String> {
        let query = Query::new(language, source).map_err(|e| e.to_string())?;
        let mut roles = Vec::new();
        for name in query.capture_names() {
            let role = if let Some(k) = name.strip_prefix("def.") {
                Role::Def { kind: ItemKind::parse(k).ok_or_else(|| format!("unknown kind @{name}"))?, tag: true }
            } else if let Some(k) = name.strip_prefix("outline.") {
                Role::Def { kind: ItemKind::parse(k).ok_or_else(|| format!("unknown kind @{name}"))?, tag: false }
            } else {
                match *name {
                    "name" => Role::Name,
                    "detail" => Role::Detail,
                    "trait" => Role::Trait,
                    "container" => Role::Container,
                    _ if name.starts_with('_') => Role::Ignore,
                    other => return Err(format!("unknown capture @{other}")),
                }
            };
            roles.push(role);
        }
        let has_tags = roles.iter().any(|r| matches!(r, Role::Def { tag: true, .. }));
        Ok(Self { query, roles, has_tags })
    }
}

struct Raw {
    node_id: usize,
    pattern: usize,
    start: usize,
    end: usize,
    range: ide_core::Range,
    sel: ide_core::Range,
    kind: ItemKind,
    tag: bool,
    name: String,
    /// Name used as `container` for nested symbols.
    container_name: String,
    explicit_container: Option<String>,
    detail: Option<String>,
    /// From a modifier keyword in the declaration (`pub`, `private`, ...).
    visibility: Option<Visibility>,
    /// Rust `impl Trait for Type`: members take the trait's visibility.
    trait_impl: bool,
}

struct Built {
    raw: Raw,
    kind: SymbolKind,
    visibility: Option<Visibility>,
    children: Vec<Built>,
}

fn collect(g: &Grammar, q: &OutlineQuery, tree: &Tree, text: &str) -> Vec<Built> {
    let idx = LineIndex::new(text);
    let src = text.as_bytes();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&q.query, tree.root_node(), src);
    let mut by_node: HashMap<usize, Raw> = HashMap::new();
    while let Some(m) = matches.next() {
        let mut def: Option<(Node, ItemKind, bool)> = None;
        let mut names: Vec<Node> = Vec::new();
        let (mut detail, mut trait_, mut container) = (None, None, None);
        for c in m.captures {
            match q.roles[c.index as usize] {
                Role::Def { kind, tag } => def = Some((c.node, kind, tag)),
                Role::Name => names.push(c.node),
                Role::Detail => detail = Some(c.node),
                Role::Trait => trait_ = Some(c.node),
                Role::Container => container = Some(c.node),
                Role::Ignore => {}
            }
        }
        let Some((node, kind, tag)) = def else { continue };
        if names.is_empty() {
            continue;
        }
        names.sort_by_key(|n| n.start_byte());
        names.dedup_by_key(|n| n.id());
        let base = names.iter().map(|n| name_text(n, text)).collect::<Vec<_>>().join(".");
        if base.is_empty() {
            continue;
        }
        let (mut kind, mut base, mut container) =
            (kind, base, container.map(|c| strip_generics(&clean(node_text(&c, text), 120))));
        // C++ out-of-line definitions: `void Widget::draw()` is method `draw` of `Widget`.
        if kind == ItemKind::Symbol(SymbolKind::Function)
            && let Some((qualifier, last)) = base.rsplit_once("::")
            && !qualifier.is_empty()
        {
            container = Some(strip_generics(qualifier));
            base = last.to_owned();
            kind = ItemKind::Symbol(SymbolKind::Method);
        }
        let trait_impl = kind == ItemKind::Impl && trait_.is_some();
        let name = match (kind, trait_) {
            (ItemKind::Impl, Some(t)) => format!("impl {} for {base}", clean(node_text(&t, text), 120)),
            (ItemKind::Impl, None) => format!("impl {base}"),
            _ => base.clone(),
        };
        let container_name = match kind {
            ItemKind::Impl | ItemKind::Extension => strip_generics(&base),
            _ => base.clone(),
        };
        let first = names[0];
        let last = names[names.len() - 1];
        let sel = idx.range(first.start_byte(), last.end_byte());
        let raw = Raw {
            node_id: node.id(),
            pattern: m.pattern_index,
            start: node.start_byte(),
            end: trimmed_end(&node, text),
            range: idx.range(node.start_byte(), trimmed_end(&node, text)),
            sel,
            kind,
            tag,
            name,
            container_name,
            explicit_container: container,
            detail: detail.map(|d| clean(node_text(&d, text), 80)).filter(|d| !d.is_empty()),
            visibility: explicit_visibility(&node, text),
            trait_impl,
        };
        match by_node.get(&raw.node_id) {
            Some(existing) if existing.pattern <= raw.pattern => {}
            _ => {
                by_node.insert(raw.node_id, raw);
            }
        }
    }
    let mut raws: Vec<Raw> = by_node.into_values().collect();
    raws.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)).then(a.pattern.cmp(&b.pattern)));
    build_tree(g, raws)
}

fn build_tree(g: &Grammar, raws: Vec<Raw>) -> Vec<Built> {
    // Stack of open items; an item is closed once a raw starts beyond its end.
    let mut roots: Vec<Built> = Vec::new();
    let mut stack: Vec<Built> = Vec::new();
    for raw in raws {
        while let Some(top) = stack.last() {
            if raw.start >= top.raw.start && raw.end <= top.raw.end {
                break;
            }
            let done = stack.pop().unwrap();
            push_child(&mut stack, &mut roots, done);
        }
        let parent_kind = stack.last().map(|p| p.raw.kind);
        let parent_trait_impl = stack.last().is_some_and(|p| p.raw.trait_impl);
        let mut kind = raw.kind.symbol_kind();
        if kind == SymbolKind::Function && parent_kind.is_some_and(ItemKind::holds_methods) {
            kind = SymbolKind::Method;
        }
        if kind == SymbolKind::Method {
            let owner = raw.explicit_container.as_deref().or(stack.last().map(|p| p.raw.container_name.as_str()));
            let in_type = parent_kind.is_some_and(ItemKind::holds_methods) || raw.explicit_container.is_some();
            if in_type && (g.spec.constructors.contains(&raw.name.as_str()) || owner == Some(raw.name.as_str())) {
                kind = SymbolKind::Constructor;
            }
        }
        let visibility = raw
            .visibility
            .or_else(|| implicit_visibility(g.spec.name, raw.kind, kind, &raw.name, parent_kind, parent_trait_impl));
        stack.push(Built { raw, kind, visibility, children: Vec::new() });
    }
    while let Some(done) = stack.pop() {
        push_child(&mut stack, &mut roots, done);
    }
    roots
}

fn push_child(stack: &mut [Built], roots: &mut Vec<Built>, item: Built) {
    match stack.last_mut() {
        Some(parent) => parent.children.push(item),
        None => roots.push(item),
    }
}

pub(crate) fn outline(g: &Grammar, q: &OutlineQuery, tree: &Tree, text: &str) -> Vec<OutlineItem> {
    fn convert(b: Built) -> OutlineItem {
        let detail = b.raw.detail.or(match b.raw.kind {
            ItemKind::Extension => Some("extension".to_owned()),
            _ => None,
        });
        OutlineItem {
            name: b.raw.name,
            detail,
            kind: b.kind,
            range: b.raw.range,
            selection_range: b.raw.sel,
            children: b.children.into_iter().map(convert).collect(),
            visibility: b.visibility,
        }
    }
    collect(g, q, tree, text).into_iter().map(convert).collect()
}

/// [`outline`], plus, for the HTML grammar, each inline `<script>` region's
/// TS/JS declarations nested under its `script` entry and shifted to document
/// coordinates (Vue SFC / HTML documents). `block` outlines one region's
/// language, answering in region-local coordinates.
pub(crate) fn outline_nested(
    g: &Grammar,
    q: &OutlineQuery,
    tree: &Tree,
    text: &str,
    block: &impl Fn(&LanguageId, &str) -> Vec<OutlineItem>,
) -> Vec<OutlineItem> {
    let mut items = outline(g, q, tree, text);
    if g.spec.name != "html" {
        return items;
    }
    let lines = LineIndex::new(text);
    for region in super::sfc::script_regions(tree, text) {
        let mut decls = block(&region.language, &region.text);
        if decls.is_empty() {
            continue;
        }
        let base = lines.pos(region.base);
        shift_outline(&mut decls, base);
        if !attach_script(&mut items, base, &mut Some(decls)) {
            // The region and the entry come from the same `script_element` node,
            // so this means the outline query no longer matches script elements.
            tracing::debug!("outline: no script entry for the <script> region at byte {}", region.base);
        }
    }
    items
}

/// Recursively shifts region-local positions in `items` to document coordinates.
fn shift_outline(items: &mut [OutlineItem], base: Pos) {
    for item in items {
        item.range = shift_range(item.range, base);
        item.selection_range = shift_range(item.selection_range, base);
        shift_outline(&mut item.children, base);
    }
}

/// Nests `decls` under the innermost `script` entry covering `base`. The
/// region and the entry both come from the same `script_element` node, so the
/// entry always exists; a miss means the outline query no longer matches it.
fn attach_script(items: &mut [OutlineItem], base: Pos, decls: &mut Option<Vec<OutlineItem>>) -> bool {
    let covers = |range: &ide_core::Range| {
        (range.start.line, range.start.col) <= (base.line, base.col)
            && (base.line, base.col) < (range.end.line, range.end.col)
    };
    for item in items.iter_mut() {
        if item.name.eq_ignore_ascii_case("script") && covers(&item.range) {
            item.children.extend(decls.take().unwrap_or_default());
            return true;
        }
    }
    for item in items.iter_mut() {
        if attach_script(&mut item.children, base, decls) {
            return true;
        }
    }
    false
}

pub(crate) fn tags(g: &Grammar, q: &OutlineQuery, tree: &Tree, text: &str) -> Vec<SymbolTag> {
    fn walk(items: Vec<Built>, container: Option<&str>, out: &mut Vec<SymbolTag>) {
        for b in items {
            let own_container = b.raw.explicit_container.as_deref().or(container);
            if b.raw.tag && !matches!(b.raw.kind, ItemKind::Impl | ItemKind::Extension | ItemKind::Heading) {
                out.push(SymbolTag {
                    name: b.raw.name.clone(),
                    kind: b.kind,
                    container: own_container.map(str::to_owned),
                    range: b.raw.sel,
                });
            }
            let next = if b.raw.tag || matches!(b.raw.kind, ItemKind::Impl | ItemKind::Extension) {
                Some(b.raw.container_name.as_str())
            } else {
                container
            };
            walk(b.children, next, out);
        }
    }
    let mut out = Vec::new();
    walk(collect(g, q, tree, text), None, &mut out);
    out
}

/// Visibility spelled out by a modifier child (`visibility_modifier`, `modifiers`,
/// `accessibility_modifier`, ...) of the declaration.
fn explicit_visibility(node: &Node, text: &str) -> Option<Visibility> {
    let mut cursor = node.walk();
    let mut found: Option<Visibility> = None;
    for child in node.children(&mut cursor) {
        if !child.kind().contains("modifier") {
            continue;
        }
        let t = node_text(&child, text);
        if child.kind() == "visibility_modifier" && t.starts_with("pub") {
            // Rust: `pub` / `pub(crate)` / `pub(super)` / `pub(in path)`.
            let v = if t.trim() == "pub" { Visibility::Public } else { Visibility::Package };
            found = Some(found.map_or(v, |f| narrower(f, v)));
            continue;
        }
        for word in t.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
            let v = match word {
                "public" | "open" => Visibility::Public,
                "protected" => Visibility::Protected,
                "internal" | "fileprivate" => Visibility::Package,
                "private" => Visibility::Private,
                _ => continue,
            };
            found = Some(found.map_or(v, |f| narrower(f, v)));
        }
    }
    found
}

/// Several keywords (C# `private protected`): the narrower one wins.
fn narrower(a: Visibility, b: Visibility) -> Visibility {
    let rank = |v: Visibility| match v {
        Visibility::Public => 0,
        Visibility::Protected => 1,
        Visibility::Package => 2,
        Visibility::Private => 3,
    };
    if rank(a) >= rank(b) { a } else { b }
}

/// The language's default when no modifier is written.
fn implicit_visibility(
    lang: &str,
    item: ItemKind,
    kind: SymbolKind,
    name: &str,
    parent: Option<ItemKind>,
    parent_trait_impl: bool,
) -> Option<Visibility> {
    use SymbolKind as K;
    if matches!(item, ItemKind::Impl | ItemKind::Extension | ItemKind::Heading)
        || matches!(kind, K::EnumMember | K::Package | K::Namespace)
    {
        return None;
    }
    let in_interface = matches!(parent, Some(ItemKind::Symbol(K::Interface | K::Trait)));
    match lang {
        "rust" => (!in_interface && !parent_trait_impl && kind != K::Macro).then_some(Visibility::Private),
        "java" => (!in_interface).then_some(Visibility::Package),
        "csharp" => match parent {
            _ if in_interface => None,
            Some(ItemKind::Symbol(K::Class | K::Struct | K::Enum)) => Some(Visibility::Private),
            _ => Some(Visibility::Package),
        },
        "go" => name.starts_with(|c: char| c.is_lowercase() || c == '_').then_some(Visibility::Package),
        "python" => {
            (name.starts_with('_') && !(name.starts_with("__") && name.ends_with("__"))).then_some(Visibility::Private)
        }
        "dart" => name.starts_with('_').then_some(Visibility::Private),
        "typescript" | "tsx" | "javascript" => name.starts_with('#').then_some(Visibility::Private),
        _ => None,
    }
}

/// Copies tree-sitter visibility onto language-server symbols (which carry none),
/// matching by name and identifier start.
pub fn merge_visibility(target: &mut [OutlineItem], source: &[OutlineItem]) {
    fn index(items: &[OutlineItem], out: &mut HashMap<(ide_core::Pos, String), Visibility>) {
        for i in items {
            if let Some(v) = i.visibility {
                out.insert((i.selection_range.start, i.name.clone()), v);
            }
            index(&i.children, out);
        }
    }
    fn apply(items: &mut [OutlineItem], map: &HashMap<(ide_core::Pos, String), Visibility>) {
        for i in items {
            if i.visibility.is_none() {
                i.visibility = map.get(&(i.selection_range.start, i.name.clone())).copied();
            }
            apply(&mut i.children, map);
        }
    }
    let mut map = HashMap::new();
    index(source, &mut map);
    if !map.is_empty() {
        apply(target, &map);
    }
}

/// End of `node` without trailing whitespace (C macros and others include the newline).
fn trimmed_end(node: &Node, text: &str) -> usize {
    let (s, e) = (node.start_byte(), node.end_byte());
    text.get(s..e).map_or(e, |t| s + t.trim_end().len())
}

fn node_text<'t>(n: &Node, text: &'t str) -> &'t str {
    text.get(n.start_byte()..n.end_byte()).unwrap_or_default()
}

fn name_text(n: &Node, text: &str) -> String {
    let t = node_text(n, text);
    // Ruby / Elixir symbols: `:total` -> `total`.
    let t = if matches!(n.kind(), "simple_symbol" | "atom") { t.trim_start_matches(':') } else { t };
    clean(t, 120)
}

/// Collapses whitespace runs, strips surrounding quotes and truncates to `max` chars.
fn clean(s: &str, max: usize) -> String {
    let s = s.trim();
    let s = s
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .or_else(|| s.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')))
        .or_else(|| s.strip_prefix('`').and_then(|r| r.strip_suffix('`')))
        .unwrap_or(s);
    let mut out = String::with_capacity(s.len().min(max + 1));
    let mut count = 0;
    let mut pending_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        if count >= max {
            out.push('…');
            break;
        }
        out.push(c);
        count += 1;
    }
    out
}

/// `Foo<T>` -> `Foo`, `*Foo` -> `Foo`, `&mut Foo` -> `Foo`.
fn strip_generics(s: &str) -> String {
    let s = s.trim_start_matches(['*', '&']).trim_start_matches("mut ").trim();
    let end = s.find(['<', '[', '(']).unwrap_or(s.len());
    s[..end].trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_names() {
        assert_eq!(clean("  \"a  b\n c\" ", 80), "a b c");
        assert_eq!(clean("abcdef", 3), "abc…");
        assert_eq!(strip_generics("Foo<T: Clone>"), "Foo");
        assert_eq!(strip_generics("*Server"), "Server");
    }
}
