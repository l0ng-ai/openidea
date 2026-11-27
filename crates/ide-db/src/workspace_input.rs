//! Bounded, typed reads for staging explicitly selected database tables.
use crate::{DataSource, DbDriver, DbManager, Pool, conn::db_err, jdbc::WorkspaceDuckDbSource, route::RouteUse, sql};
use futures::TryStreamExt;
use ide_core::{CancellationToken, IdeError, IdeResult};
use sqlx::{Connection, Row, postgres::PgConnection, sqlite::SqlitePool};
use std::{borrow::Cow, fmt::Write, time::Duration};

const MAX_COLUMNS: usize = 128;

#[derive(Debug, Clone)]
pub struct WorkspaceInputRequest {
    pub source_id: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    pub limits: WorkspaceInputLimits,
}

#[derive(Debug, Clone, Copy)]
pub struct WorkspaceInputLimits {
    pub max_rows: usize,
    pub max_cell_bytes: usize,
    pub max_bytes: usize,
}

#[derive(Debug)]
pub struct WorkspaceInput {
    pub columns: Vec<WorkspaceInputColumn>,
    /// Exact text accepted by the workspace engine, with SQL NULL represented separately.
    pub rows: Vec<Vec<Option<String>>>,
    pub(crate) bytes: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct WorkspaceInputColumn {
    pub name: String,
    pub data_type: WorkspaceInputType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceInputType {
    Boolean,
    Int8,
    Int16,
    Int32,
    Int64,
    UInt8,
    UInt16,
    UInt32,
    UInt64,
    Float32,
    Float64,
    Decimal { precision: u8, scale: u8 },
    Text,
    Date,
    Time,
    Timestamp,
    TimestampTz,
    Uuid,
}

pub(crate) struct PreparedWorkspaceInput {
    pub(crate) request: WorkspaceInputRequest,
    source: DataSource,
    duckdb: Option<WorkspaceDuckDbSource>,
}

/// Verify the saved source and relation before a workspace opens any source connection.
pub(crate) async fn prepare_table(
    db: &DbManager,
    request: &WorkspaceInputRequest,
) -> IdeResult<PreparedWorkspaceInput> {
    let limits = request.limits;
    if limits.max_rows > 100_000 || !(1..=1_048_576).contains(&limits.max_cell_bytes) || limits.max_bytes > 16_777_216 {
        return Err(IdeError::invalid("Workspace source limits are out of range"));
    }
    if request.source_id.is_empty() || request.source_id.contains(':') {
        return Err(IdeError::invalid("Select a saved data source for the workspace"));
    }
    let source = db.source(&request.source_id)?;
    if !source.options.startup_script.trim().is_empty() {
        return Err(IdeError::invalid("Workspace inputs do not run saved source startup scripts"));
    }
    let mut request = request.clone();
    normalize_relation(&source, &mut request)?;
    let duckdb = match source.driver {
        DbDriver::Jdbc => Some(db.prepare_workspace_duckdb_source(&source).await?),
        DbDriver::Sqlite => {
            let file =
                source.file.as_deref().ok_or_else(|| IdeError::invalid("Choose a saved SQLite database file"))?;
            if !tokio::fs::metadata(db.root.join(file)).await.is_ok_and(|meta| meta.is_file()) {
                return Err(IdeError::invalid("Choose an existing SQLite database file as the workspace source"));
            }
            None
        }
        _ => None,
    };
    Ok(PreparedWorkspaceInput { request, source, duckdb })
}

#[cfg(test)]
async fn read_table(
    db: &DbManager,
    request: &WorkspaceInputRequest,
    cancel: &CancellationToken,
) -> IdeResult<WorkspaceInput> {
    let prepared = prepare_table(db, request).await?;
    read_prepared_table(db, prepared, None, cancel).await
}

/// Opens an independent read-only connection through the saved source's approved route.
pub(crate) async fn read_prepared_table(
    db: &DbManager,
    prepared: PreparedWorkspaceInput,
    selection: Option<&[&str]>,
    cancel: &CancellationToken,
) -> IdeResult<WorkspaceInput> {
    let PreparedWorkspaceInput { request, source, duckdb } = prepared;
    let request = &request;
    let driver = source.driver;
    if let Some(duckdb) = duckdb {
        let open = async {
            let password = db.password(&source).await;
            duckdb.connect(password.as_deref()).await
        };
        let pool = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
            result = open => result?,
        };
        let result = read_duckdb(&pool, request, selection, cancel).await;
        pool.close().await;
        return result;
    }
    let open = async {
        let password = db.password(&source).await;
        let (mut target, route) = db.endpoint(&source, None, RouteUse::Connect).await?;
        if !request.database.is_empty() {
            target.select_database(Some(&request.database));
        }
        target.read_only = true;
        if driver == DbDriver::Sqlite {
            target.properties = vec![crate::DbProperty { name: "trusted_schema".into(), value: "OFF".into() }];
        }
        if driver == DbDriver::Clickhouse {
            target.options.default_schema.clear();
            target.properties.retain(|p| !p.name.trim().replace('-', "_").eq_ignore_ascii_case("use_http_session"));
            // Do not retain a server session for a workspace that only issues qualified SELECTs.
            target.properties.push(crate::DbProperty { name: "use_http_session".into(), value: "false".into() });
        }
        let pool =
            db.open_pool(&target, password.as_deref(), false).await.map_err(|e| db.connection_error(e, &source))?;
        Ok::<_, IdeError>((pool, route))
    };
    let (pool, _route) = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(IdeError::cancelled()),
        () = tokio::time::sleep(Duration::from_secs(30)) =>
            return Err(IdeError::new(ide_core::error::ErrorKind::TimedOut, "Workspace source connection timed out")),
        result = open => result?,
    };
    match &pool {
        Pool::Postgres(_) => pool.read_workspace_postgres(request, selection, cancel).await,
        Pool::Sqlite(pool) => {
            let result = tokio::select! {
                biased;
                () = cancel.cancelled() => Err(IdeError::cancelled()),
                result = read_sqlite(pool, request, selection, cancel) => result,
            };
            pool.close().await;
            result
        }
        Pool::Clickhouse(pool) => read_clickhouse(pool, request, selection, cancel).await,
        _ => unreachable!(),
    }
}

fn normalize_relation(source: &crate::DataSource, request: &mut WorkspaceInputRequest) -> IdeResult<()> {
    let driver = source.driver;
    if request.table.is_empty() {
        return Err(IdeError::invalid("Select a qualified table for the workspace"));
    }
    match driver {
        DbDriver::Postgres if request.schema.is_empty() => {
            let configured = source.options.default_schema.trim();
            if !configured.is_empty()
                && !configured.bytes().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'_')
            {
                return Err(IdeError::invalid("Qualify the PostgreSQL table with a schema"));
            }
            request.schema = if configured.is_empty() { "public" } else { configured }.into();
        }
        DbDriver::Postgres => {}
        DbDriver::Clickhouse => {
            if request.database.is_empty() {
                request.database = if !request.schema.is_empty() {
                    request.schema.clone()
                } else if source.database.is_empty() {
                    "default".into()
                } else {
                    source.database.clone()
                };
            }
            if !request.schema.is_empty() && request.schema != request.database {
                return Err(IdeError::invalid("ClickHouse input schema must match its database"));
            }
        }
        DbDriver::Sqlite => {
            if !matches!(request.schema.as_str(), "" | "main") || !matches!(request.database.as_str(), "" | "main") {
                return Err(IdeError::invalid("Workspace SQLite inputs require the main database"));
            }
            request.schema = "main".into();
        }
        DbDriver::Jdbc if source.url.starts_with("jdbc:duckdb:") => {
            if request.schema.is_empty() {
                request.schema = "main".into();
            }
        }
        _ => {
            return Err(IdeError::invalid(
                "Workspace inputs require PostgreSQL, ClickHouse, SQLite or file-backed DuckDB",
            ));
        }
    }
    for name in [&request.database, &request.schema, &request.table] {
        if name.contains('\0') || name.len() > 255 || (driver == DbDriver::Postgres && name.len() > 63) {
            return Err(IdeError::invalid("Workspace input name is invalid"));
        }
    }
    Ok(())
}

