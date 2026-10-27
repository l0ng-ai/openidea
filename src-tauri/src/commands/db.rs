use crate::state::AppState;
use ide_core::{IdeError, IdeResult, IpcPath, RequestId};
use ide_db::split::SqlStatement;
use ide_db::{
    CompletionModel, DataSource, DbObjectKind, DbRowEdit, HistoryEntry, PlanNode, QueryResult, SchemaObjects, SortKey,
    TableDetails, TableInfo, TablePage,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub fn db_sources(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<DataSource>> {
    state.project(window.label())?.db.sources()
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_sources(window: Window, state: State<'_, AppState>, sources: Vec<DataSource>) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    db.save_sources(sources).await
}

/// Remembers the password of data source `id` for the session, and in the OS
/// saved passwords when `save` (`None` forgets it).
#[tauri::command]
#[specta::specta]
pub async fn db_set_password(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
    save: bool,
) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    db.set_password(&id, password, save).await
}

/// Test Connection: connects with unsaved settings and returns the server version.
#[tauri::command]
#[specta::specta]
pub async fn db_test(
    window: Window,
    state: State<'_, AppState>,
    source: DataSource,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> IdeResult<String> {
    let db = state.project(window.label())?.db.clone();
    db.test(&source, password, ssh_secret).await
}

/// Remembers the SSH password / key passphrase of a data source (see `db_set_password`).
#[tauri::command]
#[specta::specta]
pub async fn db_set_ssh_secret(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    secret: Option<String>,
    save: bool,
) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    db.set_ssh_secret(&id, secret, save).await
}

/// Trusts the SSH host key that made the last connection of `id` fail with
/// "Unknown SSH host key" (records it in `~/.ssh/known_hosts`).
#[tauri::command]
#[specta::specta]
pub async fn db_trust_ssh_host(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    db.trust_ssh_host(&id).await
}

#[tauri::command]
#[specta::specta]
pub fn db_connected(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<String>> {
    Ok(state.project(window.label())?.db.connected())
}

/// Connects (fails with `permissionDenied` when the password is missing or wrong).
#[tauri::command]
#[specta::specta]
pub async fn db_connect(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    db.pool(&id).await.map(|_| ())
}

/// Switches a data source between auto-commit and manual commit (leaving
/// manual mode rolls back what was not committed).
#[tauri::command]
#[specta::specta]
pub async fn db_set_manual_commit(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    manual: bool,
) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    db.set_manual_commit(&id, manual).await;
    Ok(())
}

/// Commits or rolls back the open transaction of a manual-commit data source.
#[tauri::command]
#[specta::specta]
pub async fn db_finish_transaction(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    commit: bool,
) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    db.finish_transaction(&id, commit).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_disconnect(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    db.disconnect(&id).await;
    Ok(())
}

/// Databases of the server of data source `id` (PostgreSQL); connect to one as `<id>:<database>`.
#[tauri::command]
#[specta::specta]
pub async fn db_databases(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<ide_db::Databases> {
    let db = state.project(window.label())?.db.clone();
    db.databases(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_schemas(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<Vec<String>> {
    let db = state.project(window.label())?.db.clone();
    db.schemas(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_tables(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
) -> IdeResult<Vec<TableInfo>> {
    let db = state.project(window.label())?.db.clone();
    db.tables(&id, &schema).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_table_details(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
    table: String,
) -> IdeResult<TableDetails> {
    let db = state.project(window.label())?.db.clone();
    db.table_details(&id, &schema, &table).await
}

/// The DDL of table or view `table` (Go to DDL, Generate DDL).
#[tauri::command]
#[specta::specta]
pub async fn db_ddl(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
    table: String,
) -> IdeResult<String> {
    let db = state.project(window.label())?.db.clone();
    db.ddl(&id, &schema, &table).await
}

/// The routines and sequences of `schema` (the tree's `routines` / `sequences`).
#[tauri::command]
#[specta::specta]
pub async fn db_schema_objects(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
) -> IdeResult<SchemaObjects> {
    let db = state.project(window.label())?.db.clone();
    db.schema_objects(&id, &schema).await
}

/// The definition of a routine, trigger or sequence (Go to DDL, Quick Documentation).
#[tauri::command]
#[specta::specta]
pub async fn db_object_ddl(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
    kind: DbObjectKind,
    name: String,
) -> IdeResult<String> {
    let db = state.project(window.label())?.db.clone();
    db.object_ddl(&id, &schema, kind, &name).await
}

/// Explain Plan: the execution plan of `statement` on `id`, without running it.
#[tauri::command]
#[specta::specta]
pub async fn db_explain(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    id: String,
    statement: String,
) -> IdeResult<Vec<PlanNode>> {
    let db = state.project(window.label())?.db.clone();
    let cancel = state.begin_request(request);
    let result = db.explain(&id, &statement, &cancel).await;
    state.end_request(request);
    result
}

/// The statements data source `id` ran, newest first (Browse Query History).
#[tauri::command]
#[specta::specta]
pub async fn db_history(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<Vec<HistoryEntry>> {
    let db = state.project(window.label())?.db.clone();
    db.history(&id).await
}

/// Removes statements from the query history of `id` (`None`: all of them).
#[tauri::command]
#[specta::specta]
pub async fn db_remove_history(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    texts: Option<Vec<String>>,
) -> IdeResult<()> {
    let db = state.project(window.label())?.db.clone();
    db.remove_history(&id, texts).await
}

/// Writes exported result data (CSV, JSON, SQL…) to `path`.
#[tauri::command]
#[specta::specta]
pub async fn db_export_file(path: std::path::PathBuf, text: String) -> IdeResult<()> {
    super::doc::blocking(move || {
        std::fs::write(&path, text)?;
        Ok(())
    })
    .await
}

/// Tables, columns and foreign keys for SQL completion.
#[tauri::command]
#[specta::specta]
pub async fn db_completion(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<CompletionModel> {
    let db = state.project(window.label())?.db.clone();
    db.completion(&id).await
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbStatementOutcome")]
pub struct StatementOutcome {
    pub statement: SqlStatement,
    pub result: Option<QueryResult>,
    pub error: Option<String>,
}

/// Statements a console runs: the selection's (`from < to`) or the one at the caret (`from`).
#[tauri::command]
#[specta::specta]
pub fn db_statements(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    text: String,
    from: u32,
    to: u32,
) -> IdeResult<Vec<SqlStatement>> {
    let driver = state.project(window.label())?.db.source(&id)?.driver;
    Ok(if from < to {
        ide_db::split::statements_in(&text, from, to, driver)
    } else {
        ide_db::split::statement_at(&text, from, driver).into_iter().collect()
    })
}

/// Runs `statements` in order on data source `id`, stopping at the first
/// error. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn db_execute(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    id: String,
    statements: Vec<SqlStatement>,
    max_rows: u32,
) -> IdeResult<Vec<StatementOutcome>> {
    let db = state.project(window.label())?.db.clone();
    let cancel = state.begin_request(request);
    let mut out = Vec::new();
    for statement in statements {
        match db.execute(&id, &statement.text, max_rows.max(1) as usize, &cancel).await {
            Ok(result) => out.push(StatementOutcome { statement, result: Some(result), error: None }),
            Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => {
                state.end_request(request);
                return Err(e);
            }
            Err(e) if e.kind == ide_core::error::ErrorKind::PermissionDenied && out.is_empty() => {
                // Not connected for lack of a password: the UI asks and retries.
                state.end_request(request);
                return Err(e);
            }
            Err(e) => {
                out.push(StatementOutcome { statement, result: None, error: Some(e.message) });
                break;
            }
        }
    }
    state.end_request(request);
    Ok(out)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn db_table_page(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    id: String,
    schema: String,
    table: String,
    filter: Option<String>,
    sort: Vec<SortKey>,
    offset: u32,
    limit: u32,
) -> IdeResult<TablePage> {
    let db = state.project(window.label())?.db.clone();
    let cancel = state.begin_request(request);
    let result = db
        .table_page(&id, &schema, &table, filter.as_deref(), &sort, offset.into(), limit.max(1).into(), &cancel)
        .await;
    state.end_request(request);
    result
}

/// Submits the table editor's changes in one transaction; returns the rows changed.
#[tauri::command]
#[specta::specta]
pub async fn db_apply_edits(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
    table: String,
    edits: Vec<DbRowEdit>,
) -> IdeResult<f64> {
    let db = state.project(window.label())?.db.clone();
    Ok(db.apply_edits(&id, &schema, &table, &edits).await? as f64)
}

/// The query console file of data source `id` (`<appData>/consoles/db/<id>/console.sql`), created on first use.
#[tauri::command]
#[specta::specta]
pub fn db_console_path(state: State<'_, AppState>, id: String) -> IdeResult<IpcPath> {
    let (source, database) = ide_db::split_target(&id);
    if source.is_empty() || !source.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(IdeError::invalid("invalid data source id"));
    }
    // One console per database: `<id>` for the default one, `<id>.<database>` for the others.
    let name = match database {
        Some(db) => {
            let safe: String =
                db.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
            format!("{source}.{safe}")
        }
        None => source.to_owned(),
    };
    let dir = state.data_dir.join("consoles").join("db").join(&name);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join("console.sql");
    if !file.exists() {
        std::fs::write(&file, "")?;
    }
    Ok(file.into())
}
