//! Results returned by a plugin's optional Search Everywhere provider.
use crate::Location;

#[derive(Clone, Debug)]
pub enum SearchTarget {
    Location(Location),
    Command { id: String, arg: Option<String> },
}
#[derive(Clone, Debug)]
pub struct SearchItem {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub target: SearchTarget,
}
#[derive(Clone, Debug, Default)]
pub struct SearchPage {
    pub items: Vec<SearchItem>,
    pub has_more: bool,
}
