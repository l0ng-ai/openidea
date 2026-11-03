//! Execution plans (IDEA's Explain Plan): the `EXPLAIN` statement of each
//! dialect and its output read into one flat tree of operations.

use crate::DbDriver;
use crate::conn::QueryResult;
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbPlanProperty")]
pub struct PlanProperty {
    pub name: String,
    pub value: String,
}

/// One operation of a plan; `parent` indexes the plan's node list (roots: `None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbPlanNode")]
pub struct PlanNode {
    pub parent: Option<u32>,
    /// `Full Scan`, `Index Scan`, `Hash Join`…
    pub operation: String,
    /// The object it works on and its key details (`table: o;`).
    pub params: String,
    pub properties: Vec<PlanProperty>,
}

/// The statement that explains `statement` without running it.
pub fn explain_statement(driver: DbDriver, statement: &str) -> String {
    let s = statement.trim().trim_end_matches(';');
    match driver {
        DbDriver::Sqlite => format!("EXPLAIN QUERY PLAN {s}"),
        DbDriver::Postgres => format!("EXPLAIN (FORMAT JSON) {s}"),
        DbDriver::Mysql => format!("EXPLAIN {s}"),
        DbDriver::SqlServer => format!("SET SHOWPLAN_TEXT ON; {s}"),
    }
}

/// Reads the result of [`explain_statement`].
pub fn parse(driver: DbDriver, result: &QueryResult) -> IdeResult<Vec<PlanNode>> {
    match driver {
        DbDriver::Sqlite => Ok(sqlite(&result.rows)),
        DbDriver::Postgres => {
            let text: String =
                result.rows.iter().filter_map(|r| r.first().cloned().flatten()).collect::<Vec<_>>().join("\n");
            let json: Value = serde_json::from_str(&text).map_err(|e| IdeError::invalid(format!("plan: {e}")))?;
            let mut out = Vec::new();
            for root in json.as_array().into_iter().flatten() {
                if let Some(plan) = root.get("Plan") {
                    postgres(plan, None, &mut out);
                }
            }
            Ok(out)
        }
        DbDriver::Mysql => {
            let names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
            Ok(mysql(&names, &result.rows))
        }
        DbDriver::SqlServer => Ok(Vec::new()),
    }
}

fn prop(name: &str, value: impl Into<String>) -> PlanProperty {
    PlanProperty { name: name.to_owned(), value: value.into() }
}

/// SQLite rows: `id, parent, notused, detail` (`SCAN o`, `SEARCH c USING INTEGER PRIMARY KEY (rowid=?)`).
fn sqlite(rows: &[Vec<Option<String>>]) -> Vec<PlanNode> {
    let mut ids: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for r in rows {
        let cell = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
        let (id, parent, detail) = (cell(0), cell(1), cell(3));
        let parent = ids.iter().position(|x| *x == parent).map(|i| i as u32);
        let (operation, params) = sqlite_operation(&detail);
        out.push(PlanNode { parent, operation, params, properties: vec![prop("Detail", detail.clone())] });
        ids.push(id);
    }
    out
}

fn sqlite_operation(detail: &str) -> (String, String) {
    let words: Vec<&str> = detail.split_whitespace().collect();
    let object = |i: usize| words.get(i).map(|t| format!("table: {t};")).unwrap_or_default();
    let using = || detail.find(" USING ").map(|i| detail[i + 1..].to_owned()).unwrap_or_default();
    match words.first().copied() {
        Some("SCAN") if detail.contains(" USING ") => ("Index Scan".into(), format!("{} {}", object(1), using())),
        Some("SCAN") => ("Full Scan".into(), object(1)),
        Some("SEARCH") => ("Index Scan".into(), format!("{} {}", object(1), using()).trim().to_owned()),
        Some("USE") if detail.contains("ORDER BY") => ("Order By".into(), String::new()),
        Some("USE") if detail.contains("GROUP BY") => ("Group By".into(), String::new()),
        Some("USE") if detail.contains("DISTINCT") => ("Distinct".into(), String::new()),
        _ => (detail.to_owned(), String::new()),
    }
}

