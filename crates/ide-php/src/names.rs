//! PHP name resolution.
//!
//! Every name in a file is resolved the way PHP compiles it:
//!
//! - namespaces, several per file, implicit (`namespace A;`) or braced
//!   (`namespace A { … }`, `namespace { … }` for global code);
//! - `use`, `use function`, `use const` and grouped `use A\{B, function c}`,
//!   with aliases; imports only apply inside their own namespace block;
//! - fully qualified (`\A\B`), qualified (`A\B`, whose first segment may be an
//!   alias) and namespace-relative (`namespace\B`) names;
//! - unqualified functions and constants inside a namespace, which PHP looks up
//!   in the namespace first and then globally ([`Resolution::Fallback`]);
//! - `self`, `static` and `parent`, kept as markers ([`Resolution::Relative`])
//!   that the type layer resolves against the enclosing class later.
//!
//! The alias tables and prefix rules come from `mago-names`
//! ([`NamespaceScope`]); this module adds the walk that knows *what kind* of
//! name each identifier is (which `mago_names::NameResolver` does not report),
//! the global fallback, the relative-class markers, imports and aliases as
//! entries of their own, and a snapshot of the scope at every point of the file
//! so later phases can resolve names found in docblocks.
//!
//! Fully qualified names are stored without the leading `\`, as written
//! (PHP compares class, function and namespace names case-insensitively; see
//! [`fqn_eq`]). Identifiers are bytes in Mago; they become `String`s here,
//! lossily, which is the summary boundary described in `docs/php-engine/spike.md`.

use std::fmt;
use std::sync::Arc;

use ide_core::Range;
use mago_names::kind::NameKind as MagoKind;
use mago_names::scope::{NamespaceScope, is_never_namespaced_function};
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{
    Attribute, Binary, BinaryOperator, Class, ClassConstantAccess, Constant, ConstantAccess, Enum, Expression, Extends,
    Function, FunctionCall, FunctionPartialApplication, Hint, Identifier, Implements, Instantiation, Interface,
    Keyword, LocalIdentifier, Namespace, NamespaceBody, StaticMethodCall, StaticMethodPartialApplication,
    StaticPropertyAccess, Trait, TraitUse, TraitUseAbsoluteMethodReference, TraitUsePrecedenceAdaptation, Use, UseItem,
    UseItems, UseType,
};
use mago_syntax::walker::Walker;

use crate::syntax::{LineIndex, ParsedFile};

/// What a name refers to. It decides which import table applies and whether
/// the global fallback exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NameKind {
    /// Classes, interfaces, traits and enums.
    ClassLike,
    Function,
    Constant,
    /// A namespace name: a `namespace` declaration or the prefix of a group
    /// `use`.
    Namespace,
}

/// How the name occurs in the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NameRole {
    /// The name of a declared namespace, class-like, function or constant.
    Declaration,
    /// The imported name of a `use` item (or a group `use` prefix).
    Import,
    /// The alias of a `use` item (`as Alias`); resolves to the imported name.
    Alias,
    /// Any other use of a name.
    Reference,
}

/// `self`, `static` or `parent`, resolved later against the enclosing class.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum RelativeClass {
    Self_,
    Static,
    Parent,
}

impl RelativeClass {
    /// Recognises `self`, `static` and `parent` in any case.
    pub fn from_name(name: &[u8]) -> Option<Self> {
        if name.eq_ignore_ascii_case(b"self") {
            Some(Self::Self_)
        } else if name.eq_ignore_ascii_case(b"static") {
            Some(Self::Static)
        } else if name.eq_ignore_ascii_case(b"parent") {
            Some(Self::Parent)
        } else {
            None
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Self_ => "self",
            Self::Static => "static",
            Self::Parent => "parent",
        }
    }
}

/// Where a name points.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Resolution {
    /// A fully qualified name, without the leading `\`.
    Fqn(String),
    /// An unqualified function or constant inside a namespace. PHP tries
    /// `namespaced` first and uses `global` when no such symbol exists.
    Fallback { namespaced: String, global: String },
    /// `self`, `static` or `parent`.
    Relative(RelativeClass),
}

impl Resolution {
    /// The fully qualified candidates in lookup order (none for a relative
    /// class).
    pub fn candidates(&self) -> impl Iterator<Item = &str> {
        let (first, second) = match self {
            Self::Fqn(fqn) => (Some(fqn.as_str()), None),
            Self::Fallback { namespaced, global } => (Some(namespaced.as_str()), Some(global.as_str())),
            Self::Relative(_) => (None, None),
        };
        first.into_iter().chain(second)
    }

    /// The first candidate: the name itself, or the namespaced one of a
    /// fallback.
    pub fn primary(&self) -> Option<&str> {
        self.candidates().next()
    }

    /// Whether any candidate is `fqn` (compared as PHP compares `kind` names).
    pub fn matches(&self, kind: NameKind, fqn: &str) -> bool {
        self.candidates().any(|candidate| fqn_eq(kind, candidate, fqn))
    }
}

impl fmt::Display for Resolution {
    /// `App\Foo`, `App\foo|foo` for a fallback, `self` for a marker.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fqn(fqn) => f.write_str(fqn),
            Self::Fallback { namespaced, global } => write!(f, "{namespaced}|{global}"),
            Self::Relative(relative) => f.write_str(relative.as_str()),
        }
    }
}

