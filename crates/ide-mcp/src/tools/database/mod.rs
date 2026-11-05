//! The database tools: the project's data sources (Database tool window), their schemas
//! and objects, and running SQL with the user's consent.
//!
//! Metadata is read live rather than from an introspected model, so every schema counts as
//! introspected; statements are classified by keywords rather than by a SQL parser
//! ([`safety`]); a query's rows (up to [`results::MAX_KEPT_ROWS`]) are read at once and
//! paged from memory.

pub mod consent;
pub mod model;
pub mod results;
pub mod safety;

use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, IdeResult, error::ErrorKind};
use ide_db::{DataSource, DbManager};
use model::Schema;
use results::{QueryExecutionResult, StoredResult};
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;

/// The toolset of the database tools.
pub const GROUP: &str = "database.DatabaseToolset";

const CONNECTION_ID_DESCRIPTION: &str = "The unique ID of a database connection.";
const SCHEMA_NAME_DESCRIPTION: &str = "Name of the schema.";
const DATABASE_NAME_DESCRIPTION: &str = "Name of the database the schema belongs to. Might be empty if DBMS has no databases, but only schemas.
Together with `schemaName` property forms qualified schema name that uniquely identifies the schema within the connection.";
const QUERY_SESSION_ID_DESCRIPTION: &str = "The unique ID of a query session.";
const DATABASE_CONNECTION_NAME_DESCRIPTION: &str = "Unique name of the database connection.";
const DBMS_NAME_DESCRIPTION: &str = "Name of the database management system (DBMS)";
const DATABASE_URL_DESCRIPTION: &str =
    "Fully-formed JDBC URL of the database connection (e.g. `jdbc:postgresql://<host>:<port>/<database>`)";
const NEED_TO_CHECK_DS_DESCRIPTION: &str =
    "Whether to test the connection right after the data source is created/edited.
Set to `false` when configuring multiple connections in a batch — the per-connection probe is expensive,
and `test_database_connection` can be called explicitly for the connections that matter.";

/// Rows a page of `execute_sql_query` holds.
const DEFAULT_QUERY_ROWS_LIMIT: usize = 10;

const CONNECTION_NOT_FOUND: &str = "Couldn't find connection with specified id";
const SESSION_NOT_FOUND: &str = "Couldn't find database session";
const QUERY_EXECUTED: &str = "Query executed successfully";
const NO_MORE_ROWS: &str = "No more rows in the query result";
const EXECUTE_FAILED: &str = "Attempt to execute query has failed: ";
const FETCH_FAILED: &str = "Attempt to fetch query result has failed: ";
const UNTESTED: &str = "Connection test was skipped (needToCheckDs=false). Run `test_database_connection` if you want to verify this connection.";

