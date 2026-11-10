//! Structure service: tree-sitter answers for editor features when the
//! language server is unavailable, not ready, failing — or, for
//! refactorings, when the code does not parse (IDEA's dumb-mode PSI).
//!
//! Trees come from `ide-language`'s per-document [`SyntaxCache`] (parsed
//! lazily on the first query, re-parsed incrementally after edits, dropped on
//! close), so queries on an open document cost a tree walk, not a parse.
//!
//! Contract for consumers (phase-B features):
//!  - **LSP first.** Use this only when the server is not usable, or when a
//!    refactoring came back empty over code with [`StructureService::syntax_errors`].
//!  - Answers are purely syntactic and only claim what is certain: a name in
//!    member position is never a local, a local's references never cross a
//!    shadowing declaration, and ambiguous cases are flagged (`certain: false`,
//!    `exact: false`, candidate lists) rather than guessed.
//!  - Coordinates are 0-based lines and UTF-16 columns (`ide_core::text`).
//!  - Every method is synchronous and may parse: call it from a blocking
//!    thread (`spawn_blocking`), never from a command or UI thread. Parsing and
//!    the query loops honour the [`CancellationToken`].

mod identifiers;
mod jvm;
mod kinds;
mod lines;
mod locals;
mod nodes;
mod types;

#[cfg(test)]
mod tests;

pub use jvm::{JvmPresentation, JvmTypeKind, jvm_type_header};
pub use types::*;

use ide_core::{CancellationToken, DocId, IdeError, LanguageId, Pos, Range};
use ide_language::{ParsedTree, Syntax, SyntaxCache, TreeError, shift_range};
use kinds::Kinds;
use lines::Lines;
use std::sync::Arc;
use tree_sitter::Tree;

/// At most this many errors are reported by [`StructureService::syntax_errors`].
pub const MAX_SYNTAX_ERRORS: usize = 200;

/// The text a query runs on: an open document (cached, incremental tree) or
/// a free-standing text (parsed from scratch, e.g. a file that is not open).
#[derive(Clone, Copy, Debug)]
pub struct Snapshot<'a> {
    pub doc: Option<DocId>,
    pub version: u32,
    pub language: &'a LanguageId,
    pub text: &'a str,
}

impl<'a> Snapshot<'a> {
    /// The open document `doc` at `version`, whose current text is `text`.
    pub fn doc(doc: DocId, version: u32, language: &'a LanguageId, text: &'a str) -> Self {
        Self { doc: Some(doc), version, language, text }
    }

    pub fn text(language: &'a LanguageId, text: &'a str) -> Self {
        Self { doc: None, version: 0, language, text }
    }
}

/// Why a query produced no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StructureError {
    /// No grammar (or, for `locals`, no `locals.scm`) for the language.
    Unsupported,
    /// The text is larger than the parser accepts.
    TooLarge,
    Cancelled,
}

impl From<TreeError> for StructureError {
    fn from(e: TreeError) -> Self {
        match e {
            TreeError::Unsupported => Self::Unsupported,
            TreeError::TooLarge => Self::TooLarge,
            TreeError::Cancelled => Self::Cancelled,
        }
    }
}

impl From<StructureError> for IdeError {
    fn from(e: StructureError) -> Self {
        match e {
            StructureError::Unsupported => IdeError::unavailable("no syntax structure for this language"),
            StructureError::TooLarge => IdeError::unavailable("file is too large for syntax analysis"),
            StructureError::Cancelled => IdeError::cancelled(),
        }
    }
}

pub type StructureResult<T> = Result<T, StructureError>;

/// One parsed snapshot plus the per-grammar tables, handed to the query modules.
pub(crate) struct Ctx<'a> {
    pub grammar: &'static str,
    pub language: &'a tree_sitter::Language,
    pub tree: &'a Tree,
    pub kinds: &'static Kinds,
    pub lines: Lines<'a>,
    pub cancel: &'a CancellationToken,
}

