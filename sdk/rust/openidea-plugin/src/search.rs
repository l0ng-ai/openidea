//! Custom categories in Search Everywhere (API 1.11).
use crate::{Error, Invocation, Location};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchTarget {
    Location(Location),
    /// A local id declared in `contributes.commands`, and its optional argument.
    Command {
        id: String,
        arg: Option<String>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchItem {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub target: SearchTarget,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchPage {
    pub items: Vec<SearchItem>,
    pub has_more: bool,
}
/// Declare `[[contributes.searchCategories]]` and register with
/// `register_plugin!(MyPlugin, search)`. Calls are bounded, cancellable and
/// non-interactive. Return at most `limit` items, in relevance order.
pub trait SearchProvider {
    fn search(&mut self, category: &str, query: &str, limit: u32, ctx: &Invocation) -> Result<SearchPage, Error>;
}
