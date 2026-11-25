//! The Dart analysis server's closing labels (`dart/textDocument/publishClosingLabels`): the
//! widget or call a closing `)` / `]` ends, shown after it at the end of the line (`// Column`).

use crate::convert::Conv;
use crate::text::{DocText, Encoding, col_to_byte, units};
use crate::types::{InlayHint, InlayKind};
use ide_core::Pos;
use lsp_types as lsp;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;
#[cfg(test)]
use std::sync::Arc;

#[derive(Deserialize)]
pub(crate) struct Params {
    pub uri: String,
    pub labels: Vec<Label>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct Label {
    range: lsp::Range,
    label: String,
}

/// One end-of-line hint per line, as the Flutter plugin shows them: `// Padding // Center` when
/// several constructs close on one line. A label whose range no longer ends in `)` or `]` (the
/// text changed since the analysis) is left out.
pub(crate) fn hints(conv: &Conv, path: &Path, text: &DocText, labels: Vec<Label>) -> Vec<InlayHint> {
    let mut lines: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    for l in labels {
        let end = conv.pos(path, l.range.end);
        let line = text.line(end.line as usize);
        let before = &line[..col_to_byte(line, end.col as usize, Encoding::Utf16)];
        if before.ends_with([')', ']']) {
            lines.entry(end.line).or_default().push(l.label);
        }
    }
    lines
        .into_iter()
        .map(|(line, labels)| InlayHint {
            position: Pos::new(line, units(text.line(line as usize), Encoding::Utf16) as u32),
            label: format!("// {}", labels.join(" // ")),
            kind: InlayKind::ClosingLabel,
            padding_left: true,
            padding_right: false,
            tooltip: None,
            parts: Vec::new(),
            text_edits: Vec::new(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn labels(v: serde_json::Value) -> Vec<Label> {
        serde_json::from_value(v).unwrap()
    }

    fn label(line: u32, from: u32, to: u32, label: &str) -> serde_json::Value {
        json!({ "label": label, "range": { "start": { "line": line, "character": from }, "end": { "line": line, "character": to } } })
    }

    #[test]
    fn labels_go_to_the_end_of_the_line_and_share_it() {
        let text = DocText::new("return Center(\n  child: Padding(\n    child: Text('a'))), // x\n");
        let conv = Conv::new(Encoding::Utf16, |_: &Path| None::<Arc<DocText>>);
        let hints = hints(
            &conv,
            Path::new("/a.dart"),
            &text,
            labels(json!([label(2, 4, 21, "Padding"), label(2, 4, 22, "Center"), label(2, 11, 20, "Text")])),
        );
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].label, "// Padding // Center // Text");
        assert_eq!(hints[0].position, Pos::new(2, 28));
        assert_eq!(hints[0].kind, InlayKind::ClosingLabel);
    }

    #[test]
    fn a_label_that_no_longer_ends_at_a_bracket_is_dropped() {
        let text = DocText::new("Column(children: [])\nRow(\n");
        let conv = Conv::new(Encoding::Utf16, |_: &Path| None::<Arc<DocText>>);
        let hints = hints(
            &conv,
            Path::new("/a.dart"),
            &text,
            labels(json!([label(0, 0, 19, "<Widget>[]"), label(1, 0, 3, "Row")])),
        );
        assert_eq!(hints.iter().map(|h| h.label.as_str()).collect::<Vec<_>>(), ["// <Widget>[]"]);
    }

    #[test]
    fn utf8_servers_and_wide_characters_give_utf16_columns() {
        let text = Arc::new(DocText::new("Text('🙂')\n"));
        let doc = text.clone();
        let conv = Conv::new(Encoding::Utf8, move |_: &Path| Some(doc.clone()));
        let hints = hints(&conv, Path::new("/a.dart"), &text, labels(json!([label(0, 0, 12, "Text")])));
        assert_eq!(hints[0].position, Pos::new(0, 10));
    }
}
