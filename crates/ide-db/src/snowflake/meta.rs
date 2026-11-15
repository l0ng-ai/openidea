//! The Database tree's metadata, read with `SHOW` and `DESCRIBE`: they need no running
//! warehouse, list only what the session's role may see, and are asked one level at a time.

use super::SnowflakePool;
use crate::sql::{quote_ident, quote_literal};
use crate::{
    ColumnInfo, CompletionColumn, CompletionTable, DbDriver, DbObjectKind, DbTableKind, ForeignKey, RoutineInfo,
    SchemaObject, SchemaObjects, SequenceInfo, TableDetails, TableInfo,
};
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::HashMap;

/// `SHOW … LIMIT` takes at most this many rows; longer lists continue `FROM` the last name.
const PAGE: usize = 10_000;
const MAX_ROWS: usize = 100_000;
const DRIVER: DbDriver = DbDriver::Snowflake;

/// A `SHOW` / `DESCRIBE` result, read by column name (their column order varies by version).
struct Shown {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
}

impl Shown {
    fn index(&self, name: &str) -> Option<usize> {
        self.columns.iter().position(|c| c.eq_ignore_ascii_case(name))
    }

    fn values<'a>(&'a self, name: &str) -> impl Iterator<Item = Option<&'a str>> + 'a {
        let index = self.index(name);
        self.rows.iter().map(move |row| index.and_then(|i| row.get(i)).and_then(|v| v.as_deref()))
    }

    fn records(&self) -> impl Iterator<Item = Record<'_>> {
        self.rows.iter().map(|row| Record { shown: self, row })
    }
}

struct Record<'a> {
    shown: &'a Shown,
    row: &'a [Option<String>],
}

impl<'a> Record<'a> {
    fn get(&self, name: &str) -> Option<&'a str> {
        self.shown.index(name).and_then(|i| self.row.get(i)).and_then(|v| v.as_deref())
    }

    fn text(&self, name: &str) -> String {
        self.get(name).unwrap_or_default().to_owned()
    }
}

async fn show(pool: &SnowflakePool, sql: &str) -> IdeResult<Shown> {
    let result = pool.metadata().execute(sql, MAX_ROWS, &CancellationToken::new()).await?;
    Ok(Shown { columns: result.columns.into_iter().map(|c| c.name).collect(), rows: result.rows })
}

/// A `SHOW` that lists by name, page after page.
async fn show_all(pool: &SnowflakePool, sql: &str) -> IdeResult<Shown> {
    let mut all = show(pool, &format!("{sql} LIMIT {PAGE}")).await?;
    let mut last_page = all.rows.len();
    while last_page >= PAGE && all.rows.len() < MAX_ROWS {
        let Some(last) = all.values("name").last().flatten().map(str::to_owned) else { break };
        let next = show(pool, &format!("{sql} LIMIT {PAGE} FROM {}", quote_literal(DRIVER, &last))).await?;
        last_page = next.rows.len();
        all.rows.extend(next.rows);
    }
    Ok(all)
}

/// ` IN DATABASE "DB"`, or nothing for the session's current database.
fn in_database(pool: &SnowflakePool) -> String {
    pool.database_ident().map(|db| format!(" IN DATABASE {db}")).unwrap_or_default()
}

/// `"DB"."SCHEMA"` (the schema as the tree names it: exactly).
fn schema_path(pool: &SnowflakePool, schema: &str) -> String {
    match pool.database_ident() {
        Some(db) => format!("{db}.{}", quote_ident(DRIVER, schema)),
        None => quote_ident(DRIVER, schema),
    }
}

fn object_path(pool: &SnowflakePool, schema: &str, name: &str) -> String {
    format!("{}.{}", schema_path(pool, schema), quote_ident(DRIVER, name))
}

pub(crate) async fn schemas(pool: &SnowflakePool, system: bool) -> IdeResult<Vec<String>> {
    let shown = show_all(pool, &format!("SHOW TERSE SCHEMAS{}", in_database(pool))).await?;
    Ok(shown
        .values("name")
        .flatten()
        .filter(|name| system || *name != "INFORMATION_SCHEMA")
        .map(str::to_owned)
        .collect())
}

