use ide_core::Range;
use ide_lsp::types::{InlayHint, InlayKind};
use ide_plugin::PluginInlayHint;

pub(crate) fn merge(server: Vec<InlayHint>, plugin: Vec<PluginInlayHint>, range: Range) -> Vec<InlayHint> {
    let inside = |h: &PluginInlayHint| {
        let at = (h.position.line, h.position.col);
        (range.start.line, range.start.col) <= at && at <= (range.end.line, range.end.col)
    };
    let mut out = server;
    out.extend(plugin.into_iter().filter(inside).map(|h| InlayHint {
        position: h.position,
        label: h.label,
        kind: match h.kind.as_str() {
            "type" => InlayKind::Type,
            "parameter" => InlayKind::Parameter,
            _ => InlayKind::Other,
        },
        padding_left: h.padding_left,
        padding_right: h.padding_right,
        tooltip: h.tooltip,
        parts: Vec::new(),
    }));
    out.sort_by_key(|h| (h.position.line, h.position.col));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::Pos;

    fn plugin(line: u32, col: u32, label: &str, kind: &str) -> PluginInlayHint {
        PluginInlayHint {
            position: Pos::new(line, col),
            label: label.into(),
            kind: kind.into(),
            tooltip: Some("from the plugin".into()),
            padding_left: true,
            padding_right: false,
        }
    }

    fn server(line: u32, col: u32, label: &str) -> InlayHint {
        InlayHint {
            position: Pos::new(line, col),
            label: label.into(),
            kind: InlayKind::Parameter,
            padding_left: false,
            padding_right: true,
            tooltip: None,
            parts: Vec::new(),
        }
    }

    fn summary(hints: &[InlayHint]) -> Vec<(u32, u32, String)> {
        hints.iter().map(|h| (h.position.line, h.position.col, h.label.clone())).collect()
    }

    #[test]
    fn plugin_hints_join_the_servers_in_position_order() {
        let range = Range::new(Pos::new(0, 0), Pos::new(10, 0));
        let merged = merge(
            vec![server(2, 4, "name:"), server(5, 1, "id:")],
            vec![plugin(3, 9, ": string", "type"), plugin(2, 1, "GET /orders", "other")],
            range,
        );
        assert_eq!(
            summary(&merged),
            [
                (2, 1, "GET /orders".to_owned()),
                (2, 4, "name:".to_owned()),
                (3, 9, ": string".to_owned()),
                (5, 1, "id:".to_owned())
            ]
        );
        let typed = merged.iter().find(|h| h.label == ": string").unwrap();
        assert!(matches!(typed.kind, InlayKind::Type));
        assert!(typed.padding_left && !typed.padding_right);
        assert_eq!(typed.tooltip.as_deref(), Some("from the plugin"));
    }

    #[test]
    fn unknown_kinds_are_other_and_hints_outside_the_range_are_dropped() {
        let range = Range::new(Pos::new(2, 5), Pos::new(4, 3));
        let merged = merge(
            Vec::new(),
            vec![plugin(2, 4, "before", "type"), plugin(3, 0, "in", "route"), plugin(4, 4, "after", "type")],
            range,
        );
        assert_eq!(summary(&merged), [(3, 0, "in".to_owned())]);
        assert!(matches!(merged[0].kind, InlayKind::Other));
    }
}