/// The result of resolving one name in a [`NameScope`].
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Resolved {
    pub resolution: Resolution,
    /// The name went through a `use` import (its first segment is an alias).
    pub imported: bool,
}

/// Compares two fully qualified names the way PHP does for `kind`: class-likes,
/// functions and namespaces ignore ASCII case; a constant's own name is
/// case-sensitive but its namespace part is not.
pub fn fqn_eq(kind: NameKind, a: &str, b: &str) -> bool {
    match kind {
        NameKind::Constant => {
            let (a_ns, a_name) = split_last(a);
            let (b_ns, b_name) = split_last(b);
            a_name == b_name && a_ns.eq_ignore_ascii_case(b_ns)
        }
        _ => a.eq_ignore_ascii_case(b),
    }
}

fn split_last(fqn: &str) -> (&str, &str) {
    match fqn.rfind('\\') {
        Some(i) => (&fqn[..i], &fqn[i + 1..]),
        None => ("", fqn),
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `true`, `false` and `null`: PHP never namespaces them.
fn is_special_constant(name: &[u8]) -> bool {
    [b"true".as_slice(), b"false", b"null"].iter().any(|special| name.eq_ignore_ascii_case(special))
}

/// The namespace and imports in force at one point of a file.
#[derive(Clone, Debug, Default)]
pub struct NameScope {
    namespace: String,
    imports: NamespaceScope,
}

impl NameScope {
    /// Global code with no imports.
    pub fn global() -> Self {
        Self::default()
    }

    /// The scope at the start of `namespace` (empty for global code).
    pub fn for_namespace(namespace: &str) -> Self {
        let namespace = namespace.trim_start_matches('\\');
        Self { namespace: namespace.to_owned(), imports: NamespaceScope::new(Some(namespace.as_bytes().to_vec())) }
    }

    /// The current namespace, empty for global code.
    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    /// Adds the imports of a `use` statement.
    pub fn add_use(&mut self, r#use: &Use<'_>) {
        self.imports.populate_from_use(r#use);
    }

    /// Adds one import, as `use`, `use function` or `use const` would. `alias`
    /// defaults to the last segment of `fqn`.
    pub fn add_import(&mut self, kind: NameKind, fqn: &str, alias: Option<&str>) {
        self.imports.add(mago_kind(kind), fqn.trim_start_matches('\\'), &alias);
    }

    /// Resolves `name` as written in the source (`Foo`, `A\Foo`, `\A\Foo`,
    /// `namespace\Foo`, `self`, …) as a name of `kind`.
    pub fn resolve(&self, kind: NameKind, name: &str) -> Resolved {
        self.resolve_bytes(kind, name.as_bytes())
    }

    fn resolve_bytes(&self, kind: NameKind, name: &[u8]) -> Resolved {
        let fqn = |resolution: String, imported| Resolved { resolution: Resolution::Fqn(resolution), imported };
        if let Some(rest) = name.strip_prefix(b"\\") {
            return fqn(lossy(rest), false);
        }
        if kind == NameKind::Namespace {
            return fqn(lossy(name), false);
        }
        if kind == NameKind::ClassLike
            && let Some(relative) = RelativeClass::from_name(name)
        {
            return Resolved { resolution: Resolution::Relative(relative), imported: false };
        }
        if kind == NameKind::Constant && is_special_constant(name) {
            return fqn(lossy(name), false);
        }
        if name.len() > b"namespace\\".len() && name[..b"namespace\\".len()].eq_ignore_ascii_case(b"namespace\\") {
            return fqn(self.qualify(&name[b"namespace\\".len()..]), false);
        }
        if let Some(target) = self.imports.resolve_alias(mago_kind(kind), name) {
            return fqn(lossy(&target), true);
        }
        if kind == NameKind::Function && is_never_namespaced_function(name) {
            return fqn(lossy(name), false);
        }
        let qualified = self.qualify(name);
        let unqualified = !name.contains(&b'\\');
        if unqualified && !self.namespace.is_empty() && matches!(kind, NameKind::Function | NameKind::Constant) {
            return Resolved {
                resolution: Resolution::Fallback { namespaced: qualified, global: lossy(name) },
                imported: false,
            };
        }
        fqn(qualified, false)
    }

    /// Prefixes the current namespace (a declaration's name, or a name with
    /// no import).
    pub(crate) fn qualify(&self, name: &[u8]) -> String {
        if self.namespace.is_empty() { lossy(name) } else { format!("{}\\{}", self.namespace, lossy(name)) }
    }
}

fn mago_kind(kind: NameKind) -> MagoKind {
    match kind {
        NameKind::ClassLike | NameKind::Namespace => MagoKind::Default,
        NameKind::Function => MagoKind::Function,
        NameKind::Constant => MagoKind::Constant,
    }
}

/// One resolved name in a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedName {
    /// Byte offsets of the name in the source, end exclusive.
    pub start: u32,
    pub end: u32,
    pub range: Range,
    /// The name as written.
    pub text: String,
    pub kind: NameKind,
    pub role: NameRole,
    pub resolution: Resolution,
    /// Resolved through a `use` import (always true for imports and aliases).
    pub imported: bool,
}

/// Every resolved name of a file, in source order, plus the scope at every
/// offset.
#[derive(Clone, Debug)]
pub struct FileNames {
    names: Vec<ResolvedName>,
    /// `(start offset, scope)`, sorted by offset; the first entry starts at 0.
    scopes: Vec<(u32, Arc<NameScope>)>,
}

impl FileNames {
    pub fn resolve(file: &ParsedFile) -> Self {
        let mut collector = Collector {
            line_index: file.line_index(),
            scope: NameScope::global(),
            names: Vec::new(),
            scopes: vec![(0, Arc::new(NameScope::global()))],
        };
        NameWalker.walk_program(file.program(), &mut collector);
        let mut names = collector.names;
        // A node can be visited by two hooks (`new Foo` is also an
        // identifier expression); the first visit wins.
        names.sort_by_key(|name| name.start);
        names.dedup_by_key(|name| name.start);
        Self { names, scopes: collector.scopes }
    }

    /// All names, sorted by start offset.
    pub fn names(&self) -> &[ResolvedName] {
        &self.names
    }

    /// The name whose bytes contain `offset` (`start <= offset < end`).
    pub fn at_offset(&self, offset: u32) -> Option<&ResolvedName> {
        let index = self.names.partition_point(|name| name.start <= offset).checked_sub(1)?;
        let name = &self.names[index];
        (offset < name.end).then_some(name)
    }

    /// The namespace and imports in force at `offset`, for resolving names
    /// that are not in the AST (docblocks, strings).
    pub fn scope_at(&self, offset: u32) -> &NameScope {
        let index = self.scopes.partition_point(|(start, _)| *start <= offset).saturating_sub(1);
        &self.scopes[index].1
    }

    /// The names of `kind` that may refer to `fqn` (fallbacks match on either
    /// candidate).
    pub fn references_to<'a>(&'a self, kind: NameKind, fqn: &'a str) -> impl Iterator<Item = &'a ResolvedName> + 'a {
        let fqn = fqn.trim_start_matches('\\');
        self.names.iter().filter(move |name| name.kind == kind && name.resolution.matches(kind, fqn))
    }
}

struct Collector<'a> {
    line_index: &'a LineIndex,
    scope: NameScope,
    names: Vec<ResolvedName>,
    scopes: Vec<(u32, Arc<NameScope>)>,
}