#[derive(Debug)]
struct SourceColumn {
    name: String,
    native: String,
    data_type: WorkspaceInputType,
}

fn decimal(precision: u8, scale: u8) -> Option<WorkspaceInputType> {
    (precision > 0 && precision <= 38 && scale <= precision).then_some(WorkspaceInputType::Decimal { precision, scale })
}

fn parse_decimal(arguments: &str) -> Option<WorkspaceInputType> {
    let (precision, scale) = arguments.split_once(',')?;
    decimal(precision.trim().parse().ok()?, scale.trim().parse().ok()?)
}

fn pg_type(name: &str) -> Option<WorkspaceInputType> {
    use WorkspaceInputType::*;
    Some(match name {
        "boolean" => Boolean,
        "smallint" => Int16,
        "integer" => Int32,
        "bigint" => Int64,
        "real" => Float32,
        "double precision" => Float64,
        "text" | "character varying" => Text,
        "date" => Date,
        "uuid" => Uuid,
        "time without time zone" => Time,
        "timestamp without time zone" => Timestamp,
        "timestamp with time zone" => TimestampTz,
        _ if name.starts_with("character varying(") => Text,
        _ if name.starts_with("time(") && name.ends_with(" without time zone") => Time,
        _ if name.starts_with("timestamp(") && name.ends_with(" without time zone") => Timestamp,
        _ if name.starts_with("timestamp(") && name.ends_with(" with time zone") => TimestampTz,
        _ => return parse_decimal(name.strip_prefix("numeric(")?.strip_suffix(')')?),
    })
}

fn clickhouse_type(mut name: &str) -> Option<WorkspaceInputType> {
    use WorkspaceInputType::*;
    while let Some(inner) = name.strip_prefix("Nullable(").or_else(|| name.strip_prefix("LowCardinality(")) {
        name = inner.strip_suffix(')')?;
    }
    Some(match name {
        "Bool" => Boolean,
        "Int8" => Int8,
        "Int16" => Int16,
        "Int32" => Int32,
        "Int64" => Int64,
        "UInt8" => UInt8,
        "UInt16" => UInt16,
        "UInt32" => UInt32,
        "UInt64" => UInt64,
        "Float32" => Float32,
        "Float64" => Float64,
        "String" => Text,
        "Date" | "Date32" => Date,
        "UUID" => Uuid,
        "DateTime" => TimestampTz,
        _ if name.starts_with("DateTime(") && name.ends_with(')') => TimestampTz,
        _ if name.starts_with("DateTime64(") => {
            let arguments = name.strip_prefix("DateTime64(")?.strip_suffix(')')?;
            if arguments.split(',').next()?.trim().parse::<u8>().ok()? > 6 {
                return None;
            }
            TimestampTz
        }
        _ => return parse_decimal(name.strip_prefix("Decimal(")?.strip_suffix(')')?),
    })
}

fn sqlite_type(name: &str) -> Option<WorkspaceInputType> {
    use WorkspaceInputType::*;
    let name = name.trim().to_ascii_uppercase();
    let base = name.split('(').next()?.trim_end();
    Some(match base {
        "INT" | "INTEGER" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "BIGINT" | "INT2" | "INT8" => Int64,
        "BOOLEAN" | "BOOL" => Boolean,
        "TEXT" | "CHAR" | "VARCHAR" | "NCHAR" | "NVARCHAR" | "CLOB" => Text,
        "REAL" | "FLOAT" | "DOUBLE" | "DOUBLE PRECISION" => Float64,
        _ => return None,
    })
}

fn duckdb_type(name: &str) -> Option<WorkspaceInputType> {
    use WorkspaceInputType::*;
    Some(match name {
        "BOOLEAN" => Boolean,
        "TINYINT" => Int8,
        "SMALLINT" => Int16,
        "INTEGER" => Int32,
        "BIGINT" => Int64,
        "UTINYINT" => UInt8,
        "USMALLINT" => UInt16,
        "UINTEGER" => UInt32,
        "UBIGINT" => UInt64,
        "FLOAT" => Float32,
        "DOUBLE" => Float64,
        "VARCHAR" => Text,
        "DATE" => Date,
        "TIME" => Time,
        "TIMESTAMP" | "TIMESTAMP_MS" | "TIMESTAMP_S" => Timestamp,
        "TIMESTAMP WITH TIME ZONE" => TimestampTz,
        "UUID" => Uuid,
        _ => return parse_decimal(name.strip_prefix("DECIMAL(")?.strip_suffix(')')?),
    })
}

fn source_column(driver: DbDriver, name: String, native: String) -> IdeResult<SourceColumn> {
    let data_type = match driver {
        DbDriver::Postgres => pg_type(&native),
        DbDriver::Clickhouse => clickhouse_type(&native),
        DbDriver::Sqlite => sqlite_type(&native),
        DbDriver::Jdbc => duckdb_type(&native),
        _ => unreachable!(),
    }
    .ok_or_else(|| IdeError::invalid(format!("Workspace column {name:?} has unsupported source type {native}")))?;
    Ok(SourceColumn { name, native, data_type })
}

fn row_limit() -> IdeError {
    IdeError::invalid("Workspace inputs exceed the row limit")
}

fn byte_limit() -> IdeError {
    IdeError::invalid("Workspace inputs exceed the byte limit")
}

fn cell_limit() -> IdeError {
    IdeError::invalid("Workspace input exceeds the source cell limit")
}

struct InputRows {
    rows: Vec<Vec<Option<String>>>,
    limits: WorkspaceInputLimits,
    bytes: usize,
}

impl InputRows {
    fn new(limits: WorkspaceInputLimits) -> Self {
        Self { rows: Vec::new(), limits, bytes: 0 }
    }

    fn new_row(&mut self) -> IdeResult<()> {
        if self.rows.len() >= self.limits.max_rows {
            return Err(row_limit());
        }
        self.bytes += std::mem::size_of::<Vec<Option<String>>>();
        if self.bytes > self.limits.max_bytes {
            return Err(byte_limit());
        }
        Ok(())
    }

    fn cell(&mut self, value: Option<&str>, data_type: WorkspaceInputType) -> IdeResult<()> {
        let bytes = value.map_or(0, str::len);
        if bytes > self.limits.max_cell_bytes {
            return Err(cell_limit());
        }
        // Charge the field allocation even for SQL NULL and empty strings.
        self.bytes += std::mem::size_of::<Option<String>>() + bytes;
        if self.bytes > self.limits.max_bytes {
            return Err(byte_limit());
        }
        if matches!(data_type, WorkspaceInputType::Decimal { .. })
            && value.is_some_and(|v| v.contains(|ch: char| ch.is_ascii_alphabetic()))
        {
            return Err(IdeError::invalid("Workspace decimals must be finite"));
        }
        Ok(())
    }

    fn finish(self, columns: Vec<SourceColumn>) -> WorkspaceInput {
        WorkspaceInput {
            columns: columns
                .into_iter()
                .map(|SourceColumn { name, data_type, .. }| WorkspaceInputColumn { name, data_type })
                .collect(),
            rows: self.rows,
            bytes: self.bytes,
        }
    }
}

