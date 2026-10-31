//! Query results the database tools hand out by id (`qr_1f3a9c0b`) and page through, and
//! their CSV text.

use ide_db::QueryResult;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

/// Result sets kept per project.
pub const MAX_STORED_RESULT_SETS: usize = 25;
/// Evicted ids remembered to tell "evicted" from "not found".
const MAX_EVICTED_IDS: usize = 1000;
/// Rows of a result OpenIDEA fetches and keeps for paging (read up front).
pub const MAX_KEPT_ROWS: usize = 10_000;

pub const EVICTED: &str = "Query result set has been evicted from the cache";
pub const NOT_FOUND: &str = "Query result set was not found";

/// One stored result: its rows and the page size it was run with.
#[derive(Clone)]
pub struct StoredResult {
    pub result: QueryResult,
    pub page_size: usize,
}

#[derive(Default)]
struct ResultSets {
    /// In insertion order: eviction drops the oldest, reading does not refresh.
    entries: VecDeque<(String, StoredResult)>,
    evicted: VecDeque<String>,
}

/// The stores of the open projects, by project root.
fn stores() -> &'static Mutex<HashMap<PathBuf, ResultSets>> {
    static STORES: std::sync::OnceLock<Mutex<HashMap<PathBuf, ResultSets>>> = std::sync::OnceLock::new();
    STORES.get_or_init(Mutex::default)
}

fn new_id() -> String {
    format!("qr_{}", &uuid::Uuid::new_v4().to_string()[..8])
}

/// Keeps `result` of project `root`, evicting the oldest beyond the capacity; returns its id.
pub fn store(root: &Path, result: StoredResult) -> String {
    let id = new_id();
    let mut stores = stores().lock();
    let sets = stores.entry(root.to_path_buf()).or_default();
    sets.entries.push_back((id.clone(), result));
    while sets.entries.len() > MAX_STORED_RESULT_SETS {
        let Some((old, _)) = sets.entries.pop_front() else { break };
        sets.evicted.push_back(old);
        if sets.evicted.len() > MAX_EVICTED_IDS {
            sets.evicted.pop_front();
        }
    }
    id
}

/// The stored result `id` of project `root`, or why there is none.
pub fn get(root: &Path, id: &str) -> Result<StoredResult, &'static str> {
    let stores = stores().lock();
    let Some(sets) = stores.get(root) else { return Err(NOT_FOUND) };
    if let Some((_, r)) = sets.entries.iter().find(|(k, _)| k == id) {
        return Ok(r.clone());
    }
    Err(if sets.evicted.iter().any(|k| k == id) { EVICTED } else { NOT_FOUND })
}

/// A query's result: `text` and `errorMessage` are left out when absent.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueryExecutionResult {
    pub result_set_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// The page of `stored` at row `offset` as CSV, or `empty_text` when it has no rows there.
pub fn page(id: &str, stored: &StoredResult, offset: usize, empty_text: &str) -> QueryExecutionResult {
    let rows = &stored.result.rows;
    let end = offset.saturating_add(stored.page_size.max(1)).min(rows.len());
    let text = if offset >= rows.len() {
        empty_text.to_owned()
    } else {
        let names: Vec<Option<String>> = stored.result.columns.iter().map(|c| Some(c.name.clone())).collect();
        csv(&names, &rows[offset..end])
    };
    QueryExecutionResult { result_set_id: id.to_owned(), text: Some(text), error_message: None }
}

/// The IDE's default CSV format: a header line and one line per row, each ending with `\n`;
/// a value is quoted (`"` doubled inside) when it contains `,`, `"` or a line break, or is
/// empty; SQL NULL is nothing at all.
pub fn csv(header: &[Option<String>], rows: &[Vec<Option<String>>]) -> String {
    let mut out = String::new();
    for row in std::iter::once(header).chain(rows.iter().map(Vec::as_slice)) {
        let cells: Vec<String> = row.iter().map(|v| cell(v.as_deref())).collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    out
}

fn cell(value: Option<&str>) -> String {
    match value {
        None => String::new(),
        Some(v) if v.is_empty() || v.contains([',', '"', '\n', '\r']) => format!("\"{}\"", v.replace('"', "\"\"")),
        Some(v) => v.to_owned(),
    }
}

/// The summary of one error: the trimmed message ending with `.\n`
/// (only `\n` when it already ends with a period); blank paragraphs become sentences.
pub fn error_summary(message: &str) -> String {
    let text = message.trim().replace("\n\n", ".\n");
    if text.is_empty() {
        return "Unknown error".to_owned();
    }
    if text.ends_with('.') { format!("{text}\n") } else { format!("{text}.\n") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_db::ResultColumn;

    fn result(rows: usize) -> QueryResult {
        QueryResult {
            statement: "select".into(),
            columns: vec![
                ResultColumn { name: "id".into(), type_name: "int".into() },
                ResultColumn { name: "name".into(), type_name: "text".into() },
            ],
            rows: (0..rows).map(|i| vec![Some(i.to_string()), Some(format!("n{i}"))]).collect(),
            affected: None,
            has_more: false,
            elapsed_ms: 0.0,
            execution_ms: 0.0,
        }
    }

    #[test]
    fn renders_csv_like_the_ide_default_format() {
        let rows = vec![
            vec![Some("1".into()), None],
            vec![Some("a,b".into()), Some(String::new())],
            vec![Some("say \"hi\"".into()), Some("two\nlines".into())],
        ];
        assert_eq!(
            csv(&[Some("id".into()), Some("v".into())], &rows),
            "id,v\n1,\n\"a,b\",\"\"\n\"say \"\"hi\"\"\",\"two\nlines\"\n"
        );
    }

    #[test]
    fn pages_through_a_result() {
        let stored = StoredResult { result: result(25), page_size: 10 };
        let first = page("qr_1", &stored, 0, "Query executed successfully");
        let text = first.text.unwrap();
        assert!(text.starts_with("id,name\n0,n0\n"));
        assert_eq!(text.lines().count(), 11);
        assert_eq!(page("qr_1", &stored, 20, "x").text.unwrap().lines().count(), 6);
        assert_eq!(
            page("qr_1", &stored, 25, "No more rows in the query result").text.unwrap(),
            "No more rows in the query result"
        );
        let empty = StoredResult { result: result(0), page_size: 10 };
        assert_eq!(page("qr_2", &empty, 0, "Query executed successfully").text.unwrap(), "Query executed successfully");
    }

    #[test]
    fn evicts_the_oldest_and_remembers_it() {
        let root = Path::new("/projects/evicts_the_oldest");
        let first = store(root, StoredResult { result: result(1), page_size: 10 });
        assert!(first.starts_with("qr_") && first.len() == 11);
        for _ in 0..MAX_STORED_RESULT_SETS {
            store(root, StoredResult { result: result(1), page_size: 10 });
        }
        assert_eq!(get(root, &first).err(), Some(EVICTED));
        assert_eq!(get(root, "qr_00000000").err(), Some(NOT_FOUND));
        assert_eq!(get(Path::new("/elsewhere"), &first).err(), Some(NOT_FOUND));
    }

    #[test]
    fn summarises_errors() {
        assert_eq!(error_summary("relation \"t\" does not exist"), "relation \"t\" does not exist.\n");
        assert_eq!(error_summary("Done."), "Done.\n");
        assert_eq!(error_summary(" "), "Unknown error");
    }
}
