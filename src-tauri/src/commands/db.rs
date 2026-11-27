//! IPC commands of `ide_host::ops::db` (the shared implementation).

use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::{IdeResult, RequestId};
use ide_db::tools::{DbTool, DbToolJob, DumpInfo, ToolInstall, ToolLine};
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Writes exported result data (CSV, JSON, SQL…) to `path`. Stays in the
/// desktop shell: the path comes from a local save dialog, and a remote
/// window exports through its local fs commands instead.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn db_export_file(path: std::path::PathBuf, text: String) -> IdeResult<()> {
    ide_host::ops::blocking(move || {
        std::fs::write(&path, text)?;
        Ok(())
    })
    .await
}

/// Installed copies of `tool`, newest first.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn db_tool_installs(tool: DbTool) -> IdeResult<Vec<ToolInstall>> {
    ide_host::ops::blocking(move || Ok(ide_db::tools::find_installs(tool))).await
}

/// The version line of the executable at `path`.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn db_tool_version(path: std::path::PathBuf) -> IdeResult<String> {
    ide_host::ops::blocking(move || ide_db::tools::version_of(&path)).await
}

/// The long options the executable at `path` lists in its `--help` (`masking-policies`…).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn db_tool_options(path: std::path::PathBuf) -> IdeResult<Vec<String>> {
    ide_host::ops::blocking(move || ide_db::tools::options_of(&path)).await
}

/// What made the dump at `path` and whether it creates its own database (from its first bytes).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn db_dump_info(path: std::path::PathBuf) -> IdeResult<DumpInfo> {
    ide_host::ops::blocking(move || ide_db::tools::dump_info(&path)).await
}

/// The command line `db_run_tool` would run, without the password.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub fn db_tool_preview(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    executable: std::path::PathBuf,
    job: DbToolJob,
) -> IdeResult<String> {
    ide_host::ops::db::tool_preview(&state.host, window.label(), &id, &executable, &job)
}

/// Runs `job` against target `id` and streams the tool's output; returns its exit code. Stays
/// in the desktop shell like [`db_export_file`]: the paths in `job` are local.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn db_run_tool(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    id: String,
    executable: std::path::PathBuf,
    job: DbToolJob,
    on_output: Channel<Vec<ToolLine>>,
) -> IdeResult<Option<i32>> {
    ide_host::ops::db::run_tool(&state.host, window.label(), request, &id, &executable, &job, |lines| {
        let _ = on_output.send(lines);
    })
    .await
}

/// `server_version_num` of the PostgreSQL server of target `id` (connects first).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn db_server_version(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<u32> {
    ide_host::ops::db::server_version(&state.host, window.label(), &id).await
}

/// Records the exact helper and destination reviewed in the local data-source dialog.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn db_approve_external_tunnel(
    window: Window,
    state: State<'_, AppState>,
    source: ide_db::DataSource,
) -> IdeResult<()> {
    state.host.project(window.label())?.db.approve_external_tunnel(&source).await
}

/// Tests the reviewed helper once, without persisting approval for subsequent connections.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn db_test_external_tunnel(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    source: ide_db::DataSource,
    password: Option<String>,
) -> IdeResult<String> {
    let db = state.host.project(window.label())?.db.clone();
    let cancel = state.host.begin_project_request(window.label(), request);
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(ide_core::IdeError::cancelled()),
        result = db.test_external_tunnel(&source, password) => result,
    };
    state.host.end_request(request);
    result
}

ide_command::desktop_domain!(
    db_approve_external_tunnel,
    db_test_external_tunnel,
    db_dump_info,
    db_export_file,
    db_run_tool,
    db_server_version,
    db_tool_installs,
    db_tool_options,
    db_tool_preview,
    db_tool_version,
);
