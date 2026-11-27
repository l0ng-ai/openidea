//! A read-only equality join of explicitly selected source tables on the project host.
use crate::jdbc::JdbcPool;
use crate::workspace_input::{
    self, WorkspaceInput, WorkspaceInputColumn, WorkspaceInputLimits, WorkspaceInputRequest, WorkspaceInputType,
};
use crate::{DbDriver, DbManager, QueryResult, sql};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::{BufWriter, Write};
use std::time::{Duration, Instant};
use tempfile::{NamedTempFile, TempPath};

const MAX_TABLES: usize = 8;
const MAX_RESULT_ROWS: usize = 100_000;
const MAX_RESULT_COLUMNS: usize = 256;
const WORKSPACE_INPUT_LIMITS: WorkspaceInputLimits =
    WorkspaceInputLimits { max_rows: 100_000, max_cell_bytes: 1_048_576, max_bytes: 16_777_216 };

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", rename = "DbWorkspaceJoinRelation")]
pub struct WorkspaceJoinRelation {
    pub source_id: String,
    pub database: String,
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", rename = "DbWorkspaceJoinColumn")]
pub struct WorkspaceJoinColumn {
    pub relation: u32,
    pub column: String,
}

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", rename = "DbWorkspaceJoinCondition")]
pub struct WorkspaceJoinCondition {
    /// The right relation is the next table in the chain.
    pub left: WorkspaceJoinColumn,
    pub right_column: String,
}

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", rename = "DbWorkspaceJoinProjection")]
pub struct WorkspaceJoinProjection {
    pub relation: u32,
    /// None expands this relation's columns in source order.
    pub column: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", rename = "DbWorkspaceJoinPlan")]
pub struct WorkspaceJoinPlan {
    pub tables: Vec<WorkspaceJoinRelation>,
    pub joins: Vec<WorkspaceJoinCondition>,
    /// None expands all relations in FROM/JOIN order.
    pub projection: Option<Vec<WorkspaceJoinProjection>>,
}

fn validate_plan(
    table_count: usize,
    joins: &[WorkspaceJoinCondition],
    projection: Option<&[WorkspaceJoinProjection]>,
) -> IdeResult<()> {
    if !(2..=MAX_TABLES).contains(&table_count) || joins.len() + 1 != table_count {
        return Err(IdeError::invalid("A workspace JOIN needs 2 to 8 tables and one equality per JOIN"));
    }
    let valid_column = |name: &str| !name.is_empty() && name.len() <= 255 && !name.contains('\0');
    for (index, link) in joins.iter().enumerate() {
        if link.left.relation as usize > index || !valid_column(&link.left.column) || !valid_column(&link.right_column)
        {
            return Err(IdeError::invalid("Each JOIN must compare a column of its new table with an earlier table"));
        }
    }
    if let Some(projection) = projection
        && (projection.is_empty()
            || projection.len() > MAX_RESULT_COLUMNS
            || projection.iter().any(|item| {
                item.relation as usize >= table_count || item.column.as_deref().is_some_and(|name| !valid_column(name))
            }))
    {
        return Err(IdeError::invalid("Invalid workspace SELECT columns"));
    }
    Ok(())
}

struct StagedTable {
    path: TempPath,
    longest_row: usize,
    columns: Vec<WorkspaceInputColumn>,
}

impl WorkspaceInputType {
    fn is_integer(self) -> bool {
        use WorkspaceInputType::*;
        matches!(self, Int8 | Int16 | Int32 | Int64 | UInt8 | UInt16 | UInt32 | UInt64)
    }