impl<'a> Ctx<'a> {
    pub(crate) fn text(&self) -> &'a str {
        self.lines.text()
    }

    pub(crate) fn node(&self, node: &tree_sitter::Node) -> SyntaxNode {
        SyntaxNode {
            kind: node.kind().to_owned(),
            range: self.lines.range(node.start_byte(), node.end_byte()),
            field: kinds::field_name(node).map(str::to_owned),
            named: node.is_named(),
            error: node.is_error(),
            missing: node.is_missing(),
            has_error: node.has_error(),
        }
    }

    pub(crate) fn range(&self, node: &tree_sitter::Node) -> Range {
        self.lines.range(node.start_byte(), node.end_byte())
    }

    pub(crate) fn check(&self) -> StructureResult<()> {
        if self.cancel.is_cancelled() { Err(StructureError::Cancelled) } else { Ok(()) }
    }
}

/// Tree-sitter structure queries over open documents and free texts.
pub struct StructureService {
    cache: Arc<SyntaxCache>,
}

impl StructureService {
    pub fn new(cache: Arc<SyntaxCache>) -> Self {
        Self { cache }
    }

    /// What the service can answer for `language`.
    pub fn support(&self, language: &LanguageId) -> StructureSupport {
        let syn = self.cache.syntax();
        // Web containers (Vue SFC / Svelte / JSP have no grammar of their own)
        // answer from the HTML tree; inline <script> regions add the block
        // grammar's tables — TypeScript / JavaScript ship locals.scm — so both
        // capabilities are on whenever HTML is.
        let g =
            syn.grammar_name(language).or_else(|| (syn.web_grammar_name(language) == Some("html")).then_some("html"));
        match g {
            Some(g) => StructureSupport { tree: true, locals: kinds::locals_source(g).is_some() || g == "html" },
            None => StructureSupport::default(),
        }
    }

    /// The smallest named node covering `range`, with its ancestors.
    /// `None` only for an empty text.
    pub fn node_at(
        &self,
        snap: &Snapshot,
        range: Range,
        cancel: &CancellationToken,
    ) -> StructureResult<Option<NodeAt>> {
        let bytes = Lines::new(snap.text).bytes(range);
        if let Some(at) = self.with_script_tree(snap, bytes, cancel, |cx, local, base| {
            Ok(nodes::node_at(cx, local).map(|at| shift_node_at(at, base)))
        })? {
            return Ok(at);
        }
        // Outside any <script> region a web container (template markup) has no
        // identifier to offer: an empty answer, not an error.
        if self.web_container(snap.language) {
            return Ok(None);
        }
        self.run(snap, cancel, |cx| Ok(nodes::node_at(cx, range)))
    }

    /// The expression a selection denotes (exact or minimally enclosing), its
    /// statement and block. See [`ExpressionAt`].
    pub fn expression_at(
        &self,
        snap: &Snapshot,
        range: Range,
        cancel: &CancellationToken,
    ) -> StructureResult<ExpressionAt> {
        self.run(snap, cancel, |cx| Ok(nodes::expression_at(cx, range)))
    }

    /// `ERROR` and `MISSING` nodes in document order.
    pub fn syntax_errors(&self, snap: &Snapshot, cancel: &CancellationToken) -> StructureResult<SyntaxErrors> {
        self.run(snap, cancel, nodes::syntax_errors)
    }

    /// Scope analysis for the identifier at `pos` (`locals.scm`).
    pub fn locals(&self, snap: &Snapshot, pos: Pos, cancel: &CancellationToken) -> StructureResult<Locals> {
        let byte = Lines::new(snap.text).byte(pos);
        if let Some(locals) = self.with_script_tree(snap, (byte, byte), cancel, |cx, local, base| {
            locals::locals(cx, local.start).map(|l| shift_locals(l, base))
        })? {
            return Ok(locals);
        }
        if self.web_container(snap.language) {
            // Template markup: no TypeScript identifier here; the frontend
            // treats `noIdentifier` as "nothing at this position".
            return Ok(Locals::NoIdentifier);
        }
        self.run(snap, cancel, |cx| locals::locals(cx, pos))
    }