impl Collector<'_> {
    fn snapshot(&mut self, at: u32) {
        let scope = Arc::new(self.scope.clone());
        match self.scopes.last_mut() {
            Some(last) if last.0 >= at => last.1 = scope,
            _ => self.scopes.push((at, scope)),
        }
    }

    fn push(&mut self, span: Span, text: &[u8], kind: NameKind, role: NameRole, resolved: Resolved) {
        let (start, end) = (span.start.offset, span.end.offset);
        if start >= end {
            // Recovered nodes can be empty; nothing to point at.
            return;
        }
        self.names.push(ResolvedName {
            start,
            end,
            range: self.line_index.range(start, end),
            text: lossy(text),
            kind,
            role,
            resolution: resolved.resolution,
            imported: resolved.imported,
        });
    }

    fn reference(&mut self, kind: NameKind, identifier: &Identifier<'_>) {
        let resolved = self.scope.resolve_bytes(kind, identifier.value());
        self.push(identifier.span(), identifier.value(), kind, NameRole::Reference, resolved);
    }

    fn relative(&mut self, keyword: &Keyword<'_>, relative: RelativeClass) {
        let resolved = Resolved { resolution: Resolution::Relative(relative), imported: false };
        self.push(keyword.span, keyword.value, NameKind::ClassLike, NameRole::Reference, resolved);
    }

    fn declaration(&mut self, kind: NameKind, name: &LocalIdentifier<'_>) {
        let resolved = Resolved { resolution: Resolution::Fqn(self.scope.qualify(name.value)), imported: false };
        self.push(name.span, name.value, kind, NameRole::Declaration, resolved);
    }

    /// The class operand of `new`, `::` and `instanceof`.
    fn class_operand(&mut self, expression: &Expression<'_>) {
        match expression {
            Expression::Identifier(identifier) => self.reference(NameKind::ClassLike, identifier),
            Expression::Self_(keyword) => self.relative(keyword, RelativeClass::Self_),
            Expression::Static(keyword) => self.relative(keyword, RelativeClass::Static),
            Expression::Parent(keyword) => self.relative(keyword, RelativeClass::Parent),
            _ => {}
        }
    }

    /// An imported name, `prefix\name` for group `use`.
    fn import(&mut self, kind: NameKind, prefix: Option<&[u8]>, item: &UseItem<'_>) {
        let name = item.name.value();
        let name = name.strip_prefix(b"\\").unwrap_or(name);
        let fqn = match prefix {
            Some(prefix) => format!("{}\\{}", lossy(prefix), lossy(name)),
            None => lossy(name),
        };
        let resolved = Resolved { resolution: Resolution::Fqn(fqn), imported: true };
        self.push(item.name.span(), item.name.value(), kind, NameRole::Import, resolved.clone());
        if let Some(alias) = &item.alias {
            self.push(alias.identifier.span, alias.identifier.value, kind, NameRole::Alias, resolved);
        }
    }
}