    fn duckdb_type(self) -> String {
        use WorkspaceInputType::*;
        match self {
            Boolean => "BOOLEAN",
            Int8 => "TINYINT",
            Int16 => "SMALLINT",
            Int32 => "INTEGER",
            Int64 => "BIGINT",
            UInt8 => "UTINYINT",
            UInt16 => "USMALLINT",
            UInt32 => "UINTEGER",
            UInt64 => "UBIGINT",
            Float32 => "FLOAT",
            Float64 => "DOUBLE",
            Decimal { precision, scale } => return format!("DECIMAL({precision},{scale})"),
            Text => "VARCHAR",
            Date => "DATE",
            Time => "TIME",
            Timestamp => "TIMESTAMP",
            TimestampTz => "TIMESTAMPTZ",
            Uuid => "UUID",
        }
        .into()
    }
}

fn stage(input: WorkspaceInput, cancel: &CancellationToken) -> IdeResult<StagedTable> {
    let mut file = NamedTempFile::new()?;
    let mut longest_row = 1;
    {
        let mut out = BufWriter::new(file.as_file_mut());
        for row in input.rows {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if row.len() != input.columns.len() {
                return Err(IdeError::invalid("Incomplete workspace input row"));
            }
            let mut bytes = row.len(); // separators and newline
            for (column, cell) in row.into_iter().enumerate() {
                if column > 0 {
                    out.write_all(b",")?;
                }
                bytes += 2; // quotes or the NULL marker
                if let Some(value) = cell {
                    bytes += value.len();
                    out.write_all(b"\"")?;
                    let mut pieces = value.split('"');
                    out.write_all(pieces.next().unwrap_or_default().as_bytes())?;
                    for piece in pieces {
                        bytes += 1;
                        out.write_all(b"\"\"")?;
                        out.write_all(piece.as_bytes())?;
                    }
                    out.write_all(b"\"")?;
                } else {
                    out.write_all(br"\N")?;
                }
            }
            longest_row = longest_row.max(bytes);
            out.write_all(b"\n")?;
        }
        out.flush()?;
    }
    Ok(StagedTable { path: file.into_temp_path(), longest_row, columns: input.columns })
}

impl StagedTable {
    fn quoted_path(&self) -> IdeResult<String> {
        self.path
            .to_str()
            .map(|p| sql::quote_literal(DbDriver::Jdbc, p))
            .ok_or_else(|| IdeError::invalid("The workspace temporary directory needs a UTF-8 path"))
    }

    fn scan(&self, path: &str) -> String {
        // Synthetic column names also preserve case-distinct names from the source.
        let columns = self
            .columns
            .iter()
            .enumerate()
            .map(|(i, c)| format!("'c{i}':'{}'", c.data_type.duckdb_type()))
            .collect::<Vec<_>>()
            .join(",");
        let line = self.longest_row;
        // The single-threaded reader only needs one complete CSV record per buffer.
        let buffer = line.max(64 * 1024);
        format!(
            r#"read_csv({path},columns={{{columns}}},auto_detect=false,header=false,delim=',',quote='"',escape='"',nullstr='\N',allow_quoted_nulls=false,parallel=false,max_line_size={line},buffer_size={buffer})"#
        )
    }

    fn column(&self, name: &str) -> IdeResult<usize> {
        self.columns
            .iter()
            .position(|c| c.name == name)
            .ok_or_else(|| IdeError::invalid(format!("Unknown workspace column: {name}")))
    }
}

fn staging_columns<'a>(
    table_count: usize,
    joins: &'a [WorkspaceJoinCondition],
    projection: Option<&'a [WorkspaceJoinProjection]>,
) -> Vec<Option<Vec<&'a str>>> {
    let Some(projection) = projection else {
        return vec![None; table_count];
    };
    let mut columns: Vec<Option<Vec<&str>>> = vec![Some(Vec::new()); table_count];
    for item in projection {
        let selected = &mut columns[item.relation as usize];
        match (&item.column, selected) {
            (Some(name), Some(selected)) => selected.push(name),
            (None, selected) => *selected = None,
            _ => {}
        }
    }
    for (index, link) in joins.iter().enumerate() {
        if let Some(selected) = &mut columns[link.left.relation as usize] {
            selected.push(&link.left.column);
        }
        if let Some(selected) = &mut columns[index + 1] {
            selected.push(&link.right_column);
        }
    }
    for selected in columns.iter_mut().flatten() {
        selected.sort_unstable();
        selected.dedup();
    }
    columns
}

fn result_projection(
    tables: &[StagedTable],
    selection: Option<&[WorkspaceJoinProjection]>,
) -> IdeResult<Vec<(usize, usize)>> {
    let mut fields = Vec::new();
    match selection {
        Some(selection) => {
            for item in selection {
                let relation = item.relation as usize;
                let table = &tables[relation];
                match &item.column {
                    Some(name) => fields.push((relation, table.column(name)?)),
                    None => fields.extend((0..table.columns.len()).map(|column| (relation, column))),
                }
            }
        }
        None => {
            for (relation, table) in tables.iter().enumerate() {
                fields.extend((0..table.columns.len()).map(|column| (relation, column)));
            }
        }
    }
    if fields.len() > MAX_RESULT_COLUMNS {
        return Err(IdeError::invalid("Workspace result exceeds 256 columns"));
    }
    Ok(fields)
}