fn table_kind(kind: &str) -> DbTableKind {
    let kind = kind.to_ascii_uppercase().replace('_', " ");
    if kind == "MATERIALIZED VIEW" {
        DbTableKind::MaterializedView
    } else if kind.ends_with("VIEW") {
        DbTableKind::View
    } else {
        DbTableKind::Table
    }
}

/// Tables of every kind (dynamic, external, hybrid…) and views of `schema`.
pub(crate) async fn tables(pool: &SnowflakePool, schema: &str) -> IdeResult<Vec<TableInfo>> {
    let shown = show_all(pool, &format!("SHOW TERSE OBJECTS IN SCHEMA {}", schema_path(pool, schema))).await?;
    Ok(shown
        .records()
        .filter_map(|r| {
            Some(TableInfo { name: r.get("name")?.to_owned(), kind: table_kind(r.get("kind").unwrap_or("TABLE")) })
        })
        .collect())
}

pub(crate) async fn table_details(pool: &SnowflakePool, schema: &str, table: &str) -> IdeResult<TableDetails> {
    let path = object_path(pool, schema, table);
    let described = show(pool, &format!("DESCRIBE TABLE {path}")).await?;
    let yes = |v: Option<&str>| v.is_some_and(|v| v.eq_ignore_ascii_case("Y"));
    let columns = described
        .records()
        .filter(|r| r.get("kind").is_none_or(|kind| kind.eq_ignore_ascii_case("COLUMN")))
        .filter_map(|r| {
            Some(ColumnInfo {
                name: r.get("name")?.to_owned(),
                data_type: r.text("type"),
                nullable: yes(r.get("null?")),
                default: r.get("default").filter(|d| !d.is_empty()).map(str::to_owned),
                primary_key: yes(r.get("primary key")),
            })
        })
        .collect();
    // Views have no keys; a role without the privilege still sees the columns.
    let foreign_keys = match show(pool, &format!("SHOW IMPORTED KEYS IN TABLE {path}")).await {
        Ok(keys) => foreign_keys(&keys),
        Err(_) => Vec::new(),
    };
    Ok(TableDetails { columns, indexes: Vec::new(), foreign_keys, triggers: Vec::new() })
}

fn foreign_keys(shown: &Shown) -> Vec<ForeignKey> {
    let mut rows: Vec<Record<'_>> = shown.records().collect();
    let sequence = |r: &Record<'_>| r.get("key_sequence").and_then(|n| n.parse::<u32>().ok()).unwrap_or(0);
    rows.sort_by_key(|a| (a.text("fk_name"), sequence(a)));
    let mut keys: Vec<(String, ForeignKey)> = Vec::new();
    for r in rows {
        let name = r.text("fk_name");
        if !keys.last().is_some_and(|(last, _)| *last == name) {
            keys.push((
                name,
                ForeignKey {
                    schema: r.text("fk_schema_name"),
                    table: r.text("fk_table_name"),
                    columns: Vec::new(),
                    ref_schema: r.text("pk_schema_name"),
                    ref_table: r.text("pk_table_name"),
                    ref_columns: Vec::new(),
                },
            ));
        }
        let key = &mut keys.last_mut().expect("pushed above").1;
        key.columns.push(r.text("fk_column_name"));
        key.ref_columns.push(r.text("pk_column_name"));
    }
    keys.into_iter().map(|(_, key)| key).collect()
}

