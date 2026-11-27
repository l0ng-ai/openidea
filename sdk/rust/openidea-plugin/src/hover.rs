use crate::types::{Position, Range};

pub use crate::providers::Document;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hover {
    pub markdown: String,
    pub range: Option<Range>,
}

impl Hover {
    pub fn new(markdown: impl Into<String>) -> Self {
        Self { markdown: markdown.into(), range: None }
    }

    pub fn range(mut self, range: Range) -> Self {
        self.range = Some(range);
        self
    }
}

pub trait HoverProvider {
    fn hover(&mut self, doc: &Document, at: Position) -> Option<Hover>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hover_can_name_the_range_it_describes() {
        let range = Range { start: Position { line: 2, character: 4 }, end: Position { line: 2, character: 9 } };
        let hover = Hover::new("**route** `orders.index`").range(range);
        assert_eq!(hover.markdown, "**route** `orders.index`");
        assert_eq!(hover.range, Some(range));
        assert_eq!(Hover::new("x").range, None);
    }
}
