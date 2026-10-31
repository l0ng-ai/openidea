//! Test helpers: sources are plain strings; positions are named by the n-th
//! whole-word occurrence of an identifier (1-based), so fixtures stay readable.

mod jvm;
mod locals_langs;
mod structure;

use crate::*;
use ide_core::{LanguageId, Pos, Range};
use ide_language::{Syntax, SyntaxCache};
use std::sync::{Arc, OnceLock};

pub(crate) fn service() -> &'static StructureService {
    static S: OnceLock<StructureService> = OnceLock::new();
    S.get_or_init(|| StructureService::new(Arc::new(SyntaxCache::new(Arc::new(Syntax::new())))))
}

pub(crate) fn none() -> CancellationToken {
    CancellationToken::new()
}

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// Byte offsets of whole-word occurrences of `word`.
pub(crate) fn occurrences(src: &str, word: &str) -> Vec<usize> {
    let bytes = src.as_bytes();
    let first_is_word = word.bytes().next().is_some_and(is_word);
    src.match_indices(word)
        .map(|(i, _)| i)
        .filter(|&i| {
            let before = i.checked_sub(1).map(|j| bytes[j]);
            let after = bytes.get(i + word.len()).copied();
            (!first_is_word || !before.is_some_and(is_word)) && !after.is_some_and(is_word)
        })
        .collect()
}

pub(crate) fn pos_of(src: &str, byte: usize) -> Pos {
    let line = src[..byte].matches('\n').count() as u32;
    let start = src[..byte].rfind('\n').map_or(0, |i| i + 1);
    Pos::new(line, src[start..byte].encode_utf16().count() as u32)
}

/// Range of the `nth` (1-based) whole-word occurrence of `word`.
pub(crate) fn occ(src: &str, word: &str, nth: usize) -> Range {
    let all = occurrences(src, word);
    let Some(&b) = all.get(nth - 1) else { panic!("`{word}` occurs {} times, wanted #{nth}", all.len()) };
    Range::new(pos_of(src, b), pos_of(src, b + word.len()))
}

/// Range from the start of `from` to the end of `to` (first occurrences of the snippets).
pub(crate) fn span(src: &str, snippet: &str) -> Range {
    let b = src.find(snippet).unwrap_or_else(|| panic!("no `{snippet}` in source"));
    Range::new(pos_of(src, b), pos_of(src, b + snippet.len()))
}

pub(crate) fn lang(id: &str) -> LanguageId {
    LanguageId::new(id)
}

pub(crate) fn locals_at(language: &str, src: &str, word: &str, nth: usize) -> Locals {
    let l = lang(language);
    let r = occ(src, word, nth);
    service().locals(&Snapshot::text(&l, src), r.start, &none()).expect("locals")
}

/// Asserts that occurrence `at` of `word` is a local defined by occurrence
/// `def`, referenced exactly by occurrences `refs`.
#[track_caller]
pub(crate) fn assert_local(language: &str, src: &str, word: &str, at: usize, def: usize, refs: &[usize]) {
    match locals_at(language, src, word, at) {
        Locals::Local { symbol } => {
            let name = |r: &Range| {
                (1..=occurrences(src, word).len())
                    .find(|&n| occ(src, word, n) == *r)
                    .map_or_else(|| format!("{r:?}"), |n| format!("#{n}"))
            };
            let got_refs: Vec<String> = symbol.references.iter().map(name).collect();
            let want_refs: Vec<String> = refs.iter().map(|n| format!("#{n}")).collect();
            assert_eq!(
                (name(&symbol.definition), got_refs),
                (format!("#{def}"), want_refs),
                "{language}: `{word}` #{at} (definition, references)"
            );
            assert_eq!(symbol.name, word);
        }
        other => panic!("{language}: `{word}` #{at}: expected a local, got {other:?}"),
    }
}

#[track_caller]
pub(crate) fn assert_not_local(language: &str, src: &str, word: &str, at: usize) -> NotLocalReason {
    match locals_at(language, src, word, at) {
        Locals::NotLocal { reason, name, .. } => {
            assert_eq!(name, word);
            reason
        }
        other => panic!("{language}: `{word}` #{at}: expected not local, got {other:?}"),
    }
}