    /// Identifier tokens spelled `name`, excluding comments and string
    /// contents (interpolations count as code). Document order.
    pub fn identifiers_named(
        &self,
        snap: &Snapshot,
        name: &str,
        cancel: &CancellationToken,
    ) -> StructureResult<Vec<IdentifierOccurrence>> {
        if name.is_empty() || memchr::memmem::find(snap.text.as_bytes(), name.as_bytes()).is_none() {
            // Nothing to find: skip the parse (find-usages filters many files).
            return if self.cache.syntax().grammar_name(snap.language).is_some() {
                Ok(Vec::new())
            } else {
                Err(StructureError::Unsupported)
            };
        }
        self.run(snap, cancel, |cx| identifiers::identifiers_named(cx, name))
    }

    /// [`StructureService::identifiers_named`] over many files in parallel
    /// (find-usages filtering). `load` returns a file's language, its open
    /// document (id, version) if any, and its text; files it cannot load, and
    /// files without a grammar, are skipped. Files without an occurrence are
    /// left out of the result.
    pub fn identifiers_in_files<L>(
        &self,
        paths: &[std::path::PathBuf],
        name: &str,
        load: L,
        cancel: &CancellationToken,
    ) -> StructureResult<Vec<FileIdentifiers>>
    where
        L: Fn(&std::path::Path) -> Option<(LanguageId, Option<(DocId, u32)>, String)> + Sync,
    {
        use rayon::prelude::*;
        let results: Vec<StructureResult<Option<FileIdentifiers>>> = paths
            .par_iter()
            .map(|path| {
                if cancel.is_cancelled() {
                    return Err(StructureError::Cancelled);
                }
                let Some((language, doc, text)) = load(path) else { return Ok(None) };
                let snap = match doc {
                    Some((id, version)) => Snapshot::doc(id, version, &language, &text),
                    None => Snapshot::text(&language, &text),
                };
                match self.identifiers_named(&snap, name, cancel) {
                    Ok(occurrences) if occurrences.is_empty() => Ok(None),
                    Ok(occurrences) => Ok(Some(FileIdentifiers { path: path.clone().into(), occurrences })),
                    Err(StructureError::Cancelled) => Err(StructureError::Cancelled),
                    Err(_) => Ok(None),
                }
            })
            .collect();
        results.into_iter().filter_map(Result::transpose).collect()
    }

    /// Selection chain plus statement / declaration ranges at `pos` (Extend
    /// Selection, Move Statement, Complete Statement for non-Lezer languages).
    pub fn structural_ranges(
        &self,
        snap: &Snapshot,
        pos: Pos,
        cancel: &CancellationToken,
    ) -> StructureResult<StructuralRanges> {
        let mut ranges = self.run(snap, cancel, |cx| Ok(nodes::structural_ranges(cx, pos)))?;
        let offset = utf16_offset(snap.text, pos);
        ranges.selection = match snap.doc {
            Some(doc) => self.cache.selection_ranges(doc, snap.language, snap.version, snap.text, offset),
            None => self.cache.syntax().selection_ranges(snap.language, snap.text, offset),
        };
        Ok(ranges)
    }

    /// Whether `language` is an HTML container without a grammar of its own
    /// (Vue SFC / Svelte / JSP): structure answers come from the HTML tree
    /// plus the inline `<script>` regions' block grammars.
    fn web_container(&self, language: &LanguageId) -> bool {
        let syn = self.cache.syntax();
        syn.grammar_name(language).is_none() && syn.web_grammar_name(language) == Some("html")
    }