fn native_table_required() -> IdeError {
    IdeError::invalid("Workspace input must be a readable native table with columns")
}

fn require_columns(columns: &[SourceColumn], selection: Option<&[&str]>) -> IdeResult<()> {
    if columns.is_empty() {
        return Err(native_table_required());
    }
    if columns.len() > MAX_COLUMNS {
        return Err(IdeError::invalid("Workspace input exceeds the source column limit"));
    }
    if let Some(selection) = selection
        && let Some(missing) = selection.iter().find(|name| !columns.iter().any(|c| c.name == **name))
    {
        return Err(IdeError::invalid(format!("Unknown workspace column: {missing}")));
    }
    Ok(())
}

const PG_COLUMNS: &str = "
SELECT a.attname::pg_catalog.text,
       CASE WHEN t.typnamespace = 'pg_catalog'::pg_catalog.regnamespace
            THEN pg_catalog.format_type(t.oid, a.atttypmod)
            ELSE 'user-defined ' || t.typname::pg_catalog.text END
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid
JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
WHERE n.nspname::pg_catalog.text = $1 AND c.relname::pg_catalog.text = $2
  AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  AND ($4::pg_catalog.text[] IS NULL OR a.attname::pg_catalog.text = ANY($4))
ORDER BY a.attnum LIMIT $3";

pub(crate) async fn read_postgres(
    conn: &mut PgConnection,
    request: &WorkspaceInputRequest,
    selection: Option<&[&str]>,
) -> IdeResult<WorkspaceInput> {
    sqlx::raw_sql(
        "SET LOCAL DateStyle TO 'ISO, YMD'; SET LOCAL TimeZone TO 'UTC'; SET LOCAL extra_float_digits TO 3; \
         SET LOCAL search_path TO pg_catalog; \
         SELECT pg_catalog.set_config('statement_timeout', \
             COALESCE(NULLIF(LEAST(setting::integer, 20000), 0), 20000)::text, true) \
         FROM pg_catalog.pg_settings WHERE name = 'statement_timeout'",
    )
    .execute(&mut *conn)
    .await
    .map_err(db_err)?;
    let native_table = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class AS c
            JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname::text = $1 AND c.relname::text = $2 AND c.relkind IN ('r', 'p')
        )",
    )
    .bind(&request.schema)
    .bind(&request.table)
    .persistent(false)
    .fetch_one(&mut *conn)
    .await
    .map_err(db_err)?;
    if !native_table {
        return Err(native_table_required());
    }
    let table = sql::qualified(DbDriver::Postgres, &request.schema, &request.table);
    let lock = format!("LOCK TABLE ONLY {table} IN ACCESS SHARE MODE");
    sqlx::raw_sql(sqlx::AssertSqlSafe(lock)).execute(&mut *conn).await.map_err(db_err)?;
    let mut columns = Vec::new();
    let mut stream = sqlx::query(PG_COLUMNS)
        .bind(&request.schema)
        .bind(&request.table)
        .bind((MAX_COLUMNS + 1) as i64)
        .bind(selection)
        .persistent(false)
        .fetch(&mut *conn);
    while let Some(row) = stream.try_next().await.map_err(db_err)? {
        columns.push(source_column(
            DbDriver::Postgres,
            row.try_get(0).map_err(db_err)?,
            row.try_get(1).map_err(db_err)?,
        )?);
    }
    drop(stream);
    require_columns(&columns, selection)?;
    let projection: Vec<_> = columns
        .iter()
        .map(|c| format!("t.{}::pg_catalog.text", sql::quote_ident(DbDriver::Postgres, &c.name)))
        .collect();
    let limits = request.limits;
    let statement = bounded_select(DbDriver::Postgres, &table, &projection, None, limits);
    let mut rows = InputRows::new(limits);
    let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(statement)).fetch(&mut *conn);
    while let Some(row) = stream.try_next().await.map_err(db_err)? {
        rows.new_row()?;
        let status: &str = row.try_get_unchecked(columns.len()).map_err(db_err)?;
        check_row_status(status)?;
        let mut values = Vec::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let value: Option<&str> = row.try_get(index).map_err(db_err)?;
            rows.cell(value, column.data_type)?;
            let value = value.map(|value| pg_temporal(value, column.data_type)).transpose()?;
            values.push(value.map(Cow::into_owned));
        }
        rows.rows.push(values);
    }
    Ok(rows.finish(columns))
}

fn pg_temporal(value: &str, kind: WorkspaceInputType) -> IdeResult<Cow<'_, str>> {
    use WorkspaceInputType::*;
    if !matches!(kind, Date | Timestamp | TimestampTz) || matches!(value, "infinity" | "-infinity") {
        return Ok(Cow::Borrowed(value));
    }
    let Some((year, rest)) = value.split_once('-') else {
        return Err(IdeError::invalid("Invalid PostgreSQL workspace temporal value"));
    };
    if let Some(rest) = rest.strip_suffix(" BC") {
        let year = year.parse::<i32>().map_err(|_| IdeError::invalid("Invalid PostgreSQL workspace year"))?;
        // DuckDB takes an astronomical year for BCE values, where 1 BC is year zero.
        return Ok(Cow::Owned(if year == 1 { format!("0000-{rest}") } else { format!("-{:04}-{rest}", year - 1) }));
    }
    if matches!(kind, Timestamp | TimestampTz) && year.len() >= 6 && year >= "294247" {
        return Err(IdeError::invalid("PostgreSQL workspace timestamp is outside the supported range"));
    }
    Ok(Cow::Borrowed(value))
}

fn check_row_status(status: &str) -> IdeResult<()> {
    match status {
        "0" => Ok(()),
        "1" => Err(cell_limit()),
        "2" => Err(byte_limit()),
        "3" => Err(IdeError::invalid("Workspace input contains a ClickHouse string that is not valid UTF-8")),
        "4" => Err(IdeError::invalid("Workspace input table types changed during the read")),
        _ => Err(IdeError::invalid("Invalid workspace source row status")),
    }
}