/// Rows of `SHOW TERSE OBJECTS` for database `db` (quoted; `None`: the session's), each with
/// its `schema_name`. One listing for the database when that answers in full; schema by schema
/// (as the tree lists them) when it is refused or is cut off at a page, since a page
/// continues by object name and names repeat across schemas.
async fn database_objects(pool: &SnowflakePool, db: Option<&str>, schemas: &[String]) -> IdeResult<Shown> {
    let scope = db.map(|db| format!(" IN DATABASE {db}")).unwrap_or_default();
    match show(pool, &format!("SHOW TERSE OBJECTS{scope} LIMIT {PAGE}")).await {
        Ok(whole) if whole.rows.len() < PAGE && whole.index("schema_name").is_some() => return Ok(whole),
        Ok(_) => {}
        Err(e) => tracing::warn!("listing a whole database failed, listing its schemas instead: {}", e.message),
    }
    let mut all = Shown { columns: vec!["name".into(), "kind".into(), "schema_name".into()], rows: Vec::new() };
    let (mut listed, mut refused) = (0, None);
    for schema in schemas {
        let path = match db {
            Some(db) => format!("{db}.{}", quote_ident(DRIVER, schema)),
            None => quote_ident(DRIVER, schema),
        };
        // A schema the role may not list: the others still complete.
        let shown = match show_all(pool, &format!("SHOW TERSE OBJECTS IN SCHEMA {path}")).await {
            Ok(shown) => shown,
            Err(e) => {
                refused.get_or_insert(e);
                continue;
            }
        };
        listed += 1;
        let (Some(name), Some(kind)) = (shown.index("name"), shown.index("kind")) else { continue };
        all.rows.extend(shown.rows.into_iter().map(|mut row| {
            let kind = row.get_mut(kind).and_then(Option::take);
            let name = row.get_mut(name).and_then(Option::take);
            vec![name, kind, Some(schema.clone())]
        }));
        if all.rows.len() >= MAX_ROWS {
            break;
        }
    }
    // Nothing could be listed at all: that is a failure, not an empty database.
    match refused {
        Some(e) if listed == 0 => Err(e),
        _ => Ok(all),
    }
}

/// Every schema of `database` with its tables and views, for completion across databases.
pub(crate) async fn catalog(pool: &SnowflakePool, database: &str) -> IdeResult<Vec<crate::CatalogSchema>> {
    let db = quote_ident(DRIVER, database);
    let schemas = show_all(pool, &format!("SHOW TERSE SCHEMAS IN DATABASE {db}")).await?;
    let names: Vec<String> =
        schemas.values("name").flatten().filter(|name| *name != "INFORMATION_SCHEMA").map(str::to_owned).collect();
    let mut out: Vec<crate::CatalogSchema> =
        names.iter().map(|name| crate::CatalogSchema { name: name.clone(), tables: Vec::new() }).collect();
    let at: HashMap<String, usize> = out.iter().enumerate().map(|(i, s)| (s.name.clone(), i)).collect();
    let objects = database_objects(pool, Some(&db), &names).await?;
    for r in objects.records() {
        let (Some(&index), Some(name)) = (at.get(r.get("schema_name").unwrap_or_default()), r.get("name")) else {
            continue;
        };
        out[index].tables.push(TableInfo { name: name.to_owned(), kind: table_kind(r.get("kind").unwrap_or("TABLE")) });
    }
    for schema in &mut out {
        schema.tables.sort_by(|a, b| a.name.cmp(&b.name));
        schema.tables.dedup_by(|a, b| a.name == b.name);
    }
    Ok(out)
}

/// The session's warehouse and role, and the ones it may switch to.
pub(crate) async fn session(pool: &SnowflakePool) -> IdeResult<crate::SessionContext> {
    // The consoles' session: `USE WAREHOUSE` / `USE ROLE` there is what the pickers show.
    let sql = "SELECT CURRENT_WAREHOUSE(), CURRENT_ROLE(), CURRENT_AVAILABLE_ROLES()";
    let current = pool.execute(sql, 1, &CancellationToken::new()).await?.rows;
    let cell = |i: usize| current.first().and_then(|r| r.get(i).cloned().flatten()).unwrap_or_default();
    let mut roles: Vec<String> = serde_json::from_str(&cell(2)).unwrap_or_default();
    roles.sort();
    let warehouses = match show(pool, "SHOW WAREHOUSES").await {
        Ok(shown) => shown.values("name").flatten().map(str::to_owned).collect(),
        Err(_) => Vec::new(),
    };
    Ok(crate::SessionContext { warehouse: cell(0), role: cell(1), warehouses, roles })
}

/// `NAME(NUMBER, VARCHAR) RETURN NUMBER` as its argument types and result type.
fn signature(arguments: &str) -> (String, Option<String>) {
    let inner = arguments.split_once('(').map_or(arguments, |(_, rest)| rest);
    // The result type may hold parentheses of its own (`TABLE (…)`): split at the marker.
    let (types, returns) = match inner.split_once(") RETURN ") {
        Some((types, returns)) => (types, Some(returns.trim().to_owned())),
        None => (inner.strip_suffix(')').unwrap_or(inner), None),
    };
    (types.trim().to_owned(), returns.filter(|r| !r.is_empty()))
}