pub fn tools() -> Vec<Tool> {
    let connection_id = || Param::required("connectionId", ParamType::String, CONNECTION_ID_DESCRIPTION);
    let database_name = || Param::required("databaseName", ParamType::String, DATABASE_NAME_DESCRIPTION);
    let schema_name = || Param::required("schemaName", ParamType::String, SCHEMA_NAME_DESCRIPTION);
    let configure = |tool: Tool| {
        tool.param(Param::required("dbms", ParamType::String, DBMS_NAME_DESCRIPTION))
            .param(Param::required("url", ParamType::String, DATABASE_URL_DESCRIPTION))
            .param(Param::required("needToCheckDs", ParamType::Boolean, NEED_TO_CHECK_DS_DESCRIPTION))
    };
    vec![
        Tool::new(
            "list_database_connections",
            McpToolKind::Read,
            "Retrieves a list of configured database connections or data sources in the project.",
            list_database_connections,
        ),
        Tool::new(
            "test_database_connection",
            McpToolKind::Read,
            "Checks whether a specific database connection is valid and reachable.
Do not use this tool for DDL data sources as they have no underlying DBMS connection.
Returns connection diagnostic info.",
            test_database_connection,
        )
        .param(Param::required("id", ParamType::String, CONNECTION_ID_DESCRIPTION)),
        configure(
            Tool::new(
                "create_database_connection",
                McpToolKind::Edit,
                "Create a new database connection (data source) by name, DBMS (dbms), JDBC URL (url) and flag to check connection (needToCheckDs). All parameters are required.
Returns connection diagnostic info.",
                create_database_connection,
            )
            .param(Param::required("name", ParamType::String, DATABASE_CONNECTION_NAME_DESCRIPTION)),
        ),
        configure(
            Tool::new(
                "edit_database_connection",
                McpToolKind::Edit,
                "Edit an existing database connection (data source) identified by `connectionId`.
Updates the connection's DBMS driver and JDBC URL; the connection `name` is preserved.
Required parameters: connectionId, dbms, url, needToCheckDs
Returns connection diagnostic info.
Do not use this tool for DDL data sources as they have no underlying DBMS connection.",
                edit_database_connection,
            )
            .param(connection_id()),
        ),
        Tool::new(
            "list_database_schemas",
            McpToolKind::Read,
            "Retrieves a list of database schemas in the specified database connection.",
            list_database_schemas,
        )
        .param(connection_id()),
        Tool::new(
            "introspect_schema",
            McpToolKind::Read,
            "Introspects a database schema, loading its metadata (tables, columns, indexes, etc.)
into the local model. Use this when a schema's `isIntrospected` flag is false
and you need to investigate the schema's structure, or to refresh stale metadata.
Returns the schema identifier with updated introspection status.",
            introspect_schema,
        )
        .param(connection_id())
        .param(database_name())
        .param(schema_name()),
        Tool::new(
            "list_schema_object_kinds",
            McpToolKind::Read,
            "Retrieves supported schema object kinds (e.g., table, view, routine) for the given database connection.",
            list_schema_object_kinds,
        )
        .param(connection_id()),
        Tool::new(
            "list_schema_objects",
            McpToolKind::Read,
            "Retrieves a list of database objects within the given schema.",
            list_schema_objects,
        )
        .param(connection_id())
        .param(database_name())
        .param(schema_name())
        .param(Param::optional(
            "kind",
            ParamType::String,
            "Object kind to filter by (e.g., table, view). If null, returns all objects in the schema.",
        )),
        Tool::new(
            "get_database_object_description",
            McpToolKind::Read,
            "Retrieves the structure of a database object (columns, types, keys, indexes) within a particular schema as a hierarchical text representation.
In case of ambiguity returns definition of all applicable objects.",
            get_database_object_description,
        )
        .param(connection_id())
        .param(database_name())
        .param(schema_name())
        .param(Param::required("kind", ParamType::String, "Non-empty object kind (e.g., table, view, routine)."))
        .param(Param::required(
            "objectName",
            ParamType::String,
            "Non-empty object name of the specified kind (e.g., table or view name).",
        )),
        Tool::new(
            "list_recent_sql_queries",
            McpToolKind::Read,
            "Retrieves a list of recent (including currently running) queries for the given database connection.
Do not use this tool for DDL data sources as they have no underlying DBMS connection.",
            list_recent_sql_queries,
        )
        .param(connection_id()),
        Tool::new("cancel_sql_query", McpToolKind::Execute, "Cancels a running query using its unique ID. ", cancel_sql_query)
            .param(Param::required("sessionId", ParamType::Integer, QUERY_SESSION_ID_DESCRIPTION)),
        Tool::new(
            "execute_sql_query",
            McpToolKind::Execute,
            "Executes a SQL query against the given database connection.
Do not use this tool for DDL data sources as they have no underlying DBMS connection.
Reports execution status (success/error) with error details when applicable.
Returns query results in CSV format, if any.",
            execute_sql_query,
        )
        .param(connection_id())
        .param(database_name())
        .param(schema_name())
        .param(Param::required("queryText", ParamType::String, "SQL query to be executed.")),
        Tool::new(
            "preview_table_data",
            McpToolKind::Read,
            "Previews data of the table, view, materialized view or other table-like object using given database connection.
Do not use this tool for DDL data sources as they have no underlying DBMS connection.
Returns table content in CSV format",
            preview_table_data,
        )
        .param(connection_id())
        .param(database_name())
        .param(schema_name())
        .param(Param::required("tableName", ParamType::String, "Name of the table."))
        .param(Param::optional(
            "maxRowCount",
            ParamType::Integer,
            "Maximum number of rows to return. Default is 10. You must NOT pass zero or negative value for this argument.",
        )),
        Tool::new(
            "fetch_query_result",
            McpToolKind::Read,
            "Fetches rows from an already executed query by its id, starting at the given row offset.
Returns the same shape as `execute_sql_query`: the `resultSetId` and the rendered result in CSV format.
Use this tool to paginate over a previously returned `resultSetId` from `execute_sql_query` or `preview_table_data`.",
            fetch_query_result,
        )
        .param(Param::required(
            "resultSetId",
            ParamType::String,
            "The opaque result set ID returned by a previous `execute_sql_query` or `preview_table_data` call.",
        ))
        .param(Param::required("offset", ParamType::Integer, "Row offset to start fetching from (0-based).")),
    ]
    .into_iter()
    .map(|t| t.group(GROUP))
    .collect()
}