async fn join(
    engine: &JdbcPool,
    tables: &[StagedTable],
    joins: &[WorkspaceJoinCondition],
    selection: Option<&[WorkspaceJoinProjection]>,
    cancel: &CancellationToken,
) -> IdeResult<QueryResult> {
    use std::fmt::Write as _;
    let fields = result_projection(tables, selection)?;
    let names = fields.iter().map(|(relation, column)| format!("r{relation}.c{column}")).collect::<Vec<_>>().join(", ");
    let paths = tables.iter().map(StagedTable::quoted_path).collect::<IdeResult<Vec<_>>>()?;
    let mut query = format!("SELECT {names} FROM {} r0", tables[0].scan(&paths[0]));
    for (index, condition) in joins.iter().enumerate() {
        let left_relation = condition.left.relation as usize;
        let right_relation = index + 1;
        let left = &tables[left_relation];
        let right = &tables[right_relation];
        let li = left.column(&condition.left.column)?;
        let ri = right.column(&condition.right_column)?;
        let (a, b) = (left.columns[li].data_type, right.columns[ri].data_type);
        // DuckDB compares mixed integer widths and signs exactly, up to BIGINT against UBIGINT.
        if a != b && !(a.is_integer() && b.is_integer()) {
            return Err(IdeError::invalid("Choose integer join columns or columns of the same type and precision"));
        }
        write!(
            query,
            " INNER JOIN {} r{right_relation} ON r{left_relation}.c{li}=r{right_relation}.c{ri}",
            right.scan(&paths[right_relation]),
        )
        .unwrap();
    }
    write!(query, " LIMIT {}", MAX_RESULT_ROWS + 1).unwrap();
    for setting in [
        "SET threads=1",
        "SET memory_limit='96MiB'",
        "SET temp_directory=''",
        "SET max_temp_directory_size='0B'",
        &format!("SET allowed_paths=[{}]", paths.join(",")),
        "SET enable_external_access=false",
        "SET lock_configuration=true",
    ] {
        engine.query(setting, 0, 0, cancel).await?;
    }
    let mut result = engine.query(&query, 0, MAX_RESULT_ROWS, cancel).await?;
    if result.has_more {
        return Err(IdeError::invalid("Workspace result exceeds 100,000 rows"));
    }
    if result.columns.len() != fields.len() {
        return Err(IdeError::invalid("Unexpected workspace result columns"));
    }
    for (display, (relation, column)) in result.columns.iter_mut().zip(fields) {
        display.name.clone_from(&tables[relation].columns[column].name);
    }
    result.statement.clear();
    Ok(result)
}

#[cfg(test)]
fn two_table_join(keys: [&str; 2]) -> WorkspaceJoinCondition {
    WorkspaceJoinCondition {
        left: WorkspaceJoinColumn { relation: 0, column: keys[0].into() },
        right_column: keys[1].into(),
    }
}

impl DbManager {
    #[cfg(test)]
    pub(crate) async fn workspace_join_pair_for_test(
        &self,
        driver: &str,
        tables: [&WorkspaceInputRequest; 2],
        keys: [&str; 2],
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        let joins = [two_table_join(keys)];
        validate_plan(tables.len(), &joins, None)?;
        self.execute_workspace_join(driver, &tables, &joins, None, cancel).await
    }

    /// The caller retains the bounded result for paging. Reading another page never reruns the sources.
    pub async fn workspace_join(
        &self,
        driver: &str,
        plan: WorkspaceJoinPlan,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        validate_plan(plan.tables.len(), &plan.joins, plan.projection.as_deref())?;
        let tables: Vec<_> = plan
            .tables
            .into_iter()
            .map(|table| WorkspaceInputRequest {
                source_id: table.source_id,
                database: table.database,
                schema: table.schema,
                table: table.table,
                limits: WORKSPACE_INPUT_LIMITS,
            })
            .collect();
        let tables: Vec<_> = tables.iter().collect();
        self.execute_workspace_join(driver, &tables, &plan.joins, plan.projection.as_deref(), cancel).await
    }