// Return a bounded status row in place of a wide value. SQL NULL stays distinct from an empty
// string. The aggregate byte budget is enforced again incrementally as rows are received.
fn bounded_select(
    driver: DbDriver,
    table: &str,
    projection: &[String],
    mismatch: Option<&str>,
    limits: WorkspaceInputLimits,
) -> String {
    let count = projection.len();
    let sizes: Vec<_> = (0..count)
        .map(|i| match driver {
            DbDriver::Postgres => format!("coalesce(pg_catalog.octet_length(input.v{i}), 0)"),
            DbDriver::Sqlite => format!("coalesce(length(CAST(input.v{i} AS BLOB)), 0)"),
            DbDriver::Jdbc => format!("coalesce(octet_length(encode(input.v{i})), 0)"),
            _ => format!("coalesce(length(input.v{i}), 0)"),
        })
        .collect();
    let oversized = sizes.iter().map(|s| format!("{s} > {}", limits.max_cell_bytes)).collect::<Vec<_>>().join(" OR ");
    let row_size = sizes.join(" + ");
    let overhead = std::mem::size_of::<Vec<Option<String>>>() + count * std::mem::size_of::<Option<String>>();
    let mut status =
        format!("CASE WHEN {oversized} THEN '1' WHEN {row_size} + {overhead} > {} THEN '2'", limits.max_bytes);
    let mut values = projection.iter().enumerate().map(|(i, p)| format!("{p} AS v{i}")).collect::<Vec<_>>().join(", ");
    if driver == DbDriver::Clickhouse {
        let invalid = (0..count).map(|i| format!("NOT isValidUTF8(coalesce(input.v{i}, ''))")).collect::<Vec<_>>();
        write!(status, " WHEN {} THEN '3'", invalid.join(" OR ")).unwrap();
    }
    if let Some(mismatch) = mismatch {
        write!(values, ", ({mismatch}) AS ws_mismatch").unwrap();
        status.push_str(" WHEN input.ws_mismatch THEN '4'");
    }
    status.push_str(" ELSE '0' END");
    let bounded = (0..count)
        .map(|i| format!("CASE WHEN checked.row_status = '0' THEN checked.v{i} ELSE NULL END AS v{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let final_status =
        format!("CASE WHEN tally.running_bytes > {} THEN '2' ELSE tally.row_status END", limits.max_bytes);
    let fields = (0..count)
        .map(|i| format!("CASE WHEN ({final_status}) = '0' THEN tally.v{i} ELSE NULL END AS v{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let guard = if driver == DbDriver::Clickhouse { format!("WHERE {CLICKHOUSE_READ_CHECK}") } else { String::new() };
    format!(
        "SELECT {fields}, {final_status} AS ws_status
         FROM (
             SELECT bounded.*, sum(row_bytes) OVER (ROWS UNBOUNDED PRECEDING) AS running_bytes
             FROM (
                 SELECT {bounded}, checked.row_status,
                        CASE WHEN checked.row_status = '0' THEN checked.row_bytes ELSE 0 END AS row_bytes
                 FROM (
                     SELECT input.*, {status} AS row_status, {row_size} + {overhead} AS row_bytes
                     FROM (SELECT {values} FROM {table} AS t {guard} LIMIT {}) AS input
                 ) AS checked
             ) AS bounded
         ) AS tally",
        limits.max_rows + 1
    )
}

fn column_filter(driver: DbDriver, column: &str, selection: Option<&[&str]>) -> String {
    selection.map_or_else(String::new, |names| {
        let names = names.iter().map(|name| sql::quote_literal(driver, name)).collect::<Vec<_>>().join(", ");
        format!("AND {column} IN ({names})")
    })
}

async fn read_sqlite(
    pool: &SqlitePool,
    request: &WorkspaceInputRequest,
    selection: Option<&[&str]>,
    cancel: &CancellationToken,
) -> IdeResult<WorkspaceInput> {
    let mut connection = pool.acquire().await.map_err(db_err)?;
    let cancel = cancel.clone();
    connection.lock_handle().await.map_err(db_err)?.set_progress_handler(1000, move || !cancel.is_cancelled());
    let mut tx = connection.begin().await.map_err(db_err)?;
    let native_table = sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_list WHERE schema = 'main' AND name = ? AND type = 'table')",
    )
    .bind(&request.table)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    if native_table == 0 {
        return Err(native_table_required());
    }
    let filter = column_filter(DbDriver::Sqlite, "name", selection);
    let metadata =
        format!("SELECT name, type FROM pragma_table_xinfo(?, 'main') WHERE hidden != 1 {filter} ORDER BY cid LIMIT ?");
    let mut stream =
        sqlx::query(sqlx::AssertSqlSafe(metadata)).bind(&request.table).bind((MAX_COLUMNS + 1) as i64).fetch(&mut *tx);
    let mut columns = Vec::new();
    let driver = DbDriver::Sqlite;
    while let Some(row) = stream.try_next().await.map_err(db_err)? {
        columns.push(source_column(driver, row.try_get(0).map_err(db_err)?, row.try_get(1).map_err(db_err)?)?);
    }
    drop(stream);
    require_columns(&columns, selection)?;
    let table = sql::qualified(driver, &request.schema, &request.table);
    let mut projection = Vec::with_capacity(columns.len());
    let mut storage = Vec::with_capacity(columns.len());
    for column in &columns {
        let cell = format!("t.{}", sql::quote_ident(driver, &column.name));
        let expected = match column.data_type {
            WorkspaceInputType::Boolean => format!("typeof({cell}) != 'integer' OR {cell} NOT IN (0, 1)"),
            WorkspaceInputType::Int64 => format!("typeof({cell}) != 'integer'"),
            WorkspaceInputType::Float64 => format!("typeof({cell}) != 'real'"),
            WorkspaceInputType::Text => format!("typeof({cell}) != 'text'"),
            _ => unreachable!(),
        };
        storage.push(format!("({cell} IS NOT NULL AND ({expected}))"));
        projection.push(if column.data_type == WorkspaceInputType::Float64 {
            format!("CASE WHEN {cell} IS NOT NULL THEN printf('%!.26g', {cell}) END")
        } else {
            format!("CAST({cell} AS TEXT)")
        });
    }
    let mismatch = storage.join(" OR ");
    let statement = bounded_select(driver, &table, &projection, Some(&mismatch), request.limits);
    let mut rows = InputRows::new(request.limits);
    let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(statement)).fetch(&mut *tx);
    while let Some(row) = stream.try_next().await.map_err(db_err)? {
        rows.new_row()?;
        let status: &str = row.try_get(columns.len()).map_err(db_err)?;
        check_row_status(status)?;
        let mut values = Vec::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let value: Option<&str> = row.try_get(index).map_err(db_err)?;
            rows.cell(value, column.data_type)?;
            values.push(value.map(str::to_owned));
        }
        rows.rows.push(values);
    }
    Ok(rows.finish(columns))
}

async fn read_duckdb(
    pool: &crate::jdbc::JdbcPool,
    request: &WorkspaceInputRequest,
    selection: Option<&[&str]>,
    cancel: &CancellationToken,
) -> IdeResult<WorkspaceInput> {
    let driver = DbDriver::Jdbc;
    let schema = sql::quote_literal(driver, &request.schema);
    let name = sql::quote_literal(driver, &request.table);
    let database = if request.database.is_empty() {
        "current_database()".into()
    } else {
        sql::quote_literal(driver, &request.database)
    };
    let filter = column_filter(driver, "c.column_name", selection);
    let query = format!(
        "SELECT c.column_name, c.data_type FROM information_schema.columns AS c
         JOIN information_schema.tables AS t USING (table_catalog, table_schema, table_name)
         WHERE c.table_catalog = current_database() AND c.table_catalog = {database}
         AND c.table_schema = {schema} AND c.table_name = {name}
         AND t.table_type = 'BASE TABLE' {filter} ORDER BY c.ordinal_position LIMIT {}",
        MAX_COLUMNS + 1
    );
    let metadata = pool.query(&query, 0, MAX_COLUMNS + 1, cancel).await?;
    let mut columns = Vec::with_capacity(metadata.rows.len());
    for row in metadata.rows {
        let [Some(name), Some(data_type)] = <[Option<String>; 2]>::try_from(row)
            .map_err(|_| IdeError::invalid("Invalid DuckDB workspace column metadata"))?
        else {
            return Err(IdeError::invalid("Invalid DuckDB workspace column metadata"));
        };
        columns.push(source_column(driver, name, data_type)?);
    }
    require_columns(&columns, selection)?;
    let table = sql::qualified(driver, &request.schema, &request.table);
    let projection: Vec<_> =
        columns.iter().map(|column| format!("CAST(t.{} AS VARCHAR)", sql::quote_ident(driver, &column.name))).collect();
    let statement = bounded_select(driver, &table, &projection, None, request.limits);
    let result = pool.query(&statement, 0, request.limits.max_rows + 1, cancel).await?;
    let mut rows = InputRows::new(request.limits);
    for mut row in result.rows {
        rows.new_row()?;
        let status = row.pop().flatten().ok_or_else(|| IdeError::invalid("Missing DuckDB workspace row status"))?;
        check_row_status(&status)?;
        if row.len() != columns.len() {
            return Err(IdeError::invalid("Incomplete DuckDB workspace row"));
        }
        for (cell, column) in row.iter().zip(&columns) {
            rows.cell(cell.as_deref(), column.data_type)?;
        }
        rows.rows.push(row);
    }
    Ok(rows.finish(columns))
}