/// An error the tool reports as is.
fn fail(message: impl Into<String>) -> IdeError {
    IdeError::invalid(message)
}

fn db(call: &Call) -> Arc<DbManager> {
    call.project().db.clone()
}

/// The data source `id`. OpenIDEA has no DDL data sources: every one is a connection.
fn find_source(call: &Call, id: &str) -> IdeResult<DataSource> {
    db(call).sources()?.into_iter().find(|s| s.id == id).ok_or_else(|| fail(CONNECTION_NOT_FOUND))
}

// --- results -----------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseConnectionInfo {
    id: String,
    name: String,
    dbms: String,
    driver_name: String,
    #[serde(rename = "isDDL")]
    is_ddl: bool,
    read_only: bool,
    jdbc_url: String,
}

/// Whether the connection has problems: `YES`, `NO` or `UNSURE` (not tested).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
enum ThreeState {
    Yes,
    No,
    Unsure,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseConnectionDiagnosticInfo {
    has_problems: ThreeState,
    connection_info: String,
    summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaInfo {
    database_name: String,
    schema_name: String,
    is_introspected: bool,
}

impl SchemaInfo {
    fn of(schema: &Schema) -> Self {
        Self { database_name: schema.database.clone(), schema_name: schema.name.clone(), is_introspected: true }
    }
}

// --- connections ---------------------------------------------------------------------

async fn list_database_connections(call: Call) -> IdeResult<Output> {
    let connections: Vec<DatabaseConnectionInfo> = db(&call)
        .sources()?
        .into_iter()
        .map(|s| {
            let vendor = model::vendor_of(&s);
            DatabaseConnectionInfo {
                jdbc_url: model::jdbc_url(&s),
                id: s.id,
                name: s.name,
                dbms: vendor.dbms.into(),
                driver_name: vendor.driver_name.into(),
                is_ddl: false,
                read_only: s.read_only,
            }
        })
        .collect();
    Output::json(json!({ "connections": connections }))
}

/// Tests `source`: its state, the DBMS and driver, and
/// the ping time or the error.
async fn test_connection(db: &DbManager, source: &DataSource) -> (ThreeState, String, String) {
    let vendor = model::vendor_of(source);
    let started = std::time::Instant::now();
    match db.test(source, None, None).await {
        Ok(version) => (
            ThreeState::No,
            format!("DBMS: {} (ver. {version})\nDriver: {}", vendor.dbms, vendor.driver_name),
            format!("\nPing: {} ms", started.elapsed().as_millis()),
        ),
        Err(e) => (
            ThreeState::Yes,
            format!("DBMS: {} (no ver.)\nDriver: {}", vendor.dbms, vendor.driver_name),
            results::error_summary(&e.message),
        ),
    }
}

async fn test_database_connection(call: Call) -> IdeResult<Output> {
    let source = find_source(&call, &call.str("id")?)?;
    let (has_problems, connection_info, summary) = test_connection(&db(&call), &source).await;
    Output::json(DatabaseConnectionDiagnosticInfo { has_problems, connection_info, summary })
}

/// The data source type named `dbms` (a driver name), and the settings of `url` for it.
fn vendor_and_url(dbms: &str, url: &str) -> IdeResult<(&'static model::Vendor, ide_db::source::ParsedUrl)> {
    let vendor = model::VENDORS.iter().find(|v| v.driver_name == dbms).ok_or_else(|| {
        let names: Vec<&str> = model::VENDORS.iter().map(|v| v.driver_name).collect();
        fail(format!("DBMS name is not valid, use one from the list: [{}]", names.join(", ")))
    })?;
    match ide_db::source::parse_url(url) {
        Ok(parsed) if parsed.driver == Some(vendor.driver) => Ok((vendor, parsed)),
        _ => Err(fail(format!("Invalid JDBC URL format for DBMS: {dbms}"))),
    }
}

/// Points `source` at `url` (its settings come from the URL, see [`DataSource::resolved`]).
fn apply_url(source: &mut DataSource, vendor: &model::Vendor, url: &str, parsed: ide_db::source::ParsedUrl) {
    source.driver = vendor.driver;
    source.vendor = vendor.id.into();
    source.url_only = true;
    source.url = url.trim().to_owned();
    if vendor.driver == ide_db::DbDriver::Sqlite {
        source.file = parsed.file.map(Into::into);
    } else {
        source.host = parsed.host;
        source.port = parsed.port;
        source.database = parsed.database;
        if !parsed.user.is_empty() {
            source.user = parsed.user;
        }
    }
}

/// Saves the data sources (the Database tool window re-reads them) and reports the
/// connection's diagnostic info.
async fn save_and_report(call: &Call, sources: Vec<DataSource>, id: &str, check: bool) -> IdeResult<Output> {
    let db = db(call);
    db.save_sources(sources).await?;
    call.record_change(&ide_core::project_dir::path(call.root(), "data-sources.toml"));
    let info = if check {
        let source = db.sources()?.into_iter().find(|s| s.id == id).ok_or_else(|| fail(CONNECTION_NOT_FOUND))?;
        let (has_problems, info, summary) = test_connection(&db, &source).await;
        DatabaseConnectionDiagnosticInfo {
            has_problems,
            connection_info: format!("ConnectionId: {id}\r\n{info}"),
            summary,
        }
    } else {
        DatabaseConnectionDiagnosticInfo {
            has_problems: ThreeState::Unsure,
            connection_info: format!("ConnectionId: {id}"),
            summary: UNTESTED.into(),
        }
    };
    Output::json(info)
}

async fn create_database_connection(call: Call) -> IdeResult<Output> {
    let (name, dbms, url) = (call.str("name")?, call.str("dbms")?, call.str("url")?);
    let check = call.opt_bool("needToCheckDs")?.ok_or_else(|| fail("missing required argument `needToCheckDs`"))?;
    let (vendor, parsed) = vendor_and_url(&dbms, &url)?;
    let mut sources = db(&call).sources()?;
    if sources.iter().any(|s| s.name == name) {
        return Err(fail(format!("Datasource with name '{name}' already exists")));
    }
    let mut source = DataSource { id: uuid::Uuid::new_v4().to_string(), name, ..Default::default() };
    apply_url(&mut source, vendor, &url, parsed);
    let id = source.id.clone();
    sources.push(source);
    save_and_report(&call, sources, &id, check).await
}

async fn edit_database_connection(call: Call) -> IdeResult<Output> {
    let (id, dbms, url) = (call.str("connectionId")?, call.str("dbms")?, call.str("url")?);
    let check = call.opt_bool("needToCheckDs")?.ok_or_else(|| fail("missing required argument `needToCheckDs`"))?;
    let mut sources = db(&call).sources()?;
    let Some(source) = sources.iter_mut().find(|s| s.id == id) else { return Err(fail(CONNECTION_NOT_FOUND)) };
    let (vendor, parsed) = vendor_and_url(&dbms, &url)?;
    apply_url(source, vendor, &url, parsed);
    save_and_report(&call, sources, &id, check).await
}

// --- schemas and objects ---------------------------------------------------------------

async fn list_database_schemas(call: Call) -> IdeResult<Output> {
    let source = find_source(&call, &call.str("connectionId")?)?;
    let schemas: Vec<SchemaInfo> =
        model::scoped_schemas(&db(&call), &source).await?.iter().map(SchemaInfo::of).collect();
    Output::json(json!({ "schemas": schemas }))
}

async fn introspect_schema(call: Call) -> IdeResult<Output> {
    let source = find_source(&call, &call.str("connectionId")?)?;
    let database_name = call.str("databaseName")?;
    let schema = model::find_schema(&db(&call), &source, &database_name, &call.str("schemaName")?).await?;
    // The catalogs are read live: there is nothing to load. The result echoes `databaseName`.
    Output::json(SchemaInfo { database_name, schema_name: schema.name, is_introspected: true })
}

async fn list_schema_object_kinds(call: Call) -> IdeResult<Output> {
    let source = find_source(&call, &call.str("connectionId")?)?;
    consent::read_schema_or_fail(&call, &source, None).await?;
    let kinds: Vec<_> = model::object_kinds(source.driver)
        .iter()
        .map(|code| json!({ "code": code, "name": model::kind_name(code) }))
        .collect();
    Output::json(json!({ "objectKinds": kinds }))
}

async fn list_schema_objects(call: Call) -> IdeResult<Output> {
    let source = find_source(&call, &call.str("connectionId")?)?;
    let db = db(&call);
    let schema = model::find_schema(&db, &source, &call.str("databaseName")?, &call.str("schemaName")?).await?;
    consent::read_schema_or_fail(&call, &source, Some((schema.object_path(source.driver), schema.display_name())))
        .await?;
    let kind = call.opt_str("kind")?;
    let kind = kind.as_deref().map(model::kind_or_fail).transpose()?;
    let objects: Vec<_> = model::schema_objects(&db, &source, &schema, kind)
        .await?
        .into_iter()
        .map(|o| json!({ "name": o.name, "kind": o.kind }))
        .collect();
    Output::json(json!({ "schemaInfo": SchemaInfo::of(&schema), "schemaObjects": objects }))
}

async fn get_database_object_description(call: Call) -> IdeResult<Output> {
    let source = find_source(&call, &call.str("connectionId")?)?;
    let db = db(&call);
    let schema = model::find_schema(&db, &source, &call.str("databaseName")?, &call.str("schemaName")?).await?;
    let kind = call.str("kind")?;
    let kind = model::kind_or_fail(&kind)?;
    let definitions = model::describe(&db, &schema, kind, &call.str("objectName")?).await?;
    Output::json(json!({ "schemaInfo": SchemaInfo::of(&schema), "definitions": definitions }))
}

// --- queries ---------------------------------------------------------------------------

async fn list_recent_sql_queries(call: Call) -> IdeResult<Output> {
    let source = find_source(&call, &call.str("connectionId")?)?;
    Output::json(json!({ "queries": db(&call).query_sessions(&source.id) }))
}

async fn cancel_sql_query(call: Call) -> IdeResult<Output> {
    let id = call.opt_i64("sessionId")?.ok_or_else(|| fail("missing required argument `sessionId`"))?;
    if id < 0 || !db(&call).cancel_session(id as u64) {
        return Err(fail(SESSION_NOT_FOUND));
    }
    Ok(Output::text("[success]"))
}

/// Classifies `query`, asks for consent, runs it in `schema`
/// and keeps its rows for paging.
async fn execute_safely(
    call: &Call,
    source: &DataSource,
    schema: &Schema,
    query: &str,
    page_size: usize,
) -> IdeResult<Output> {
    let op = safety::classify(query, source.driver);
    let ctx = consent::ConsentContext { source, schema: Some(schema.display_name()), query };
    consent::query_or_fail(call, &ctx, op).await?;
    let db = db(call);
    let result =
        db.execute_isolated(&schema.target, Some(&schema.name), query, results::MAX_KEPT_ROWS, &call.cancel).await;
    let out = match result {
        Ok(result) => {
            let stored = StoredResult { result, page_size };
            let id = results::store(call.root(), stored.clone());
            results::page(&id, &stored, 0, QUERY_EXECUTED)
        }
        Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
        Err(e) => QueryExecutionResult {
            result_set_id: String::new(),
            text: None,
            error_message: Some(format!("{EXECUTE_FAILED}{}", results::error_summary(&e.message))),
        },
    };
    Output::json(out)
}

async fn execute_sql_query(call: Call) -> IdeResult<Output> {
    let source = find_source(&call, &call.str("connectionId")?)?;
    let schema = model::find_schema(&db(&call), &source, &call.str("databaseName")?, &call.str("schemaName")?).await?;
    let query = call.str("queryText")?;
    execute_safely(&call, &source, &schema, &query, DEFAULT_QUERY_ROWS_LIMIT).await
}

async fn preview_table_data(call: Call) -> IdeResult<Output> {
    let source = find_source(&call, &call.str("connectionId")?)?;
    let db = db(&call);
    let schema = model::find_schema(&db, &source, &call.str("databaseName")?, &call.str("schemaName")?).await?;
    let table_name = call.str("tableName")?;
    let Some(table) = model::find_table(&db, &schema, &table_name).await? else {
        let name = model::display_name(&schema.display_name(), &table_name);
        return Err(fail(format!("Database object {name} is not found")));
    };
    let page_size = call.opt_i64("maxRowCount")?.unwrap_or(DEFAULT_QUERY_ROWS_LIMIT as i64).max(1) as usize;
    let query = format!("SELECT * FROM {}", ide_db::sql::qualified(source.driver, &schema.name, &table));
    execute_safely(&call, &source, &schema, &query, page_size).await
}

async fn fetch_query_result(call: Call) -> IdeResult<Output> {
    let id = call.str("resultSetId")?;
    if id.trim().is_empty() {
        return Err(fail("resultSetId cannot be empty or blank"));
    }
    let offset = call.opt_i64("offset")?.ok_or_else(|| fail("missing required argument `offset`"))?.max(0) as usize;
    let failed = |message: &str| QueryExecutionResult {
        result_set_id: id.clone(),
        text: None,
        error_message: Some(format!("{FETCH_FAILED}{message}")),
    };
    let out = match results::get(call.root(), &id) {
        Err(message) => failed(message),
        Ok(stored) if offset >= stored.result.rows.len() && stored.result.has_more => failed(&format!(
            "OpenIDEA keeps the first {} rows of a query result; narrow the query to see the others",
            stored.result.rows.len()
        )),
        Ok(stored) => results::page(&id, &stored, offset, NO_MORE_ROWS),
    };
    Output::json(out)
}