    async fn execute_workspace_join(
        &self,
        driver: &str,
        tables: &[&WorkspaceInputRequest],
        joins: &[WorkspaceJoinCondition],
        projection: Option<&[WorkspaceJoinProjection]>,
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        let _run =
            self.workspace_run.try_lock().map_err(|_| IdeError::invalid("A workspace query is already running"))?;
        let start = Instant::now();
        let child = cancel.child_token();
        let run = async {
            let cancel = &child;
            let mut prepared = Vec::with_capacity(tables.len());
            for table in tables {
                let input = tokio::select! {
                    biased;
                    () = cancel.cancelled() => return Err(IdeError::cancelled()),
                    input = workspace_input::prepare_table(self, table) => input?,
                };
                prepared.push(input);
            }
            let selection = staging_columns(tables.len(), joins, projection);
            let mut staged = Vec::with_capacity(tables.len());
            let engine = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(IdeError::cancelled()),
                engine = self.workspace_engine(driver) => engine?,
            };
            let result = async {
                let mut remaining_rows = 200_000;
                let mut remaining_bytes = 32 * 1024 * 1024;
                for (mut table, columns) in prepared.into_iter().zip(&selection) {
                    let limits = &mut table.request.limits;
                    limits.max_rows = limits.max_rows.min(remaining_rows);
                    limits.max_bytes = limits.max_bytes.min(remaining_bytes);
                    let input = workspace_input::read_prepared_table(self, table, columns.as_deref(), cancel).await?;
                    remaining_rows -= input.rows.len();
                    remaining_bytes -= input.bytes;
                    let cancellation = cancel.clone();
                    let table = tokio::task::spawn_blocking(move || stage(input, &cancellation))
                        .await
                        .map_err(|e| IdeError::internal(e.to_string()))??;
                    staged.push(table);
                }
                join(&engine, &staged, joins, projection, cancel).await
            }
            .await;
            // Windows cannot remove a staged file while the JDBC process still has it open.
            engine.close().await;
            drop(staged);
            let mut result = result?;
            result.elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            Ok(result)
        };
        tokio::pin!(run);
        let stopped = tokio::select! {
            biased;
            () = cancel.cancelled() => IdeError::cancelled(),
            result = &mut run => return result,
            () = tokio::time::sleep(Duration::from_secs(90)) => IdeError::new(ide_core::error::ErrorKind::TimedOut, "Workspace query timed out"),
        };
        child.cancel();
        // Let the source or JDBC bridge deliver cancellation before dropping its connection.
        let _ = tokio::time::timeout(Duration::from_secs(15), run).await;
        Err(stopped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DbJdbcDriver;

    fn input(values: &[(&str, Option<&str>)]) -> WorkspaceInput {
        WorkspaceInput {
            columns: vec![
                WorkspaceInputColumn {
                    name: "key".into(),
                    data_type: WorkspaceInputType::Decimal { precision: 32, scale: 6 },
                },
                WorkspaceInputColumn { name: "text".into(), data_type: WorkspaceInputType::Text },
            ],
            rows: values.iter().map(|(k, v)| vec![Some(k.to_string()), v.map(str::to_owned)]).collect(),
            bytes: 0,
        }
    }

    #[test]
    fn workspace_join_chain_links_must_target_an_earlier_table() -> IdeResult<()> {
        let first = two_table_join(["key", "key"]);
        let second = two_table_join(["key", "id"]);
        let links = [first, second];
        validate_plan(3, &links, None)?;
        let over_limit: Vec<_> = (0..8).map(|_| two_table_join(["key", "key"])).collect();
        assert!(validate_plan(9, &over_limit, None).is_err());
        validate_plan(8, &over_limit[..7], None)?;
        assert!(validate_plan(4, &links, None).is_err());
        assert!(validate_plan(3, &links, Some(&[])).is_err());
        let invalid = WorkspaceJoinProjection { relation: 3, column: None };
        assert!(validate_plan(3, &links, Some(&[invalid])).is_err());
        let mut links = links;
        links[0].left.relation = 1;
        assert!(validate_plan(3, &links, None).is_err());
        Ok(())
    }

    #[test]
    fn staging_preserves_null_and_csv_text_and_removes_the_file_on_drop() -> IdeResult<()> {
        let cancel = CancellationToken::new();
        let table = stage(input(&[("1", None), ("2", Some("")), ("3", Some("a,\"b\"\nc"))]), &cancel)?;
        let path = table.path.to_path_buf();
        assert_eq!(std::fs::read_to_string(&path)?, "\"1\",\\N\n\"2\",\"\"\n\"3\",\"a,\"\"b\"\"\nc\"\n");
        drop(table);
        assert!(!path.exists());
        cancel.cancel();
        assert!(stage(input(&[("1", None)]), &cancel).is_err());
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires DUCKDB_JDBC_JAR and Java 17+"]
    async fn workspace_engine_joins_exact_keys_nulls_and_empty_inputs() -> IdeResult<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path();
        let db = DbManager::new(
            root.join("project"),
            root.join("passwords"),
            root.join("history"),
            std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh"))),
        )
        .with_global_sources(root.join("global"));
        db.save_jdbc_driver(DbJdbcDriver {
            id: "duck".into(),
            name: "DuckDB".into(),
            vendor: Some("duckdb".into()),
            jars: vec![std::env::var("DUCKDB_JDBC_JAR").expect("driver fixture")],
            class_name: "org.duckdb.DuckDBDriver".into(),
            url_template: "jdbc:duckdb:".into(),
        })?;
        let cancel = CancellationToken::new();
        let mut signed = input(&[("-1", None), ("9007199254740993", None), ("9223372036854775807", None)]);
        signed.columns[0].data_type = WorkspaceInputType::Int64;
        let mut unsigned = input(&[
            ("18446744073709551615", None),
            ("9007199254740992", None),
            ("9007199254740993", None),
            ("9223372036854775807", None),
        ]);
        unsigned.columns[0].data_type = WorkspaceInputType::UInt64;
        let tables = [stage(signed, &cancel)?, stage(unsigned, &cancel)?];
        let engine = db.workspace_engine("duck").await?;
        let output = join(&engine, &tables, &[two_table_join(["key", "key"])], None, &cancel).await?;
        let mut matches: Vec<_> = output.rows.iter().map(|row| (row[0].as_deref(), row[2].as_deref())).collect();
        matches.sort_unstable();
        assert_eq!(
            matches,
            [
                (Some("9007199254740993"), Some("9007199254740993")),
                (Some("9223372036854775807"), Some("9223372036854775807")),
            ]
        );
        engine.close().await;
        let wide = "a,\n\"b\"".repeat(32 * 1024);
        let left = stage(input(&[("0", None), ("1", Some(&wide)), ("2", Some("short"))]), &cancel)?;
        let right = stage(input(&[("1", Some(&wide))]), &cancel)?;
        let engine = db.workspace_engine("duck").await?;
        let output = join(&engine, &[left, right], &[two_table_join(["key", "key"])], None, &cancel).await?;
        assert_eq!(output.rows.len(), 1);
        assert_eq!(output.rows[0][1].as_deref(), Some(wide.as_str()));
        assert_eq!(output.rows[0][3].as_deref(), Some(wide.as_str()));
        engine.close().await;
        for empty in [false, true] {
            let left =
                stage(input(&[("9007199254740993.000001", None), ("9007199254740993.000002", Some(""))]), &cancel)?;
            let mut right =
                input(&[("9007199254740993.000001", Some("a,\"b\"\nc")), ("9007199254740993.000002", Some(r"\N"))]);
            if empty {
                right.rows.clear();
            }
            let engine = db.workspace_engine("duck").await?;
            let right = stage(right, &cancel)?;
            let output = join(&engine, &[left, right], &[two_table_join(["key", "key"])], None, &cancel).await?;
            assert_eq!(
                output.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
                ["key", "text", "key", "text"]
            );
            let mut rows = output.rows;
            rows.sort();
            if empty {
                assert!(rows.is_empty());
            } else {
                assert_eq!(rows.len(), 2);
                assert_eq!(
                    rows[0],
                    [
                        Some("9007199254740993.000001".into()),
                        None,
                        Some("9007199254740993.000001".into()),
                        Some("a,\"b\"\nc".into())
                    ]
                );
                assert_eq!(
                    rows[1],
                    [
                        Some("9007199254740993.000002".into()),
                        Some("".into()),
                        Some("9007199254740993.000002".into()),
                        Some(r"\N".into())
                    ]
                );
            }
            engine.close().await;
        }
        Ok(())
    }
}
