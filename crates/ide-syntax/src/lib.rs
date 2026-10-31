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

pub use jvm::{JvmPresentation, JvmTypeKind};
pub use types::*;

use ide_core::{CancellationToken, DocId, IdeError, LanguageId, Pos, Range};
use ide_language::{ParsedTree, SyntaxCache, TreeError};
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
        match self.cache.syntax().grammar_name(language) {
            Some(g) => StructureSupport { tree: true, locals: kinds::locals_source(g).is_some() },
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