async fn routines(
    pool: &SnowflakePool,
    schema: &str,
    kind: DbObjectKind,
    like: Option<&str>,
) -> IdeResult<Vec<RoutineInfo>> {
    let what = if kind == DbObjectKind::Procedure { "PROCEDURES" } else { "USER FUNCTIONS" };
    let like = like.map(|name| format!(" LIKE {}", quote_literal(DRIVER, &escape_like(name)))).unwrap_or_default();
    let shown = show(pool, &format!("SHOW {what}{like} IN SCHEMA {}", schema_path(pool, schema))).await?;
    Ok(shown
        .records()
        .filter(|r| !r.get("is_builtin").is_some_and(|b| b.eq_ignore_ascii_case("Y")))
        .filter_map(|r| {
            let (arguments, returns) = signature(r.get("arguments").unwrap_or_default());
            Some(RoutineInfo {
                name: r.get("name")?.to_owned(),
                kind,
                arguments,
                returns: returns.filter(|_| kind == DbObjectKind::Function),
            })
        })
        .collect())
}

/// `LIKE` patterns match `_` and `%` loosely; escape them to match the name itself.
fn escape_like(name: &str) -> String {
    name.replace('\\', "\\\\").replace('_', "\\_").replace('%', "\\%")
}

/// Kinds of the tree's other folders, the `SHOW` that lists them, and the column that says most about one.
const OTHERS: &[(&str, &str, &str)] = &[
    ("stage", "STAGES", "type"),
    ("stream", "STREAMS", "table_name"),
    ("task", "TASKS", "schedule"),
    ("pipe", "PIPES", "definition"),
    ("fileFormat", "FILE FORMATS", "type"),
];

pub(crate) async fn schema_objects(pool: &SnowflakePool, schema: &str) -> IdeResult<SchemaObjects> {
    let mut out = SchemaObjects::default();
    // A role may see a schema's tables and none of these: each list stands alone.
    for kind in [DbObjectKind::Function, DbObjectKind::Procedure] {
        out.routines.extend(routines(pool, schema, kind, None).await.unwrap_or_default());
    }
    out.routines.sort_by(|a, b| (&a.name, &a.arguments).cmp(&(&b.name, &b.arguments)));
    if let Ok(shown) = show(pool, &format!("SHOW SEQUENCES IN SCHEMA {}", schema_path(pool, schema))).await {
        out.sequences = shown
            .values("name")
            .flatten()
            .map(|name| SequenceInfo { name: name.to_owned(), data_type: "NUMBER".into() })
            .collect();
    }
    for (kind, what, detail) in OTHERS {
        let Ok(shown) = show(pool, &format!("SHOW {what} IN SCHEMA {}", schema_path(pool, schema))).await else {
            continue;
        };
        out.others.extend(shown.records().filter_map(|r| {
            let detail: String = r.text(detail).split_whitespace().collect::<Vec<_>>().join(" ");
            Some(SchemaObject {
                kind: (*kind).to_owned(),
                name: r.get("name")?.to_owned(),
                detail: detail.chars().take(120).collect(),
            })
        }));
    }
    Ok(out)
}

/// The definitions of a routine's overloads, or of a sequence.
pub(crate) async fn object_ddl(
    pool: &SnowflakePool,
    schema: &str,
    kind: DbObjectKind,
    name: &str,
) -> IdeResult<Vec<String>> {
    let path = object_path(pool, schema, name);
    let mut out = Vec::new();
    match kind {
        DbObjectKind::Sequence => out.extend(ddl(pool, "SEQUENCE", path).await?),
        DbObjectKind::Function | DbObjectKind::Procedure => {
            let object = if kind == DbObjectKind::Procedure { "PROCEDURE" } else { "FUNCTION" };
            for routine in routines(pool, schema, kind, Some(name)).await?.into_iter().filter(|r| r.name == name) {
                // Overloads are told apart by their argument types (names and defaults dropped).
                let types: Vec<&str> = routine
                    .arguments
                    .split(',')
                    .map(|a| a.trim().trim_start_matches("DEFAULT ").trim())
                    .filter(|a| !a.is_empty())
                    .collect();
                out.extend(ddl(pool, object, format!("{path}({})", types.join(", "))).await?);
            }
        }
        DbObjectKind::Trigger | DbObjectKind::Package => {
            return Err(IdeError::invalid("Snowflake has no triggers or packages"));
        }
    }
    Ok(out)
}

