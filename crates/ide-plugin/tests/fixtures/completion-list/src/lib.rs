//! API 1.16 fixture for the optional `completion-list-provider` export: GORM-style
//! dynamic finders, built from what has been typed after the `.`, so the list is
//! marked incomplete.
use openidea_plugin::providers::{CompletionItem, CompletionKind, CompletionList, Document, Providers};
use openidea_plugin::{Error, Invocation, Plugin, Position, register_plugin};

#[derive(Default)]
struct Fixture;

impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(id.into()))
    }
}

impl Providers for Fixture {
    /// Not called once `completion_list` is exported.
    fn completion(&mut self, _: &Document, _: Position, _: Option<&str>) -> Vec<CompletionItem> {
        vec![CompletionItem::new("legacy", CompletionKind::Text)]
    }

    fn completion_list(&mut self, doc: &Document, at: Position, _: Option<&str>) -> CompletionList {
        let line = doc.text.lines().nth(at.line as usize).unwrap_or_default();
        // ASCII test documents: the UTF-16 column is the byte offset.
        let head = &line[..(at.character as usize).min(line.len())];
        let Some(dot) = head.rfind('.') else {
            return vec![CompletionItem::new("findBy", CompletionKind::Method)].into();
        };
        let typed = &head[dot + 1..];
        let items = ["Title", "Author"]
            .iter()
            .map(|p| CompletionItem::new(&format!("{typed}{p}"), CompletionKind::Method))
            .collect();
        CompletionList { items, incomplete: true }
    }
}

register_plugin!(Fixture, providers, completion_list);