/// PostgreSQL JSON plan node: `Node Type`, `Relation Name`, nested `Plans`.
fn postgres(node: &Value, parent: Option<u32>, out: &mut Vec<PlanNode>) {
    let text = |k: &str| node.get(k).and_then(Value::as_str).unwrap_or_default();
    let mut operation = text("Node Type").to_owned();
    if let Some(j) = node.get("Join Type").and_then(Value::as_str).filter(|j| *j != "Inner") {
        operation = format!("{operation} ({j})");
    }
    let mut params = Vec::new();
    if let Some(r) = node.get("Relation Name").and_then(Value::as_str) {
        let alias = text("Alias");
        params.push(if alias.is_empty() || alias == r {
            format!("table: {r};")
        } else {
            format!("table: {r} {alias};")
        });
    }
    if let Some(i) = node.get("Index Name").and_then(Value::as_str) {
        params.push(format!("index: {i};"));
    }
    for k in ["Index Cond", "Hash Cond", "Merge Cond", "Filter", "Join Filter"] {
        if let Some(c) = node.get(k).and_then(Value::as_str) {
            params.push(format!("{}: {c};", k.to_lowercase()));
        }
    }
    let properties = node
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, _)| k.as_str() != "Plans")
        .map(|(k, v)| {
            let value = match v {
                Value::String(s) => s.clone(),
                Value::Array(a) => a
                    .iter()
                    .map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_owned))
                    .collect::<Vec<_>>()
                    .join(", "),
                other => other.to_string(),
            };
            prop(k, value)
        })
        .collect();
    let me = out.len() as u32;
    out.push(PlanNode { parent, operation, params: params.join(" "), properties });
    for child in node.get("Plans").and_then(Value::as_array).into_iter().flatten() {
        postgres(child, Some(me), out);
    }
}