    /// Runs `f` on the block grammar's tree when one of the document's inline
    /// `<script>` regions covers `bytes`; `f` sees the region's `Ctx`, the
    /// query converted into region coordinates, and the region's document
    /// `base`. `Ok(None)` when no region covers `bytes`.
    fn with_script_tree<R>(
        &self,
        snap: &Snapshot,
        bytes: (usize, usize),
        cancel: &CancellationToken,
        f: impl FnOnce(&Ctx, Range, Pos) -> StructureResult<R>,
    ) -> StructureResult<Option<R>> {
        if cancel.is_cancelled() {
            return Err(StructureError::Cancelled);
        }
        let cancelled = || cancel.is_cancelled();
        let syn = self.cache.syntax();
        if syn.web_grammar_name(snap.language) != Some("html") {
            return Ok(None);
        }
        let extract = |p: ParsedTree<'_>| Syntax::script_regions_of(p.tree, p.text);
        let regions = match snap.doc {
            Some(doc) if syn.grammar_name(snap.language).is_some() => {
                self.cache.with_parsed(doc, snap.language, snap.version, snap.text, &cancelled, extract)
            }
            _ => syn.with_parsed(&LanguageId::new("html"), snap.text, &cancelled, extract),
        };
        let Some(region) = regions?.into_iter().find(|r| bytes.0 >= r.base && bytes.1 <= r.base + r.text.len()) else {
            return Ok(None);
        };
        let base = Lines::new(snap.text).pos(region.base);
        let (a, b) = (bytes.0 - region.base, bytes.1 - region.base);
        syn.with_parsed(&region.language, &region.text, &cancelled, |p| {
            let cx = Ctx {
                grammar: p.grammar,
                language: p.language,
                tree: p.tree,
                kinds: Kinds::for_grammar(p.grammar, p.language),
                lines: Lines::new(p.text),
                cancel,
            };
            let local = Range::new(cx.lines.pos(a), cx.lines.pos(b));
            f(&cx, local, base)
        })
        .map_err(StructureError::from)
        .and_then(|r| r)
        .map(Some)
    }

    fn run<R>(
        &self,
        snap: &Snapshot,
        cancel: &CancellationToken,
        f: impl FnOnce(&Ctx) -> StructureResult<R>,
    ) -> StructureResult<R> {
        if cancel.is_cancelled() {
            return Err(StructureError::Cancelled);
        }
        let cancelled = || cancel.is_cancelled();
        let with = |p: ParsedTree<'_>| {
            let cx = Ctx {
                grammar: p.grammar,
                language: p.language,
                tree: p.tree,
                kinds: Kinds::for_grammar(p.grammar, p.language),
                lines: Lines::new(p.text),
                cancel,
            };
            f(&cx)
        };
        match snap.doc {
            Some(doc) => self.cache.with_parsed(doc, snap.language, snap.version, snap.text, &cancelled, with)?,
            None => self.cache.syntax().with_parsed(snap.language, snap.text, &cancelled, with)?,
        }
    }
}

/// UTF-16 offset of `pos` into `text`.
fn utf16_offset(text: &str, pos: Pos) -> u32 {
    let lines = Lines::new(text);
    lines::utf16_len(&text[..lines.byte(pos)])
}

/// Shifts a `<script>` region's answer to document coordinates (`base` is the
/// region start): the node and every ancestor move by [`shift_range`].
fn shift_node_at(at: NodeAt, base: Pos) -> NodeAt {
    let shift = |n: SyntaxNode| SyntaxNode { range: shift_range(n.range, base), ..n };
    NodeAt { node: shift(at.node), ancestors: at.ancestors.into_iter().map(shift).collect() }
}

/// [`shift_node_at`] for a `locals` answer: every range moves (`NotLocal`'s,
/// the symbol's definition, scope, references and conflicts), names stay.
fn shift_locals(l: Locals, base: Pos) -> Locals {
    match l {
        Locals::NoIdentifier => Locals::NoIdentifier,
        Locals::NotLocal { name, range, reason } => Locals::NotLocal { name, range: shift_range(range, base), reason },
        Locals::Local { symbol } => Locals::Local {
            symbol: LocalSymbol {
                definition: shift_range(symbol.definition, base),
                scope: shift_range(symbol.scope, base),
                references: symbol.references.into_iter().map(|r| shift_range(r, base)).collect(),
                conflicts: symbol.conflicts.into_iter().map(|r| shift_range(r, base)).collect(),
                ..symbol
            },
        },
    }
}