fn use_kind(r#type: &UseType<'_>) -> NameKind {
    match r#type {
        UseType::Function(_) => NameKind::Function,
        UseType::Const(_) => NameKind::Constant,
    }
}

struct NameWalker;

impl<'ast, 'arena, 'a> Walker<'ast, 'arena, Collector<'a>> for NameWalker {
    fn walk_in_namespace(&self, node: &'ast Namespace<'arena>, cx: &mut Collector<'a>) {
        let name = node.name.as_ref().map(|name| name.value()).unwrap_or_default();
        let name = name.strip_prefix(b"\\").unwrap_or(name);
        cx.scope = NameScope::for_namespace(&lossy(name));
        cx.snapshot(node.span().start.offset);
        if let Some(identifier) = &node.name {
            let resolved = Resolved { resolution: Resolution::Fqn(lossy(name)), imported: false };
            cx.push(identifier.span(), identifier.value(), NameKind::Namespace, NameRole::Declaration, resolved);
        }
    }

    fn walk_out_namespace(&self, node: &'ast Namespace<'arena>, cx: &mut Collector<'a>) {
        cx.scope = NameScope::global();
        // An implicit namespace (`namespace A;`) runs until the next one; its
        // span stops at its last statement, so trailing text stays inside it.
        // A braced one ends at its `}`.
        if let NamespaceBody::BraceDelimited(_) = node.body {
            cx.snapshot(node.span().end.offset);
        }
    }