/// MySQL's tabular `EXPLAIN`: one row per table access, flat.
fn mysql(names: &[&str], rows: &[Vec<Option<String>>]) -> Vec<PlanNode> {
    let col = |r: &[Option<String>], n: &str| {
        names.iter().position(|c| c.eq_ignore_ascii_case(n)).and_then(|i| r.get(i).cloned().flatten())
    };
    rows.iter()
        .map(|r| {
            let access = col(r, "type").unwrap_or_default();
            let operation = match access.as_str() {
                "ALL" => "Full Scan".to_owned(),
                "index" => "Full Index Scan".to_owned(),
                "range" => "Index Range Scan".to_owned(),
                "ref" | "eq_ref" | "ref_or_null" => "Index Lookup".to_owned(),
                "const" | "system" => "Constant Lookup".to_owned(),
                "" => col(r, "Extra").unwrap_or_else(|| "Select".to_owned()),
                other => other.to_owned(),
            };
            let mut params = Vec::new();
            if let Some(t) = col(r, "table") {
                params.push(format!("table: {t};"));
            }
            if let Some(k) = col(r, "key") {
                params.push(format!("key: {k};"));
            }
            let properties = names.iter().zip(r).filter_map(|(n, v)| v.as_ref().map(|v| prop(n, v.clone()))).collect();
            PlanNode { parent: None, operation, params: params.join(" "), properties }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conn::ResultColumn;

    fn result(columns: &[&str], rows: Vec<Vec<Option<&str>>>) -> QueryResult {
        QueryResult {
            statement: String::new(),
            columns: columns.iter().map(|c| ResultColumn { name: (*c).into(), type_name: String::new() }).collect(),
            rows: rows.into_iter().map(|r| r.into_iter().map(|v| v.map(str::to_owned)).collect()).collect(),
            affected: None,
            has_more: false,
            elapsed_ms: 0.0,
            execution_ms: 0.0,
        }
    }

    #[test]
    fn explains_per_dialect() {
        assert_eq!(explain_statement(DbDriver::Sqlite, "select 1;"), "EXPLAIN QUERY PLAN select 1");
        assert_eq!(explain_statement(DbDriver::Postgres, " select 1 "), "EXPLAIN (FORMAT JSON) select 1");
        assert_eq!(explain_statement(DbDriver::Mysql, "select 1"), "EXPLAIN select 1");
        assert_eq!(explain_statement(DbDriver::SqlServer, "select 1"), "SET SHOWPLAN_TEXT ON; select 1");
    }

    #[test]
    fn reads_sqlite_plans_like_idea() {
        let r = result(
            &["id", "parent", "notused", "detail"],
            vec![
                vec![Some("3"), Some("0"), Some("0"), Some("SCAN o")],
                vec![Some("5"), Some("0"), Some("0"), Some("SEARCH c USING INTEGER PRIMARY KEY (rowid=?)")],
                vec![Some("9"), Some("0"), Some("0"), Some("USE TEMP B-TREE FOR ORDER BY")],
            ],
        );
        let plan = parse(DbDriver::Sqlite, &r).unwrap();
        let ops: Vec<(&str, &str)> = plan.iter().map(|n| (n.operation.as_str(), n.params.as_str())).collect();
        assert_eq!(
            ops,
            [
                ("Full Scan", "table: o;"),
                ("Index Scan", "table: c; USING INTEGER PRIMARY KEY (rowid=?)"),
                ("Order By", "")
            ]
        );
        assert!(plan.iter().all(|n| n.parent.is_none()));
    }

    #[test]
    fn nests_sqlite_children_under_their_parent() {
        let r = result(
            &["id", "parent", "notused", "detail"],
            vec![
                vec![Some("2"), Some("0"), Some("0"), Some("CO-ROUTINE sub")],
                vec![Some("4"), Some("2"), Some("0"), Some("SCAN t")],
            ],
        );
        let plan = parse(DbDriver::Sqlite, &r).unwrap();
        assert_eq!(plan[1].parent, Some(0));
    }

    #[test]
    fn reads_postgres_json_trees() {
        let json = r#"[{"Plan": {"Node Type": "Hash Join", "Join Type": "Inner", "Hash Cond": "(o.customer_id = c.id)",
            "Total Cost": 12.5, "Plans": [
              {"Node Type": "Seq Scan", "Relation Name": "orders", "Alias": "o", "Filter": "(status <> 'x')"},
              {"Node Type": "Hash", "Plans": [{"Node Type": "Seq Scan", "Relation Name": "customers", "Alias": "c"}]}
            ]}}]"#;
        let plan = parse(DbDriver::Postgres, &result(&["QUERY PLAN"], vec![vec![Some(json)]])).unwrap();
        assert_eq!(plan.len(), 4);
        assert_eq!(plan[0].operation, "Hash Join");
        assert_eq!(plan[0].params, "hash cond: (o.customer_id = c.id);");
        assert!(plan[0].properties.iter().any(|p| p.name == "Total Cost" && p.value == "12.5"));
        assert_eq!((plan[1].parent, plan[1].params.as_str()), (Some(0), "table: orders o; filter: (status <> 'x');"));
        assert_eq!((plan[3].parent, plan[3].operation.as_str()), (Some(2), "Seq Scan"));
    }

    #[test]
    fn reads_mysql_rows() {
        let r = result(
            &["id", "select_type", "table", "type", "key", "rows", "Extra"],
            vec![
                vec![Some("1"), Some("SIMPLE"), Some("o"), Some("ALL"), None, Some("20"), Some("Using where")],
                vec![Some("1"), Some("SIMPLE"), Some("c"), Some("eq_ref"), Some("PRIMARY"), Some("1"), None],
            ],
        );
        let plan = parse(DbDriver::Mysql, &r).unwrap();
        assert_eq!((plan[0].operation.as_str(), plan[0].params.as_str()), ("Full Scan", "table: o;"));
        assert_eq!((plan[1].operation.as_str(), plan[1].params.as_str()), ("Index Lookup", "table: c; key: PRIMARY;"));
        assert!(plan[0].properties.iter().any(|p| p.name == "rows" && p.value == "20"));
    }
}
