//! IPC commands of `ide_host::ops::coverage` (the shared implementation).

use crate::state::AppState;
use ide_core::{IdeResult, IpcPath};
use ide_coverage::{CoveragePrepared, CoverageReportSpec, CoverageSuite};
#[allow(unused_imports)]
pub use ide_host::ops::coverage::*;
use ide_run::RunConfig;
use tauri::{State, Window};

/// How to run `config` with coverage: the command to launch and where its report will be,
/// or which tool is missing.
#[tauri::command]
#[specta::specta]
pub async fn coverage_prepare(
    window: Window,
    state: State<'_, AppState>,
    config: RunConfig,
) -> IdeResult<CoveragePrepared> {
    ide_host::ops::coverage::coverage_prepare(&state.host, window.label(), config).await
}

/// Reads the report a coverage run left behind.
#[tauri::command]
#[specta::specta]
pub async fn coverage_collect(state: State<'_, AppState>, report: CoverageReportSpec) -> IdeResult<CoverageSuite> {
    ide_host::ops::coverage::coverage_collect(&state.host, "", report).await
}

/// Reads a report collected elsewhere (CI): lcov, a Go cover profile or JaCoCo XML,
/// with paths mapped into this project.
#[tauri::command]
#[specta::specta]
pub async fn coverage_import(window: Window, state: State<'_, AppState>, path: IpcPath) -> IdeResult<CoverageSuite> {
    ide_host::ops::coverage::coverage_import(&state.host, window.label(), path).await
}