async fn ddl(pool: &SnowflakePool, object: &str, target: String) -> IdeResult<Option<String>> {
    let sql = format!("SELECT GET_DDL('{object}', {})", quote_literal(DRIVER, &target));
    let rows = pool.metadata().execute(&sql, 1, &CancellationToken::new()).await?.rows;
    Ok(rows.into_iter().next().and_then(|r| r.into_iter().next().flatten()))
}

/// A column type of `SHOW COLUMNS` (`{"type":"FIXED","precision":38,"scale":0,…}`) the way SQL spells it.
fn column_type(json: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return json.to_owned() };
    let kind = value.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_ascii_uppercase();
    let number = |name: &str| value.get(name).and_then(|n| n.as_i64());
    match kind.as_str() {
        "FIXED" => match (number("precision"), number("scale")) {
            (Some(p), Some(s)) => format!("NUMBER({p},{s})"),
            _ => "NUMBER".into(),
        },
        "REAL" => "FLOAT".into(),
        "TEXT" => match number("length") {
            Some(n) if n > 0 && n < 16_777_216 => format!("VARCHAR({n})"),
            _ => "VARCHAR".into(),
        },
        "TIME" | "TIMESTAMP_NTZ" | "TIMESTAMP_LTZ" | "TIMESTAMP_TZ" => match number("scale") {
            Some(s) => format!("{kind}({s})"),
            None => kind,
        },
        _ => kind,
    }
}

/// Above this many tables, a database's columns are too many to read at once.
const SMALL_DATABASE: usize = 1_000;

