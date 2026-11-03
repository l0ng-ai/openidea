//! Syntax from outside this crate for languages without a built-in grammar: a
//! plugin's `syntax-provider`. Providers return flat
//! results in UTF-8 byte offsets; they are validated and converted here into
//! the same [`OutlineItem`], [`FoldRange`] and highlight data the grammars
//! produce, so the editor can't tell the difference. Results are memoized per
//! document version by the [`super::SyntaxCache`] like the grammars' answers.

use super::highlight::SyntaxHighlightKind;
use super::lines::LineIndex;
use crate::{FoldKind, FoldRange};
use ide_core::{LanguageId, OutlineItem, SymbolKind};
use parking_lot::RwLock;
use std::sync::Arc;

/// A highlighted range (UTF-8 byte offsets); `kind` is a kebab-case
/// [`SyntaxHighlightKind`] name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalToken {
    pub start: u32,
    pub end: u32,
    pub kind: String,
}

/// A structure-view symbol (UTF-8 byte offsets); `parent` indexes an earlier
/// symbol of the same list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: String,
    pub start: u32,
    pub end: u32,
    pub name_start: u32,
    pub name_end: u32,
    pub parent: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalFold {
    pub start_line: u32,
    pub end_line: u32,
    pub kind: String,
}

/// Answers for languages it provides, `None` for the others.
pub trait ExternalSyntax: Send + Sync {
    fn highlights(&self, lang: &LanguageId, text: &str) -> Option<Vec<ExternalToken>>;
    fn outline(&self, lang: &LanguageId, text: &str) -> Option<Vec<ExternalSymbol>>;
    fn folding(&self, lang: &LanguageId, text: &str) -> Option<Vec<ExternalFold>>;
}

static PROVIDER: RwLock<Option<Arc<dyn ExternalSyntax>>> = RwLock::new(None);

/// Installs (or removes) the provider every project's syntax cache consults.
pub fn set_external_syntax(provider: Option<Arc<dyn ExternalSyntax>>) {
    *PROVIDER.write() = provider;
}

fn provider() -> Option<Arc<dyn ExternalSyntax>> {
    PROVIDER.read().clone()
}

