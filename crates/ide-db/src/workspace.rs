//! A read-only equality join of two explicitly selected source tables on the project host.
use crate::jdbc::JdbcPool;
use crate::workspace_input::{self, WorkspaceInput, WorkspaceInputColumn, WorkspaceInputRequest, WorkspaceInputType};
use crate::{DbDriver, DbManager, QueryResult, sql};
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::{BufWriter, Write};
use std::time::{Duration, Instant};
use tempfile::{NamedTempFile, TempPath};

const MAX_RESULT_ROWS: usize = 100_000;

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

    fn key(&self, name: &str) -> IdeResult<usize> {
        self.columns
            .iter()
            .position(|c| c.name == name)
            .ok_or_else(|| IdeError::invalid(format!("Unknown workspace join column: {name}")))
    }
}

async fn join(
    engine: &JdbcPool,
    tables: &[StagedTable; 2],
    keys: [&str; 2],
    cancel: &CancellationToken,
) -> IdeResult<QueryResult> {
    let [left, right] = tables;
    let li = left.key(keys[0])?;
    let ri = right.key(keys[1])?;
    let (a, b) = (left.columns[li].data_type, right.columns[ri].data_type);
    // DuckDB compares mixed integer widths and signs exactly, up to BIGINT against UBIGINT.
    if a != b && !(a.is_integer() && b.is_integer()) {
        return Err(IdeError::invalid("Choose integer join columns or columns of the same type and precision"));
    }
    let paths = [left.quoted_path()?, right.quoted_path()?];
    for setting in [
        "SET threads=1",
        "SET memory_limit='96MiB'",
        "SET temp_directory=''",
        "SET max_temp_directory_size='0B'",
        &format!("SET allowed_paths=[{},{}]", paths[0], paths[1]),
        "SET enable_external_access=false",
        "SET lock_configuration=true",
    ] {
        engine.query(setting, 0, 0, cancel).await?;
    }
    let query = format!(
        "SELECT a.*, b.* FROM {} a INNER JOIN {} b ON a.c{li}=b.c{ri} LIMIT {}",
        left.scan(&paths[0]),
        right.scan(&paths[1]),
        MAX_RESULT_ROWS + 1
    );
    let mut result = engine.query(&query, 0, MAX_RESULT_ROWS, cancel).await?;
    if result.has_more {
        return Err(IdeError::invalid("Workspace result exceeds 100,000 rows"));
    }
    if result.columns.len() != left.columns.len() + right.columns.len() {
        return Err(IdeError::invalid("Unexpected workspace result columns"));
    }
    for (display, source) in result.columns.iter_mut().zip(left.columns.iter().chain(&right.columns)) {
        display.name.clone_from(&source.name);
    }
    result.statement.clear();
    Ok(result)
}

impl DbManager {
    /// The caller retains the bounded result for paging. Reading another page never reruns the sources.
    pub async fn workspace_join(
        &self,
        driver: &str,
        tables: [&WorkspaceInputRequest; 2],
        keys: [&str; 2],
        cancel: &CancellationToken,
    ) -> IdeResult<QueryResult> {
        let _run =
            self.workspace_run.try_lock().map_err(|_| IdeError::invalid("A workspace query is already running"))?;
        if tables[0].source_id == tables[1].source_id {
            return Err(IdeError::invalid("Select two distinct workspace sources"));
        }
        let start = Instant::now();
        let child = cancel.child_token();
        let run = async {
            let cancel = &child;
            let mut staged = Vec::with_capacity(tables.len());
            let engine = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(IdeError::cancelled()),
                engine = self.workspace_engine(driver) => engine?,
            };
            let stage_table = async |request: &WorkspaceInputRequest| {
                let input = workspace_input::read_table(self, request, cancel).await?;
                let cancellation = cancel.clone();
                tokio::task::spawn_blocking(move || stage(input, &cancellation))
                    .await
                    .map_err(|e| IdeError::internal(e.to_string()))?
            };
            let result = async {
                for table in tables {
                    staged.push(stage_table(table).await?);
                }
                join(&engine, staged.as_slice().try_into().expect("two inputs"), keys, cancel).await
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
        }
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
        let output = join(&engine, &tables, ["key", "key"], &cancel).await?;
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
        let output = join(&engine, &[left, right], ["key", "key"], &cancel).await?;
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
            let output = join(&engine, &[left, right], ["key", "key"], &cancel).await?;
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
