use crate::types::{Position, Range};

pub use crate::providers::Document;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum InlayKind {
    Type,
    Parameter,
    Other,
}

impl InlayKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Type => "type",
            Self::Parameter => "parameter",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlayHint {
    pub position: Position,
    pub label: String,
    pub kind: InlayKind,
    pub tooltip: Option<String>,
    pub padding_left: bool,
    pub padding_right: bool,
}

impl InlayHint {
    pub fn new(position: Position, label: impl Into<String>) -> Self {
        Self {
            position,
            label: label.into(),
            kind: InlayKind::Other,
            tooltip: None,
            padding_left: false,
            padding_right: false,
        }
    }

    pub fn kind(mut self, kind: InlayKind) -> Self {
        self.kind = kind;
        self
    }

    pub fn tooltip(mut self, tooltip: impl Into<String>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    pub fn padding_left(mut self) -> Self {
        self.padding_left = true;
        self
    }

    pub fn padding_right(mut self) -> Self {
        self.padding_right = true;
        self
    }
}

pub trait InlayHints {
    fn inlay_hints(&mut self, doc: &Document, range: Range) -> Vec<InlayHint>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hint_is_built_step_by_step() {
        let at = Position { line: 3, character: 14 };
        let hint = InlayHint::new(at, "GET /orders").kind(InlayKind::Type).tooltip("orders.index").padding_left();
        assert_eq!(hint.position, at);
        assert_eq!(hint.kind.as_str(), "type");
        assert_eq!(hint.tooltip.as_deref(), Some("orders.index"));
        assert!(hint.padding_left && !hint.padding_right);
        assert_eq!(InlayHint::new(at, "x").kind, InlayKind::Other);
    }
}
