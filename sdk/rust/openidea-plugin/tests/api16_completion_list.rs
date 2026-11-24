use openidea_plugin::Position;
use openidea_plugin::mock::MockHost;
use openidea_plugin::providers::{CompletionItem, CompletionKind, CompletionList, Document, Providers};

/// GORM-style dynamic finders: each step depends on what has been typed, so the list is incomplete.
struct Finders;
impl Providers for Finders {
    fn completion_list(&mut self, doc: &Document, at: Position, _: Option<&str>) -> CompletionList {
        let line = doc.text.lines().nth(at.line as usize).unwrap_or_default();
        let typed = &line[line.rfind('.').map_or(0, |i| i + 1)..at.character as usize];
        let items = ["Title", "Author"]
            .iter()
            .map(|p| CompletionItem::new(&format!("{typed}{p}"), CompletionKind::Method))
            .collect();
        CompletionList { items, incomplete: true }
    }
}

/// A provider written before API 1.16: only `completion`.
struct Keywords;
impl Providers for Keywords {
    fn completion(&mut self, _: &Document, _: Position, _: Option<&str>) -> Vec<CompletionItem> {
        vec![CompletionItem::new("where", CompletionKind::Keyword)]
    }
}

#[test]
fn completion_lists_carry_the_incomplete_flag_and_default_to_completion() {
    let mock = MockHost::install();
    assert_eq!(mock.completion_list(&mut Finders, Position::new(0, 0), None), None, "no editor");
    mock.open_editor("/p/Book.groovy", "groovy", "Book.findByTitleAnd", &[]);
    let list = mock.completion_list(&mut Finders, Position::new(0, 19), None).unwrap();
    assert!(list.incomplete);
    let labels: Vec<_> = list.items.iter().map(|i| i.label.as_str()).collect();
    assert_eq!(labels, ["findByTitleAndTitle", "findByTitleAndAuthor"]);

    let list = mock.completion_list(&mut Keywords, Position::new(0, 19), None).unwrap();
    assert_eq!(list, CompletionList::from(vec![CompletionItem::new("where", CompletionKind::Keyword)]));
    assert!(!list.incomplete);
}