/// Every table of the target's database for SQL completion, with the columns of all of them
/// when the database is small, else of the session's schema only. A table listed without
/// columns is one whose columns were not read.
pub(crate) async fn completion(pool: &SnowflakePool) -> IdeResult<Vec<CompletionTable>> {
    let names = schemas(pool, false).await?;
    let objects = database_objects(pool, pool.database_ident().as_deref(), &names).await?;
    let mut tables: Vec<CompletionTable> = objects
        .records()
        .filter(|r| r.get("schema_name") != Some("INFORMATION_SCHEMA"))
        .filter_map(|r| {
            Some(CompletionTable {
                schema: r.text("schema_name"),
                name: r.get("name")?.to_owned(),
                kind: table_kind(r.get("kind").unwrap_or("TABLE")),
                columns: Vec::new(),
            })
        })
        .collect();
    tables.sort_by(|a, b| (&a.schema, &a.name).cmp(&(&b.schema, &b.name)));
    tables.dedup_by(|a, b| a.schema == b.schema && a.name == b.name);
    let scope = if tables.len() <= SMALL_DATABASE {
        Some(in_database(pool))
    } else {
        let current = show(pool, "SELECT CURRENT_SCHEMA()").await?;
        let schema = current.rows.first().and_then(|r| r.first().cloned().flatten()).filter(|s| !s.is_empty());
        schema.map(|schema| format!(" IN SCHEMA {}", schema_path(pool, &schema)))
    };
    let Some(scope) = scope else { return Ok(tables) };
    // Columns are a help, not a need: without them the tables still complete.
    let Ok(shown) = show(pool, &format!("SHOW COLUMNS{scope}")).await else { return Ok(tables) };
    let at: HashMap<(String, String), usize> =
        tables.iter().enumerate().map(|(i, t)| ((t.schema.clone(), t.name.clone()), i)).collect();
    for r in shown.records() {
        let Some(&index) = at.get(&(r.text("schema_name"), r.text("table_name"))) else { continue };
        tables[index].columns.push(CompletionColumn {
            name: r.text("column_name"),
            data_type: column_type(r.get("data_type").unwrap_or_default()),
            nullable: !r
                .get("null?")
                .is_some_and(|v| v.eq_ignore_ascii_case("NOT_NULL") || v.eq_ignore_ascii_case("N")),
            primary_key: false,
            has_default: r.get("default").is_some_and(|d| !d.is_empty())
                || r.get("autoincrement").is_some_and(|a| !a.is_empty()),
        });
    }
    Ok(tables)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_split_into_arguments_and_result() {
        assert_eq!(signature("ADD_ONE(NUMBER) RETURN NUMBER"), ("NUMBER".into(), Some("NUMBER".into())));
        assert_eq!(
            signature("PARSE(VARCHAR, NUMBER(38,0)) RETURN TABLE (A NUMBER)"),
            ("VARCHAR, NUMBER(38,0)".into(), Some("TABLE (A NUMBER)".into()))
        );
        assert_eq!(signature("NOW_UTC() RETURN TIMESTAMP_NTZ"), (String::new(), Some("TIMESTAMP_NTZ".into())));
        assert_eq!(signature(""), (String::new(), None));
    }

    #[test]
    fn column_types_read_like_sql() {
        assert_eq!(column_type(r#"{"type":"FIXED","precision":38,"scale":0,"nullable":true}"#), "NUMBER(38,0)");
        assert_eq!(column_type(r#"{"type":"TEXT","length":100,"byteLength":400,"nullable":false}"#), "VARCHAR(100)");
        assert_eq!(column_type(r#"{"type":"TEXT","length":16777216}"#), "VARCHAR");
        assert_eq!(column_type(r#"{"type":"TIMESTAMP_NTZ","precision":0,"scale":9}"#), "TIMESTAMP_NTZ(9)");
        assert_eq!(column_type(r#"{"type":"VARIANT","nullable":true}"#), "VARIANT");
        assert_eq!(column_type(r#"{"type":"REAL"}"#), "FLOAT");
        assert_eq!(column_type("not json"), "not json");
    }

    #[test]
    fn object_kinds_become_tree_kinds() {
        for kind in ["TABLE", "DYNAMIC TABLE", "EXTERNAL TABLE", "EVENT TABLE", "HYBRID TABLE"] {
            assert_eq!(table_kind(kind), DbTableKind::Table, "{kind}");
        }
        assert_eq!(table_kind("VIEW"), DbTableKind::View);
        assert_eq!(table_kind("MATERIALIZED_VIEW"), DbTableKind::MaterializedView);
        assert_eq!(table_kind("MATERIALIZED VIEW"), DbTableKind::MaterializedView);
    }

    #[test]
    fn imported_keys_group_by_constraint_in_column_order() {
        let columns = [
            "pk_schema_name",
            "pk_table_name",
            "pk_column_name",
            "fk_schema_name",
            "fk_table_name",
            "fk_column_name",
            "key_sequence",
            "fk_name",
        ];
        let row = |values: [&str; 8]| values.iter().map(|v| Some((*v).to_owned())).collect::<Vec<_>>();
        let shown = Shown {
            columns: columns.iter().map(|c| (*c).to_owned()).collect(),
            rows: vec![
                row(["PUBLIC", "REGIONS", "CODE", "PUBLIC", "ORDERS", "REGION_CODE", "2", "FK_REGION"]),
                row(["PUBLIC", "CUSTOMERS", "ID", "PUBLIC", "ORDERS", "CUSTOMER_ID", "1", "FK_CUSTOMER"]),
                row(["PUBLIC", "REGIONS", "COUNTRY", "PUBLIC", "ORDERS", "COUNTRY", "1", "FK_REGION"]),
            ],
        };
        let keys = foreign_keys(&shown);
        assert_eq!(keys.len(), 2);
        assert_eq!(
            (keys[0].ref_table.as_str(), keys[0].columns.as_slice()),
            ("CUSTOMERS", &["CUSTOMER_ID".to_owned()][..])
        );
        assert_eq!(keys[1].columns, ["COUNTRY", "REGION_CODE"]);
        assert_eq!(keys[1].ref_columns, ["COUNTRY", "CODE"]);
    }
}
