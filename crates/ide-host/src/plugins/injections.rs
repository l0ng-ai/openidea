//! Embedded plugin-provider documents preserve the host's UTF-16 coordinates.
use super::{PluginHost, ProviderKind};
use ide_core::{Pos, Range};
use ide_plugin::{ProviderDocument, language_features::Injection};
use std::sync::Arc;

/// Allowed output ranges for one virtual document; the host document is unrestricted.
pub(super) struct Bounds(Option<Vec<Range>>);
impl Bounds {
    pub fn unrestricted() -> Self {
        Self(None)
    }
    pub fn contains(&self, range: Range) -> bool {
        self.0.as_ref().is_none_or(|rs| rs.iter().any(|r| r.start <= range.start && range.end <= r.end))
    }
    pub fn lines(&self, start: u32, end: u32) -> bool {
        self.0.as_ref().is_none_or(|rs| rs.iter().any(|r| r.start.line <= start && end <= r.end.line))
    }
}

impl PluginHost {
    pub fn provide_injections(&self, doc: &ProviderDocument) -> Vec<Injection> {
        if !self.providers.any(ProviderKind::Injections) {
            return vec![];
        }
        if doc.text.len() > super::navigation::MAX_DOCUMENT_BYTES {
            return Vec::new();
        }
        let text = ide_text::Document::new(&doc.text);
        let d = Arc::new(doc.clone());
        let mut items: Vec<_> = self
            .document_calls(ProviderKind::Injections, doc, move |rt, t| rt.provide_injections(&d, t))
            .into_iter()
            .flat_map(|(_, v)| v)
            .filter(|i| {
                !i.range.is_empty()
                    && super::language_features::valid_range_in(&text, i.range)
                    && i.language != doc.language
                    && !i.language.is_empty()
                    && i.language.len() <= 64
                    && i.language.chars().all(|c| c.is_ascii_alphanumeric() || "-_.+#".contains(c))
            })
            .collect();
        items.sort_by_key(|i| i.range);
        let mut end = Pos::default();
        items.retain(|i| {
            if i.range.start < end {
                return false;
            }
            end = i.range.end;
            true
        });
        items.truncate(1000);
        items
    }

    pub(super) fn feature_documents(&self, doc: &ProviderDocument, at: Option<Pos>) -> Vec<(ProviderDocument, Bounds)> {
        let injections = self.provide_injections(doc);
        let mut languages = Vec::new();
        for i in &injections {
            if at.is_some_and(|p| p < i.range.start || p >= i.range.end) || languages.contains(&i.language) {
                continue;
            }
            languages.push(i.language.clone());
            if languages.len() == 32 {
                break;
            }
        }
        let mut docs = Vec::new();
        for language in languages {
            let ranges = injections.iter().filter(|i| i.language == language).map(|i| i.range).collect();
            let text = virtual_text(doc, &injections, &language);
            docs.push((ProviderDocument { language, text, ..doc.clone() }, Bounds(Some(ranges))));
        }
        docs.push((doc.clone(), Bounds(None)));
        docs
    }
}

pub(crate) fn virtual_text(doc: &ProviderDocument, ranges: &[Injection], language: &str) -> String {
    let ranges: Vec<_> = ranges.iter().filter(|i| i.language == language).map(|i| i.range).collect();
    let mut index = 0;
    let mut at = Pos::default();
    let mut text = String::with_capacity(doc.text.len());
    for c in doc.text.chars() {
        while index < ranges.len() && ranges[index].end <= at {
            index += 1;
        }
        let inside = ranges.get(index).is_some_and(|r| r.start <= at && at < r.end);
        if inside || c == '\n' || c == '\r' {
            text.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                text.push(' ');
            }
        }
        if c == '\n' {
            at.line += 1;
            at.col = 0;
        } else {
            at.col += c.len_utf16() as u32;
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn virtual_documents_preserve_utf16_columns_and_newlines() {
        let d = ProviderDocument {
            path: "/p/a".into(),
            language: "host".into(),
            version: 7,
            text: "😀 sql\n outside\n sql".into(),
        };
        let ranges = vec![
            Injection { range: Range::new(Pos::new(0, 3), Pos::new(0, 6)), language: "sql".into() },
            Injection { range: Range::new(Pos::new(2, 1), Pos::new(2, 4)), language: "sql".into() },
        ];
        let text = virtual_text(&d, &ranges, "sql");
        assert_eq!(text, "   sql\n        \n sql");
        assert_eq!(text.encode_utf16().count(), d.text.encode_utf16().count());
    }
}
