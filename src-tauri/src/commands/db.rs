//! IPC commands of `ide_host::ops::db` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, IpcPath, RequestId};
use ide_db::split::SqlStatement;
use ide_db::{DataSource, DbObjectKind, DbRowEdit, SortKey};
#[allow(unused_imports)]
pub use ide_host::ops::db::*;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub fn db_sources(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<DataSource>> {
    ide_host::ops::db::sources(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_sources(window: Window, state: State<'_, AppState>, sources: Vec<DataSource>) -> IdeResult<()> {
    ide_host::ops::db::save_sources(&state.host, window.label(), sources).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_set_password(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
    save: bool,
) -> IdeResult<()> {
    ide_host::ops::db::set_password(&state.host, window.label(), &id, password, save).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_test(
    window: Window,
    state: State<'_, AppState>,
    source: DataSource,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> IdeResult<String> {
    ide_host::ops::db::test(&state.host, window.label(), source, password, ssh_secret).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_set_ssh_secret(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    secret: Option<String>,
    save: bool,
) -> IdeResult<()> {
    ide_host::ops::db::set_ssh_secret(&state.host, window.label(), &id, secret, save).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_trust_ssh_host(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    ide_host::ops::db::trust_ssh_host(&state.host, window.label(), &id).await
}

#[tauri::command]
#[specta::specta]
pub fn db_connected(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<String>> {
    ide_host::ops::db::connected(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub async fn db_connect(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    ide_host::ops::db::connect(&state.host, window.label(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_set_manual_commit(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    manual: bool,
) -> IdeResult<()> {
    ide_host::ops::db::set_manual_commit(&state.host, window.label(), &id, manual).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_finish_transaction(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    commit: bool,
) -> IdeResult<()> {
    ide_host::ops::db::finish_transaction(&state.host, window.label(), &id, commit).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_disconnect(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    ide_host::ops::db::disconnect(&state.host, window.label(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_databases(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<ide_db::Databases> {
    ide_host::ops::db::databases(&state.host, window.label(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_schemas(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<Vec<String>> {
    ide_host::ops::db::schemas(&state.host, window.label(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_tables(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
) -> IdeResult<Vec<ide_db::TableInfo>> {
    ide_host::ops::db::tables(&state.host, window.label(), &id, &schema).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_table_details(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
    table: String,
) -> IdeResult<ide_db::TableDetails> {
    ide_host::ops::db::table_details(&state.host, window.label(), &id, &schema, &table).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_ddl(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
    table: String,
) -> IdeResult<String> {
    ide_host::ops::db::ddl(&state.host, window.label(), &id, &schema, &table).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_schema_objects(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    schema: String,
) -> IdeResult<ide_db::SchemaObjects> {
    ide_host::ops::db::schema_objects(&state.host, window.label(), &id, &schema).await
}

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
    ide_host::ops::db::object_ddl(&state.host, window.label(), &id, &schema, kind, &name).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_explain(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    id: String,
    statement: String,
    schema: Option<String>,
) -> IdeResult<Vec<ide_db::PlanNode>> {
    ide_host::ops::db::explain(&state.host, window.label(), request, &id, &statement, schema.as_deref()).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_history(
    window: Window,
    state: State<'_, AppState>,
    id: String,
) -> IdeResult<Vec<ide_db::HistoryEntry>> {
    ide_host::ops::db::history(&state.host, window.label(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_remove_history(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    texts: Option<Vec<String>>,
) -> IdeResult<()> {
    ide_host::ops::db::remove_history(&state.host, window.label(), &id, texts).await
}

/// Writes exported result data (CSV, JSON, SQL…) to `path`. Stays in the
/// desktop shell: the path comes from a local save dialog, and a remote
/// window exports through its local fs commands instead.
#[tauri::command]
#[specta::specta]
pub async fn db_export_file(path: std::path::PathBuf, text: String) -> IdeResult<()> {
    super::doc::blocking(move || {
        std::fs::write(&path, text)?;
        Ok(())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn db_completion(
    window: Window,
    state: State<'_, AppState>,
    id: String,
) -> IdeResult<ide_db::CompletionModel> {
    ide_host::ops::db::completion(&state.host, window.label(), &id).await
}

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
    ide_host::ops::db::statements(&state.host, window.label(), &id, &text, from, to)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn db_execute(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    id: String,
    statements: Vec<SqlStatement>,
    skip: u32,
    max_rows: u32,
    schema: Option<String>,
) -> IdeResult<Vec<StatementOutcome>> {
    ide_host::ops::db::execute(&state.host, window.label(), request, &id, statements, skip, max_rows, schema.as_deref())
        .await
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
) -> IdeResult<ide_db::TablePage> {
    ide_host::ops::db::table_page(
        &state.host,
        window.label(),
        request,
        &id,
        &schema,
        &table,
        filter,
        sort,
        offset,
        limit,
    )
    .await
}

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
    ide_host::ops::db::apply_edits(&state.host, window.label(), &id, &schema, &table, edits).await
}

#[tauri::command]
#[specta::specta]
pub fn db_console_path(state: State<'_, AppState>, id: String) -> IdeResult<IpcPath> {
    ide_host::ops::db::console_path(&state.host, &id)
}