    fn walk_in_use(&self, node: &'ast Use<'arena>, cx: &mut Collector<'a>) {
        match &node.items {
            UseItems::Sequence(sequence) => {
                for item in &sequence.items {
                    cx.import(NameKind::ClassLike, None, item);
                }
            }
            UseItems::TypedSequence(sequence) => {
                for item in &sequence.items {
                    cx.import(use_kind(&sequence.r#type), None, item);
                }
            }
            UseItems::TypedList(list) => {
                let prefix = list.namespace.value();
                let prefix = prefix.strip_prefix(b"\\").unwrap_or(prefix);
                let resolved = Resolved { resolution: Resolution::Fqn(lossy(prefix)), imported: true };
                cx.push(list.namespace.span(), list.namespace.value(), NameKind::Namespace, NameRole::Import, resolved);
                for item in &list.items {
                    cx.import(use_kind(&list.r#type), Some(prefix), item);
                }
            }
            UseItems::MixedList(list) => {
                let prefix = list.namespace.value();
                let prefix = prefix.strip_prefix(b"\\").unwrap_or(prefix);
                let resolved = Resolved { resolution: Resolution::Fqn(lossy(prefix)), imported: true };
                cx.push(list.namespace.span(), list.namespace.value(), NameKind::Namespace, NameRole::Import, resolved);
                for mixed in &list.items {
                    let kind = mixed.r#type.as_ref().map_or(NameKind::ClassLike, use_kind);
                    cx.import(kind, Some(prefix), &mixed.item);
                }
            }
        }
        cx.scope.add_use(node);
        cx.snapshot(node.span().end.offset);
    }

    fn walk_in_class(&self, node: &'ast Class<'arena>, cx: &mut Collector<'a>) {
        cx.declaration(NameKind::ClassLike, &node.name);
    }

    fn walk_in_interface(&self, node: &'ast Interface<'arena>, cx: &mut Collector<'a>) {
        cx.declaration(NameKind::ClassLike, &node.name);
    }

    fn walk_in_trait(&self, node: &'ast Trait<'arena>, cx: &mut Collector<'a>) {
        cx.declaration(NameKind::ClassLike, &node.name);
    }

    fn walk_in_enum(&self, node: &'ast Enum<'arena>, cx: &mut Collector<'a>) {
        cx.declaration(NameKind::ClassLike, &node.name);
    }

    fn walk_in_function(&self, node: &'ast Function<'arena>, cx: &mut Collector<'a>) {
        cx.declaration(NameKind::Function, &node.name);
    }

    fn walk_in_constant(&self, node: &'ast Constant<'arena>, cx: &mut Collector<'a>) {
        for item in &node.items {
            cx.declaration(NameKind::Constant, &item.name);
        }
    }

    fn walk_in_extends(&self, node: &'ast Extends<'arena>, cx: &mut Collector<'a>) {
        for parent in &node.types {
            cx.reference(NameKind::ClassLike, parent);
        }
    }

    fn walk_in_implements(&self, node: &'ast Implements<'arena>, cx: &mut Collector<'a>) {
        for interface in &node.types {
            cx.reference(NameKind::ClassLike, interface);
        }
    }

    fn walk_in_trait_use(&self, node: &'ast TraitUse<'arena>, cx: &mut Collector<'a>) {
        for name in &node.trait_names {
            cx.reference(NameKind::ClassLike, name);
        }
    }

    fn walk_in_trait_use_absolute_method_reference(
        &self,
        node: &'ast TraitUseAbsoluteMethodReference<'arena>,
        cx: &mut Collector<'a>,
    ) {
        cx.reference(NameKind::ClassLike, &node.trait_name);
    }

    fn walk_in_trait_use_precedence_adaptation(
        &self,
        node: &'ast TraitUsePrecedenceAdaptation<'arena>,
        cx: &mut Collector<'a>,
    ) {
        for name in &node.trait_names {
            cx.reference(NameKind::ClassLike, name);
        }
    }

    fn walk_in_hint(&self, node: &'ast Hint<'arena>, cx: &mut Collector<'a>) {
        match node {
            Hint::Identifier(identifier) => cx.reference(NameKind::ClassLike, identifier),
            Hint::Self_(keyword) => cx.relative(keyword, RelativeClass::Self_),
            Hint::Static(keyword) => cx.relative(keyword, RelativeClass::Static),
            Hint::Parent(keyword) => cx.relative(keyword, RelativeClass::Parent),
            _ => {}
        }
    }

    fn walk_in_attribute(&self, node: &'ast Attribute<'arena>, cx: &mut Collector<'a>) {
        cx.reference(NameKind::ClassLike, &node.name);
    }

    fn walk_in_function_call(&self, node: &'ast FunctionCall<'arena>, cx: &mut Collector<'a>) {
        if let Expression::Identifier(identifier) = node.function {
            cx.reference(NameKind::Function, identifier);
        }
    }

    fn walk_in_function_partial_application(
        &self,
        node: &'ast FunctionPartialApplication<'arena>,
        cx: &mut Collector<'a>,
    ) {
        if let Expression::Identifier(identifier) = node.function {
            cx.reference(NameKind::Function, identifier);
        }
    }

    fn walk_in_instantiation(&self, node: &'ast Instantiation<'arena>, cx: &mut Collector<'a>) {
        cx.class_operand(node.class);
    }

    fn walk_in_static_method_call(&self, node: &'ast StaticMethodCall<'arena>, cx: &mut Collector<'a>) {
        cx.class_operand(node.class);
    }

    fn walk_in_static_method_partial_application(
        &self,
        node: &'ast StaticMethodPartialApplication<'arena>,
        cx: &mut Collector<'a>,
    ) {
        cx.class_operand(node.class);
    }

    fn walk_in_static_property_access(&self, node: &'ast StaticPropertyAccess<'arena>, cx: &mut Collector<'a>) {
        cx.class_operand(node.class);
    }

    fn walk_in_class_constant_access(&self, node: &'ast ClassConstantAccess<'arena>, cx: &mut Collector<'a>) {
        cx.class_operand(node.class);
    }

    fn walk_in_binary(&self, node: &'ast Binary<'arena>, cx: &mut Collector<'a>) {
        if let BinaryOperator::Instanceof(_) = node.operator {
            cx.class_operand(node.rhs);
        }
    }

    fn walk_in_constant_access(&self, node: &'ast ConstantAccess<'arena>, cx: &mut Collector<'a>) {
        cx.reference(NameKind::Constant, &node.name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::Pos;

    const CARET: &str = "/*|*/";

    /// Removes every `/*|*/` marker and returns the clean source with the
    /// byte offsets the markers stood at.
    fn carets(fixture: &str) -> (String, Vec<u32>) {
        let mut source = String::new();
        let mut offsets = Vec::new();
        let mut rest = fixture;
        while let Some(i) = rest.find(CARET) {
            source.push_str(&rest[..i]);
            offsets.push(source.len() as u32);
            rest = &rest[i + CARET.len()..];
        }
        source.push_str(rest);
        (source, offsets)
    }

    fn kind_str(kind: NameKind) -> &'static str {
        match kind {
            NameKind::ClassLike => "class",
            NameKind::Function => "function",
            NameKind::Constant => "const",
            NameKind::Namespace => "namespace",
        }
    }

    fn role_str(role: NameRole) -> &'static str {
        match role {
            NameRole::Declaration => "decl",
            NameRole::Import => "import",
            NameRole::Alias => "alias",
            NameRole::Reference => "ref",
        }
    }

    /// `kind role resolution`, with ` (use)` when it went through an import.
    fn describe(name: &ResolvedName) -> String {
        let imported = if name.imported { " (use)" } else { "" };
        format!("{} {} {}{imported}", kind_str(name.kind), role_str(name.role), name.resolution)
    }

    /// Each case is a fixture with `/*|*/` carets in front of names and the
    /// expected description of the name at each caret.
    fn check(cases: &[(&str, &[&str])]) {
        for (fixture, expected) in cases {
            let (source, offsets) = carets(fixture);
            assert_eq!(offsets.len(), expected.len(), "caret count in {fixture}");
            let file = ParsedFile::parse("names.php", source.as_str());
            assert!(!file.has_errors(), "{fixture}: {:?}", file.errors());
            let names = FileNames::resolve(&file);
            let actual: Vec<String> = offsets
                .iter()
                .map(|&offset| names.at_offset(offset).map_or_else(|| "<none>".to_owned(), describe))
                .collect();
            assert_eq!(actual, *expected, "{fixture}");
        }
    }

    #[test]
    fn namespaces_and_declarations() {
        check(&[
            (
                "<?php\nnamespace /*|*/App\\Model;\nclass /*|*/Book {}\ninterface /*|*/Shelf {}\ntrait /*|*/Stamps {}\nenum /*|*/Genre {}\nfunction /*|*/slug() {}\nconst /*|*/MAX = 1, /*|*/MIN = 0;\n",
                &[
                    "namespace decl App\\Model",
                    "class decl App\\Model\\Book",
                    "class decl App\\Model\\Shelf",
                    "class decl App\\Model\\Stamps",
                    "class decl App\\Model\\Genre",
                    "function decl App\\Model\\slug",
                    "const decl App\\Model\\MAX",
                    "const decl App\\Model\\MIN",
                ],
            ),
            ("<?php\nclass /*|*/Top {}\nfunction /*|*/top() {}\n", &["class decl Top", "function decl top"]),
        ]);
    }

    #[test]
    fn several_namespaces_per_file() {
        check(&[
            (
                "<?php\nnamespace A;\nuse X\\Foo;\nclass /*|*/One extends /*|*/Foo {}\nnamespace B;\nclass /*|*/Two extends /*|*/Foo {}\n",
                // The import of the first block does not leak into the second.
                &["class decl A\\One", "class ref X\\Foo (use)", "class decl B\\Two", "class ref B\\Foo"],
            ),
            (
                "<?php\nnamespace A {\n    new /*|*/Foo;\n}\nnamespace B\\C {\n    new /*|*/Foo;\n}\nnamespace {\n    new /*|*/Foo;\n    /*|*/f();\n}\n",
                &["class ref A\\Foo", "class ref B\\C\\Foo", "class ref Foo", "function ref f"],
            ),
        ]);
    }

    #[test]
    fn use_statements() {
        check(&[
            (
                "<?php\nnamespace App;\nuse /*|*/Lib\\Book;\nuse function /*|*/Lib\\slug;\nuse const /*|*/Lib\\MAX;\n\n/*|*/Book::/*|*/MAX;\n/*|*/slug(/*|*/MAX);\nnew /*|*/book;\n",
                &[
                    "class import Lib\\Book (use)",
                    "function import Lib\\slug (use)",
                    "const import Lib\\MAX (use)",
                    "class ref Lib\\Book (use)",
                    // A class constant selector is not a name.
                    "<none>",
                    "function ref Lib\\slug (use)",
                    "const ref Lib\\MAX (use)",
                    // Class imports ignore case.
                    "class ref Lib\\Book (use)",
                ],
            ),
            (
                // The leading `\` of an import is optional.
                "<?php\nnamespace App;\nuse \\Lib\\Book;\nnew /*|*/Book;\n",
                &["class ref Lib\\Book (use)"],
            ),
            (
                // Each kind has its own table.
                "<?php\nnamespace App;\nuse Lib\\Thing;\n/*|*/thing();\necho /*|*/Thing;\n",
                &["function ref App\\thing|thing", "const ref App\\Thing|Thing"],
            ),
        ]);
    }

    #[test]
    fn grouped_use() {
        check(&[
            (
                "<?php\nnamespace App;\nuse /*|*/Lib\\{/*|*/Book, /*|*/Shelf as /*|*/Rack, function /*|*/slug, const /*|*/MAX};\nuse function Fns\\{/*|*/a, /*|*/b as /*|*/bee};\n\nnew /*|*/Rack;\n/*|*/slug();\n/*|*/bee();\necho /*|*/MAX;\n",
                &[
                    "namespace import Lib (use)",
                    "class import Lib\\Book (use)",
                    "class import Lib\\Shelf (use)",
                    "class alias Lib\\Shelf (use)",
                    "function import Lib\\slug (use)",
                    "const import Lib\\MAX (use)",
                    "function import Fns\\a (use)",
                    "function import Fns\\b (use)",
                    "function alias Fns\\b (use)",
                    "class ref Lib\\Shelf (use)",
                    "function ref Lib\\slug (use)",
                    "function ref Fns\\b (use)",
                    "const ref Lib\\MAX (use)",
                ],
            ),
            ("<?php\nuse Lib\\{Sub\\Book};\nnew /*|*/Book;\n", &["class ref Lib\\Sub\\Book (use)"]),
        ]);
    }

    #[test]
    fn aliases() {
        check(&[
            (
                "<?php\nnamespace App;\nuse Lib\\Book as /*|*/Tome;\nuse Lib\\Models;\nuse function Lib\\slugify as /*|*/slug;\nuse const Lib\\MAX as /*|*/LIMIT;\n\nnew /*|*/Tome;\nnew /*|*/Models\\User;\nnew /*|*/TOME;\n/*|*/slug();\necho /*|*/LIMIT;\nnew /*|*/Book;\n",
                &[
                    "class alias Lib\\Book (use)",
                    "function alias Lib\\slugify (use)",
                    "const alias Lib\\MAX (use)",
                    "class ref Lib\\Book (use)",
                    // A qualified name's first segment goes through the class table.
                    "class ref Lib\\Models\\User (use)",
                    "class ref Lib\\Book (use)",
                    "function ref Lib\\slugify (use)",
                    "const ref Lib\\MAX (use)",
                    // The original short name is not imported.
                    "class ref App\\Book",
                ],
            ),
            (
                // Qualified function calls and constants use the class table too.
                "<?php\nnamespace App;\nuse Lib\\Util;\n/*|*/Util\\go();\necho /*|*/Util\\MAX;\n",
                &["function ref Lib\\Util\\go (use)", "const ref Lib\\Util\\MAX (use)"],
            ),
        ]);
    }

    #[test]
    fn qualified_fully_qualified_and_namespace_relative() {
        check(&[(
            "<?php\nnamespace App;\nnew /*|*/Sub\\Foo;\nnew /*|*/\\Other\\Foo;\nnew /*|*/namespace\\Foo;\n/*|*/\\strlen('x');\n/*|*/namespace\\helper();\n/*|*/Sub\\helper();\necho /*|*/\\PHP_EOL;\n",
            &[
                "class ref App\\Sub\\Foo",
                "class ref Other\\Foo",
                "class ref App\\Foo",
                "function ref strlen",
                // Explicitly qualified functions never fall back.
                "function ref App\\helper",
                "function ref App\\Sub\\helper",
                "const ref PHP_EOL",
            ],
        )]);
    }

    #[test]
    fn functions_and_constants_fall_back_to_global() {
        check(&[
            (
                "<?php\nnamespace App;\n/*|*/strlen('x');\necho /*|*/PHP_EOL;\n$f = /*|*/strlen(...);\n",
                &[
                    "function ref App\\strlen|strlen",
                    "const ref App\\PHP_EOL|PHP_EOL",
                    "function ref App\\strlen|strlen",
                ],
            ),
            (
                // No fallback in global code: the name is already global.
                "<?php\n/*|*/strlen('x');\necho /*|*/PHP_EOL;\n",
                &["function ref strlen", "const ref PHP_EOL"],
            ),
            (
                // Class names never fall back.
                "<?php\nnamespace App;\nnew /*|*/DateTime;\n",
                &["class ref App\\DateTime"],
            ),
        ]);
    }

    #[test]
    fn self_static_and_parent_are_markers() {
        check(&[(
            "<?php\nnamespace App;\nclass A extends /*|*/B {\n    public function make(): /*|*/static { return new /*|*/static; }\n    public function me(/*|*/self $x): ?/*|*/self { return /*|*/self::/*|*/X; }\n    public function __construct() { /*|*/parent::__construct(); }\n    public function is($o): bool { return $o instanceof /*|*/self || $o instanceof /*|*/C; }\n    public static function v() { return /*|*/static::$v; }\n}\n",
            &[
                "class ref App\\B",
                "class ref static",
                "class ref static",
                "class ref self",
                "class ref self",
                "class ref self",
                "<none>",
                "class ref parent",
                "class ref self",
                "class ref App\\C",
                "class ref static",
            ],
        )]);
    }

    #[test]
    fn class_positions_are_resolved() {
        check(&[(
            "<?php\nnamespace App;\nuse Lib\\{Attr, Base, Contract, Mixin, Other, Err};\n#[/*|*/Attr]\nfinal class C extends /*|*/Base implements /*|*/Contract {\n    use /*|*/Mixin, /*|*/Other { /*|*/Mixin::run insteadof /*|*/Other; }\n    public function f(/*|*/Base|/*|*/Contract|null $a): /*|*/Base&/*|*/Contract {\n        try {} catch (/*|*/Err $e) {}\n        /*|*/Base::$p; /*|*/Base::m(); /*|*/Base::m(...); /*|*/Base::K;\n        return $a instanceof /*|*/Base ? $a : $a;\n    }\n}\n",
            &[
                "class ref Lib\\Attr (use)",
                "class ref Lib\\Base (use)",
                "class ref Lib\\Contract (use)",
                "class ref Lib\\Mixin (use)",
                "class ref Lib\\Other (use)",
                "class ref Lib\\Mixin (use)",
                "class ref Lib\\Other (use)",
                "class ref Lib\\Base (use)",
                "class ref Lib\\Contract (use)",
                "class ref Lib\\Base (use)",
                "class ref Lib\\Contract (use)",
                "class ref Lib\\Err (use)",
                "class ref Lib\\Base (use)",
                "class ref Lib\\Base (use)",
                "class ref Lib\\Base (use)",
                "class ref Lib\\Base (use)",
                "class ref Lib\\Base (use)",
            ],
        )]);
    }

    #[test]
    fn special_constants_are_global() {
        // Whatever node `true` and `null` parse to, they never resolve into the
        // namespace.
        let scope = NameScope::for_namespace("App");
        for name in ["true", "FALSE", "Null"] {
            assert_eq!(scope.resolve(NameKind::Constant, name).resolution, Resolution::Fqn(name.to_owned()));
        }
    }

    #[test]
    fn scope_tracks_namespaces_and_imports() {
        let cases: &[(&str, &[(&str, &str)])] = &[
            (
                "<?php\n/*|*/\nnamespace A;\n/*|*/\nuse Lib\\Book;\n/*|*/\nnamespace B;\n/*|*/\n",
                &[("", "Book"), ("A", "A\\Book"), ("A", "Lib\\Book"), ("B", "B\\Book")],
            ),
            (
                "<?php\n/*|*/\nnamespace A {\n/*|*/ use Lib\\Book; /*|*/\n}\n/*|*/\nnamespace {\n/*|*/\n}\n",
                &[("", "Book"), ("A", "A\\Book"), ("A", "Lib\\Book"), ("", "Book"), ("", "Book")],
            ),
        ];
        for (fixture, expected) in cases {
            let (source, offsets) = carets(fixture);
            let file = ParsedFile::parse("scope.php", source.as_str());
            assert!(!file.has_errors(), "{:?}", file.errors());
            let names = FileNames::resolve(&file);
            let actual: Vec<(String, String)> = offsets
                .iter()
                .map(|&offset| {
                    let scope = names.scope_at(offset);
                    let book = scope.resolve(NameKind::ClassLike, "Book").resolution.to_string();
                    (scope.namespace().to_owned(), book)
                })
                .collect();
            let expected: Vec<(String, String)> =
                expected.iter().map(|(ns, book)| ((*ns).to_owned(), (*book).to_owned())).collect();
            assert_eq!(actual, expected, "{fixture}");
        }
    }

    #[test]
    fn scope_resolves_like_the_walk() {
        let mut scope = NameScope::for_namespace("\\App");
        scope.add_import(NameKind::ClassLike, "\\Lib\\Book", None);
        scope.add_import(NameKind::Function, "Lib\\slugify", Some("slug"));
        assert_eq!(scope.namespace(), "App");
        let book = scope.resolve(NameKind::ClassLike, "book");
        assert_eq!(book, Resolved { resolution: Resolution::Fqn("Lib\\Book".into()), imported: true });
        assert_eq!(scope.resolve(NameKind::Function, "SLUG").resolution.to_string(), "Lib\\slugify");
        assert_eq!(scope.resolve(NameKind::Function, "other").resolution.to_string(), "App\\other|other");
        // `exit`, `die` and `clone` always compile to the global function
        // (in the AST they are constructs, not calls).
        assert_eq!(scope.resolve(NameKind::Function, "Die").resolution.to_string(), "Die");
        assert_eq!(
            scope.resolve(NameKind::ClassLike, "Parent").resolution,
            Resolution::Relative(RelativeClass::Parent)
        );
        assert_eq!(scope.resolve(NameKind::Namespace, "\\Lib\\Sub").resolution.to_string(), "Lib\\Sub");
        let fallback = scope.resolve(NameKind::Constant, "MAX").resolution;
        assert_eq!(fallback.candidates().collect::<Vec<_>>(), ["App\\MAX", "MAX"]);
        assert_eq!(fallback.primary(), Some("App\\MAX"));
        assert_eq!(Resolution::Relative(RelativeClass::Self_).primary(), None);
    }

    #[test]
    fn references_and_comparisons() {
        let source = "<?php\nnamespace App;\nuse Lib\\Book;\nnew Book; new \\LIB\\BOOK; new Other;\nstrlen('a'); \\strlen('b');\necho MAX, \\App\\MAX, \\app\\MAX, \\App\\max;\n";
        let file = ParsedFile::parse("refs.php", source);
        let names = FileNames::resolve(&file);
        let texts = |kind, fqn| names.references_to(kind, fqn).map(|n| n.text.clone()).collect::<Vec<_>>();
        assert_eq!(texts(NameKind::ClassLike, "\\Lib\\Book"), ["Lib\\Book", "Book", "\\LIB\\BOOK"]);
        // A fallback matches either candidate.
        assert_eq!(texts(NameKind::Function, "strlen"), ["strlen", "\\strlen"]);
        assert_eq!(texts(NameKind::Function, "App\\strlen"), ["strlen"]);
        // Constant names are case-sensitive, their namespace is not.
        assert_eq!(texts(NameKind::Constant, "App\\MAX"), ["MAX", "\\App\\MAX", "\\app\\MAX"]);
        assert!(fqn_eq(NameKind::ClassLike, "A\\B", "a\\b"));
        assert!(!fqn_eq(NameKind::Constant, "A\\B", "a\\b"));
    }

    #[test]
    fn ranges_are_utf16_and_offsets_cover_the_name() {
        let source = "<?php\nnamespace App;\n$s = '😀'; new Foo\\Bar;\n";
        let file = ParsedFile::parse("utf.php", source);
        let names = FileNames::resolve(&file);
        let name = names.names().iter().find(|n| n.text == "Foo\\Bar").expect("Foo\\Bar");
        assert_eq!(&source[name.start as usize..name.end as usize], "Foo\\Bar");
        let col = "$s = '😀'; new ".encode_utf16().count() as u32;
        assert_eq!(name.range, Range::new(Pos::new(2, col), Pos::new(2, col + 7)));
        assert_eq!(names.at_offset(name.end - 1), Some(name));
        assert!(names.at_offset(name.end).is_none_or(|other| other.start == name.end));
        assert!(names.names().windows(2).all(|w| w[0].start < w[1].start));
    }

    #[test]
    fn never_panics_on_any_prefix() {
        let text = "<?php\nnamespace A\\B;\nuse X\\{Y, function z as zz, const W};\nclass C extends Y { use T { T::a insteadof U; } function f(): static { return zz(W) ?? new self; } }\nnamespace D { new Y; }\n";
        for end in (0..=text.len()).filter(|&end| text.is_char_boundary(end)) {
            let file = ParsedFile::parse("p.php", &text[..end]);
            let names = FileNames::resolve(&file);
            for name in names.names() {
                assert!(name.start < name.end && name.end as usize <= end, "{name:?}");
            }
            let _ = names.scope_at(end as u32);
        }
    }
}