type RawValue = serde_json::value::RawValue;

struct ClickhouseLines {
    pending: Vec<u8>,
    max_line: usize,
    headers: usize,
    width: usize,
}

impl ClickhouseLines {
    fn new(width: usize, max_line: usize) -> Self {
        Self { pending: Vec::new(), max_line: max_line.max(16_384), headers: 0, width }
    }

    fn push(&mut self, mut chunk: &[u8], row: &mut impl FnMut(Vec<&RawValue>) -> IdeResult<()>) -> IdeResult<()> {
        while let Some(end) = chunk.iter().position(|&b| b == b'\n') {
            let line = &chunk[..end];
            self.check_length(line.len())?;
            if self.pending.is_empty() {
                self.line(line, row)?;
            } else {
                self.pending.extend_from_slice(line);
                let pending = std::mem::take(&mut self.pending);
                self.line(&pending, row)?;
            }
            chunk = &chunk[end + 1..];
        }
        self.check_length(chunk.len())?;
        self.pending.extend_from_slice(chunk);
        Ok(())
    }

    fn check_length(&self, additional: usize) -> IdeResult<()> {
        if self.pending.len() + additional > self.max_line {
            return Err(byte_limit());
        }
        Ok(())
    }

    fn line(&mut self, line: &[u8], row: &mut impl FnMut(Vec<&RawValue>) -> IdeResult<()>) -> IdeResult<()> {
        let values: Vec<&RawValue> = serde_json::from_slice(line)
            .map_err(|_| IdeError::invalid("ClickHouse interrupted the workspace read or sent an invalid response"))?;
        if values.len() != self.width {
            return Err(IdeError::invalid("ClickHouse response width does not match the workspace table"));
        }
        if self.headers < 2 {
            if values.iter().any(|v| !v.get().starts_with('"')) {
                return Err(IdeError::invalid("Invalid ClickHouse workspace response header"));
            }
            self.headers += 1;
            return Ok(());
        }
        row(values)
    }

    fn finish(&self) -> IdeResult<()> {
        if self.headers != 2 || !self.pending.is_empty() {
            return Err(IdeError::invalid("ClickHouse workspace response ended before a complete result"));
        }
        Ok(())
    }
}

fn json_string(raw: &RawValue) -> IdeResult<String> {
    serde_json::from_str(raw.get()).map_err(|_| IdeError::invalid("Invalid ClickHouse workspace text field"))
}

const CLICKHOUSE_READ_CHECK: &str = "throwIf(
    getSetting('readonly') != 1 OR
    getSetting('read_overflow_mode') != 'throw' OR
    getSetting('result_overflow_mode') != 'throw' OR
    getSetting('timeout_overflow_mode') != 'throw',
    'Workspace requires ClickHouse read-only mode and overflow modes that throw'
) = 0";