fn clamp(text: &str, offset: u32) -> usize {
    let mut at = (offset as usize).min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// `[from, to, kind]` triples in UTF-16 offsets, sorted and non-overlapping.
pub(crate) fn highlights(lang: &LanguageId, text: &str) -> Option<Vec<u32>> {
    let mut tokens = provider()?.highlights(lang, text)?;
    tokens.sort_by_key(|t| (t.start, t.end));
    let lines = LineIndex::new(text);
    let mut data = Vec::with_capacity(tokens.len() * 3);
    let mut covered = 0usize;
    for t in tokens {
        let Some(kind) = SyntaxHighlightKind::from_name(&t.kind) else { continue };
        let (start, end) = (clamp(text, t.start), clamp(text, t.end));
        if end <= start || start < covered {
            continue;
        }
        covered = end;
        let index = SyntaxHighlightKind::ALL.iter().position(|k| *k == kind).unwrap_or_default() as u32;
        data.extend([lines.utf16_at(start) as u32, lines.utf16_at(end) as u32, index]);
    }
    Some(data)
}

fn symbol_kind(name: &str) -> SymbolKind {
    let camel: String = {
        let mut out = String::with_capacity(name.len());
        let mut upper = false;
        for c in name.chars() {
            if c == '-' {
                upper = true;
            } else if upper {
                out.push(c.to_ascii_uppercase());
                upper = false;
            } else {
                out.push(c);
            }
        }
        out
    };
    serde_json::from_value(serde_json::Value::String(camel)).unwrap_or(SymbolKind::Unknown)
}

pub(crate) fn outline(lang: &LanguageId, text: &str) -> Option<Vec<OutlineItem>> {
    let symbols = provider()?.outline(lang, text)?;
    let lines = LineIndex::new(text);
    // Built bottom-up: children are attached to their parent (an earlier index).
    let mut items: Vec<Option<OutlineItem>> = Vec::with_capacity(symbols.len());
    let mut parents: Vec<Option<usize>> = Vec::with_capacity(symbols.len());
    for (i, s) in symbols.iter().enumerate() {
        let (start, end) = (clamp(text, s.start), clamp(text, s.end.max(s.start)));
        let name_start = clamp(text, s.name_start).clamp(start, end);
        let name_end = clamp(text, s.name_end).clamp(name_start, end);
        items.push(Some(OutlineItem {
            name: s.name.clone(),
            detail: s.detail.clone(),
            kind: symbol_kind(&s.kind),
            range: lines.range(start, end),
            selection_range: lines.range(name_start, name_end),
            children: Vec::new(),
            visibility: None,
        }));
        parents.push(s.parent.map(|p| p as usize).filter(|&p| p < i));
    }
    for i in (0..items.len()).rev() {
        if let Some(p) = parents[i] {
            let child = items[i].take().expect("each item is moved once");
            if let Some(parent) = items[p].as_mut() {
                parent.children.insert(0, child);
            }
        }
    }
    Some(items.into_iter().flatten().collect())
}

pub(crate) fn folding(lang: &LanguageId, text: &str) -> Option<Vec<FoldRange>> {
    let folds = provider()?.folding(lang, text)?;
    let last_line = LineIndex::new(text).line_of(text.len()) as u32;
    let mut out: Vec<FoldRange> = folds
        .into_iter()
        .filter(|f| f.start_line < f.end_line && f.end_line <= last_line)
        .map(|f| FoldRange {
            start_line: f.start_line,
            end_line: f.end_line,
            kind: match f.kind.as_str() {
                "comment" => FoldKind::Comment,
                "imports" => FoldKind::Imports,
                _ => FoldKind::Region,
            },
        })
        .collect();
    out.sort_by_key(|f| (f.start_line, std::cmp::Reverse(f.end_line)));
    out.dedup_by_key(|f| (f.start_line, f.end_line));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;

    impl ExternalSyntax for Fake {
        fn highlights(&self, lang: &LanguageId, _: &str) -> Option<Vec<ExternalToken>> {
            (lang.as_str() == "fake").then(|| {
                vec![
                    ExternalToken { start: 9, end: 12, kind: "keyword".into() },
                    // "é" is 2 bytes, 1 UTF-16 unit.
                    ExternalToken { start: 0, end: 6, kind: "string".into() },
                    ExternalToken { start: 2, end: 4, kind: "number".into() }, // overlaps: dropped
                    ExternalToken { start: 13, end: 14, kind: "nonsense".into() },
                    ExternalToken { start: 7, end: 99, kind: "doc-comment".into() },
                ]
            })
        }
        fn outline(&self, lang: &LanguageId, _: &str) -> Option<Vec<ExternalSymbol>> {
            let sym = |name: &str, kind: &str, start, end, parent| ExternalSymbol {
                name: name.into(),
                detail: None,
                kind: kind.into(),
                start,
                end,
                name_start: start,
                name_end: start + 1,
                parent,
            };
            (lang.as_str() == "fake").then(|| {
                vec![
                    sym("C", "class", 0, 14, None),
                    sym("f", "function", 8, 12, Some(0)),
                    sym("g", "event", 12, 13, Some(0)),
                    sym("bad", "method", 1, 2, Some(9)),
                ]
            })
        }
        fn folding(&self, lang: &LanguageId, _: &str) -> Option<Vec<ExternalFold>> {
            (lang.as_str() == "fake").then(|| {
                vec![
                    ExternalFold { start_line: 0, end_line: 1, kind: "comment".into() },
                    ExternalFold { start_line: 1, end_line: 1, kind: "region".into() },
                    ExternalFold { start_line: 0, end_line: 9, kind: "region".into() },
                ]
            })
        }
    }

    #[test]
    fn converts_and_validates_provider_results() {
        set_external_syntax(Some(Arc::new(Fake)));
        let text = "\"héllo\"\nfn x(){}";
        let lang = LanguageId::new("fake");
        assert!(highlights(&LanguageId::new("other"), text).is_none());
        let data = highlights(&lang, text).unwrap();
        let string = SyntaxHighlightKind::ALL.iter().position(|k| *k == SyntaxHighlightKind::String).unwrap() as u32;
        let doc = SyntaxHighlightKind::ALL.iter().position(|k| *k == SyntaxHighlightKind::DocComment).unwrap() as u32;
        // UTF-16: `"héllo"` is 7 units (bytes 0..8 → 0..7); byte 6 is inside "o\"" → 5.
        assert_eq!(&data[..3], &[0, 5, string]);
        assert_eq!(&data[3..], &[6, 16, doc], "clamped to the text, keyword dropped as overlapping");

        let outline = outline(&lang, text).unwrap();
        assert_eq!(outline.len(), 2, "orphan with a bad parent stays top-level");
        assert_eq!(outline[0].kind, SymbolKind::Class);
        assert_eq!(
            outline[0].children.iter().map(|c| c.kind).collect::<Vec<_>>(),
            [SymbolKind::Function, SymbolKind::Event]
        );
        assert_eq!(outline[1].kind, SymbolKind::Method);

        let folds = folding(&lang, text).unwrap();
        assert_eq!(folds, [FoldRange { start_line: 0, end_line: 1, kind: FoldKind::Comment }]);
        set_external_syntax(None);
    }
}
