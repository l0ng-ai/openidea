//! `limit` and `offset` of the tools that list things: a few items by default, the rest page by page.

use super::tool::Call;
use ide_core::{IdeError, IdeResult};
use serde_json::{Map, Value};

/// The most items one call returns.
pub const MAX_LIMIT: usize = 1000;
pub const OFFSET: &str = "Items to skip: `nextOffset` of the previous page";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Page {
    pub offset: usize,
    pub limit: usize,
}

impl Page {
    /// The `limit` (`default` when absent, at most [`MAX_LIMIT`]) and `offset` (0) arguments.
    pub fn of(call: &Call, default: usize) -> IdeResult<Self> {
        let limit = match call.opt_i64("limit")? {
            None => default,
            Some(n) if n <= 0 => return Err(IdeError::invalid("limit must be > 0")),
            Some(n) => (n as usize).min(MAX_LIMIT),
        };
        let offset = match call.opt_i64("offset")? {
            None => 0,
            Some(n) if n < 0 => return Err(IdeError::invalid("offset must be >= 0")),
            Some(n) => n as usize,
        };
        Ok(Self { offset, limit })
    }

    /// Where the page ends: the items to find for it.
    pub fn end(&self) -> usize {
        self.offset.saturating_add(self.limit)
    }

    /// This page of all the `items`; `out` gets their `total`, and `more` and `nextOffset` when some follow.
    pub fn take<T>(&self, items: Vec<T>, out: &mut Map<String, Value>) -> Vec<T> {
        let total = items.len();
        out.insert("total".into(), total.into());
        self.mark(total > self.end(), out);
        items.into_iter().skip(self.offset).take(self.limit).collect()
    }

    /// `more` and `nextOffset` when items follow the page.
    pub fn mark(&self, more: bool, out: &mut Map<String, Value>) {
        if more {
            out.insert("more".into(), true.into());
            out.insert("nextOffset".into(), self.end().into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_say_what_follows() {
        let page = |offset, limit| Page { offset, limit };
        let mut out = Map::new();
        assert_eq!(page(0, 2).take(vec![1, 2, 3, 4, 5], &mut out), [1, 2]);
        assert_eq!(Value::Object(out), serde_json::json!({ "total": 5, "more": true, "nextOffset": 2 }));
        let mut out = Map::new();
        assert_eq!(page(4, 2).take(vec![1, 2, 3, 4, 5], &mut out), [5]);
        assert_eq!(Value::Object(out), serde_json::json!({ "total": 5 }), "the last page");
        let mut out = Map::new();
        assert!(page(9, 2).take(vec![1], &mut out).is_empty());
    }
}