async fn read_clickhouse(
    pool: &crate::clickhouse::ClickhousePool,
    request: &WorkspaceInputRequest,
    selection: Option<&[&str]>,
    cancel: &CancellationToken,
) -> IdeResult<WorkspaceInput> {
    let driver = DbDriver::Clickhouse;
    let database = sql::quote_literal(driver, &request.database);
    let table = sql::quote_literal(driver, &request.table);
    let filter = column_filter(driver, "name", selection);
    let catalog = format!(
        "SELECT name, type FROM system.columns
         WHERE database = {database} AND table = {table}
           AND (
               SELECT count() FROM system.tables
               WHERE database = {database} AND name = {table}
                 AND (endsWith(engine, 'MergeTree') OR engine IN ('Memory', 'Log', 'TinyLog', 'StripeLog', 'Null'))
           ) > 0
           AND {CLICKHOUSE_READ_CHECK} {filter}
         ORDER BY position LIMIT {}",
        MAX_COLUMNS + 1,
    );
    let mut columns = Vec::new();
    let mut parser = ClickhouseLines::new(2, 16_384);
    pool.workspace_rows(&catalog, MAX_COLUMNS + 1, 1_048_576, cancel, |chunk| {
        parser.push(chunk, &mut |row| {
            if columns.len() >= MAX_COLUMNS {
                return Err(IdeError::invalid("Workspace input exceeds the source column limit"));
            }
            columns.push(source_column(driver, json_string(row[0])?, json_string(row[1])?)?);
            Ok(())
        })
    })
    .await?;
    parser.finish()?;
    require_columns(&columns, selection)?;
    let table = sql::qualified(driver, &request.database, &request.table);
    let limits = request.limits;
    let projection: Vec<_> = columns
        .iter()
        .map(|col| {
            let name = sql::quote_ident(driver, &col.name);
            if col.data_type == WorkspaceInputType::TimestampTz {
                format!("concat(toString(t.{name}, 'UTC'), '+00:00')")
            } else {
                format!("toString(t.{name})")
            }
        })
        .collect();
    let mismatch = columns
        .iter()
        .map(|c| {
            let column = sql::quote_ident(driver, &c.name);
            let native = sql::quote_literal(driver, &c.native);
            format!("toTypeName(t.{column}) != {native}")
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    let query = bounded_select(driver, &table, &projection, Some(&mismatch), limits);
    let mut rows = InputRows::new(limits);
    let wire_limit = 6 * limits.max_bytes + 16_384;
    let mut parser = ClickhouseLines::new(columns.len() + 1, wire_limit);
    pool.workspace_rows(&query, limits.max_rows + 1, wire_limit, cancel, |chunk| {
        parser.push(chunk, &mut |row| {
            rows.new_row()?;
            check_row_status(&json_string(row[columns.len()])?)?;
            let mut values = Vec::with_capacity(columns.len());
            for (raw, column) in row.into_iter().zip(&columns) {
                let value = if raw.get() == "null" {
                    None
                } else {
                    if raw.get().len() > 6 * limits.max_cell_bytes + 2 {
                        return Err(cell_limit());
                    }
                    Some(json_string(raw)?)
                };
                rows.cell(value.as_deref(), column.data_type)?;
                values.push(value);
            }
            rows.rows.push(values);
            Ok(())
        })
    })
    .await?;
    parser.finish()?;
    Ok(rows.finish(columns))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DataSource;
    use std::sync::Arc;

    const LIMITS: WorkspaceInputLimits = WorkspaceInputLimits { max_rows: 10, max_cell_bytes: 128, max_bytes: 4096 };

    #[tokio::test]
    async fn sqlite_workspace_reads_exact_integer_and_rejects_dynamic_types() -> IdeResult<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path();
        let file = root.join("source.sqlite");
        let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&file).create_if_missing(true);
        let mut conn = sqlx::SqliteConnection::connect_with(&options).await.map_err(db_err)?;
        sqlx::raw_sql(
            "CREATE TABLE items(id BIGINT, label TEXT);
             INSERT INTO items VALUES (9007199254740993, 'fixture');
             CREATE TABLE mixed(id BIGINT);
             INSERT INTO mixed VALUES ('not an integer');
             CREATE TABLE empty_items(id BIGINT);
             CREATE TABLE computed(
                 value BIGINT,
                 doubled BIGINT GENERATED ALWAYS AS (value * 2) STORED
             );
             INSERT INTO computed(value) VALUES (9007199254740993);
             CREATE VIEW view_items AS SELECT * FROM items",
        )
        .execute(&mut conn)
        .await
        .map_err(db_err)?;
        conn.close().await.map_err(db_err)?;
        let ssh = Arc::new(ide_ssh::SshManager::new(root.join("ssh.json")));
        let db = DbManager::new(root.to_path_buf(), root.join("passwords.json"), root.join("history.json"), ssh);
        db.save_sources(vec![DataSource {
            id: "sqlite".into(),
            name: "SQLite".into(),
            file: Some(file.into()),
            ..Default::default()
        }])
        .await?;
        let request = WorkspaceInputRequest {
            source_id: "sqlite".into(),
            database: String::new(),
            schema: "main".into(),
            table: "items".into(),
            limits: LIMITS,
        };
        let cancel = CancellationToken::new();
        let input = read_table(&db, &request, &cancel).await?;
        assert_eq!(input.columns[0].data_type, WorkspaceInputType::Int64);
        assert_eq!(input.rows, [vec![Some("9007199254740993".into()), Some("fixture".into())]]);
        for (table, message) in [("mixed", "types"), ("view_items", "native table")] {
            let error = read_table(&db, &WorkspaceInputRequest { table: table.into(), ..request.clone() }, &cancel)
                .await
                .unwrap_err();
            assert!(error.message.contains(message), "{error}");
        }
        let generated = WorkspaceInputRequest { table: "computed".into(), ..request.clone() };
        let generated = read_table(&db, &generated, &cancel).await?;
        assert_eq!(generated.columns[1].name, "doubled");
        assert_eq!(generated.rows, [vec![Some("9007199254740993".into()), Some("18014398509481986".into())]]);
        for (limits, message) in [
            (WorkspaceInputLimits { max_rows: 0, ..LIMITS }, "row limit"),
            (WorkspaceInputLimits { max_bytes: 0, ..LIMITS }, "byte limit"),
        ] {
            let limited = WorkspaceInputRequest { limits, ..request.clone() };
            let error = read_table(&db, &limited, &cancel).await.unwrap_err();
            assert!(error.message.contains(message), "{error}");
            let empty = WorkspaceInputRequest { table: "empty_items".into(), ..limited };
            assert!(read_table(&db, &empty, &cancel).await?.rows.is_empty());
        }
        assert!(!db.is_connected("sqlite"));
        Ok(())
    }

    #[test]
    fn source_types_cannot_silently_lose_precision() {
        let decimal = WorkspaceInputType::Decimal { precision: 32, scale: 6 };
        assert_eq!(pg_type("numeric(32,6)"), Some(decimal));
        assert_eq!(clickhouse_type("Nullable(Decimal(32, 6))"), Some(decimal));
        for name in ["numeric", "numeric(39,4)", "numeric(18,-8)", "time with time zone", "jsonb"] {
            assert_eq!(pg_type(name), None, "{name}");
        }
        for name in ["Decimal(39, 5)", "DateTime64(9, 'UTC')", "Array(String)", "Int128"] {
            assert_eq!(clickhouse_type(name), None, "{name}");
        }
    }

    #[test]
    fn postgres_temporal_values_keep_their_era() -> IdeResult<()> {
        use WorkspaceInputType::*;
        assert_eq!(pg_temporal("0044-03-15 BC", Date)?, "-0043-03-15");
        assert_eq!(pg_temporal("0001-03-15 00:00:00+00 BC", TimestampTz)?, "0000-03-15 00:00:00+00");
        assert_eq!(pg_temporal("infinity", Timestamp)?, "infinity");
        assert!(pg_temporal("294276-12-31 23:59:59.999999", Timestamp).is_err());
        Ok(())
    }

    #[test]
    fn clickhouse_chunks_keep_exact_strings_and_require_complete_protocol() -> IdeResult<()> {
        let mut parser = ClickhouseLines::new(2, 1_024);
        let mut entries = Vec::new();
        let mut push = |cells: Vec<&RawValue>| {
            entries.push((json_string(cells[0])?, cells[1].get().to_owned()));
            Ok(())
        };
        parser.push(b"[\"v0\",\"v1\"]\n[\"String\",\"String\"]\n[\"900719925", &mut push)?;
        parser.push(b"4740993\",null]\n[\"a,b\\\"c\\nd\",\"\" ]\n", &mut push)?;
        parser.finish()?;
        assert_eq!(
            entries,
            [("9007199254740993".to_owned(), "null".to_owned()), ("a,b\"c\nd".to_owned(), "\"\"".to_owned())],
        );
        parser.push(b"[\"partial\"", &mut |_| Ok(()))?;
        assert!(parser.finish().is_err());
        assert!(parser.push(&vec![b'x'; 16_384], &mut |_| Ok(())).is_err());
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires the disposable ClickHouse fixture"]
    async fn clickhouse_workspace_refuses_truncated_reads() -> IdeResult<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path();
        let ssh = Arc::new(ide_ssh::SshManager::new(root.join("ssh.json")));
        let db = DbManager::new(root.to_path_buf(), root.join("passwords.json"), root.join("history.json"), ssh);
        let port = std::env::var("WORKSPACE_CH_PORT").unwrap().parse().unwrap();
        for (user, message) in
            [("fixture_break", "overflow modes that throw"), ("fixture_cap", "Limit for result exceeded")]
        {
            db.save_sources(vec![DataSource {
                id: user.into(),
                name: user.into(),
                driver: DbDriver::Clickhouse,
                host: "127.0.0.1".into(),
                port: Some(port),
                user: user.into(),
                ..Default::default()
            }])
            .await?;
            let request = WorkspaceInputRequest {
                source_id: user.into(),
                database: String::new(),
                schema: "default".into(),
                table: "overflow data".into(),
                limits: LIMITS,
            };
            let error = read_table(&db, &request, &CancellationToken::new()).await.unwrap_err();
            assert!(error.message.contains(message), "{user}: {error}");
        }
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires the workspace PG/CH fixtures, DUCKDB_JDBC_JAR, and Java 17+"]
    async fn workspace_join_chains_four_live_engines() -> IdeResult<()> {
        use crate::workspace::{
            WorkspaceJoinColumn, WorkspaceJoinCondition, WorkspaceJoinPlan, WorkspaceJoinProjection,
            WorkspaceJoinRelation,
        };
        ide_ssh::secrets::testing::use_memory_store();
        let temp = tempfile::tempdir()?;
        let root = temp.path();
        let ssh = Arc::new(ide_ssh::SshManager::new(root.join("ssh.json")));
        let db = DbManager::new(root.to_path_buf(), root.join("passwords.json"), root.join("history.json"), ssh)
            .with_global_sources(root.join("global"));
        db.save_jdbc_driver(crate::DbJdbcDriver {
            id: "duck".into(),
            name: "DuckDB".into(),
            vendor: Some("duckdb".into()),
            jars: vec![std::env::var("DUCKDB_JDBC_JAR").expect("official DuckDB fixture")],
            class_name: "org.duckdb.DuckDBDriver".into(),
            url_template: "jdbc:duckdb:".into(),
        })?;
        let cancel = CancellationToken::new();
        let duck_file = root.join("warehouse.duckdb");
        let duck_source = DataSource {
            id: "duckdb".into(),
            name: "DuckDB file".into(),
            driver: DbDriver::Jdbc,
            vendor: "duckdb".into(),
            jdbc_driver: "duck".into(),
            url: format!("jdbc:duckdb:{}", duck_file.display()),
            ..Default::default()
        };
        let Pool::Jdbc(duck_writer) = db.open_pool(&duck_source, None, true).await? else {
            unreachable!();
        };
        duck_writer
            .query("CREATE TABLE products (cost DECIMAL(32,6), product VARCHAR, attachment BLOB)", 0, 0, &cancel)
            .await?;
        duck_writer
            .query(
                "INSERT INTO products (cost, product) VALUES
                 (100000000000000000001.000001, 'exact product'),
                 (100000000000000000002.000002, 'adjacent decimal')",
                0,
                0,
                &cancel,
            )
            .await?;
        duck_writer.close().await;
        db.approve_jdbc_source(&duck_source)?;
        let sqlite_file = root.join("local.sqlite");
        let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&sqlite_file).create_if_missing(true);
        let mut writer = sqlx::SqliteConnection::connect_with(&options).await.map_err(db_err)?;
        sqlx::raw_sql(
            "CREATE TABLE local_rows (id BIGINT, tag TEXT, attachment BLOB);
             INSERT INTO local_rows (id, tag) VALUES (9007199254740993, 'local'), (9007199254740994, NULL)",
        )
        .execute(&mut writer)
        .await
        .map_err(db_err)?;
        writer.close().await.map_err(db_err)?;
        let postgres: u16 = std::env::var("WORKSPACE_PG_PORT").unwrap().parse().unwrap();
        let clickhouse: u16 = std::env::var("WORKSPACE_CH_PORT").unwrap().parse().unwrap();
        db.save_sources(vec![
            DataSource {
                id: "pg".into(),
                name: "PostgreSQL".into(),
                driver: DbDriver::Postgres,
                url_only: true,
                url: format!("postgresql://postgres@127.0.0.1:{postgres}/postgres"),
                ..Default::default()
            },
            DataSource {
                id: "ch".into(),
                name: "ClickHouse".into(),
                driver: DbDriver::Clickhouse,
                host: "127.0.0.1".into(),
                port: Some(clickhouse),
                user: std::env::var("WORKSPACE_CH_USER").expect("fixture user"),
                ..Default::default()
            },
            DataSource {
                id: "sqlite".into(),
                name: "SQLite".into(),
                file: Some(sqlite_file.into()),
                ..Default::default()
            },
            duck_source,
        ])
        .await?;
        let relation = |source_id: &str, database: &str, schema: &str, table: &str| WorkspaceJoinRelation {
            source_id: source_id.into(),
            database: database.into(),
            schema: schema.into(),
            table: table.into(),
        };
        let on = |relation, left: &str, right: &str| WorkspaceJoinCondition {
            left: WorkspaceJoinColumn { relation, column: left.into() },
            right_column: right.into(),
        };
        let select =
            |relation, column: Option<&str>| WorkspaceJoinProjection { relation, column: column.map(str::to_owned) };
        let plan = WorkspaceJoinPlan {
            tables: vec![
                relation("pg", "", "", "exact data"),
                relation("ch", "", "default", "exact data"),
                relation("sqlite", "", "main", "local_rows"),
                relation("duckdb", "warehouse", "main", "products"),
            ],
            joins: vec![on(0, "exact key", "exact key"), on(0, "id", "id"), on(1, "exact key", "cost")],
            projection: Some(vec![
                select(3, Some("cost")),
                select(3, Some("product")),
                select(2, Some("id")),
                select(1, Some("label")),
                select(2, Some("tag")),
                select(3, Some("cost")),
                select(0, None),
                select(0, Some("id")),
            ]),
        };
        let result = db.workspace_join("duck", plan, &cancel).await?;
        eprintln!("Four-engine workspace JOIN: {:.1} ms including metadata, inputs, and engine", result.elapsed_ms);
        assert_eq!(
            result.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(),
            ["cost", "product", "id", "label", "tag", "cost", "exact key", "id", "ts", "label", "id"],
        );
        assert_eq!(result.rows.len(), 1);
        let row = &result.rows[0];
        assert_eq!(
            row[..6],
            [
                Some("100000000000000000001.000001".into()),
                Some("exact product".into()),
                Some("9007199254740993".into()),
                Some("a,b\"c\nd".into()),
                Some("local".into()),
                Some("100000000000000000001.000001".into()),
            ],
        );
        assert_eq!(row[6], row[0]);
        assert_eq!(row[7], row[2]);
        assert!(row[8].as_deref().is_some_and(|ts| ts.contains(".123456")));
        assert_eq!(row[9], row[3]);
        assert_eq!(row[10], row[2]);
        let wildcard = WorkspaceJoinPlan {
            tables: vec![relation("sqlite", "", "", "local_rows"), relation("duckdb", "warehouse", "main", "products")],
            joins: vec![on(0, "id", "cost")],
            projection: None,
        };
        let error = db.workspace_join("duck", wildcard, &cancel).await.unwrap_err();
        assert!(error.message.contains("unsupported source type BLOB"), "{error}");
        let missing_source = WorkspaceJoinPlan {
            tables: vec![
                relation("pg", "", "", "exact data"),
                relation("ch", "", "default", "exact data"),
                relation("sqlite", "", "", "local_rows"),
                relation("removed", "", "", "products"),
            ],
            joins: vec![on(0, "exact key", "exact key"), on(0, "id", "id"), on(1, "exact key", "cost")],
            projection: None,
        };
        let error = db.workspace_join("no engine installed", missing_source, &cancel).await.unwrap_err();
        assert_eq!(error.kind, ide_core::error::ErrorKind::NotFound);
        assert!(error.message.contains("no data source removed"), "{error}");
        assert!(!result.has_more);
        for id in ["pg", "ch", "sqlite", "duckdb"] {
            assert!(!db.is_connected(id), "{id} used a console pool");
        }
        Ok(())
    }

    #[tokio::test]
    #[ignore = "run bash crates/ide-db/tests/fixtures/workspace.sh for disposable PG17/CH25.8"]
    async fn native_workspace_sources_are_exact_and_fail_on_limits() -> IdeResult<()> {
        ide_ssh::secrets::testing::use_memory_store();
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let ssh = Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
        let db = DbManager::new(root.to_path_buf(), root.join("passwords.json"), root.join("history.json"), ssh)
            .with_global_sources(root.join("global"));
        let postgres = std::env::var("WORKSPACE_PG_PORT").unwrap().parse().unwrap();
        let clickhouse = std::env::var("WORKSPACE_CH_PORT").unwrap().parse().unwrap();
        db.save_sources(vec![
            DataSource {
                id: "postgres".into(),
                name: "postgres".into(),
                driver: DbDriver::Postgres,
                url_only: true,
                url: format!("postgresql://postgres@127.0.0.1:{postgres}/postgres"),
                ..Default::default()
            },
            DataSource {
                id: "clickhouse".into(),
                name: "clickhouse".into(),
                driver: DbDriver::Clickhouse,
                host: "127.0.0.1".into(),
                database: "default".into(),
                user: std::env::var("WORKSPACE_CH_USER").unwrap_or_else(|_| "default".into()),
                port: Some(clickhouse),
                ..Default::default()
            },
        ])
        .await?;
        let cancel = CancellationToken::new();
        for (id, database, schema) in [("postgres", "", "public"), ("clickhouse", "default", "default")] {
            let request = WorkspaceInputRequest {
                source_id: id.into(),
                database: database.into(),
                schema: schema.into(),
                table: "exact data".into(),
                limits: LIMITS,
            };
            let input = read_table(&db, &request, &cancel).await?;
            assert_eq!(input.columns[0].data_type, WorkspaceInputType::Decimal { precision: 32, scale: 6 });
            assert_eq!(input.columns[1].data_type, WorkspaceInputType::Int64);
            assert_eq!(input.columns[2].data_type, WorkspaceInputType::TimestampTz);
            assert_eq!(input.columns[3].data_type, WorkspaceInputType::Text);
            assert_eq!(input.columns[0].name, "exact key");
            let first = input.rows.iter().find(|r| r[1].as_deref() == Some("9007199254740993")).unwrap();
            let second = input.rows.iter().find(|r| r[1].as_deref() == Some("9007199254740994")).unwrap();
            assert_eq!(first[0].as_deref(), Some("100000000000000000001.000001"));
            assert!(first[2].as_deref().unwrap().starts_with("2025-01-03 04:05:06.123456"));
            assert_eq!(first[3].as_deref(), Some("a,b\"c\nd"));
            assert_eq!(second[2], None);
            assert_eq!(second[3].as_deref(), Some(""));
            assert!(input.rows.iter().any(|row| row[3].is_none()));
            let empty =
                read_table(&db, &WorkspaceInputRequest { table: "empty data".into(), ..request.clone() }, &cancel)
                    .await?;
            assert_eq!(empty.columns, input.columns);
            assert!(empty.rows.is_empty());
            for (limits, message) in [
                (WorkspaceInputLimits { max_rows: 1, ..LIMITS }, "row limit"),
                (WorkspaceInputLimits { max_cell_bytes: 8, ..LIMITS }, "cell limit"),
                (WorkspaceInputLimits { max_bytes: 150, ..LIMITS }, "byte limit"),
                (WorkspaceInputLimits { max_bytes: 250, ..LIMITS }, "byte limit"),
            ] {
                let limited = WorkspaceInputRequest { limits, ..request.clone() };
                let err = read_table(&db, &limited, &cancel).await.unwrap_err();
                assert!(err.message.contains(message), "{id}: {err}");
            }
            for (table, message) in
                [("unsupported data", "unsupported source type"), ("fixture view", "readable native table")]
            {
                let request = WorkspaceInputRequest { table: table.into(), ..request.clone() };
                let err = read_table(&db, &request, &cancel).await.unwrap_err();
                assert!(err.message.contains(message), "{id}: {err}");
            }
            assert!(!db.is_connected(id), "the workspace must not open or use a console pool");
        }
        let has_duckdb = if let Ok(jar) = std::env::var("DUCKDB_JDBC_JAR") {
            db.save_jdbc_driver(crate::DbJdbcDriver {
                id: "duck".into(),
                name: "DuckDB".into(),
                vendor: Some("duckdb".into()),
                jars: vec![jar],
                class_name: "org.duckdb.DuckDBDriver".into(),
                url_template: "jdbc:duckdb:".into(),
            })?;
            true
        } else {
            false
        };
        use sqlx::{Connection, postgres::PgConnectOptions};
        let options =
            PgConnectOptions::new().host("127.0.0.1").port(postgres).database("postgres").username("postgres");
        let mut lock = PgConnection::connect_with(&options).await.map_err(db_err)?;
        let mut observer = PgConnection::connect_with(&options).await.map_err(db_err)?;
        sqlx::raw_sql("BEGIN; LOCK TABLE public.\"exact data\" IN ACCESS EXCLUSIVE MODE")
            .execute(&mut lock)
            .await
            .map_err(db_err)?;
        let blocked = WorkspaceInputRequest {
            source_id: "postgres".into(),
            database: "postgres".into(),
            schema: "public".into(),
            table: "exact data".into(),
            limits: LIMITS,
        };
        let ch = WorkspaceInputRequest {
            source_id: "clickhouse".into(),
            database: "default".into(),
            schema: "default".into(),
            ..blocked.clone()
        };
        let blocked_cancel = CancellationToken::new();
        let interrupt = async {
            let pending = async {
                loop {
                    let pid: Option<i32> = sqlx::query_scalar(
                        "SELECT pid FROM pg_catalog.pg_stat_activity
                         WHERE wait_event_type = 'Lock' AND query LIKE 'LOCK TABLE ONLY %' LIMIT 1",
                    )
                    .fetch_optional(&mut observer)
                    .await
                    .map_err(db_err)?;
                    if let Some(pid) = pid {
                        return Ok::<_, IdeError>(pid);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            };
            let blocked_query = tokio::time::timeout(std::time::Duration::from_secs(8), pending).await;
            blocked_cancel.cancel();
            blocked_query.map_err(|_| IdeError::internal("Workspace did not reach its source lock"))?
        };
        let blocked_run = async {
            if has_duckdb {
                db.workspace_join_pair_for_test("duck", [&blocked, &ch], ["exact key", "exact key"], &blocked_cancel)
                    .await
                    .map(drop)
            } else {
                read_table(&db, &blocked, &blocked_cancel).await.map(drop)
            }
        };
        let (result, interrupted) = tokio::join!(blocked_run, interrupt);
        let pid = interrupted.unwrap_or_else(|error| panic!("{error}; workspace returned {result:?}"));
        assert_eq!(result.unwrap_err().kind, ide_core::error::ErrorKind::Cancelled);
        let drained = async {
            loop {
                let waiting: bool = sqlx::query_scalar(
                    "SELECT EXISTS (
                        SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
                    )",
                )
                .bind(pid)
                .fetch_one(&mut observer)
                .await
                .map_err(db_err)?;
                if !waiting {
                    return Ok::<_, IdeError>(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), drained)
            .await
            .expect("workspace released its server waiter before the fixture released the lock")?;
        sqlx::raw_sql("ROLLBACK").execute(&mut lock).await.map_err(db_err)?;
        let unsigned = WorkspaceInputRequest { table: "unsigned data".into(), ..ch.clone() };
        let input = read_table(&db, &unsigned, &cancel).await?;
        assert_eq!(input.columns[0].data_type, WorkspaceInputType::UInt64);
        assert!(input.rows.iter().any(|row| row[0].as_deref() == Some("18446744073709551615")));
        if has_duckdb {
            let mismatch =
                db.workspace_join_pair_for_test("duck", [&blocked, &ch], ["id", "label"], &cancel).await.unwrap_err();
            assert!(mismatch.message.contains("type"), "{mismatch}");
            let mixed = db.workspace_join_pair_for_test("duck", [&blocked, &unsigned], ["id", "id"], &cancel).await?;
            assert_eq!(mixed.rows.len(), 1);
            assert_eq!(mixed.rows[0][1].as_deref(), Some("9007199254740993"));
            assert_eq!(mixed.rows[0][4].as_deref(), Some("9007199254740993"));
            let pg = blocked;
            let result =
                db.workspace_join_pair_for_test("duck", [&pg, &ch], ["exact key", "exact key"], &cancel).await?;
            assert_eq!(result.rows.len(), 2);
            for row in result.rows {
                assert_eq!(row[0], row[4]);
                assert_eq!(row[1], row[5]);
                assert_eq!(row[2], row[6]);
                assert_eq!(row[3], row[7]);
                let id = row[1].as_deref().unwrap();
                if id == "9007199254740993" {
                    assert_eq!(row[0].as_deref(), Some("100000000000000000001.000001"));
                    assert!(row[2].as_deref().unwrap().contains(".123456"));
                    assert_eq!(row[3].as_deref(), Some("a,b\"c\nd"));
                } else {
                    assert_eq!(id, "9007199254740994");
                    assert_eq!(row[0].as_deref(), Some("100000000000000000002.000001"));
                    assert_eq!(row[2], None);
                    assert_eq!(row[3].as_deref(), Some(""));
                    assert_eq!(row[6], None);
                }
            }
        }
        Ok(())
    }
}
